/**
 * agentbill — Node.js SDK
 *
 * Usage-based billing for AI agents. 3-line integration.
 *
 *   import { meter } from 'agentbill'
 *
 *   const runAgent = meter(
 *     async ({ customerId, topic }) => { ... },
 *     { event: 'research_run', customerIdFrom: 'customerId' }
 *   )
 *
 * Environment variables:
 *   AGENTBILL_API_KEY     Required. Your key from agentbill.fly.dev/register.
 *   AGENTBILL_BASE_URL    Optional. Defaults to https://agentbill.fly.dev
 *   AGENTBILL_CUSTOMER_ID Optional. Fallback customer_id when not passed per-call.
 */

const BASE_URL = process.env.AGENTBILL_BASE_URL ?? 'https://agentbill.fly.dev'

// ---------------------------------------------------------------------------
// Public exceptions
// ---------------------------------------------------------------------------

export class BudgetExhaustedError extends Error {
  readonly customerId: string
  constructor(customerId: string, message?: string) {
    super(message ?? `Customer '${customerId}' has no remaining budget.`)
    this.name = 'BudgetExhaustedError'
    this.customerId = customerId
  }
}

export class AgentBillError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentBillError'
  }
}

/** The cross-call budget for this task is spent — the job dies here. */
export class TaskCeilingExceededError extends Error {
  readonly taskRef: string
  readonly taskCeiling?: number
  readonly taskUsedUnits?: number
  readonly taskRemainingUnits?: number
  constructor(taskRef: string, taskCeiling?: number, taskUsedUnits?: number, taskRemainingUnits?: number) {
    super(
      `Task '${taskRef}' blocked: ${taskUsedUnits}/${taskCeiling} units used, ` +
      `${taskRemainingUnits} remaining is not enough for this call.`
    )
    this.name = 'TaskCeilingExceededError'
    this.taskRef = taskRef
    this.taskCeiling = taskCeiling
    this.taskUsedUnits = taskUsedUnits
    this.taskRemainingUnits = taskRemainingUnits
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UnitsResolver<TResult> = number | ((result: TResult) => number)

export interface MeterOptions<TArgs extends Record<string, unknown>, TResult> {
  /** Event type label (snake_case). Shown in dashboard. */
  event: string
  /** Fixed customer identifier. */
  customerId?: string
  /** Name of a key in the args object to read customer_id from. */
  customerIdFrom?: keyof TArgs & string
  /** Billable units per call. Pass a function to derive from the result. Default: 1 */
  units?: UnitsResolver<TResult>
  /** If true, check budget BEFORE running the function. Blocks immediately if exhausted. */
  preflight?: boolean
  /** Static metadata attached to every event (not billed). */
  metadata?: Record<string, unknown>
  /** Attribute events to a cross-call task budget (created via preflight()). */
  taskRef?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function apiKey(): string {
  const key = process.env.AGENTBILL_API_KEY ?? ''
  if (!key) {
    throw new AgentBillError(
      'AGENTBILL_API_KEY is not set. Get your key at agentbill.fly.dev/register.'
    )
  }
  return key
}

function resolveCustomerId<TArgs extends Record<string, unknown>>(
  options: Pick<MeterOptions<TArgs, unknown>, 'customerId' | 'customerIdFrom'>,
  args: TArgs
): string {
  if (options.customerId) return options.customerId

  if (options.customerIdFrom) {
    const value = args[options.customerIdFrom]
    if (value == null) {
      throw new AgentBillError(
        `customerIdFrom='${String(options.customerIdFrom)}' was not found in the args object. ` +
        `Available keys: ${Object.keys(args).join(', ')}`
      )
    }
    return String(value)
  }

  const envId = process.env.AGENTBILL_CUSTOMER_ID ?? ''
  if (envId) return envId

  throw new AgentBillError(
    'No customer_id resolved. Use one of:\n' +
    '  meter(fn, { customerId: "fixed_id" })\n' +
    '  meter(fn, { customerIdFrom: "argKeyName" })\n' +
    '  export AGENTBILL_CUSTOMER_ID=...'
  )
}

function resolveUnits<TResult>(units: UnitsResolver<TResult>, result: TResult): number {
  if (typeof units === 'function') {
    const resolved = units(result)
    if (!Number.isInteger(resolved) || resolved < 1) {
      throw new AgentBillError(`units function must return a positive integer, got ${resolved}`)
    }
    return resolved
  }
  return units
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const { fetch } = await import('undici')
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
      ...(init.headers as Record<string, string> ?? {}),
    },
  } as Parameters<typeof fetch>[1])
  return res as unknown as Response
}

