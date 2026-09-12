import { mailOwner, ownerMailReady } from './mail.js'

// A rejected webhook now reaches a person.
//
// The signature check on /webhooks/polar hashed an empty string from the day it
// was written until 2026-09-07, so every genuine Polar webhook was refused and
// no payment ever moved an account off free. It survived months for one reason:
// the 401 branch returned a status and told nobody. It did not even log. There
// are no paying customers yet, so nothing else could have surfaced it either.
//
// This is the second half of that fix. The first half made the check correct;
// this one makes its failures loud, so the next time the paid path breaks it is
// measured in minutes rather than in months.
//
// Three reasons are worth waking someone for, and they are not equally urgent:
//
//   invalid_signature   Polar RETRIES a 401, so the money is not lost yet.
//                       Either the secret rotated on one side only, or someone
//                       is posting at the endpoint.
//   not_configured      POLAR_WEBHOOK_SECRET is missing, so the route refuses
//                       everything. Same retry, same window to fix it.
//   unusable_account_id A signed event arrived that could not be matched to an
//                       account. This one answers 200, deliberately, because no
//                       retry can make the payload valid, which also means Polar
//                       will never send it again. IF it was a real purchase it
//                       is the only reason where waiting costs the customer, and
//                       it looks the healthiest from outside. But the handler
//                       cannot see whether money moved, so the alert says so
//                       rather than asserting a payment it cannot confirm.
//
// It logs whether or not email is configured. The point is that the branch
// stops being silent; the email is how it travels when Resend is set up.


/** One email per reason per hour. A sender that retries must not become a mailbox. */
const COOLDOWN_MS = 60 * 60_000

export type WebhookAlertReason = 'invalid_signature' | 'not_configured' | 'unusable_account_id'

const URGENCY: Record<WebhookAlertReason, string> = {
  invalid_signature: 'Polar retries a 401, so this is recoverable until it stops retrying.',
  not_configured: 'Polar retries a 503, so this is recoverable until it stops retrying.',
  // States what the alert KNOWS, not what it assumes. It cannot see whether
  // money moved, only that a signed event it could not attribute arrived and
  // that answering 200 stopped Polar retrying. Asserting "a payment was taken"
  // was false for the $0 verification probes that fired this same alert, and a
  // 3am alert that overstates its own certainty is the same defect as a metric
  // that cannot name its own source. The customer id travels in the note below,
  // so the reader can settle it in the Polar dashboard in one click.
  unusable_account_id: 'A signed Polar event arrived that could not be matched to an account, and answering 200 stopped Polar retrying it. If it was a real purchase, someone paid and was not upgraded; it may instead be a test or a redelivery. This alert cannot tell which. Check the customer below in the Polar dashboard.',
}

type Tally = { firstAt: number; count: number; lastSentAt: number }
const tallies = new Map<WebhookAlertReason, Tally>()

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Never throws and never returns anything the caller waits on.
 *
 * The caller is a route that has already decided what to answer. An alert that
 * can delay or fail that reply would make an observability feature into an
 * availability problem, on the one route where a slow reply means a retry
 * storm. So this is called with `void` and swallows everything.
 */
export function alertRejectedWebhook(
  reason: WebhookAlertReason,
  detail: { eventType?: string; signaturePrefix?: string; accountIdShape?: string; note?: string },
): void {
  const now = Date.now()
  const t = tallies.get(reason) ?? { firstAt: now, count: 0, lastSentAt: 0 }
  t.count++
  tallies.set(reason, t)

  // Always audible, even with no mailer configured. This is the line whose
  // absence let the original bug hide.
  console.warn(
    `[webhook-alert] ${reason} (occurrence ${t.count})`,
    JSON.stringify({ ...detail, since: new Date(t.firstAt).toISOString() }),
  )

  if (now - t.lastSentAt < COOLDOWN_MS) return
  const suppressed = t.count - 1
  t.lastSentAt = now
  t.firstAt = now
  t.count = 0

  if (!ownerMailReady()) return

  const rows = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td><code>${esc(v)}</code></td></tr>`)
    .join('')

  void mailOwner({
      subject: `AgentBill: a Polar webhook was rejected (${reason})`,
      html: `
        <p><b>${esc(URGENCY[reason])}</b></p>
        <table border="1" cellpadding="6" cellspacing="0">
          <tr><td><b>reason</b></td><td><code>${esc(reason)}</code></td></tr>
          ${rows}
          ${suppressed > 0 ? `<tr><td><b>also suppressed</b></td><td>${suppressed} more in the last hour</td></tr>` : ''}
        </table>
        <p>Neither the request body nor the secret is included here on purpose.
        Check the Polar dashboard for the delivery and its response, and check that
        <code>POLAR_WEBHOOK_SECRET</code> in Fly matches the endpoint's secret in Polar.</p>
        <p><a href="https://agentbill.dev/admin">Open the dashboard</a></p>
      `,
    })
    .catch((err: unknown) => console.error('[webhook-alert] email failed:', err))
}

/** Test seam: the cooldown is module state, and a test must be able to clear it. */
export function resetWebhookAlerts(): void {
  tallies.clear()
}
