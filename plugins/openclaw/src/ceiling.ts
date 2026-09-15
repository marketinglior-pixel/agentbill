/**
 * AgentBill for OpenClaw: one spend ceiling per session. The gate itself.
 *
 * index.ts is the OpenClaw entry and is the only file that imports the
 * plugin SDK at runtime; this file imports it as types only, so the tests
 * can drive it with a fake api and no Gateway installed.
 *
 * What the plugin does, hook by hook (names and kinds are OpenClaw's, from
 * docs/plugins/hooks/reference.md in openclaw 2026.9.4):
 *
 *   session_start      observe   a session gets a task_ref: <prefix><sessionKey>
 *   subagent_spawned   observe   the child session shares the parent's task_ref,
 *                                so a fan-out draws down one number
 *   before_agent_run   gate      preflight before the model turn; refused => the
 *                                run does not reach the model
 *   before_tool_call   gate      preflight before each tool call; refused =>
 *                                { block: true }
 *   llm_output         observe   record what the model call actually spent
 *   after_tool_call    observe   record the tool call (0 units by default in
 *                                tokens mode)
 *   session_end        observe   forget the session
 *
 * The ceiling is opened on the first preflight for a task_ref and is then the
 * server's. Raising or lowering it later is a console action (PUT
 * /tasks/:task_ref/ceiling); a later task_ceiling in preflight is not applied.
 *
 * Units are what the operator says they are. In tokens mode the plugin records
 * the usage total OpenClaw reports in llm_output; it measures no provider and
 * no tool itself.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { AgentBillClient, AgentBillUnreachable, type PreflightDecision } from './client.js'

export type Units = 'tokens' | 'calls'
export type FailMode = 'closed' | 'open'
export type CustomerFrom = 'none' | 'sender' | 'channel'

export type PluginConfig = {
  apiKey?: string
  baseUrl: string
  ceilingUnits: number
  units: Units
  estimateUnits: number
  toolCallUnits: number
  taskRefPrefix: string
  agentId: string
  customerFrom: CustomerFrom
  failMode: FailMode
  timeoutMs: number
}

const DEFAULTS: Omit<PluginConfig, 'apiKey' | 'estimateUnits' | 'toolCallUnits'> = {
  baseUrl: 'https://agentbill.dev',
  ceilingUnits: 500_000,
  units: 'tokens',
  taskRefPrefix: 'openclaw:',
  agentId: 'openclaw',
  customerFrom: 'none',
  failMode: 'closed',
  timeoutMs: 5_000,
}

/** Resolve config with the same defaults the manifest declares. Exported for tests. */
export function resolveConfig(raw: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const r = raw ?? {}
  const units: Units = r.units === 'calls' ? 'calls' : 'tokens'
  const num = (key: string, fallback: number): number => {
    const v = r[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  }
  const str = (key: string, fallback: string): string => (typeof r[key] === 'string' && (r[key] as string).length > 0 ? (r[key] as string) : fallback)
  const apiKey = str('apiKey', env.AGENTBILL_API_KEY ?? '')
  return {
    apiKey: apiKey || undefined,
    baseUrl: str('baseUrl', DEFAULTS.baseUrl),
    ceilingUnits: Math.max(1, Math.round(num('ceilingUnits', DEFAULTS.ceilingUnits))),
    units,
    estimateUnits: Math.round(num('estimateUnits', units === 'tokens' ? 2_000 : 1)),
    toolCallUnits: Math.round(num('toolCallUnits', units === 'tokens' ? 0 : 1)),
    taskRefPrefix: str('taskRefPrefix', DEFAULTS.taskRefPrefix),
    agentId: str('agentId', DEFAULTS.agentId),
    customerFrom: r.customerFrom === 'sender' || r.customerFrom === 'channel' ? r.customerFrom : 'none',
    failMode: r.failMode === 'open' ? 'open' : 'closed',
    timeoutMs: Math.min(14_000, Math.max(100, Math.round(num('timeoutMs', DEFAULTS.timeoutMs)))),
  }
}

type TaskState = {
  taskRef: string
  /** Running average of what a model call in this task actually cost. */
  avgUnits: number
  samples: number
  /** The billing refusal warning is said once per task, not once per call. */
  warnedBilling: boolean
}

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

/**
 * Everything the hooks share. Kept off the OpenClaw api object so it can be
 * driven by a fake api in tests.
 */
export class Ceiling {
  private readonly tasks = new Map<string, TaskState>()
  /** child sessionKey -> the sessionKey whose task_ref it draws from */
  private readonly parentOf = new Map<string, string>()
  private counter = 0

  constructor(
    private readonly cfg: PluginConfig,
    private readonly client: AgentBillClient,
    private readonly log: Logger,
  ) {}

  // ---- session bookkeeping -------------------------------------------------

  sessionStarted(sessionKey: string): TaskState {
    const root = this.rootOf(sessionKey)
    let t = this.tasks.get(root)
    if (!t) {
      t = { taskRef: `${this.cfg.taskRefPrefix}${root}`, avgUnits: this.cfg.estimateUnits, samples: 0, warnedBilling: false }
      this.tasks.set(root, t)
    }
    return t
  }

  subagentSpawned(childSessionKey: string, requesterSessionKey: string | undefined): void {
    if (!requesterSessionKey) return
    this.parentOf.set(childSessionKey, this.rootOf(requesterSessionKey))
  }

  sessionEnded(sessionKey: string): void {
    this.parentOf.delete(sessionKey)
    // A root is forgotten only when it ends itself; a child ending leaves the
    // parent's running average in place.
    if (!this.parentOf.has(sessionKey)) this.tasks.delete(sessionKey)
  }

  /** Follow child -> parent links to the session that owns the task_ref. */
  rootOf(sessionKey: string): string {
    let k = sessionKey
    for (let i = 0; i < 16; i++) {
      const p = this.parentOf.get(k)
      if (!p) return k
      k = p
    }
    return k
  }

  taskFor(sessionKey: string): TaskState {
    return this.sessionStarted(sessionKey)
  }

  // ---- the gate ------------------------------------------------------------

  /**
   * Consult the ceiling. Returns null when the call may run, or a human
   * sentence when it may not. Never throws: a transport failure is turned into
   * a decision by failMode.
   */
  async consult(sessionKey: string, idempotencyKey: string, customerId: string | undefined): Promise<string | null> {
    const t = this.taskFor(sessionKey)
    let d: PreflightDecision
    try {
      d = await this.client.preflight({
        agentId: this.cfg.agentId,
        taskRef: t.taskRef,
        taskCeiling: this.cfg.ceilingUnits,
        estimatedUnits: Math.max(0, Math.round(t.avgUnits)),
        idempotencyKey,
        customerId,
      })
    } catch (err) {
      const why = err instanceof AgentBillUnreachable ? err.message : String(err)
      if (this.cfg.failMode === 'open') {
        this.log.warn(`agentbill unreachable (${why}); failMode=open, letting the call run`)
        return null
      }
      return `AgentBill could not be reached (${why}), and this plugin is set to refuse rather than guess. Set failMode to "open" to let calls run while it is down.`
    }

    if (d.approved) return null

    // Our own billing refusing is not the operator's ceiling refusing. The SDK
    // rule since 0.4.0 / 0.6.0: never let an AgentBill quota state stop the
    // operator's agent. Let it run, say so once.
    if (d.reason === 'free_tier_exceeded' || d.reason === 'plan_limit_exceeded') {
      if (!t.warnedBilling) {
        t.warnedBilling = true
        this.log.warn(`agentbill ${d.reason}: the plan quota is spent, so the ceiling is not being enforced for ${t.taskRef}. ${d.upgradeUrl ?? ''}`.trim())
      }
      return null
    }

    const used = d.taskUsedUnits ?? '?'
    const ceiling = d.taskCeiling ?? this.cfg.ceilingUnits
    return `AgentBill refused (${d.reason ?? 'refused'}): ${t.taskRef} is at ${used}/${ceiling} ${this.cfg.units}. Raise the ceiling at ${this.cfg.baseUrl}/app or start a new session.`
  }

  // ---- settlement ----------------------------------------------------------

  async settleModelCall(sessionKey: string, usage: { total?: number; input?: number; output?: number } | undefined, runId: string | undefined, customerId: string | undefined): Promise<void> {
    const t = this.taskFor(sessionKey)
    const units = this.cfg.units === 'calls' ? 1 : usageUnits(usage)
    if (units > 0) {
      // Running average feeds the next estimate. Only real samples move it.
      t.avgUnits = t.samples === 0 ? units : (t.avgUnits * t.samples + units) / (t.samples + 1)
      t.samples += 1
    }
    await this.recordQuietly(t, units, `${runId ?? 'run'}:llm:${++this.counter}`, customerId, { kind: 'model_call' })
  }

  async settleToolCall(sessionKey: string, toolName: string, runId: string | undefined, toolCallId: string | undefined, customerId: string | undefined): Promise<void> {
    const t = this.taskFor(sessionKey)
    await this.recordQuietly(t, this.cfg.toolCallUnits, `${runId ?? 'run'}:tool:${toolCallId ?? ++this.counter}`, customerId, { kind: 'tool_call', tool: toolName })
  }

  private async recordQuietly(t: TaskState, units: number, key: string, customerId: string | undefined, metadata: Record<string, unknown>): Promise<void> {
    if (units < 1) return
    try {
      await this.client.record({ agentId: this.cfg.agentId, taskRef: t.taskRef, units, idempotencyKey: `${t.taskRef}:${key}`, customerId, metadata })
    } catch (err) {
      // A failed record leaves the reservation open until the server sweeps it.
      // The ceiling still holds; the console is briefly behind.
      this.log.warn(`agentbill record failed for ${t.taskRef}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function usageUnits(usage: { total?: number; input?: number; output?: number } | undefined): number {
  if (!usage) return 0
  if (typeof usage.total === 'number' && usage.total > 0) return Math.round(usage.total)
  const sum = (usage.input ?? 0) + (usage.output ?? 0)
  return sum > 0 ? Math.round(sum) : 0
}

/** Register the hooks on an OpenClaw plugin api. Exported so a test can drive it with a fake api. */
export function registerCeiling(api: Pick<OpenClawPluginApi, 'on' | 'logger' | 'pluginConfig'>, ceiling?: Ceiling): Ceiling {
  const cfg = resolveConfig(api.pluginConfig)
  const log: Logger = {
    info: (m) => api.logger.info(`[agentbill] ${m}`),
    warn: (m) => api.logger.warn(`[agentbill] ${m}`),
    error: (m) => api.logger.error(`[agentbill] ${m}`),
  }
  if (!cfg.apiKey) {
    // Without a key nothing can be consulted. Say it once, loudly, and refuse
    // to pretend: registering no gate is the honest state, not a silent pass.
    log.error('no apiKey in plugin config and AGENTBILL_API_KEY is unset; the ceiling is NOT enforced. Get a key at https://agentbill.dev/register')
    return ceiling ?? new Ceiling(cfg, new AgentBillClient({ baseUrl: cfg.baseUrl, apiKey: '', timeoutMs: cfg.timeoutMs }), log)
  }
  const c = ceiling ?? new Ceiling(cfg, new AgentBillClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs }), log)

  const customerOf = (senderId: string | undefined, channelId: string | undefined): string | undefined => {
    if (cfg.customerFrom === 'sender') return senderId
    if (cfg.customerFrom === 'channel') return channelId
    return undefined
  }

  api.on('session_start', (event, ctx) => {
    c.sessionStarted(event.sessionKey ?? ctx.sessionKey ?? event.sessionId)
  })

  api.on('subagent_spawned', (event, ctx) => {
    c.subagentSpawned(event.childSessionKey, ctx.requesterSessionKey)
  })

  api.on('session_end', (event, ctx) => {
    c.sessionEnded(event.sessionKey ?? ctx.sessionKey ?? event.sessionId)
  })

  api.on('before_agent_run', async (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.sessionId
    if (!key) return { outcome: 'pass' }
    const refusal = await c.consult(key, `${ctx.runId ?? 'run'}:agent_run`, customerOf(event.senderId ?? ctx.senderId, event.channelId ?? ctx.channelId))
    if (!refusal) return { outcome: 'pass' }
    return { outcome: 'block', reason: 'agentbill_ceiling', message: refusal, category: 'cost_limit' }
  })

  api.on('before_tool_call', async (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.sessionId
    if (!key) return
    const refusal = await c.consult(key, `${ctx.runId ?? event.runId ?? 'run'}:tool:${ctx.toolCallId ?? event.toolCallId ?? event.toolName}`, customerOf(ctx.requester?.senderId, ctx.channelId))
    if (!refusal) return
    return { block: true, blockReason: refusal }
  })

  api.on('llm_output', async (event, ctx) => {
    const key = ctx.sessionKey ?? event.sessionId
    await c.settleModelCall(key, event.usage, event.runId, customerOf(ctx.senderId, ctx.channelId))
  })

  api.on('after_tool_call', async (event, ctx) => {
    const key = ctx.sessionKey ?? ctx.sessionId
    if (!key) return
    await c.settleToolCall(key, event.toolName, ctx.runId ?? event.runId, ctx.toolCallId ?? event.toolCallId, customerOf(ctx.requester?.senderId, ctx.channelId))
  })

  log.info(`ceiling ${cfg.ceilingUnits} ${cfg.units} per session, failMode=${cfg.failMode}, base ${cfg.baseUrl}`)
  return c
}

