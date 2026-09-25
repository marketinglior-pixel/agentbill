import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { plain } from '../lib/ids.js'
import { readPage } from '../lib/page.js'
import { hashKey, insertKey, maskKey, parseMasked, rotationGraceMinutes, MAX_GRACE_MINUTES } from '../lib/api-keys.js'
import { KEY_SHAPE } from '../middleware/auth.js'
import { ORIGIN } from '../ui/site.js'

// Read at boot, so a bad KEY_ROTATION_GRACE_MINUTES stops the server instead
// of the first rotation.
const DEFAULT_GRACE_MINUTES = rotationGraceMinutes()

function keyStatus(k: { revokedAt: Date | null; expiresAt: Date | null }): string {
  const now = new Date()
  if (k.revokedAt && k.revokedAt > now) return 'rotating'   // grace period
  if (k.revokedAt) return 'revoked'
  if (k.expiresAt && k.expiresAt <= now) return 'expired'
  if (k.expiresAt) {
    const hoursLeft = (k.expiresAt.getTime() - now.getTime()) / 3_600_000
    if (hoursLeft < 24) return 'expiring_soon'
  }
  return 'active'
}

const GenerateBody = z.object({
  label: plain(z.string().min(1).max(64)).optional(),
  expires_in_days: z.number().int().positive().max(3650).optional(),
})

