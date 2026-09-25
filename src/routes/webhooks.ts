import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { verifyWebhookSignature, planFromProductId, getCheckoutMetadata } from '../integrations/polar.js'
import { isUuid, isId } from '../lib/ids.js'
import { alertRejectedWebhook } from '../lib/webhook-alert.js'
import { periodEndOf } from '../lib/plan-period.js'

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
      alertRejectedWebhook('not_configured', { note: 'POLAR_WEBHOOK_SECRET is unset on this instance' })
      return reply.code(503).send({ error: 'webhook_not_configured' })
    }
    const verdict = verifyWebhookSignature(rawBody ?? '', request.headers as Record<string, string | string[] | undefined>, POLAR_WEBHOOK_SECRET)
    if (!verdict.ok) {
      // Every rejection is logged; that is the fix for the empty-string bug,
      // which answered 401 and told no one. But only a rejection that PRESENTED
      // a signature earns an email. A request with no webhook-signature header
      // cannot be a Polar delivery at all: Polar always signs. It is a scanner
      // or a monitor poking a public endpoint, and it arrives constantly. On
      // 2026-09-07 exactly this shipped a "Missing required headers, 15 bytes,
      // none sent" alert to the owner's phone within an hour of the feature
      // going live. Emailing on that is alert fatigue, and a wolf-crying alert
      // gets filtered, which is the same silence the alert was built to end.
      // So: a rejection WITH a signature (secret rotated, body tampered, replay)
      // is a real Polar delivery that failed and is worth waking someone; a
      // rejection with none is logged and left there.
      const presentedSignature = Boolean(signature)
      request.log.warn({ reason: verdict.reason, hasSignature: presentedSignature, bodyBytes: (rawBody ?? '').length },
        presentedSignature ? 'Polar webhook rejected: a signed request did not verify' : 'Unsigned POST to the webhook endpoint, ignored')
      if (presentedSignature) {
        alertRejectedWebhook('invalid_signature', {
          signaturePrefix: signature.slice(0, 12) + '...',
          note: `${verdict.reason}; body was ${(rawBody ?? '').length} bytes`,
        })
      }
      return reply.code(401).send({ error: 'invalid_signature' })
    }

    const event = request.body as any
    const eventType: string = event?.type ?? ''
    const data = event?.data ?? {}
    // Verified above, so it is present: the library refuses a delivery
    // without one. Bounded like every other id before it reaches a column.
    const rawWebhookId = request.headers['webhook-id']
    const webhookId = typeof rawWebhookId === 'string' && isId(rawWebhookId, 256) ? rawWebhookId : ''

    // What this delivery would do, decided before anything is written.
    //
    // Upgrade only on an event that says money moved or a subscription is
    // live, and only for a product this server sells. Until 2026-09-25 this
    // upgraded on order.created, whatever the order's status, and any product
    // id it did not recognise mapped to 'paid', the legacy plan with no
    // monthly cap: a pending order for any product in the organisation was
    // unlimited usage.
    //   order.paid                                    money moved
    //   subscription.active / subscription.created    with data.status 'active'
    // Everything else (order.created, a pending or incomplete subscription,
    // an unknown product) changes nothing and is logged.
    const status: string = typeof data.status === 'string' ? data.status : ''
    const isUpgradeEvent =
      (eventType === 'order.paid' && (status === '' || status === 'paid')) ||
      ((eventType === 'subscription.active' || eventType === 'subscription.created') && status === 'active')
    // What ends a plan, since 2026-09-25 (S24, migration 029). Polar's own
    // descriptions: subscription.canceled is "sent when a subscription is
    // canceled. Customers might still have access until the end of the
    // current period"; subscription.revoked is "sent when a subscription is
    // revoked and the user loses access immediately"; subscription.uncanceled
    // is "sent when a customer revokes a pending cancellation". Until this
    // commit canceled downgraded on the spot, so a customer who canceled on
    // day 2 lost the 28 days they had paid for. Now:
    //   revoked      downgrade now, as before
    //   canceled     schedule the end at the period end Polar sends
    //                (src/lib/plan-period.ts); the plan runs until then
    //   uncanceled   clear the scheduled end
    const isDowngradeEvent = eventType === 'subscription.revoked'
    const isCancelEvent = eventType === 'subscription.canceled'
    const isUncancelEvent = eventType === 'subscription.uncanceled'

    if (!isUpgradeEvent && !isDowngradeEvent && !isCancelEvent && !isUncancelEvent) {
      request.log.info({ eventType, status: status || null, webhookId }, 'Polar webhook: nothing to do for this event')
      return reply.send({ received: true })
    }

    let accountId: string =
      data?.metadata?.agentbill_account_id ??
      data?.checkoutMetadata?.agentbill_account_id ??
      ''

    // Fallback via checkout_id. The subscription's own metadata comes back
    // empty (verified on the first real delivery, 2026-09-07), but the payload
    // always carries data.checkout_id, and the session /app/checkout/:tier minted
    // put the account id on that checkout. One guarded GET recovers it, and it
    // only runs when the fast path above found nothing, so a well-formed
    // upgrade pays for no extra call. Done before the transaction below, so
    // no row is locked across a call to Polar.
    if (!isUuid(accountId)) {
      const checkoutId: string = data?.checkout_id ?? data?.checkoutId ?? ''
      if (checkoutId) {
        const md = await getCheckoutMetadata(checkoutId)
        const fromCheckout = md?.agentbill_account_id
        if (typeof fromCheckout === 'string') accountId = fromCheckout
      }
    }
    if (typeof accountId !== 'string') accountId = ''

    // Caller input, same as the account id: it lands in polar_customer_id,
    // and a control character there was a 500 the webhook sender retries.
    const rawCustomerId: string = data?.customer_id ?? data?.customerId ?? ''
    const polarCustomerId: string = isId(rawCustomerId) ? rawCustomerId : ''

    // Which tier was bought? Product id appears in different shapes across
    // Polar event types.
    const productId: string = data?.product_id ?? data?.productId ?? data?.product?.id ?? ''
    const plan = isUpgradeEvent ? planFromProductId(typeof productId === 'string' ? productId : '') : null

    // Which subscription this is about. On a subscription.* event it is the
    // object itself; order.paid names it (null for a one-off order). Bounded
    // like every id. An account remembers the subscription that bought its
    // plan, and a cancel, uncancel or revoke of any OTHER subscription (an
    // old one, after the buyer bought again) leaves the plan alone. An
    // account upgraded before migration 029 remembers none and accepts any,
    // which is how it behaved.
    const rawSubId = eventType.startsWith('subscription.') ? data?.id : (data?.subscription_id ?? data?.subscriptionId)
    const subscriptionId: string = typeof rawSubId === 'string' && isId(rawSubId, 128) ? rawSubId : ''
    const endsAt = isCancelEvent ? periodEndOf(data) : null

    // The claim and the change, in one transaction: of N copies of one
    // delivery exactly one acts, and a change that fails rolls its claim back
    // so Polar's retry can still land. A delivery with no usable id is acted
    // on without a claim (the library already required the header, so this
    // is belt and braces rather than a path Polar takes).
    type Outcome = 'duplicate' | 'unusable_account' | 'unknown_product' | 'upgraded' | 'downgraded'
      | 'end_scheduled' | 'end_cleared' | 'no_period_end' | 'other_subscription'
    const outcome: Outcome = await sql.begin(async (tx) => {
      if (webhookId) {
        const [claim] = await tx`
          INSERT INTO polar_webhook_deliveries (webhook_id, event_type)
          VALUES (${webhookId}, ${eventType})
          ON CONFLICT (webhook_id) DO NOTHING
          RETURNING webhook_id
        `
        if (!claim) return 'duplicate' as const
      }
      // The metadata comes back from Polar, but it started life in a checkout
      // URL the customer could edit, so it is caller input by the time it
      // lands here. accounts.id is a uuid column: any other shape is 22P02, a
      // 500, and a webhook Polar then retries for hours.
      if (!isUuid(accountId)) return 'unusable_account' as const
      if (isUpgradeEvent) {
        if (!plan) return 'unknown_product' as const
        // A purchase clears any end a cancel had scheduled, and remembers
        // the subscription (when the event names one) so a later cancel of
        // a different one cannot end this plan.
        await tx`
          UPDATE accounts
          SET
            plan                  = ${plan},
            polar_customer_id     = ${polarCustomerId},
            polar_subscription_id = COALESCE(${subscriptionId || null}, polar_subscription_id),
            plan_ends_at          = NULL,
            monthly_calls         = 0,
            monthly_events        = 0,
            billing_period_start  = date_trunc('month', CURRENT_DATE)::DATE
          WHERE id = ${accountId}
        `
        return 'upgraded' as const
      }
      // Everything below changes this account only for its own subscription.
      const ours = tx`(polar_subscription_id IS NULL OR ${subscriptionId} = '' OR polar_subscription_id = ${subscriptionId})`
      if (isCancelEvent) {
        // Without a period end there is nothing to schedule: the plan stays
        // as it is, and subscription.revoked ends it when Polar ends access.
        // Downgrading here instead is the bug this replaced.
        if (!endsAt) return 'no_period_end' as const
        const hit = await tx`UPDATE accounts SET plan_ends_at = ${endsAt} WHERE id = ${accountId} AND ${ours} RETURNING id`
        return hit.length ? 'end_scheduled' as const : 'other_subscription' as const
      }
      if (isUncancelEvent) {
        const hit = await tx`UPDATE accounts SET plan_ends_at = NULL WHERE id = ${accountId} AND ${ours} RETURNING id`
        return hit.length ? 'end_cleared' as const : 'other_subscription' as const
      }
      const hit = await tx`
        UPDATE accounts
        SET
          plan                  = 'free',
          polar_customer_id     = NULL,
          polar_subscription_id = NULL,
          plan_ends_at          = NULL,
          monthly_calls         = 0,
          monthly_events        = 0,
          billing_period_start  = date_trunc('month', CURRENT_DATE)::DATE
        WHERE id = ${accountId} AND ${ours}
        RETURNING id
      `
      return hit.length ? 'downgraded' as const : 'other_subscription' as const
    })

    if (outcome === 'duplicate') {
      request.log.info({ eventType, webhookId }, 'Polar webhook: already processed this delivery, ignored')
      return reply.send({ received: true, duplicate: true })
    }

    if (outcome === 'unusable_account') {
      const accountIdLen = accountId.length
      request.log.warn({ eventType, polarCustomerId, malformed: Boolean(accountId) },
        accountId ? 'Polar webhook carried a malformed agentbill_account_id' : 'Polar webhook missing agentbill_account_id')
      // Only an upgrade earns the alert. A signature that verified means this
      // is a REAL payment from Polar, and the 200 below is what stops the
      // retries, so nothing will ever deliver it again: somebody paid and
      // their account is still on free.
      if (isUpgradeEvent) {
        alertRejectedWebhook('unusable_account_id', {
          eventType,
          accountIdShape: accountIdLen ? `present but not a uuid (${accountIdLen} chars)` : 'absent',
          note: polarCustomerId ? `polar_customer_id ${polarCustomerId}` : 'no polar customer id either',
        })
      }
      return reply.send({ received: true })
    }

    if (outcome === 'unknown_product') {
      // A real, verified payment for a product this server does not sell.
      // No plan changes, and the owner hears about it, because a buyer is
      // waiting on the other end of it.
      request.log.warn({ eventType, accountId, productId }, 'Polar webhook for a product this server does not sell: no plan change')
      alertRejectedWebhook('unknown_product', {
        eventType,
        note: `product ${String(productId).slice(0, 64) || '(none)'} is not a configured tier; account ${accountId} left as it was`,
      })
      return reply.send({ received: true })
    }

    if (outcome === 'upgraded') request.log.info({ accountId, polarCustomerId, plan, productId, subscriptionId }, 'Account upgraded')
    else if (outcome === 'downgraded') request.log.info({ accountId, subscriptionId }, 'Account downgraded to free')
    else if (outcome === 'end_scheduled') request.log.info({ accountId, subscriptionId, endsAt }, 'Plan canceled: it runs to the end of the paid period')
    else if (outcome === 'end_cleared') request.log.info({ accountId, subscriptionId }, 'Cancellation withdrawn: the plan continues')
    else if (outcome === 'no_period_end') request.log.warn({ accountId, subscriptionId, eventType }, 'subscription.canceled without a period end: plan left as it is until subscription.revoked')
    else request.log.info({ accountId, subscriptionId, eventType }, 'Polar webhook for a subscription that is not the one behind this plan: no change')

    return reply.send({ received: true })
  })
}
