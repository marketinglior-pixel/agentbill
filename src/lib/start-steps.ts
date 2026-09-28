import { sql } from '../db/index.js'
import { VIAS } from '../ui/steps.js'

// Where a new account's setup stops, per step (2026-09-28, migration 038).
//
// Six external accounts had made a key and none had ever used it, and the
// server could not say where each one stopped. Every step here is either a
// page the server renders (the start screen, a card, a client named) or a
// Copy press the console's copy script reports with a beacon. The set is
// closed: a step outside it is refused, never stored, so the table can only
// ever hold these names. Nothing typed or copied is stored, only that it
// happened, how often, and when first and last.

/** The ids of the copy controls on the start screen and the key screen. */
export const COPY_IDS = [
  'sample-python', 'sample-node', 'sample-curl', 'mcp-prompt', 'cc-settings', 'cc-local',
  'key-display', 'key-export', 'key-claude-code',
] as const

export const START_STEPS: readonly string[] = [
  'start',
  ...VIAS.map((v) => `via:${v}`),
  'cc_client',
  ...COPY_IDS.map((id) => `copy:${id}`),
]

export const isStartStep = (v: unknown): v is string => typeof v === 'string' && START_STEPS.includes(v)

/** Count one step for an account. Never throws: a count must not break the page. */
export async function recordStep(accountId: string, step: string): Promise<void> {
  if (!isStartStep(step)) return
  try {
    await sql`
      INSERT INTO start_steps (account_id, step) VALUES (${accountId}, ${step})
      ON CONFLICT (account_id, step) DO UPDATE SET n = start_steps.n + 1, last_at = now()`
  } catch {
    // the table is additive; before 038 is applied this is a no-op
  }
}

export type FunnelRow = {
  account: string
  email: string
  created: string
  keyMade: string | null
  keyUsed: boolean
  called: boolean
  steps: Array<{ step: string; n: number; first: string }>
}

/** One row per account created in the window, oldest first, with the steps it reached. */
export async function loadStartFunnel(days = 30): Promise<FunnelRow[]> {
  try {
    const rows = await sql`
      SELECT a.id, lower(coalesce(a.email, u.email)) AS email, a.created_at,
             (SELECT min(k.created_at) FROM developer_api_keys k WHERE k.account_id = a.id) AS key_made,
             EXISTS (SELECT 1 FROM developer_api_keys k WHERE k.account_id = a.id AND k.last_seen_ip IS NOT NULL) AS key_used,
             EXISTS (SELECT 1 FROM events e WHERE e.account_id = a.id) AS called,
             coalesce((SELECT json_agg(json_build_object('step', s.step, 'n', s.n, 'first', s.first_at) ORDER BY s.first_at)
                       FROM start_steps s WHERE s.account_id = a.id), '[]'::json) AS steps
      FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.created_at > now() - (${days}::int * interval '1 day')
      ORDER BY a.created_at ASC`
    return rows.map((r) => ({
      account: String(r.id), email: String(r.email ?? ''), created: new Date(r.createdAt).toISOString(),
      keyMade: r.keyMade ? new Date(r.keyMade).toISOString() : null, keyUsed: !!r.keyUsed, called: !!r.called,
      steps: (Array.isArray(r.steps) ? r.steps : []).map((s: { step: string; n: number; first: string }) =>
        ({ step: String(s.step), n: Number(s.n), first: new Date(s.first).toISOString() })),
    }))
  } catch {
    return []
  }
}
