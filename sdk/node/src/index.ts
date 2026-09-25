/**
 * agentbill: the Node.js SDK
 *
 * One spend ceiling per agent job, consulted before the call goes out.
 * Bound to a task_ref, not to a calendar month.
 *
 *   import { meter } from 'agentbill'
 *
 *   const runAgent = meter(
 *     async ({ customerId, topic }) => { ... },
 *     { event: 'research_run', customerIdFrom: 'customerId' }
 *   )
 *
 * Environment variables:
 *   AGENTBILL_API_KEY     Required. Your key from agentbill.dev/register.
 *   AGENTBILL_BASE_URL    Optional. Defaults to https://agentbill.dev
 *   AGENTBILL_CUSTOMER_ID Optional. Fallback customer_id when not passed per-call.
 */

const BASE_URL = process.env.AGENTBILL_BASE_URL ?? 'https://agentbill.dev'

// ---------------------------------------------------------------------------
// Public exceptions
// ---------------------------------------------------------------------------

/** That customer's balance is spent. Thrown by preflight() and meter(). A
 *  client made with wrap() returns a Refusal with reason 'budget_exhausted'
 *  instead. */
export class BudgetExhaustedError extends Error {
  readonly customerId: string
  /** The preflight answer as the server sent it, set when preflight() throws. */
  answer?: Record<string, unknown>
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

/** This single call asked for more than its own per-request ceiling. Thrown
 *  by preflight(); a client made with wrap() returns a Refusal with reason
 *  'ceiling_exceeded' instead. */
export class CeilingExceededError extends Error {
  readonly estimatedUnits?: number
  readonly ceiling?: number
  /** The preflight answer as the server sent it, set when preflight() throws. */
  answer?: Record<string, unknown>
  constructor(estimatedUnits?: number, ceiling?: number, message?: string) {
    super(message ?? `Refused (ceiling_exceeded): estimated ${estimatedUnits} units exceeds the per-request ceiling of ${ceiling}.`)
    this.name = 'CeilingExceededError'
    this.estimatedUnits = estimatedUnits
    this.ceiling = ceiling
  }
}

/** The cross-call ceiling for this task is spent: preflight refused this call before it ran.
 *  Nothing of yours was stopped; your code decides what the job does next.
 *  Thrown by preflight(). A client made with wrap() does not throw it: the
 *  measured call returns a Refusal with reason 'task_ceiling_exceeded'. */
export class TaskCeilingExceededError extends Error {
  readonly taskRef: string
  readonly taskCeiling?: number
  readonly taskUsedUnits?: number
  readonly taskRemainingUnits?: number
  /** The preflight answer as the server sent it, set when preflight() throws. */
  answer?: Record<string, unknown>
  constructor(taskRef: string, taskCeiling?: number, taskUsedUnits?: number, taskRemainingUnits?: number) {
    super(
      `Refused (task_ceiling_exceeded): task '${taskRef}' is at ${taskUsedUnits}/${taskCeiling} units and ` +
      `${taskRemainingUnits} remaining is not enough for this call.`
    )
    this.name = 'TaskCeilingExceededError'
    this.taskRef = taskRef
    this.taskCeiling = taskCeiling
    this.taskUsedUnits = taskUsedUnits
    this.taskRemainingUnits = taskRemainingUnits
  }
}

/**
 * AgentBill's own free tier is spent. preflight() never throws this: it returns
 * `approved: false, reason: 'free_tier_exceeded'` with `upgradeUrl`, so our
 * billing state cannot crash your agent. A client made with wrap() does not
 * throw it either: the measured call returns a Refusal with that reason and
 * upgradeUrl, and is not sent (onQuota: 'refuse', the default), because once
 * the quota is spent no ceiling can be checked. wrap(client, { onQuota:
 * 'send' }) sends the call unchecked instead. Kept for code that imports it.
 */
export class FreeTierExceededError extends Error {
  readonly upgradeUrl?: string
  constructor(upgradeUrl?: string, message?: string) {
    super(message ?? 'Free tier limit reached. Upgrade to continue.')
    this.name = 'FreeTierExceededError'
    this.upgradeUrl = upgradeUrl
  }
}

/** A paid plan's monthly quota is spent. preflight() returns it (approved:
 *  false, upgradeUrl), and a wrap() client returns a Refusal, as for
 *  FreeTierExceededError. Kept for code that imports it. */
export class PlanLimitExceededError extends Error {
  readonly upgradeUrl?: string
  constructor(upgradeUrl?: string, message?: string) {
    super(message ?? 'Monthly plan quota reached. Upgrade to continue.')
    this.name = 'PlanLimitExceededError'
    this.upgradeUrl = upgradeUrl
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
  /** If true, check budget BEFORE running the function. Throws BudgetExhaustedError immediately if the balance is spent. */
  preflight?: boolean
  /** Static metadata attached to every event (not counted). */
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
      'AGENTBILL_API_KEY is not set. Get your key at agentbill.dev/register.'
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
    // 0 is allowed and means "record nothing" (meter skips it below), which is
    // what the outcome-based example in meter's own doc comment does. Until
    // 0.5.0 this threw on 0, so that example crashed the call it wrapped; the
    // Python SDK has always accepted 0.
    if (!Number.isInteger(resolved) || resolved < 0) {
      throw new AgentBillError(`units function must return a non-negative integer, got ${resolved}`)
    }
    return resolved
  }
  return units
}

// Every request carries the API key, so it only goes over https, or over plain
// http to this machine (a local server in development). Checked when a request
// is made, not at import, so an app that loads the SDK and never calls it is
// not broken by a bad AGENTBILL_BASE_URL.
const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function checkedBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AgentBillError(`AGENTBILL_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (url.protocol === 'https:') return raw
  if (url.protocol === 'http:' && LOOPBACK_HTTP_HOSTS.has(url.hostname)) return raw
  throw new AgentBillError(
    `AGENTBILL_BASE_URL must be an https URL (plain http is accepted only for localhost, ` +
    `127.0.0.1 and [::1]). Refusing to send the API key to ${url.protocol}//${url.host}.`
  )
}

