// How the harness plants and finds an API key row, 2026-09-25 (security batch B).
//
// Since migration 026 the server looks keys up by key_hash only. A fixture
// that writes just api_key still works while 026's fill trigger exists, and
// that is exactly the rollout-window case the [keyhash] gates test on purpose.
// Everywhere else the harness writes the row the way the build does
// (src/lib/api-keys.ts): hash, prefix and last four, plus api_key for as long
// as the column exists, which after 027 its scrub trigger turns into NULL. So
// the same fixture is valid before and after 027, and a gate that passes in
// the second pass (APPLY_LATER=1) passes without any plaintext in the table.
import { createHash } from 'node:crypto'

export const keyHash = (key) => createHash('sha256').update(String(key), 'utf8').digest('hex')

/** Insert a key row. Extra columns (revoked_at, expires_at) as a fragment of
 *  the caller's own `sql`, so their clock stays the database's. */
export async function insertKeyRow(sql, accountId, key, label, { revokedAt = null, expiresAt = null, ifAbsent = false } = {}) {
  await sql`
    INSERT INTO developer_api_keys (account_id, api_key, key_hash, key_prefix, key_last4, label, revoked_at, expires_at)
    VALUES (${accountId}, ${key}, ${keyHash(key)}, ${key.slice(0, 8)}, ${key.slice(-4)}, ${label}, ${revokedAt}, ${expiresAt})
    ${ifAbsent ? sql`ON CONFLICT DO NOTHING` : sql``}
  `
}

/** The row for a key, by the hash, as the server finds it. */
export const keyRow = async (sql, key) => (await sql`SELECT * FROM developer_api_keys WHERE key_hash = ${keyHash(key)}`)[0]
