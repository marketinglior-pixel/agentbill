import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { sql } from '../db/index.js'
import { INT4_MAX, ID_MAX } from './ids.js'
import { runPreflight } from '../routes/preflight.js'
import { runRecord } from '../routes/events.js'
import { taskStatus, serialize } from '../routes/tasks.js'
import { listDecisions } from '../routes/decisions.js'
import { LIST_PRICE_LABEL } from './prices.js'
import { TASK_UNITS } from './task-ceiling.js'
import { COMMIT } from './version.js'
import type { Scope } from './mcp-oauth.js'

// The tools behind https://agentbill.dev/mcp, 2026-09-25.
//
// Two are the parity pair from the Python stdio server (mcp/agentbill_mcp/
// server.py): preflight and record_event, with the same arguments, the same
// defaults and the same refusal sentences. They call runPreflight and runRecord,
// the functions POST /preflight and POST /events run, so a call through MCP
// reserves, refuses, settles and alerts exactly as one over REST. Nothing here
// is an HTTP call to this server.
//
// Three are read-only, for "where is my money going": one job's status, jobs
// ranked by what they used, and the recent refusals.
//
// What no tool can do, by construction rather than by a check: create, list or
// show an API key, change a plan, touch billing, or change an existing job's
// ceiling. None of those functions is imported into this file.
//
// A refusal is a result, not an error. approved: false comes back as an
// ordinary tool result with the reason and the sentence a model can act on,
// the way the Python server returns it; isError is kept for calls that could
// not be decided at all.

export interface ToolContext {
  accountId: string
  scopes: readonly Scope[]
  log: FastifyBaseLogger
}

export const TOOL_SCOPE: Record<string, Scope> = {
  preflight: 'agentbill:meter',
  record_event: 'agentbill:meter',
  task_status: 'agentbill:read',
  top_jobs: 'agentbill:read',
  recent_refusals: 'agentbill:read',
}

const INSTRUCTIONS =
  'AgentBill is one spend ceiling per agent job, consulted before the call goes out. ' +
  'Call preflight before starting agent work to check whether the job and the customer have units left; ' +
  'approved: false is the answer, with a reason and a sentence saying why, and the host decides what happens next. ' +
  'Call record_event after the work to record what it used; pass the same task_ref and the reservation_id preflight returned to settle that reservation. ' +
  'task_status, top_jobs and recent_refusals read what each job used, its tokens and its cost at public list price. Dollar figures are estimates, never an invoice. ' +
  'Nothing meters the tokens of the conversation you are in: a call is recorded only when record_event records it.'

const id = (what: string) => z.string().min(1).max(ID_MAX).describe(what)
const units = (what: string) => z.number().int().positive().max(INT4_MAX).describe(what)

/** The result both ways: JSON a program can read, and the same JSON as text for a host that only shows text. */
const result = (value: Record<string, unknown>, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  ...(isError ? { isError: true } : {}),
})

/** The sentence beside approved: false. The Python server's _refusal_message, word for word. */
export function refusalMessage(reason: string, data: Record<string, unknown>): string {
  switch (reason) {
    case 'ceiling_exceeded':
      return `Refused (ceiling_exceeded): estimated ${data.estimated_units} units exceeds the per-request ceiling of ${data.ceiling}.`
    case 'task_ceiling_exceeded':
      return `Refused (task_ceiling_exceeded): task '${data.task_ref}' is at ${data.task_used_units}/${data.task_ceiling} units and ${data.task_remaining_units} remaining is not enough for this call.`
    case 'task_ceiling_required':
      return 'Refused (task_ceiling_required): this task_ref is unknown. Pass task_ceiling on the first preflight of a new task, or open the job first in the console.'
    case 'budget_exhausted':
      return "Refused (budget_exhausted): this customer's balance is spent."
    case 'free_tier_exceeded':
      return `Refused (free_tier_exceeded): this month's free preflight calls are used up. Upgrade at ${data.upgrade_url ?? 'https://agentbill.dev/pricing'}`
    default:
      return `Refused (${reason}).`
  }
}

/** A preflight answer as the tool returns it, from the status and body POST /preflight would have sent. */
export function preflightToolResult(status: number, body: Record<string, unknown>): Record<string, unknown> {
  if (status === 409) {
    return { approved: false, reason: 'preflight_in_progress',
             message: (body.message as string) ?? 'Another preflight with this idempotency_key is still being decided. Retry in a moment.' }
  }
  if (status === 422) {
    return { approved: false, reason: (body.error as string) ?? 'validation_error',
             message: (body.message as string) ?? 'Preflight was rejected as invalid. The run did not start.' }
  }
  if (status !== 200) {
    return { approved: false, reason: (body.error as string) ?? 'unavailable', message: 'Preflight could not be decided. The run did not start.' }
  }
  // Approved only on an explicit true, the rule the Python server keeps: a
  // body without it is not a verdict.
  if (body.approved !== true) {
    const reason = (body.reason as string) ?? 'unknown'
    return {
      approved: false,
      reason,
      remaining_units: body.remaining_units ?? null,
      upgrade_url: body.upgrade_url ?? null,
      message: refusalMessage(reason, body),
      ...(body.task_ref ? { task_ref: body.task_ref, task_ceiling: body.task_ceiling ?? null,
                            task_used_units: body.task_used_units ?? null, task_remaining_units: body.task_remaining_units ?? null } : {}),
    }
  }
  return {
    approved: true,
    remaining_units: body.remaining_units ?? null,
    estimated_units: body.estimated_units ?? null,
    reservation_id: body.reservation_id,
    reservation_expires_at: body.reservation_expires_at,
    ...(body.task_ref ? { task_ref: body.task_ref, task_ceiling: body.task_ceiling, task_remaining_units: body.task_remaining_units } : {}),
  }
}

