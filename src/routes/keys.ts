import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { randomBytes } from 'crypto'

function generateApiKey(): string {
  return 'agb_' + randomBytes(24).toString('hex')
}

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
  label: z.string().min(1).max(64).optional(),
  expires_in_days: z.number().int().positive().max(3650).optional(),
})

const RevokeBody = z.object({
  key_prefix: z.string().min(4).optional(),
})

export async function keysRoute(app: FastifyInstance) {
  // List all keys for the authenticated account
  app.get('/keys', async (request, reply) => {
    const accountId = (request as any).accountId

    const keys = await sql`
      SELECT api_key, label, created_at, revoked_at, expires_at
      FROM developer_api_keys
      WHERE account_id = ${accountId}
      ORDER BY created_at ASC
    `

    return reply.send({
      keys: keys.map(k => ({
        api_key: k.apiKey,
        label: k.label,
        created_at: k.createdAt,
        revoked_at: k.revokedAt ?? null,
        expires_at: k.expiresAt ?? null,
        status: keyStatus({ revokedAt: k.revokedAt, expiresAt: k.expiresAt }),
      })),
    })
  })

  // Generate a new key with optional label and expiry
  app.post('/keys/generate', async (request, reply) => {
    const parse = GenerateBody.safeParse(request.body ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const accountId = (request as any).accountId
    const { label, expires_in_days } = parse.data

    const newKey = generateApiKey()
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86_400_000)
      : null

    await sql`
      INSERT INTO developer_api_keys (account_id, api_key, label, expires_at)
      VALUES (${accountId}, ${newKey}, ${label ?? 'generated'}, ${expiresAt})
    `

    return reply.send({
      api_key: newKey,
      label: label ?? 'generated',
      expires_at: expiresAt,
      message: 'New key generated. Store it securely, it will not be shown again.',
    })
  })

  // Rotate the current key: new key issued, old key gets 24h grace period
  app.post('/keys/rotate', async (request, reply) => {
    const auth = request.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const accountId = (request as any).accountId

    const graceUntil = new Date(Date.now() + 24 * 3_600_000)

    const [old] = await sql`
      SELECT label FROM developer_api_keys
      WHERE api_key = ${token} AND revoked_at IS NULL
    `

    if (!old) {
      return reply.code(400).send({ error: 'key_not_found', message: 'Key not found or already revoked.' })
    }

    // Schedule old key revocation 24h from now
    await sql`
      UPDATE developer_api_keys
      SET revoked_at = ${graceUntil}
      WHERE api_key = ${token}
    `

    const newKey = generateApiKey()
    await sql`
      INSERT INTO developer_api_keys (account_id, api_key, label)
      VALUES (${accountId}, ${newKey}, ${old.label ?? 'rotated'})
    `

    return reply.send({
      api_key: newKey,
      old_key_expires: graceUntil.toISOString(),
      message: 'New key issued. Old key still works for 24 hours, then expires automatically.',
    })
  })

  // Revoke a key, current key if no body, or specific key by prefix
  app.post('/keys/revoke', async (request, reply) => {
    const parse = RevokeBody.safeParse(request.body ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const accountId = (request as any).accountId
    const auth = request.headers.authorization ?? ''
    const currentToken = auth.startsWith('Bearer ') ? auth.slice(7) : ''

    let result

    if (parse.data.key_prefix) {
      // Revoke a specific key belonging to this account by prefix
      result = await sql`
        UPDATE developer_api_keys
        SET revoked_at = NOW()
        WHERE account_id = ${accountId}
          AND api_key LIKE ${parse.data.key_prefix + '%'}
          AND revoked_at IS NULL
        RETURNING revoked_at, api_key
      `
    } else {
      // Revoke the key used in this request
      result = await sql`
        UPDATE developer_api_keys
        SET revoked_at = NOW()
        WHERE api_key = ${currentToken}
          AND revoked_at IS NULL
        RETURNING revoked_at, api_key
      `
    }

    if (result.length === 0) {
      return reply.code(400).send({
        error: 'already_revoked',
        message: 'Key not found or already revoked.',
      })
    }

    return reply.send({
      revoked: true,
      revoked_at: result[0].revokedAt,
      message: 'Key revoked immediately. Generate a new one with POST /keys/generate.',
    })
  })
}
