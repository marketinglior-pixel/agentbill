import { sql } from '../db/index.js'

// Shared "who is likely to pay" signals. Used by the /admin dashboard and the
// daily digest email. One query, one scoring function, one definition of hot.

export const FREE_TIER_LIMIT = 1_000

export type AccountSignals = {
  id: string
  email: string | null
  name: string | null
  plan: string
  useCase: string | null
  stack: string | null
  monthlyCalls: number
  createdAt: string
  customerCount: number
  taskCount: number
  lastActivityAt: string | null
  events7d: number
}

// Aggregates are subselects on purpose: joining events x customers x tasks
// fans out rows and inflates counts.
export async function getAccountsWithSignals(): Promise<AccountSignals[]> {
  const rows = await sql`
    SELECT
      a.id, a.email, a.name, a.plan, a.use_case, a.stack,
      a.monthly_calls, a.created_at,
      (SELECT COUNT(*)::int FROM customers c WHERE c.account_id = a.id)   AS customer_count,
      (SELECT COUNT(*)::int FROM task_budgets t WHERE t.account_id = a.id) AS task_count,
      GREATEST(
        (SELECT MAX(e.created_at) FROM events e       WHERE e.account_id = a.id),
        (SELECT MAX(t.updated_at) FROM task_budgets t WHERE t.account_id = a.id)
      ) AS last_activity_at,
      (SELECT COUNT(*)::int FROM events e
        WHERE e.account_id = a.id AND e.created_at > now() - interval '7 days') AS events_7d
    FROM accounts a
    ORDER BY a.created_at DESC
  `
  return rows as unknown as AccountSignals[]
}

// 0-120. Weights favor the signals that historically precede payment:
// depth of usage, hitting the paywall, recency, and using task ceilings
// (the feature the paid tiers are priced on).
export function conversionScore(a: AccountSignals): number {
  let s = 0
  const calls = a.monthlyCalls ?? 0
  s += Math.min(40, Math.round((calls / FREE_TIER_LIMIT) * 40))
  if (calls >= FREE_TIER_LIMIT) s += 25 // saw the paywall
  const last = a.lastActivityAt ? Date.now() - new Date(a.lastActivityAt).getTime() : Infinity
  if (last < 48 * 3_600_000) s += 20
  else if (last < 7 * 24 * 3_600_000) s += 10
  if ((a.taskCount ?? 0) > 0) s += 15
  if ((a.customerCount ?? 0) > 1) s += 10
  if (a.useCase === 'ai_saas' || a.useCase === 'agent_platform') s += 10
  return s
}

export function isHot(a: AccountSignals): boolean {
  return a.plan === 'free' && conversionScore(a) >= 50
}
