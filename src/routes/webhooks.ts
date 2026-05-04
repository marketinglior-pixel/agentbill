import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { verifyWebhookSignature } from '../integrations/polar.js'

const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET ?? ''
const FREE_TIER_LIMIT = 1_000

export async function webhooksRoute(app: FastifyInstance) {
  app.post('/webhooks/polar', {
    config: { rawBody: true },
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

    // Subscription activated — upgrade account to paid
    if (eventType === 'subscription.active' || eventType === 'order.created') {
      const polarCustomerId: string = event?.data?.customer_id ?? event?.data?.customerId ?? ''
      const accountId: string =
        event?.data?.metadata?.agentbill_account_id ??
        event?.data?.checkoutMetadata?.agentbill_account_id ??
        ''

      if (!accountId) {
        request.log.warn({ eventType, polarCustomerId }, 'Polar webhook missing agentbill_account_id')
        return reply.send({ received: true })
      }

      await sql`
        UPDATE accounts
        SET
          plan                = 'paid',
          polar_customer_id   = ${polarCustomerId},
          monthly_calls       = 0,
          billing_period_start = date_trunc('month', CURRENT_DATE)::DATE
        WHERE id = ${accountId}
      `

      request.log.info({ accountId, polarCustomerId }, 'Account upgraded to paid')
    }

    // Subscription canceled — downgrade to free
    if (eventType === 'subscription.revoked' || eventType === 'subscription.canceled') {
      const accountId: string =
        event?.data?.metadata?.agentbill_account_id ??
        event?.data?.checkoutMetadata?.agentbill_account_id ??
        ''

      if (accountId) {
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
