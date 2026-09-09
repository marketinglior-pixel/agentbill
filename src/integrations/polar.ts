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

/**
 * True only for an https URL on polar.sh or one of its subdomains, which is
 * where Polar hosts a checkout session (production `polar.sh/checkout/...`,
 * sandbox `sandbox.polar.sh/...`). The buy button 302s a visitor to whatever
 * createCheckoutSession returns, so the returned string is a redirect target
 * and gets the same allowlist a user-supplied one would (CWE-601, Snyk Code
 * 2026-09-09). Verified against a session minted by production the same day:
 * its host was `polar.sh`.
 */
export function isPolarCheckoutUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'https:' && (hostname === 'polar.sh' || hostname.endsWith('.polar.sh'))
  } catch {
    return false
  }
}

// Create a checkout session carrying the account id as metadata; return its
// hosted URL. Recoverable from the webhook via getCheckoutMetadata by
// checkout_id, which the payload carries even when subscription.metadata is empty.
// Anything that is not an https polar.sh URL comes back as null, the same as a
// failed call, so no caller can be handed an off-site redirect target.
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
        // {CHECKOUT_ID} is Polar's own placeholder, substituted at redirect
        // time (their docs, "Creating Checkout Sessions"). It is what lets
        // /thanks name the plan that was bought instead of guessing, and it is
        // read-only: the page verifies the id against Polar and against our own
        // accounts row, so a forged or stale one confirms nothing.
        success_url: 'https://agentbill.dev/thanks?checkout_id={CHECKOUT_ID}',
      }),
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { url?: string }
    return isPolarCheckoutUrl(j.url) ? j.url : null
  } catch {
    return null
  }
}

// One guarded GET for a checkout by id, bounded by a short timeout. Two callers
// read different parts of the same object: the webhook wants the metadata when
// its own payload carried none, and /thanks wants the status and the product.
// Every failure is null, never a throw: both callers sit on a path where a slow
// or unreachable Polar must degrade the page, not break the request.
async function fetchCheckout(checkoutId: string): Promise<Record<string, any> | null> {
  if (!POLAR_API_KEY || !checkoutId) return null
  try {
    const r = await fetch(`https://api.polar.sh/v1/checkouts/${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${POLAR_API_KEY}` },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return null
    return (await r.json()) as Record<string, any>
  } catch {
    return null
  }
}

// Read the metadata off a checkout by id. Run only when the webhook's own
// metadata is empty.
export async function getCheckoutMetadata(checkoutId: string): Promise<Record<string, unknown>> {
  const j = await fetchCheckout(checkoutId)
  return (j?.metadata as Record<string, unknown>) ?? {}
}

/**
 * What /thanks needs to tell a buyer what they bought, read from Polar rather
 * than from our own query string, which the buyer could edit.
 *
 * `status` is Polar's own enum (open, expired, confirmed, succeeded, failed);
 * only the paid ones may be rendered as a purchase. `plan` is the tier the
 * product maps to, by the same function the webhook uses, so the page and the
 * upgrade cannot disagree about what was sold.
 */
export type CheckoutSummary = { status: string; accountId: string | null; plan: string }

export async function getCheckoutSummary(checkoutId: string): Promise<CheckoutSummary | null> {
  const j = await fetchCheckout(checkoutId)
  if (!j) return null
  // Same three shapes the webhook accepts for the product id, for the same
  // reason: Polar spells it differently across payloads and SDK versions.
  const productId: string = j.product_id ?? j.productId ?? j.product?.id ?? ''
  const accountId = j.metadata?.agentbill_account_id
  return {
    status: typeof j.status === 'string' ? j.status : '',
    accountId: typeof accountId === 'string' ? accountId : null,
    plan: planFromProductId(productId),
  }
}

/** The Polar checkout states in which money has actually moved. */
export function checkoutIsPaid(status: string): boolean {
  return status === 'succeeded' || status === 'confirmed'
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
