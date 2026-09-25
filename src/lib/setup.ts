import { sql } from '../db/index.js'

// The setup guide (2026-09-26): the six things a new account does once, in
// order, each marked done by the product's own rows and never by a click.
// The founder, as a user, found the console "not clear at all" once the start
// screen was behind him; the guide is the path across every screen after it.
//
//   connect     a live API key, or a live MCP grant (oauth_grants)
//   first_call  a recorded call with a list price: a model, tokens and dollars
//   customers   a recorded call with a customer_id other than "default"
//   ceiling     a job with a ceiling (task_budgets)
//   refusal     one call refused (preflight_decisions, blocked)
//   office      the office was visited once (accounts.setup_office_seen_at)
//
// Hidden by its owner (accounts.setup_hidden_at) it stays hidden, and with
// every step done it is not drawn at all.

export const SETUP_STEPS = [
  { key: 'connect', title: 'Connect', view: 'start' },
  { key: 'first_call', title: 'Your first priced call', view: 'start' },
  { key: 'customers', title: 'Name your customers', view: 'customers' },
  { key: 'ceiling', title: 'Give a job a ceiling', view: 'tasks' },
  { key: 'refusal', title: 'See a refusal', view: 'refusals' },
  { key: 'office', title: 'Meet the office', view: 'office' },
] as const
export type SetupKey = (typeof SETUP_STEPS)[number]['key']
export type Setup = { done: Record<SetupKey, boolean>; hidden: boolean; count: number; next: SetupKey | null }

export async function loadSetup(accountId: string): Promise<Setup> {
  const [r] = await sql`
    SELECT
      (EXISTS (SELECT 1 FROM developer_api_keys WHERE account_id = ${accountId}
                 AND (revoked_at IS NULL OR revoked_at > now()) AND (expires_at IS NULL OR expires_at > now()))
       OR EXISTS (SELECT 1 FROM oauth_grants WHERE account_id = ${accountId} AND revoked_at IS NULL)) AS connect,
      EXISTS (SELECT 1 FROM events WHERE account_id = ${accountId} AND list_price_usd IS NOT NULL) AS first_call,
      EXISTS (SELECT 1 FROM events e JOIN customers c ON c.id = e.customer_id
              WHERE e.account_id = ${accountId} AND c.customer_ref <> 'default') AS customers,
      EXISTS (SELECT 1 FROM task_budgets WHERE account_id = ${accountId} AND ceiling_units > 0) AS ceiling,
      EXISTS (SELECT 1 FROM preflight_decisions WHERE account_id = ${accountId} AND blocked) AS refusal,
      (SELECT setup_office_seen_at IS NOT NULL FROM accounts WHERE id = ${accountId}) AS office,
      (SELECT setup_hidden_at IS NOT NULL FROM accounts WHERE id = ${accountId}) AS hidden
  `
  const done = {
    connect: r?.connect === true, first_call: r?.firstCall === true, customers: r?.customers === true,
    ceiling: r?.ceiling === true, refusal: r?.refusal === true, office: r?.office === true,
  }
  const count = Object.values(done).filter(Boolean).length
  const next = SETUP_STEPS.find((s) => !done[s.key])?.key ?? null
  return { done, hidden: r?.hidden === true, count, next }
}

/** The office step: the first visit marks it, once. */
export async function markOfficeSeen(accountId: string): Promise<void> {
  await sql`UPDATE accounts SET setup_office_seen_at = now() WHERE id = ${accountId} AND setup_office_seen_at IS NULL`
}

export async function hideSetup(accountId: string): Promise<void> {
  await sql`UPDATE accounts SET setup_hidden_at = now() WHERE id = ${accountId} AND setup_hidden_at IS NULL`
}