/** How long one request to the AgentBill API may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 10_000

function requestSignal(callerSignal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const base = checkedBaseUrl(BASE_URL)
  const { fetch } = await import('undici')
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: requestSignal(init.signal),
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
// Public low-level API: preflight / record / getTask
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  /** Agent identifier, used for attribution. */
  agentId: string
  customerId?: string
  estimatedUnits?: number
  /** Per-request ceiling: refuse when estimatedUnits exceeds it. */
  ceiling?: number
  /** Cross-call job budget: many calls, one hard ceiling. */
  taskRef?: string
  /** Opens a new taskRef with this ceiling. Required then, unless the job was
   *  opened first from the console or PUT /tasks/:task_ref/ceiling; not applied
   *  once the job exists. */
  taskCeiling?: number
  /**
   * Makes a retried preflight safe. Without it a retry reserves a second time,
   * so the mechanism meant to prevent waste is the one consuming the budget.
   * Same key, same decision, one reservation.
   */
  idempotencyKey?: string
  /**
   * What the job's numbers count: 'unit' (yours, the default) or 'token'.
   * Needs taskRef. Read when this call opens the job and checked on a job
   * that exists: a different unit is a 422, thrown as AgentBillError.
   */
  unit?: 'unit' | 'token'
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
  /**
   * The handle of the reservation this preflight made. Pass it to record()
   * as reservationId (or call result.record(), which does) and the record
   * settles THIS reservation whole: units is what was spent, and the unused
   * rest is released at once instead of being held until it expires. Absent
   * when nothing was reserved, or against a server that predates it.
   */
  reservationId?: string
}

/** What result.record() takes: the call's own facts. The agent, customer,
 *  task and reservation come from the preflight that made the result. */
export interface SettleOptions {
  /** What the call actually used. 0 is allowed. Default: 1 */
  units?: number
  /** false releases the reservation without billing. */
  success?: boolean
  idempotencyKey?: string
  metadata?: Record<string, unknown>
  /** The provider reported no usage. Charged at least this preflight's
   *  reservation, never read as 0. */
  usageMissing?: boolean
}

