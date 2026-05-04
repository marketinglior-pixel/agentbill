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
  if (!POLAR_CHECKOUT_URL) return 'https://agentbill.fly.dev/upgrade'
  return `${POLAR_CHECKOUT_URL}?metadata[agentbill_account_id]=${encodeURIComponent(accountId)}`
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
