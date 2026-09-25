import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { sql } from '../db/index.js'
import { isId } from '../lib/ids.js'
import { forwardInbound, mailOwner, verifyInboundWebhook } from '../lib/mail.js'

// POST /webhooks/resend: mail to hello@agentbill.dev, forwarded to the owner.
//
// Resend receives for agentbill.dev (the MX record) and posts one
// email.received event per message, signed with Svix. This route verifies it,
// claims it once (migration 031), and forwards it with Reply-To set to the
// sender (src/lib/mail.ts, forwardInbound).
//
// Only hello@ is forwarded. The MX catches every address at the domain, and a
// catch-all forwarded to a phone is a spam pipe with our domain's name on it.
// Anything else is answered 200 and dropped, so Resend stops retrying it.

const SECRET = process.env.RESEND_INBOUND_WEBHOOK_SECRET ?? ''
const FORWARDED = new Set(['hello@agentbill.dev'])
const OWN_DOMAIN = 'agentbill.dev'

// INBOUND_PER_DAY = 100 and INBOUND_PER_SENDER_PER_DAY = 10, per UTC day, as
// ranks. hello@ has never received one mail (it bounced until this route), so
// there is no traffic to size against; 100 a day is far past what a contact
// address on a product with a few dozen accounts gets, and a full day at it is
// 0.7% of the 13,835 sends that took the domain's Gmail delivery from 66% to
// 17% in September. The per-sender term is what stops one sender spending the
// whole day's allowance and leaving a real report behind it. Past either, the
// mail is not lost: it stays in Resend, under Receiving, and the owner is told
// once a day that the ceiling was reached.
export const INBOUND_PER_DAY = 100
export const INBOUND_PER_SENDER_PER_DAY = 10

/** The bare lowercased address out of `Name <a@b>` or `a@b`. */
export const bareAddress = (s: unknown): string => {
  const v = String(s ?? '').trim()
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(v)
  return (m ? m[1] : v).toLowerCase()
}