async function budgetCheck(customerId: string): Promise<void> {
  const res = await apiFetch(`/budget?customer_id=${encodeURIComponent(customerId)}`, {
    method: 'GET',
  })
  if (!res.ok) {
    throw new AgentBillError(`AgentBill /budget returned ${res.status}`)
  }
  const data = await res.json() as { is_blocked?: boolean }
  if (data.is_blocked) {
    throw new BudgetExhaustedError(customerId)
  }
}

async function submitEvent(
  customerId: string,
  event: string,
  units: number,
  metadata?: Record<string, unknown>,
  taskRef?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    customer_id: customerId,
    event_type: event,
    units,
    idempotency_key: `${event}_${randomHex()}`,
  }
  if (metadata) body.metadata = metadata
  if (taskRef) body.task_ref = taskRef

  const res = await apiFetch('/events', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (res.status === 200) return

  if (res.status === 402) {
    const data = await res.json() as { message?: string }
    throw new BudgetExhaustedError(customerId, data.message)
  }

  const text = await res.text()
  throw new AgentBillError(`AgentBill returned ${res.status}: ${text.slice(0, 200)}`)
}

function randomHex(): string {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

// ---------------------------------------------------------------------------
// Public low-level API — preflight / record / getTask
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  /** Agent identifier — used for attribution. */
  agentId: string
  customerId?: string
  estimatedUnits?: number
  /** Per-request ceiling: block when estimatedUnits exceeds it. */
  ceiling?: number
  /** Cross-call job budget: many calls, one hard ceiling. */
  taskRef?: string
  /** Required on the first preflight of a new taskRef. */
  taskCeiling?: number
  /**
   * Makes a retried preflight safe. Without it a retry reserves a second time,
   * so the mechanism meant to prevent waste is the one consuming the budget.
   * Same key, same decision, one reservation.
   */
  idempotencyKey?: string
}

export interface PreflightResult {
  approved: boolean
  reason: string | null
  estimatedUnits: number | null
  remainingUnits: number | null
  taskRef?: string
  taskRemainingUnits?: number
  upgradeUrl?: string
  /**
   * Settle before this or the sweeper reclaims the reservation and the units
   * stop being held. ISO 8601, absent when nothing was reserved.
   */
  reservationExpiresAt?: string
}

/**
 * Check every budget BEFORE the call runs. Throws TaskCeilingExceededError /
 * BudgetExhaustedError on a blocked run so the expensive call never happens.
 */
export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  const body: Record<string, unknown> = { agent_id: options.agentId }
  if (options.customerId) body.customer_id = options.customerId
  if (options.estimatedUnits != null) body.estimated_units = options.estimatedUnits
  if (options.ceiling != null) body.ceiling = options.ceiling
  if (options.taskRef) body.task_ref = options.taskRef
  if (options.taskCeiling != null) body.task_ceiling = options.taskCeiling
  if (options.idempotencyKey) body.idempotency_key = options.idempotencyKey

  const res = await apiFetch('/preflight', { method: 'POST', body: JSON.stringify(body) })
  const data = await res.json() as Record<string, any>

  if (res.status === 422 && data.error === 'task_ceiling_required') {
    throw new AgentBillError(String(data.message ?? 'task_ceiling required for a new task_ref'))
  }
  if (res.status === 409) {
    // Never a block, and nothing was reserved: the original request holds the
    // key and its decision is one write away.
    throw new AgentBillError(String(data.message ?? 'preflight_in_progress, retry in a moment'))
  }
  if (!res.ok) {
    throw new AgentBillError(`AgentBill /preflight returned ${res.status}`)
  }

  if (!data.approved) {
    if (data.reason === 'task_ceiling_exceeded') {
      throw new TaskCeilingExceededError(
        data.task_ref ?? options.taskRef ?? '',
        data.task_ceiling,
        data.task_used_units,
        data.task_remaining_units
      )
    }
    if (data.reason === 'budget_exhausted') {
      throw new BudgetExhaustedError(options.customerId ?? 'default')
    }
    // free_tier_exceeded / plan_limit_exceeded / ceiling_exceeded fall through
    // as a non-approved result so callers can route to data.upgrade_url.
  }

  return {
    approved: Boolean(data.approved),
    reason: data.reason ?? null,
    estimatedUnits: data.estimated_units ?? null,
    remainingUnits: data.remaining_units ?? null,
    taskRef: data.task_ref,
    taskRemainingUnits: data.task_remaining_units,
    upgradeUrl: data.upgrade_url,
    reservationExpiresAt: data.reservation_expires_at,
  }
}

