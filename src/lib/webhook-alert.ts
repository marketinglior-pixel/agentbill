import { Resend } from 'resend'

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
//   unusable_account_id A real payment arrived and the account was NOT
//                       upgraded. This one answers 200, deliberately, because
//                       no retry can make the payload valid, which also means
//                       Polar will never send it again. **It is the only one
//                       where waiting costs the customer**, and it is the one
//                       that looks healthiest from the outside.
//
// It logs whether or not email is configured. The point is that the branch
// stops being silent; the email is how it travels when Resend is set up.

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const ownerEmail = process.env.OWNER_ALERT_EMAIL
const FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'

/** One email per reason per hour. A sender that retries must not become a mailbox. */
const COOLDOWN_MS = 60 * 60_000

export type WebhookAlertReason = 'invalid_signature' | 'not_configured' | 'unusable_account_id'

const URGENCY: Record<WebhookAlertReason, string> = {
  invalid_signature: 'Polar retries a 401, so this is recoverable until it stops retrying.',
  not_configured: 'Polar retries a 503, so this is recoverable until it stops retrying.',
  unusable_account_id: 'This answered 200 and Polar will NOT retry it. A payment was taken and the account was not upgraded.',
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

  if (!resend || !ownerEmail) return

  const rows = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td><code>${esc(v)}</code></td></tr>`)
    .join('')

  void resend.emails
    .send({
      from: FROM,
      to: ownerEmail,
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
