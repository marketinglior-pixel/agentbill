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
 *   AGENTBILL_API_KEY     Required. Your key from agentbill.dev/dashboard.
 *   AGENTBILL_BASE_URL    Optional. Defaults to https://api.agentbill.dev/v1
 *   AGENTBILL_CUSTOMER_ID Optional. Fallback customer_id when not passed per-call.
 */

const BASE_URL = process.env.AGENTBILL_BASE_URL ?? 'https://api.agentbill.dev/v1'

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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function apiKey(): string {
  const key = process.env.AGENTBILL_API_KEY ?? ''
  if (!key) {
    throw new AgentBillError(
      'AGENTBILL_API_KEY is not set. Get your key at agentbill.dev/dashboard.'
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

async function preflight(customerId: string): Promise<void> {
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
  metadata?: Record<string, unknown>
): Promise<void> {
  const body: Record<string, unknown> = {
    customer_id: customerId,
    event_type: event,
    units,
    idempotency_key: `${event}_${randomHex()}`,
  }
  if (metadata) body.metadata = metadata

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
  } = options

  return async function metered(args: TArgs): Promise<TResult> {
    const customerId = resolveCustomerId(options, args)

    if (doPreFlight) {
      await preflight(customerId)
    }

    const result = await fn(args)

    const actualUnits = resolveUnits(units as UnitsResolver<TResult>, result)

    // Skip recording if outcome-based billing resolved to 0
    if (actualUnits > 0) {
      await submitEvent(customerId, event, actualUnits, metadata)
    }

    return result
  }
}