/** What preflight() returns: the result, plus record() bound to this call. */
export interface Preflight extends PreflightResult {
  /**
   * Record what this call used against this preflight's own reservation.
   * Not an enumerable property: JSON.stringify, spread and deep equality see
   * the same data they always did.
   */
  record(options?: SettleOptions): Promise<Record<string, unknown>>
  /** The preflight answer as the server sent it. Not enumerable, for the
   *  same reason as record. wrap() reads it to build a Refusal. */
  readonly answer: Record<string, unknown>
}

/**
 * Check every budget BEFORE the call runs, so the expensive call never happens.
 *
 * Throws when YOUR spend rule refused the call: CeilingExceededError,
 * TaskCeilingExceededError, BudgetExhaustedError.
 *
 * Returns `approved: false` with `upgradeUrl` set when AGENTBILL'S OWN BILLING
 * refused it (`free_tier_exceeded`, `plan_limit_exceeded`), because our quota
 * must never crash your agent.
 */
export async function preflight(options: PreflightOptions): Promise<Preflight> {
  const body: Record<string, unknown> = { agent_id: options.agentId }
  if (options.customerId) body.customer_id = options.customerId
  if (options.estimatedUnits != null) body.estimated_units = options.estimatedUnits
  if (options.ceiling != null) body.ceiling = options.ceiling
  if (options.taskRef) body.task_ref = options.taskRef
  if (options.taskCeiling != null) body.task_ceiling = options.taskCeiling
  if (options.idempotencyKey) body.idempotency_key = options.idempotencyKey
  if (options.unit) body.unit = options.unit

  const res = await apiFetch('/preflight', { method: 'POST', body: JSON.stringify(body) })
  const data = await res.json() as Record<string, any>

  if (res.status === 422 && data.error === 'task_ceiling_required') {
    throw new AgentBillError(String(data.message ?? 'task_ceiling required for a new task_ref'))
  }
  if (res.status === 409) {
    // Never a refusal, and nothing was reserved: the original request holds the
    // key and its decision is one write away.
    throw new AgentBillError(String(data.message ?? 'preflight_in_progress, retry in a moment'))
  }
  if (!res.ok) {
    // The server's own sentence when it sent one: a 422 task_unit_mismatch
    // says which unit the job is counted in and what to send instead.
    const why = typeof data?.message === 'string' ? `: ${data.error ?? ''} ${data.message}`.replace(/: +/, ': ') : ''
    throw new AgentBillError(`AgentBill /preflight returned ${res.status}${why}`)
  }

  if (!data.approved) {
    // Each thrown error carries the answer as the server sent it (.answer),
    // which is how wrap() turns the same refusal into a returned Refusal.
    let refused: TaskCeilingExceededError | BudgetExhaustedError | CeilingExceededError | null = null
    if (data.reason === 'task_ceiling_exceeded') {
      refused = new TaskCeilingExceededError(
        data.task_ref ?? options.taskRef ?? '',
        data.task_ceiling,
        data.task_used_units,
        data.task_remaining_units
      )
    } else if (data.reason === 'budget_exhausted') {
      refused = new BudgetExhaustedError(options.customerId ?? 'default')
    } else if (data.reason === 'ceiling_exceeded') {
      refused = new CeilingExceededError(data.estimated_units, options.ceiling)
    }
    if (refused) {
      refused.answer = data
      throw refused
    }
    // free_tier_exceeded and plan_limit_exceeded deliberately do NOT throw.
    //
    // One rule, and it is the same in both SDKs as of 0.4.0 / 0.6.0: throw
    // when YOUR spend rule refused the call, return a result when AGENTBILL'S
    // OWN BILLING did. Those two mean our quota ran out, not that your budget
    // did. Throwing would let an AgentBill billing state crash your production
    // agent, making us a single point of failure in your critical path, which
    // is the opposite of what "no proxy in your request path" is meant to buy
    // you. They come back as approved:false with upgradeUrl set, so you can
    // degrade, alert, or send a human to upgrade, and keep running.
  }

  const result: PreflightResult = {
    approved: Boolean(data.approved),
    reason: data.reason ?? null,
    estimatedUnits: data.estimated_units ?? null,
    remainingUnits: data.remaining_units ?? null,
    taskRef: data.task_ref,
    taskRemainingUnits: data.task_remaining_units,
    upgradeUrl: data.upgrade_url,
    reservationExpiresAt: data.reservation_expires_at,
    reservationId: data.reservation_id,
  }
  Object.defineProperty(result, 'record', {
    enumerable: false,
    value: (settle: SettleOptions = {}) => record({
      ...settle,
      agentId: options.agentId,
      customerId: options.customerId,
      taskRef: options.taskRef,
      reservationId: result.reservationId,
    }),
  })
  Object.defineProperty(result, 'answer', { enumerable: false, value: data })
  return result as Preflight
}