type Sort = 'units' | 'list_price'

/** Jobs ranked by what they used, each with its list-price estimate beside the units it counted. */
async function topJobs(accountId: string, sort: Sort, limit: number, agentId?: string) {
  const rows = await sql`
    SELECT t.task_ref, t.agent_id, t.ceiling_units, t.used_units, t.reserved_units, t.unit, t.usage_missing_calls,
           t.created_at, t.updated_at, e.usd, e.priced, e.calls
    FROM task_budgets t
    LEFT JOIN LATERAL (
      SELECT sum(list_price_usd) AS usd, count(list_price_usd) AS priced, count(*) AS calls
      FROM events WHERE account_id = t.account_id AND task_ref = t.task_ref
    ) e ON true
    WHERE t.account_id = ${accountId}
      ${agentId ? sql`AND t.agent_id = ${agentId}` : sql``}
    ORDER BY ${sort === 'list_price' ? sql`e.usd DESC NULLS LAST, t.used_units DESC` : sql`t.used_units DESC, t.created_at DESC`}
    LIMIT ${limit}
  `
  return rows.map((r) => {
    const job = serialize(r as never)
    const priced = Number(r.priced ?? 0)
    return {
      task_ref: job.task_ref,
      agent_id: job.agent_id,
      unit: job.unit,
      used_units: job.used_units,
      ceiling_units: job.ceiling_units,
      remaining_units: job.remaining_units,
      exceeded: job.exceeded,
      recorded_calls: Number(r.calls ?? 0),
      list_price_usd_estimate: priced > 0 ? Number(r.usd) : null,
      priced_calls: priced,
      updated_at: job.updated_at,
    }
  })
}

