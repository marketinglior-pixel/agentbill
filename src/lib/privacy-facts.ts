import { sql } from '../db/index.js'

// The facts /privacy states that are properties of code, kept here so the page
// renders them and the harness checks them against the code (security batch C,
// S22, 2026-09-25). A sentence on the page that is not in this file or in
// src/lib/retention.ts is one the [privacy] gates cannot see, so keep it that way.

/**
 * What wrap() (sdk/python/agentbill/wrap.py, sdk/node/src/wrap.ts) sends to
 * AgentBill, field by field. The [privacy] gate runs both SDKs' real wrap()
 * against a recording stand-in for AgentBill and fails on any field sent that
 * is not listed here, and on any planted prompt, answer or provider key that
 * reaches the wire.
 */
export const WRAP_SENDS = {
  preflight: ['agent_id', 'customer_id', 'task_ref', 'task_ceiling', 'task_ceiling_usd', 'estimated_units', 'unit'],
  record: ['customer_id', 'event_type', 'idempotency_key', 'units', 'success', 'task_ref', 'reservation_id', 'usage_missing', 'metadata'],
  metadata: ['provider', 'model', 'requested_model', 'tokens', 'service_tier', 'step', 'stream', 'duration_ms'],
} as const

/** What wrap() never sends. Each is checked by planting it and reading the wire. */
export const WRAP_NEVER = [
  'your prompts or messages',
  "the model's answer",
  'your provider API key',
  'the headers of your provider request',
] as const

let plaintextCache: { at: number; value: boolean } | null = null

/**
 * Whether API keys are still stored in plain text beside their hash.
 * Migration 026 added the hash and kept the plaintext column filled;
 * migration 027 (held back, src/db/migrations-later) empties it and installs
 * the trigger developer_api_keys_scrub_plaintext, which keeps it empty. So the
 * trigger's presence is the answer, read without touching the key column
 * (the [keyhash plain] gate allows no read of it). Read at most every ten
 * minutes, and "yes" whenever it cannot tell.
 */
export async function plaintextKeysStored(): Promise<boolean> {
  if (plaintextCache && Date.now() - plaintextCache.at < 10 * 60_000) return plaintextCache.value
  let value = true
  try {
    const [row] = await sql`
      SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'developer_api_keys_scrub_plaintext' AND NOT tgisinternal) AS scrubbed`
    value = !row?.scrubbed
  } catch { value = true }
  plaintextCache = { at: Date.now(), value }
  return value
}