export async function inboundMailRoute(app: FastifyInstance) {
  // The signature is over the exact bytes Resend sent, so this route keeps
  // them. Registered inside this plugin's scope: it changes one route's body
  // handling and no other (the same shape as /webhooks/polar).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    ;(request as unknown as { rawBody: string }).rawBody = body as string
    if (!body) return done(null, {})
    try {
      done(null, JSON.parse(body as string))
    } catch (err) {
      ;(err as { statusCode?: number }).statusCode = 400
      done(err as Error, undefined)
    }
  })

  app.post('/webhooks/resend', { config: { public: true } }, async (request, reply) => {
    if (!SECRET) {
      request.log.error('RESEND_INBOUND_WEBHOOK_SECRET is not set, refusing a webhook this server cannot verify')
      return reply.code(503).send({ error: 'webhook_not_configured' })
    }
    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? ''
    const h = request.headers
    const one = (v: unknown) => (typeof v === 'string' ? v : '')
    const hdr = {
      id: one(h['svix-id']) || one(h['webhook-id']),
      timestamp: one(h['svix-timestamp']) || one(h['webhook-timestamp']),
      signature: one(h['svix-signature']) || one(h['webhook-signature']),
    }
    const event = verifyInboundWebhook(rawBody, hdr, SECRET) as
      | { type?: string; data?: { email_id?: unknown; from?: unknown; to?: unknown; cc?: unknown } }
      | null
    if (!event) {
      request.log.warn({ hasSignature: Boolean(hdr.signature), bodyBytes: rawBody.length }, 'Resend webhook rejected: did not verify')
      return reply.code(401).send({ error: 'invalid_signature' })
    }
    if (event.type !== 'email.received') {
      request.log.info({ eventType: event.type }, 'Resend webhook: not an email.received event, ignored')
      return reply.send({ received: true })
    }

    const d = event.data ?? {}
    const emailId = typeof d.email_id === 'string' && isId(d.email_id, 128) ? d.email_id : ''
    const webhookId = isId(hdr.id, 256) ? hdr.id : ''
    const list = (v: unknown) => (Array.isArray(v) ? v.map(bareAddress) : [])
    const recipients = [...list(d.to), ...list(d.cc)]
    const sender = bareAddress(d.from)
    if (!emailId || !webhookId) {
      request.log.warn({ hasEmailId: Boolean(emailId), hasWebhookId: Boolean(webhookId) }, 'Resend email.received without usable ids, ignored')
      return reply.send({ received: true })
    }
    if (!recipients.some((r) => FORWARDED.has(r))) {
      request.log.info({ emailId }, 'Inbound mail not addressed to hello@, not forwarded')
      return reply.send({ received: true, forwarded: false })
    }
    // A loop guard: nothing this system sends is addressed to hello@, so a
    // message from our own domain is a bounce or a loop, never a person.
    if (sender.endsWith('@' + OWN_DOMAIN) || sender === '') {
      request.log.warn({ emailId }, 'Inbound mail to hello@ from our own domain or no sender, not forwarded')
      return reply.send({ received: true, forwarded: false })
    }

    const senderHash = createHash('sha256').update(sender).digest('hex')
    const [claim] = await sql<{ day: number; sender: number }[]>`
      WITH ins AS (
        INSERT INTO inbound_mail_deliveries (webhook_id, email_id, sender_hash)
        VALUES (${webhookId}, ${emailId}, ${senderHash})
        ON CONFLICT (webhook_id) DO NOTHING
        RETURNING received_at
      )
      SELECT
        (SELECT count(*)::int FROM inbound_mail_deliveries, ins
          WHERE inbound_mail_deliveries.received_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            AND inbound_mail_deliveries.received_at < ins.received_at) AS day,
        (SELECT count(*)::int FROM inbound_mail_deliveries, ins
          WHERE inbound_mail_deliveries.received_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            AND inbound_mail_deliveries.received_at < ins.received_at
            AND inbound_mail_deliveries.sender_hash = ${senderHash}) AS sender
      FROM ins
    `
    if (!claim) {
      request.log.info({ emailId, webhookId }, 'Inbound mail: already handled this delivery, ignored')
      return reply.send({ received: true, duplicate: true })
    }

    const overDay = claim.day >= INBOUND_PER_DAY
    const overSender = claim.sender >= INBOUND_PER_SENDER_PER_DAY
    if (overDay || overSender) {
      await sql`UPDATE inbound_mail_deliveries SET outcome = ${overDay ? 'capped_day' : 'capped_sender'} WHERE webhook_id = ${webhookId}`
      request.log.warn({ emailId, day: claim.day, sender: claim.sender }, 'Inbound mail past the forward ceiling: left in Resend, not forwarded')
      // Exactly one notice a day, decided by the row: only one delivery has
      // day-rank INBOUND_PER_DAY.
      if (claim.day === INBOUND_PER_DAY) {
        void mailOwner({
          subject: `AgentBill: past ${INBOUND_PER_DAY} mails to hello@ today, forwarding paused`,
          html: `<p>${INBOUND_PER_DAY} mails to hello@agentbill.dev have been forwarded in this UTC day. The rest are
                 kept in Resend (Emails, Receiving) and are not forwarded until the day turns.</p>
                 <p>If this is real mail, raise <code>INBOUND_PER_DAY</code> in <code>src/routes/inbound-mail.ts</code> and deploy.</p>`,
        })
      }
      return reply.send({ received: true, forwarded: false })
    }

    const r = await forwardInbound(emailId)
    if (r.ok) {
      await sql`UPDATE inbound_mail_deliveries SET outcome = 'forwarded' WHERE webhook_id = ${webhookId}`
      request.log.info({ emailId }, 'Inbound mail to hello@ forwarded to the owner')
      return reply.send({ received: true, forwarded: true })
    }
    if (r.permanent) {
      await sql`UPDATE inbound_mail_deliveries SET outcome = 'failed' WHERE webhook_id = ${webhookId}`
      request.log.error({ emailId, why: r.why }, 'Inbound mail could not be forwarded, and a retry would fail the same way: left in Resend')
      return reply.send({ received: true, forwarded: false })
    }
    // A failure worth retrying: give the claim back so Resend's retry can land.
    await sql`DELETE FROM inbound_mail_deliveries WHERE webhook_id = ${webhookId}`
    request.log.error({ emailId, why: r.why }, 'Inbound mail forward failed, asking Resend to retry')
    return reply.code(503).send({ error: 'forward_failed' })
  })
}