/**
 * One McpServer for one request, holding only the tools the caller's scopes
 * reach. Built per request because the endpoint is stateless: there is no
 * session to hang a server on, and a server per request cannot leak one
 * account's context into another's.
 */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'agentbill', title: 'AgentBill', version: COMMIT === 'unknown' ? '1.0.0' : `1.0.0+${COMMIT.slice(0, 7)}` },
    { instructions: INSTRUCTIONS },
  )
  const allowed = (tool: string) => ctx.scopes.includes(TOOL_SCOPE[tool])

  if (allowed('preflight')) {
    server.registerTool('preflight', {
      title: 'Ask preflight before a call',
      description:
        'Check whether an agent may run before starting work. Returns approved: true when the job and the customer have units left, ' +
        'or approved: false with a reason (budget_exhausted, ceiling_exceeded, free_tier_exceeded, task_ceiling_exceeded, task_ceiling_required) ' +
        'and a message. This server does not end the run; the host decides what happens next. A unit is an integer you define; AgentBill reserves the number you ' +
        'send and never converts units into money. An approved answer reserves estimated_units against the job; settle it with record_event and ' +
        'the reservation_id, or it is released when it expires.',
      inputSchema: {
        agent_id: id('Identifier for this agent or task type, e.g. "research_agent".'),
        customer_id: z.string().max(ID_MAX).default('default').describe('Your customer identifier. Defaults to "default".'),
        estimated_units: units('Units you expect this run to use. This is what is reserved.').default(1),
        ceiling: units('Most units one call may use. Refused when estimated_units is more.').optional(),
        task_ref: id('The job this call belongs to. Every call with the same task_ref shares one ceiling.').optional(),
        task_ceiling: units('Total units the whole job may use. Needed on the first preflight of a new task_ref; not applied later.').optional(),
        idempotency_key: id('Makes a retried preflight safe: same key, same decision, one reservation.').optional(),
        unit: z.enum(TASK_UNITS).optional().describe('What the job counts, "unit" or "token". Read when this call opens the job.'),
      },
      annotations: { title: 'Ask preflight before a call', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (a) => {
      const input: Record<string, unknown> = { agent_id: a.agent_id, customer_id: a.customer_id, estimated_units: a.estimated_units }
      for (const k of ['ceiling', 'task_ref', 'task_ceiling', 'idempotency_key', 'unit'] as const) if (a[k] !== undefined) input[k] = a[k]
      const r = await runPreflight(ctx.accountId, input, ctx.log)
      const value = preflightToolResult(r.status, r.body as Record<string, unknown>)
      return result(value, r.status >= 500 || r.status === 401)
    })
  }

  if (allowed('record_event')) {
    server.registerTool('record_event', {
      title: 'Record what a call used',
      description:
        'Record a billable event after agent work completes, against the customer\'s balance and, with task_ref, the job\'s. ' +
        'Pass the reservation_id preflight returned to settle that reservation whole. Safe to retry with the same idempotency_key: ' +
        'a duplicate is ignored. With success: false nothing is recorded and the reservation is released.',
      inputSchema: {
        agent_id: id('Identifier for this agent or task type. Recorded as the event type.'),
        units: z.number().int().min(0).max(INT4_MAX).default(1).describe('Units this call used. 0 is allowed.'),
        customer_id: id('Your customer identifier. Defaults to "default".').default('default'),
        metadata: z.record(z.unknown()).optional().describe(
          'Optional key-value pairs stored with the event. At most 8 KB. A model call is priced at public list price when it names ' +
          'provider ("openai", "anthropic" or "gemini"), model, and tokens as whole numbers, e.g. ' +
          '{"provider": "anthropic", "model": "claude-sonnet-4-5", "tokens": {"input": 1200, "output": 300}, "step": "test"}.'),
        task_ref: id('The job this call belongs to, the same task_ref preflight was given.').optional(),
        reservation_id: z.string().uuid().optional().describe('The reservation_id preflight returned for this call.'),
        idempotency_key: id('Your key for this record. Generated when omitted, which makes a retry record twice.').optional(),
        success: z.boolean().default(true).describe('false: the call failed. Nothing is recorded and the reservation is released.'),
      },
      annotations: { title: 'Record what a call used', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (a) => {
      const input: Record<string, unknown> = {
        customer_id: a.customer_id,
        event_type: a.agent_id,
        idempotency_key: a.idempotency_key ?? `${a.agent_id}-${randomUUID()}`.slice(0, ID_MAX),
        units: a.units,
        success: a.success,
      }
      for (const k of ['metadata', 'task_ref', 'reservation_id'] as const) if (a[k] !== undefined) input[k] = a[k]
      const r = await runRecord(ctx.accountId, input, ctx.log)
      const body = r.body as Record<string, unknown>
      if (r.status === 402) return result({ recorded: false, reason: 'budget_exhausted', message: (body.message as string) ?? 'Customer budget is exhausted.' })
      if (r.status === 422) return result({ recorded: false, reason: 'validation_error', message: (body.message as string) ?? 'The record was rejected as invalid.' })
      if (r.status !== 200) return result({ recorded: false, reason: 'unavailable', message: 'The record could not be written.' }, true)
      return result({ recorded: true, ...body })
    })
  }

  if (allowed('task_status')) {
    server.registerTool('task_status', {
      title: 'One job\'s status',
      description:
        'One job by task_ref: its ceiling, used, reserved and remaining units, and its recorded calls by model and by step with tokens and ' +
        'an estimate in dollars at public list price. The dollar figure is an estimate, labelled as one, never an invoice.',
      inputSchema: { task_ref: id('The job to read.') },
      annotations: { title: 'One job\'s status', readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
      const task = await taskStatus(ctx.accountId, a.task_ref)
      if (!task) return result({ found: false, task_ref: a.task_ref, message: `No job with task_ref "${a.task_ref}" on this account.` })
      return result({ found: true, ...task })
    })
  }

  if (allowed('top_jobs')) {
    server.registerTool('top_jobs', {
      title: 'Jobs ranked by what they used',
      description:
        'This account\'s jobs ranked by what they used: by units (the numbers your code reported) or by the list-price estimate in dollars. ' +
        'Dollars are an estimate at public list price for calls recorded with a model named, never an invoice; a job with no priced call shows null, not 0.',
      inputSchema: {
        sort: z.enum(['units', 'list_price']).default('units').describe('units: most used units first. list_price: highest dollar estimate first.'),
        agent_id: id('Only this agent\'s jobs.').optional(),
        limit: z.number().int().min(1).max(50).default(10).describe('How many jobs, 1 to 50.'),
      },
      annotations: { title: 'Jobs ranked by what they used', readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
      const jobs = await topJobs(ctx.accountId, a.sort, a.limit, a.agent_id)
      return result({ sort: a.sort, jobs, list_price_label: LIST_PRICE_LABEL })
    })
  }

  if (allowed('recent_refusals')) {
    server.registerTool('recent_refusals', {
      title: 'Recent refusals',
      description:
        'The calls refused on this account, newest first, and the ones recorded past a ceiling, each with the body the agent received. ' +
        'Also the totals: blocked_total and overrun_total.',
      inputSchema: {
        agent_id: id('Only this agent.').optional(),
        task_ref: id('Only this job.').optional(),
        limit: z.number().int().min(1).max(50).default(10).describe('How many, 1 to 50.'),
      },
      annotations: { title: 'Recent refusals', readOnlyHint: true, openWorldHint: false },
    }, async (a) => {
      const d = await listDecisions(ctx.accountId, { agent_id: a.agent_id, task_ref: a.task_ref, limit: a.limit })
      return result(d as unknown as Record<string, unknown>)
    })
  }

  return server
}