export interface RecordOptions {
  agentId: string
  units?: number
  customerId?: string
  /** false releases the preflight reservation without billing. */
  success?: boolean
  taskRef?: string
  metadata?: Record<string, unknown>
}

/** Record what actually happened. Idempotency key is generated per call. */
export async function record(options: RecordOptions): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    customer_id: options.customerId ?? 'default',
    event_type: options.agentId,
    units: options.units ?? 1,
    success: options.success ?? true,
    idempotency_key: `${options.agentId}_${randomHex()}`,
  }
  if (options.taskRef) body.task_ref = options.taskRef
  if (options.metadata) body.metadata = options.metadata

  const res = await apiFetch('/events', { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) {
    const text = await res.text()
    throw new AgentBillError(`AgentBill /events returned ${res.status}: ${text.slice(0, 200)}`)
  }
  return await res.json() as Record<string, unknown>
}

export interface TaskStatus {
  taskRef: string
  agentId: string
  ceilingUnits: number
  usedUnits: number
  reservedUnits: number
  remainingUnits: number
  exceeded: boolean
}

/** Live burn-down of one job's budget. */
export async function getTask(taskRef: string): Promise<TaskStatus> {
  const res = await apiFetch(`/tasks/${encodeURIComponent(taskRef)}`, { method: 'GET' })
  if (!res.ok) {
    throw new AgentBillError(`AgentBill /tasks returned ${res.status}`)
  }
  const data = await res.json() as Record<string, any>
  return {
    taskRef: data.task_ref,
    agentId: data.agent_id,
    ceilingUnits: data.ceiling_units,
    usedUnits: data.used_units,
    reservedUnits: data.reserved_units,
    remainingUnits: data.remaining_units,
    exceeded: Boolean(data.exceeded),
  }
}

// ---------------------------------------------------------------------------
// Public: meter()
// ---------------------------------------------------------------------------

/**
 * Wraps an async function with usage-based billing.
 *
 * The event is submitted AFTER the function succeeds. If the function throws,
 * no event is recorded and the customer is not billed.
 *
 * @example
 * // Basic — reads customer_id from args
 * const runAgent = meter(
 *   async ({ customerId, topic }: { customerId: string; topic: string }) => {
 *     const result = await callLLM(topic)
 *     return result
 *   },
 *   { event: 'research_run', customerIdFrom: 'customerId' }
 * )
 *
 * @example
 * // Pre-flight: block before LLM call if budget is exhausted
 * const runAgent = meter(fn, {
 *   event: 'research_run',
 *   customerIdFrom: 'customerId',
 *   preflight: true,
 * })
 *
 * @example
 * // Outcome-based: bill 0 units on failure
 * const runAgent = meter(fn, {
 *   event: 'ticket_resolved',
 *   customerIdFrom: 'customerId',
 *   units: (result) => result.resolved ? 5 : 0,
 * })
 */
export function meter<TArgs extends Record<string, unknown>, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  options: MeterOptions<TArgs, TResult>
): (args: TArgs) => Promise<TResult> {
  const {
    event,
    units = 1,
    preflight: doPreFlight = false,
    metadata,
    taskRef,
  } = options

  return async function metered(args: TArgs): Promise<TResult> {
    const customerId = resolveCustomerId(options, args)

    if (doPreFlight) {
      await budgetCheck(customerId)
    }

    const result = await fn(args)

    const actualUnits = resolveUnits(units as UnitsResolver<TResult>, result)

    // Skip recording if outcome-based billing resolved to 0
    if (actualUnits > 0) {
      await submitEvent(customerId, event, actualUnits, metadata, taskRef)
    }

    return result
  }
}
