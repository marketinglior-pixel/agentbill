const POLAR_API_KEY      = process.env.POLAR_API_KEY      ?? ''
const POLAR_METER_SLUG   = process.env.POLAR_METER_SLUG   ?? ''
const POLAR_CHECKOUT_URL = process.env.POLAR_CHECKOUT_URL ?? ''
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

// Returns the Polar checkout URL with the account ID embedded as metadata.
// Polar will forward this metadata in the webhook so we know who upgraded.
export function getCheckoutUrl(accountId: string): string {
  if (!POLAR_CHECKOUT_URL) return 'https://agentbill.dev/upgrade'
  return `${POLAR_CHECKOUT_URL}?metadata[agentbill_account_id]=${encodeURIComponent(accountId)}`
}

// ---------------------------------------------------------------------------
// Pricing tiers (2026-08-26): Free / Builder $29 / Team $99 / Scale $299.
// Monthly included preflight calls are enforced app-side; the legacy 'paid'
// plan (pay-as-you-go) stays metered per call and unlimited.
// ---------------------------------------------------------------------------

export const PLAN_LIMITS: Record<string, number> = {
  free: 1_000,
  builder: 50_000,
  team: 500_000,
  scale: 2_000_000,
}

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

const TIER_CHECKOUTS: Record<string, string> = {
  builder: process.env.POLAR_CHECKOUT_URL_BUILDER ?? '',
  team: process.env.POLAR_CHECKOUT_URL_TEAM ?? '',
  scale: process.env.POLAR_CHECKOUT_URL_SCALE ?? '',
}

export function getTierCheckoutUrl(tier: string, accountId: string): string {
  const url = TIER_CHECKOUTS[tier]
  if (!url) return getCheckoutUrl(accountId)
  return accountId
    ? `${url}?metadata[agentbill_account_id]=${encodeURIComponent(accountId)}`
    : url
}

// Verify Polar webhook signature (HMAC SHA-256).
// Polar sends the signature in the "webhook-signature" header as "v1,<hex>".
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false

  const [version, sig] = signatureHeader.split(',')
  if (version !== 'v1' || !sig) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const expected = Buffer.from(signature).toString('hex')

  return expected === sig
}
