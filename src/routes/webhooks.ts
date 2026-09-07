import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { verifyWebhookSignature, planFromProductId } from '../integrations/polar.js'
import { isUuid } from '../lib/ids.js'

const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET ?? ''

export async function webhooksRoute(app: FastifyInstance) {
  app.post('/webhooks/polar', {
    config: { rawBody: true, public: true },
  }, async (request, reply) => {
    const rawBody = (request as any).rawBody as string | undefined
    const signature = request.headers['webhook-signature'] as string ?? ''

    if (POLAR_WEBHOOK_SECRET) {
      const valid = await verifyWebhookSignature(rawBody ?? '', signature, POLAR_WEBHOOK_SECRET)
      if (!valid) {
        return reply.code(401).send({ error: 'invalid_signature' })
      }
    }

    const event = request.body as any
    const eventType: string = event?.type ?? ''

    // Subscription activated, upgrade account to paid
    if (eventType === 'subscription.active' || eventType === 'order.created') {
      const polarCustomerId: string = event?.data?.customer_id ?? event?.data?.customerId ?? ''
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
