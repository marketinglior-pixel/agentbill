/**
 * The two AgentBill calls this plugin makes, on the wire.
 *
 * Why this is not `import { preflight, record } from 'agentbill'`:
 * the published Node SDK reads its key and base URL from process.env at call
 * time. A Gateway plugin gets its config from OpenClaw, must not write into a
 * shared process environment, and is bundled by `openclaw plugins pack` without
 * runtime dependencies. So the wire contract lives here once more, kept
 * deliberately small. When the SDK takes an explicit client config this file
 * should collapse into it.
 *
 * The contract itself is `POST /preflight` and `POST /events`, documented at
 * https://agentbill.dev/docs. Field names below are the server's.
 */

export type PreflightRequest = {
  agentId: string
  taskRef: string
  taskCeiling: number
  estimatedUnits: number
  idempotencyKey: string
  customerId?: string
}

export type PreflightDecision = {
  approved: boolean
  reason: string | null
  taskRef?: string
  taskCeiling?: number
  taskUsedUnits?: number
  taskRemainingUnits?: number
  upgradeUrl?: string
  /** The handle of the reservation this preflight made. Absent when nothing
   *  was reserved, or when the server predates reservation_id. */
  reservationId?: string
}

export type RecordRequest = {
  agentId: string
  taskRef: string
  units: number
  idempotencyKey: string
  customerId?: string
  metadata?: Record<string, unknown>
  /** Settles that reservation whole, unused part released now. */
  reservationId?: string
  /** The host reported no usage for the call: charged at least the
   *  reservation the record settles, the named one or else the task_ref's
   *  oldest open one; with none open, the 0 sent is recorded and flagged. */
  usageMissing?: boolean
}

export class AgentBillUnreachable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentBillUnreachable'
  }
}

export type ClientOptions = {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export class AgentBillClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * Ask before the call runs. Refusals are a normal, successful answer here:
   * `approved: false` with a reason. Only transport failures and unexpected
   * statuses throw, and the caller decides what a failure means (failMode).
   */
  async preflight(req: PreflightRequest): Promise<PreflightDecision> {
    const body: Record<string, unknown> = {
      agent_id: req.agentId,
      task_ref: req.taskRef,
      task_ceiling: req.taskCeiling,
      estimated_units: req.estimatedUnits,
      idempotency_key: req.idempotencyKey,
    }
    if (req.customerId) body.customer_id = req.customerId

    const res = await this.post('/preflight', body)
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

    if (res.status === 409) {
      // The same idempotency key is being decided by another request right now.
      // Nothing was reserved. The caller treats this like unreachable.
      throw new AgentBillUnreachable('preflight_in_progress')
    }
    if (!res.ok && res.status !== 402) {
      throw new AgentBillUnreachable(`preflight returned ${res.status}`)
    }

    return {
      approved: Boolean(data.approved),
      reason: typeof data.reason === 'string' ? data.reason : null,
      taskRef: typeof data.task_ref === 'string' ? data.task_ref : undefined,
      taskCeiling: numberOrUndefined(data.task_ceiling),
      taskUsedUnits: numberOrUndefined(data.task_used_units),
      taskRemainingUnits: numberOrUndefined(data.task_remaining_units),
      upgradeUrl: typeof data.upgrade_url === 'string' ? data.upgrade_url : undefined,
      reservationId: typeof data.reservation_id === 'string' ? data.reservation_id : undefined,
    }
  }

  /**
   * Record what the call actually cost. With reservationId it settles the
   * reservation that call's preflight made, whole; without one it settles
   * the task_ref's oldest reservations by `units`, as 0.1.0 did. The server
   * dedupes on idempotency_key, so a retried record is one event, not two.
   */
  async record(req: RecordRequest): Promise<void> {
    // 0 units is only sent with a reservationId, or as usage_missing, which
    // Ceiling passes only once the server has returned a reservation_id. A
    // server that returned one accepts 0 (migration 015); a server that did
    // not is one that refuses 0 with a 422, and with nothing named and
    // nothing missing there is nothing a 0 could settle or say anyway.
    if (req.units < 1 && !req.reservationId && !req.usageMissing) return
    const body: Record<string, unknown> = {
      customer_id: req.customerId ?? 'default',
      event_type: req.agentId,
      units: Math.max(0, Math.round(req.units)),
      success: true,
      idempotency_key: req.idempotencyKey,
      task_ref: req.taskRef,
    }
    if (req.metadata) body.metadata = req.metadata
    if (req.reservationId) body.reservation_id = req.reservationId
    if (req.usageMissing) body.usage_missing = true
    const res = await this.post('/events', body)
    if (!res.ok) throw new AgentBillUnreachable(`events returned ${res.status}`)
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'agentbill-openclaw/0.2.0',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new AgentBillUnreachable(`${path}: ${msg}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
