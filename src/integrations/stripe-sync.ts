/**
 * Stripe metered billing sync.
 *
 * Reads un-synced events from Postgres and reports them to Stripe as
 * subscription usage records. Run this on a cron (e.g. every 5 minutes).
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY        Your Stripe secret key.
 *   STRIPE_PRICE_ID          The Stripe Price ID for your metered billing price.
 *
 * Setup steps (not yet wired):
 *   1. Developer completes Stripe Connect OAuth → store stripe_customer_id on accounts table
 *   2. On first event for a customer, create a Stripe subscription with the metered price
 *   3. This sync job reports usage in batches
 *
 * To run manually: npx tsx src/integrations/stripe-sync.ts
 */

import Stripe from 'stripe'
import { sql } from '../db/index.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' })

interface UnsyncedEvent {
  id: string
  customerId: string
  units: number
  stripeSubscriptionItemId: string | null
  createdAt: Date
}

export async function syncToStripe(): Promise<{ synced: number; skipped: number }> {
  // Fetch events not yet reported to Stripe
  const rows = await sql<UnsyncedEvent[]>`
    SELECT
      e.id,
      c.customer_ref   AS "customerId",
      e.units,
      c.stripe_subscription_item_id AS "stripeSubscriptionItemId",
      e.created_at     AS "createdAt"
    FROM events e
    JOIN customers c ON c.id = e.customer_id
    WHERE e.stripe_reported_at IS NULL
    ORDER BY e.created_at
    LIMIT 500
  `

  let synced = 0
  let skipped = 0

  for (const event of rows) {
    if (!event.stripeSubscriptionItemId) {
      skipped++
      continue
    }

    // Report usage to Stripe (idempotency key = our event ID)
    await stripe.subscriptionItems.createUsageRecord(
      event.stripeSubscriptionItemId,
      {
        quantity: event.units,
        timestamp: Math.floor(event.createdAt.getTime() / 1000),
        action: 'increment',
      },
      {
        idempotencyKey: event.id,
      }
    )

    // Mark as reported
    await sql`
      UPDATE events
      SET stripe_reported_at = NOW()
      WHERE id = ${event.id}
    `

    synced++
  }

  return { synced, skipped }
}

// Direct execution
if (process.argv[1] === new URL(import.meta.url).pathname) {
  syncToStripe()
    .then(({ synced, skipped }) => {
      console.log(`Stripe sync complete: ${synced} reported, ${skipped} skipped (no subscription)`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('Stripe sync failed:', err)
      process.exit(1)
    })
}
