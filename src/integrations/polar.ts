const POLAR_API_KEY      = process.env.POLAR_API_KEY      ?? ''
const POLAR_METER_SLUG   = process.env.POLAR_METER_SLUG   ?? ''
const POLAR_ORG_SLUG     = process.env.POLAR_ORG_SLUG     ?? ''

// Report one billable call to Polar for a paid customer.
// Called after every approved preflight for paid accounts.
export async function reportUsage(polarCustomerId: string, units = 1): Promise<void> {
  if (!POLAR_API_KEY || !POLAR_METER_SLUG || !POLAR_ORG_SLUG) return

  await fetch(`https://api.polar.sh/v1/customers/${polarCustomerId}/meters/${POLAR_METER_SLUG}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${POLAR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value: units }),
  }).catch(() => {
    // Non-critical: don't block the preflight response if Polar is down
  })
}

// The buy button points at OUR server, never at buy.polar.sh directly. A Polar
// checkout LINK silently drops a `?metadata[...]` query parameter (verified
// against their API on 2026-09-07: the created checkout came back with empty
// metadata), so the account id we used to append never reached the webhook and
// no purchase could be attributed to an account. A checkout SESSION made via
// the API keeps its metadata. So the button links to /checkout/:tier, which
// mints a real session on click.
export function checkoutPath(tier: string, accountId: string): string {
  return `/checkout/${encodeURIComponent(tier)}?account_id=${encodeURIComponent(accountId)}`
}

const PRODUCT_IDS: Record<string, string> = {
  builder: process.env.POLAR_PRODUCT_ID_BUILDER ?? '',
  team: process.env.POLAR_PRODUCT_ID_TEAM ?? '',
  scale: process.env.POLAR_PRODUCT_ID_SCALE ?? '',
}

// Create a checkout session carrying the account id as metadata; return its
// hosted URL. Recoverable from the webhook via getCheckoutMetadata by
// checkout_id, which the payload carries even when subscription.metadata is empty.
export async function createCheckoutSession(tier: string, accountId: string): Promise<string | null> {
  const productId = PRODUCT_IDS[tier]
  if (!POLAR_API_KEY || !productId) return null
  try {
    const r = await fetch('https://api.polar.sh/v1/checkouts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${POLAR_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [productId],
        metadata: { agentbill_account_id: accountId },
        success_url: 'https://agentbill.dev/thanks',
      }),
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { url?: string }
    return typeof j.url === 'string' ? j.url : null
  } catch {
    return null
  }
}

// Read the metadata off a checkout by id. One guarded GET on the request path,
// bounded by a short timeout, run only when the webhook's own metadata is empty.
export async function getCheckoutMetadata(checkoutId: string): Promise<Record<string, unknown>> {
  if (!POLAR_API_KEY || !checkoutId) return {}
  try {
    const r = await fetch(`https://api.polar.sh/v1/checkouts/${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${POLAR_API_KEY}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return {}
    const j = (await r.json()) as { metadata?: Record<string, unknown> }
    return j.metadata ?? {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Pricing tiers (2026-08-26). The two tables below are the ONLY place the
// tiers are defined: preflight enforces PLAN_LIMITS, and /, /pricing and the
// console render both tables. A price or limit typed anywhere else is a copy
// that will drift. Monthly included preflight calls are enforced app-side;
// the legacy 'paid' plan (pay-as-you-go) stays metered per call and unlimited.
// ---------------------------------------------------------------------------

export const PLAN_LIMITS: Record<string, number> = {
  free: 1_000,
  builder: 50_000,
  team: 500_000,
  scale: 2_000_000,
}

/** Monthly price in whole US dollars. Free is 0 on purpose, not absent. */
export const PLAN_PRICES: Record<string, number> = {
  free: 0,
  builder: 29,
  team: 99,
  scale: 299,
}

/** Display order for the four tiers wherever they are listed. */
export const PLAN_ORDER = ['free', 'builder', 'team', 'scale'] as const

const TIER_PRODUCTS: Record<string, string> = {
  [process.env.POLAR_PRODUCT_ID_BUILDER ?? '__builder_unset']: 'builder',
  [process.env.POLAR_PRODUCT_ID_TEAM ?? '__team_unset']: 'team',
  [process.env.POLAR_PRODUCT_ID_SCALE ?? '__scale_unset']: 'scale',
}

// Map a Polar product to a plan name. Unknown products fall back to the
// legacy 'paid' plan so old checkouts keep working.
export function planFromProductId(productId: string | null | undefined): string {
  if (!productId) return 'paid'
  return TIER_PRODUCTS[productId] ?? 'paid'
}


// Verify a Polar webhook the way Polar signs it, which is Standard Webhooks.
//
// This function was wrong from the day it was written, in three ways no
// self-made test could catch: it signed the body alone where Polar signs
// `${webhook-id}.${webhook-timestamp}.${body}`, it compared hex where Polar
// emits base64, and it ignored the id and timestamp headers. Every probe
// passed, because every probe signed the way THIS code expected. Then on
// 2026-09-07 a real $0 checkout produced ten deliveries from Polar and all ten
// were 401. The first genuine event this endpoint ever received was the first
// thing that could expose it.
//
// Verification is delegated to the same library Polar's SDK uses, and the
// secret is prepared the way Polar's SDK prepares it:
//   new Webhook(Buffer.from(secret, 'utf-8').toString('base64')).verify(body, headers)
// The library base64-decodes that back to the secret's bytes for the HMAC key,
// checks the timestamp is within five minutes, and constant-time compares every
// `v1,` signature in the header. A harness that signs any other way measures the
// code against itself; scripts/preflight/verify.mjs signs through this library.
import { Webhook, WebhookVerificationError } from 'standardwebhooks'

export type WebhookVerdict = { ok: true } | { ok: false; reason: string }

export function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): WebhookVerdict {
  if (!secret) return { ok: false, reason: 'no_secret' }
  const pick = (n: string) => {
    const v = headers[n]
    return Array.isArray(v) ? v[0] : v
  }
  const h: Record<string, string> = {}
  for (const n of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const v = pick(n)
    if (v) h[n] = v
  }
  try {
    new Webhook(Buffer.from(secret, 'utf-8').toString('base64')).verify(rawBody, h, { jsonParse: false })
    return { ok: true }
  } catch (err) {
    if (err instanceof WebhookVerificationError) return { ok: false, reason: err.message }
    return { ok: false, reason: 'verifier_threw: ' + String((err as Error)?.message ?? err).slice(0, 80) }
  }
}
