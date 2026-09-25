// API keys: how one is made, stored, found and shown (security batch B, S3,
// 2026-09-25).
//
// A key is `agb_` and 48 hex characters: 24 random bytes, 192 bits. The
// database keeps the SHA-256 of the whole string (key_hash, UNIQUE) and two
// display parts, key_prefix (`agb_` and the first 4 hex) and key_last4, and
// every lookup is by the hash. Migration 026 added the three and backfilled
// them.
//
// No pepper, on purpose. 192 random bits cannot be brute-forced from a hash
// with or without one, so a pepper would buy nothing against a copy of the
// table and would add one secret whose loss kills every key at once.
//
// Lookups are `WHERE key_hash = <hash>` on the unique index: the database
// compares hashes of a secret the caller sent, so nothing here compares the
// secret itself with a timing-dependent `===`.
//
// THE TRANSITION. Until migration 027 (src/db/migrations-later/, a separate,
// later step that needs its own approval), insertKey() also writes the
// plaintext into api_key. That is the one place in src/ that names the
// column, and it exists so a rollback to the previous release still finds
// every key minted after this one shipped: that release looks keys up by
// api_key. Nothing reads it. After 027 the column is scrubbed to NULL by a
// trigger and a CHECK holds it there, so the write is harmless; the release
// after 027 deletes this line, and 028 then drops the column.
import { createHash, randomBytes } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'

export type Db = Sql<any> | TransactionSql<any>

/** A new key: agb_ and 48 lowercase hex characters. Shown once, never stored. */
export const generateApiKey = (): string => 'agb_' + randomBytes(24).toString('hex')

/** What the database stores and looks up by: SHA-256 of the whole key, hex. */
export const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

/** `agb_` and the first 4 hex characters: the part every surface may show. */
export const keyPrefixOf = (key: string): string => key.slice(0, 8)
export const keyLast4Of = (key: string): string => key.slice(-4)

/** How every surface shows a key: agb_1234…abcd. */
export const maskKey = (prefix: string, last4: string): string => `${prefix}…${last4}`

/**
 * The display form a caller may hand back to name a key: `agb_1234…abcd`, or
 * the same with three dots, which is what a terminal that cannot paste an
 * ellipsis produces. Returns the two parts, or null.
 */
export function parseMasked(v: string): { prefix: string; last4: string } | null {
  const m = /^(agb_[0-9a-f]{4})(?:…|\.\.\.)([0-9a-f]{4})$/.exec(v)
  return m ? { prefix: m[1]!, last4: m[2]! } : null
}

/**
 * How long the old key keeps working after POST /keys/rotate when the caller
 * does not say. One hour, configurable with KEY_ROTATION_GRACE_MINUTES
 * (0 to 1440). It was 24 hours until 2026-09-25.
 *
 * Why an hour: rotation is for a planned change, and a planned change is a
 * deploy that swaps an environment variable across a few machines, which is
 * minutes, not a day. An hour covers a slow rollout and a retry. It also
 * bounds what a rotation leaves behind: a key rotated because somebody saw it
 * stays useful to them for an hour instead of a day. A key that has leaked
 * should not be rotated at all but revoked, or rotated with grace_minutes: 0,
 * which revokes it in the same statement.
 */
export const MAX_GRACE_MINUTES = 1440
export function rotationGraceMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KEY_ROTATION_GRACE_MINUTES
  if (raw === undefined || raw === '') return 60
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > MAX_GRACE_MINUTES) {
    throw new Error(`KEY_ROTATION_GRACE_MINUTES must be an integer from 0 to ${MAX_GRACE_MINUTES}, got ${JSON.stringify(raw)}`)
  }
  return n
}

export type MintedKey = { id: string; key: string; prefix: string; last4: string; expiresAt: Date | null }

/**
 * Mint a key for an account and store it. The one INSERT into
 * developer_api_keys in src/: every path that makes a key (the console's first
 * key, POST /keys/generate, /keys/rotate, /recover) comes through here, so the
 * hash and the display parts cannot be forgotten on one of them.
 *
 * `expiresAt` is written as given; the caller clamps it (a key minted by a key
 * never outlives it, see keys.ts).
 */
export async function insertKey(db: Db, a: { accountId: string; label: string; expiresAt?: Date | null }): Promise<MintedKey> {
  const key = generateApiKey()
  const prefix = keyPrefixOf(key), last4 = keyLast4Of(key)
  const [row] = await db`
    INSERT INTO developer_api_keys (account_id, key_hash, key_prefix, key_last4, label, expires_at, api_key)
    VALUES (${a.accountId}, ${hashKey(key)}, ${prefix}, ${last4}, ${a.label}, ${a.expiresAt ?? null},
            -- TRANSITION: plaintext for a rollback to the release before this one. Remove after 027.
            ${key})
    RETURNING id, expires_at
  `
  return { id: row!.id as string, key, prefix, last4, expiresAt: (row!.expiresAt as Date | null) ?? null }
}
