import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { verifyWebhookSignature, planFromProductId } from '../integrations/polar.js'
import { isUuid, isId } from '../lib/ids.js'

const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET ?? ''

export async function webhooksRoute(app: FastifyInstance) {
  // The signature was verified against an empty string.
  //
  // Fastify parses JSON and discards the text it parsed, and nothing in this
  // codebase ever set request.rawBody: `config: { rawBody: true }` below is
  // read by no plugin. So verifyWebhookSignature has been hashing '' since it
  // was written. Measured 2026-09-07 on a local server: a signature computed
  // over the real body, which is what Polar sends, was refused with 401, and a
  // signature computed over the empty string was accepted. Both halves are
  // bad. Every genuine webhook has been rejected, so no payment has ever moved
  // an account off the free plan; and the check proved only that the sender
  // knew the secret, never that this body was the body it signed.
  //
  // This parser is registered inside this plugin's own scope, so it changes the
  // body handling of exactly one route and leaves every other POST on
  // Fastify's default parser.
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

  app.post('/webhooks/polar', {
    config: { rawBody: true, public: true },
  }, async (request, reply) => {
    const rawBody = (request as any).rawBody as string | undefined
    const signature = request.headers['webhook-signature'] as string ?? ''

    // A signature check that switches itself off when the secret is missing is
    // not a check. This route is public by necessity, and the handler below
    // writes accounts.plan and zeroes monthly_calls, so any request that
    // reaches it unverified is a free upgrade to any tier for whoever knows an
    // account id, and account ids travel in the /upgrade link we hand people.
    // Production has the secret set, verified, so this changes nothing there;
    // it closes the case where a rotation or a new environment leaves it unset.
    if (!POLAR_WEBHOOK_SECRET) {
      request.log.error('POLAR_WEBHOOK_SECRET is not set, refusing a webhook this server cannot verify')
      return reply.code(503).send({ error: 'webhook_not_configured' })
    }
    const valid = await verifyWebhookSignature(rawBody ?? '', signature, POLAR_WEBHOOK_SECRET)
    if (!valid) {
      return reply.code(401).send({ error: 'invalid_signature' })
    }

    const event = request.body as any
    const eventType: string = event?.type ?? ''

    // Subscription activated, upgrade account to paid
    if (eventType === 'subscription.active' || eventType === 'order.created') {
      // Caller input, same as the account id: it lands in polar_customer_id,
      // and a control character there was a 500 the webhook sender retries.
      const rawCustomerId: string = event?.data?.customer_id ?? event?.data?.customerId ?? ''
      const polarCustomerId: string = isId(rawCustomerId) ? rawCustomerId : ''
      const accountId: string =
        event?.data?.metadata?.agentbill_account_id ??
        event?.data?.checkoutMetadata?.agentbill_account_id ??
        ''

      // The metadata comes back from Polar, but it started life in a checkout
      // URL the customer could edit, so it is caller input by the time it
      // lands here. accounts.id is a uuid column: any other shape is 22P02, a
      // 500, and a webhook Polar then retries for hours. 200 with a warning
      // instead, because no retry will ever make this payload valid.
      if (!isUuid(accountId)) {
        request.log.warn({ eventType, polarCustomerId, malformed: Boolean(accountId) },
          accountId ? 'Polar webhook carried a malformed agentbill_account_id' : 'Polar webhook missing agentbill_account_id')
        return reply.send({ received: true })
      }

      // Which tier was bought? Product id appears in different shapes across
      // Polar event types; unknown/legacy products map to 'paid'.
      const productId: string =
        event?.data?.product_id ??
        event?.data?.productId ??
        event?.data?.product?.id ??
        ''
      const plan = planFromProductId(productId)

      await sql`
        UPDATE accounts
        SET
          plan                = ${plan},
          polar_customer_id   = ${polarCustomerId},
          monthly_calls       = 0,
          billing_period_start = date_trunc('month', CURRENT_DATE)::DATE
        WHERE id = ${accountId}
      `

      request.log.info({ accountId, polarCustomerId, plan, productId }, 'Account upgraded')
    }

    // Subscription canceled, downgrade to free
    if (eventType === 'subscription.revoked' || eventType === 'subscription.canceled') {
      const accountId: string =
        event?.data?.metadata?.agentbill_account_id ??
        event?.data?.checkoutMetadata?.agentbill_account_id ??
        ''

      // Same rule as the upgrade branch: a uuid, or nothing happens.
      if (isUuid(accountId)) {
        await sql`
          UPDATE accounts
          SET
            plan              = 'free',
            polar_customer_id = NULL,
            monthly_calls     = 0,
            billing_period_start = date_trunc('month', CURRENT_DATE)::DATE
          WHERE id = ${accountId}
        `
        request.log.info({ accountId }, 'Account downgraded to free')
      }
    }

    return reply.send({ received: true })
  })
}