export interface RecordOptions {
  agentId: string
  /** What the call used. 0 is allowed: a call that cost nothing records 0. Default: 1 */
  units?: number
  customerId?: string
  /** false releases the preflight reservation without billing. */
  success?: boolean
  taskRef?: string
  metadata?: Record<string, unknown>
  /**
   * Same key, one event: a retried record is ignored as a duplicate. When
   * absent a fresh random key is sent, which is what every earlier version did.
   */
  idempotencyKey?: string
  /**
   * PreflightResult.reservationId. Settles that reservation whole; without it
   * the record closes the oldest reservations of this customer and taskRef by
   * `units` only, as before.
   */
  reservationId?: string
  /**
   * The provider reported no usage for this call. Not read as 0: the server
   * charges at least the reservation the record settles (the one
   * reservationId names or, without it, the oldest open one of this customer
   * and taskRef; with none open, units as sent) and counts the call on the job.
   */
  usageMissing?: boolean
}

/** Record what actually happened. */
export async function record(options: RecordOptions): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    customer_id: options.customerId ?? 'default',
    event_type: options.agentId,
    units: options.units ?? 1,
    success: options.success ?? true,
    idempotency_key: options.idempotencyKey ?? `${options.agentId}_${randomHex()}`,
  }
  if (options.taskRef) body.task_ref = options.taskRef
  if (options.metadata) body.metadata = options.metadata
  if (options.reservationId) body.reservation_id = options.reservationId
  if (options.usageMissing) body.usage_missing = true

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
  /** What the numbers count: 'unit' (yours) or 'token'. getTask always sets it. */
  unit?: 'unit' | 'token'
  /** Calls recorded with usageMissing, charged at least the reservation they
   *  settled (units as sent when none was open). getTask always sets it. */
  usageMissingCalls?: number
  /** The job's recorded calls by model and by step, with tokens and an
   *  estimate at public list price (list price, your invoice may differ), as
   *  GET /tasks/:task_ref returns it, snake_case keys included. Absent from a
   *  server that predates it. */
  breakdown?: Record<string, unknown>
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
    unit: data.unit === 'token' ? 'token' : 'unit',
    usageMissingCalls: typeof data.usage_missing_calls === 'number' ? data.usage_missing_calls : 0,
    ...(data.breakdown && typeof data.breakdown === 'object' ? { breakdown: data.breakdown } : {}),
  }
}

// ---------------------------------------------------------------------------
// Public: meter()
// ---------------------------------------------------------------------------

/**
 * Wraps an async function so its usage is recorded in units you define.
 *
 * The event is submitted AFTER the function succeeds. If the function throws,
 * no event is recorded and nothing is drawn from that customer's balance.
 *
 * @example
 * // Basic: reads customer_id from args
 * const runAgent = meter(
 *   async ({ customerId, topic }: { customerId: string; topic: string }) => {
 *     const result = await callLLM(topic)
 *     return result
 *   },
 *   { event: 'research_run', customerIdFrom: 'customerId' }
 * )
 *
 * @example
 * // Pre-flight: refuse before the LLM call if the balance is spent
 * const runAgent = meter(fn, {
 *   event: 'research_run',
 *   customerIdFrom: 'customerId',
 *   preflight: true,
 * })
 *
 * @example
 * // Outcome-based: record 0 units on failure
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

    // Skip recording if the outcome-based unit count resolved to 0
    if (actualUnits > 0) {
      await submitEvent(customerId, event, actualUnits, metadata, taskRef)
    }

    return result
  }
}

// ---------------------------------------------------------------------------
// Public: wrap(), automatic metering for a model client. See ./wrap.ts.
// ---------------------------------------------------------------------------

export { wrap, DEFAULT_ESTIMATE, Refusal, isRefusal } from './wrap.js'
export type { WrapOptions, WrapProvider, Wrapped, Metered, RefusalReason } from './wrap.js'