const RotateBody = z.object({
  // 0 revokes the old key in the same statement: "rotate now, no grace".
  grace_minutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const RevokeBody = z.object({
  // The id GET /keys returns: exactly one key.
  key_id: z.string().regex(UUID_RE, 'key_id is the id GET /keys returns').optional(),
  // Since 2026-09-25 the database keeps only a hash and two display parts of a
  // key, so a prefix can be matched only as far as it is stored. Three forms:
  //   agb_1234            the 8 characters GET /keys and the console show
  //                       first; can match more than one key (the count says)
  //   agb_1234…abcd       the display form, prefix and last four (or ...)
  //   the whole key       matched by its hash
  // 8, not 4, for the old reason: every key begins with "agb_", so a
  // 4-character prefix was the one value that matched every key on the account.
  key_prefix: plain(z.string().min(8).max(64)).optional(),
}).refine((b) => !(b.key_id && b.key_prefix), { message: 'Pass key_id or key_prefix, not both.' })

const RevokeAllBody = z.object({
  // Deliberate: this ends every key the account has, including the one
  // making the call, and every console session opened with a key.
  confirm: z.literal(true, { errorMap: () => ({ message: 'Pass {"confirm": true}: this revokes every key on the account, including the one you are calling with.' }) }),
})

/** The WHERE clause a key_prefix names, or null for a form we cannot match. */
function prefixMatch(v: string) {
  if (KEY_SHAPE.test(v)) return sql`key_hash = ${hashKey(v)}`
  const m = parseMasked(v)
  if (m) return sql`key_prefix = ${m.prefix} AND key_last4 = ${m.last4}`
  if (v.length === 8) return sql`key_prefix = ${v}`
  return null
}

const keyView = (k: Record<string, any>, currentId: string | undefined) => ({
  id: k.id as string,
  key: maskKey(k.keyPrefix as string, k.keyLast4 as string),
  key_prefix: k.keyPrefix as string,
  key_last4: k.keyLast4 as string,
  label: k.label,
  created_at: k.createdAt,
  revoked_at: k.revokedAt ?? null,
  expires_at: k.expiresAt ?? null,
  status: keyStatus({ revokedAt: k.revokedAt, expiresAt: k.expiresAt }),
  current: k.id === currentId,
})

/**
 * Revoke every key on an account, now, grace windows included. Shared by the
 * API and the console (src/routes/app.ts). Refused, and nothing changed, for
 * an account nobody could get back into afterwards: no email to send /recover
 * to and no person who signs in. Every account made since sign-in has an owner
 * and every account made before it has an email, so this is a guard, not a
 * path anyone is expected to reach.
 */
export async function revokeAllKeys(accountId: string): Promise<{ ok: true; count: number; owner: boolean } | { ok: false }> {
  return sql.begin(async (tx) => {
    const [a] = await tx`SELECT email, owner_user_id FROM accounts WHERE id = ${accountId} FOR UPDATE`
    if (!a || (!a.email && !a.ownerUserId)) return { ok: false as const }
    const rows = await tx`
      UPDATE developer_api_keys SET revoked_at = NOW()
      WHERE account_id = ${accountId} AND (revoked_at IS NULL OR revoked_at > NOW())
      RETURNING id
    `
    return { ok: true as const, count: rows.length, owner: Boolean(a.ownerUserId) }
  })
}

export async function keysRoute(app: FastifyInstance) {
  // List the keys of the authenticated account, oldest first.
  //
  // Paged since 2026-09-25 (src/lib/page.ts): at most `limit` keys (default
  // 200, max 500). next_cursor is null on the last page.
  //
  // NEVER key material, since 2026-09-25 (security batch B). Each key is its
  // id, the display form agb_1234…abcd and its two parts; the api_key field
  // this used to carry, for every key including revoked ones, is gone. A key
  // is shown once, in the response that creates it.
  app.get('/keys', async (request, reply) => {
    const accountId = request.accountId
    const r = readPage(request.query)
    if (!r.ok) return reply.code(422).send({ error: 'validation_error', message: r.message })
    const { limit, cursor } = r.page

    const keys = await sql`
      SELECT id, key_prefix, key_last4, label, created_at, revoked_at, expires_at
      FROM developer_api_keys
      WHERE account_id = ${accountId}
        ${cursor ? sql`AND (created_at, id) > (SELECT created_at, id FROM developer_api_keys WHERE id = ${cursor} AND account_id = ${accountId})` : sql``}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit + 1}
    `
    const more = keys.length > limit
    const page = keys.slice(0, limit)

    return reply.send({
      keys: page.map((k) => keyView(k, request.apiKeyId)),
      next_cursor: more ? (page[page.length - 1]!.id as string) : null,
    })
  })

  // Generate a new key with optional label and expiry.
  //
  // A key never outlives the key that minted it (S3, 2026-09-25): until then a
  // key with expires_in_days: 1 could mint one that never expired, and so
  // turn a one-day credential into a permanent one. The new key's expiry is
  // the earliest of what was asked for, the calling key's own expiry, and the
  // end of the calling key's rotation grace. Accounts have no expiry of their
  // own, so the calling key is the whole bound.
  app.post('/keys/generate', async (request, reply) => {
    const parse = GenerateBody.safeParse(request.body ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const accountId = request.accountId
    const { label, expires_in_days } = parse.data

    const asked = expires_in_days ? new Date(Date.now() + expires_in_days * 86_400_000) : null
    const parent = request.apiKeyOutlivesAt ?? null
    const clamped = parent !== null && (asked === null || parent < asked)
    const expiresAt = clamped ? parent : asked

    const minted = await insertKey(sql, { accountId, label: label ?? 'generated', expiresAt })

    return reply.send({
      id: minted.id,
      api_key: minted.key,
      key: maskKey(minted.prefix, minted.last4),
      label: label ?? 'generated',
      expires_at: minted.expiresAt,
      clamped_to_parent: clamped,
      message: clamped
        ? 'New key generated. Its expiry was brought forward to the key you called with: a key never outlives the key that made it. Store it securely, it will not be shown again.'
        : 'New key generated. Store it securely, it will not be shown again.',
    })
  })

  // Rotate the calling key: a new key now, the old one kept for a grace
  // window. The window is explicit: grace_minutes in the body (0 to 1440), or
  // KEY_ROTATION_GRACE_MINUTES on the server, 60 by default (src/lib/api-keys.ts
  // says why). 0 revokes the old key in the same transaction: rotate now, no
  // grace. The new key inherits the old key's expiry, so a rotation is not a
  // way around it either.
  app.post('/keys/rotate', async (request, reply) => {
    const parse = RotateBody.safeParse(request.body ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }
    const accountId = request.accountId
    const grace = parse.data.grace_minutes ?? DEFAULT_GRACE_MINUTES

    const out = await sql.begin(async (tx) => {
      // The DB clock sets the window, for the reason auth.ts reads it there.
      const [old] = await tx`
        UPDATE developer_api_keys
        SET revoked_at = NOW() + (${grace} * INTERVAL '1 minute')
        WHERE id = ${request.apiKeyId ?? null} AND account_id = ${accountId} AND revoked_at IS NULL
        RETURNING label, revoked_at, expires_at
      `
      if (!old) return null
      const minted = await insertKey(tx, { accountId, label: (old.label as string | null) ?? 'rotated', expiresAt: (old.expiresAt as Date | null) ?? null })
      return { old, minted }
    })

    if (!out) {
      return reply.code(400).send({ error: 'key_not_found', message: 'Key not found, already revoked, or already rotating.' })
    }

    return reply.send({
      id: out.minted.id,
      api_key: out.minted.key,
      key: maskKey(out.minted.prefix, out.minted.last4),
      expires_at: out.minted.expiresAt,
      grace_minutes: grace,
      old_key_expires: new Date(out.old.revokedAt as Date).toISOString(),
      message: grace === 0
        ? 'New key issued. The old key was revoked with it and no longer works.'
        : `New key issued. The old key keeps working for ${grace} minute${grace === 1 ? '' : 's'}, then stops. For a key that may have leaked, rotate with {"grace_minutes": 0} or revoke it.`,
    })
  })

  // Revoke a key: the calling key with no body, or another on the account by
  // key_id or key_prefix.
  app.post('/keys/revoke', async (request, reply) => {
    const parse = RevokeBody.safeParse(request.body ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const accountId = request.accountId
    const { key_id, key_prefix } = parse.data
    const match = key_id ? sql`id = ${key_id}`
      : key_prefix ? prefixMatch(key_prefix)
      : sql`id = ${request.apiKeyId ?? null}`
    if (!match) {
      return reply.code(422).send({
        error: 'validation_error',
        message: 'key_prefix is the 8 characters a key starts with (agb_1234), its display form (agb_1234…abcd), or the whole key. Keys are stored hashed, so a longer prefix cannot be matched. Or pass key_id from GET /keys.',
      })
    }

    // The predicate is "not revoked YET", not "revoked_at IS NULL".
    //
    // /keys/rotate parks a future timestamp in revoked_at, and auth.ts reads a
    // future revoked_at as a live grace window (auth.ts: revoked only when
    // revoked_at <= now). Matching on IS NULL therefore skipped every key that
    // was mid-rotation and answered "already revoked" about a key that was
    // still authenticating requests. The key you most urgently need to kill,
    // a compromised one you have just rotated away from, was the single key
    // this endpoint refused to kill. Pulling the timestamp back to NOW() both
    // revokes a live key and cuts a grace window short.
    //
    // Always scoped to the account, the calling key included, so no form of
    // key_prefix reaches another account's key.
    const result = await sql`
      UPDATE developer_api_keys
      SET revoked_at = NOW()
      WHERE account_id = ${accountId}
        AND ${match}
        AND (revoked_at IS NULL OR revoked_at > NOW())
      RETURNING revoked_at
    `

    if (result.length === 0) {
      // Say which of the two reasons it was. Answering "already revoked" about
      // a key that does not exist is misleading on a security path.
      const [existing] = await sql`
        SELECT revoked_at FROM developer_api_keys
        WHERE account_id = ${accountId} AND ${match}
        LIMIT 1
      `
      if (!existing) {
        return reply.code(400).send({
          error: 'key_not_found',
          message: 'No key on this account matches that.',
        })
      }
      return reply.code(400).send({
        error: 'already_revoked',
        message: 'That key was already revoked. It stopped working when it was revoked.',
      })
    }

    return reply.send({
      revoked: true,
      revoked_at: result[0]!.revokedAt,
      // A prefix can legitimately match more than one key. During an incident
      // the count is the thing you need to see.
      revoked_count: result.length,
      message: result.length > 1
        ? `${result.length} keys revoked immediately. Generate a new one with POST /keys/generate.`
        : 'Key revoked immediately. Generate a new one with POST /keys/generate.',
    })
  })

  // Every key on the account, now, and with them every console session opened
  // with a key (a key session is its key: src/routes/app.ts reads the key's
  // state on every request). No new key is minted here, on purpose: a caller
  // holding a stolen key must not be able to trade it for a fresh one. The
  // way back is the owner's, not the caller's: /recover mails the account's
  // address, and a person who signs in (Google, GitHub, an email link) makes a
  // new key from the console.
  app.post('/keys/revoke-all', async (request, reply) => {
    const parse = RevokeAllBody.safeParse(request.body ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', message: parse.error.issues[0]?.message ?? 'Pass {"confirm": true}.' })
    }
    const done = await revokeAllKeys(request.accountId)
    if (!done.ok) {
      return reply.code(409).send({
        error: 'no_recovery_path',
        message: 'Refused, and nothing was revoked: this account has no email address and no person who signs in, so with every key revoked nobody could get back in. Write to hello@agentbill.dev.',
      })
    }
    request.log.info({ accountId: request.accountId, count: done.count }, 'every key revoked from the API')
    return reply.send({
      revoked: true,
      revoked_count: done.count,
      recover_url: `${ORIGIN}/recover`,
      sign_in_url: done.owner ? `${ORIGIN}/login` : null,
      message: done.owner
        ? `${done.count} key${done.count === 1 ? '' : 's'} revoked, this one included. Sign in at ${ORIGIN}/login and make a new key from the console, or use ${ORIGIN}/recover.`
        : `${done.count} key${done.count === 1 ? '' : 's'} revoked, this one included. Get a new key at ${ORIGIN}/recover with the account's email address.`,
    })
  })
}
