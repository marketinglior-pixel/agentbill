import { Resend } from 'resend'
import { getAccountsWithSignals, conversionScore, isHot } from './conversion.js'

// Daily owner email: yesterday's signups + the hot-accounts leaderboard.
// Same run-inside-the-app pattern as the DB watchdog: hourly tick, fires once
// per UTC day at SEND_HOUR_UTC. No-op when Resend or the owner email is unset.

const SEND_HOUR_UTC = 5 // 08:00 Israel
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const ownerEmail = process.env.OWNER_ALERT_EMAIL
const FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'

let lastSentDay = ''

async function sendDigest(): Promise<void> {
  if (!resend || !ownerEmail) return

  const accounts = await getAccountsWithSignals()
  const dayAgo = Date.now() - 24 * 3_600_000
  const newSignups = accounts.filter((a) => new Date(a.createdAt).getTime() > dayAgo)
  const hot = accounts.filter(isHot).sort((a, b) => conversionScore(b) - conversionScore(a))

  const signupRows = newSignups
    .map((a) => `<li><code>${a.email}</code> (${a.stack ?? '?'}, ${a.useCase ?? '?'})</li>`)
    .join('') || '<li>none</li>'

  const hotRows = hot
    .slice(0, 10)
    .map((a) => {
      const pct = Math.round(((a.monthlyCalls ?? 0) / 1_000) * 100)
      return `<tr><td><code>${a.email}</code></td><td>${conversionScore(a)}</td><td>${a.monthlyCalls} (${pct}%)</td><td>${a.taskCount} tasks</td></tr>`
    })
    .join('') || '<tr><td colspan="4">none yet</td></tr>'

  await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `AgentBill daily: ${newSignups.length} new signups, ${hot.length} hot accounts`,
    html: `
      <h3>New signups (24h): ${newSignups.length}</h3>
      <ul>${signupRows}</ul>
      <h3>Hot accounts (likely to pay)</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Email</th><th>Score</th><th>Calls</th><th>Tasks</th></tr>
        ${hotRows}
      </table>
      <p>Total accounts: ${accounts.length} · Paid: ${accounts.filter((a) => a.plan !== 'free').length}</p>
      <p><a href="https://agentbill.dev/admin">Open the dashboard</a></p>
    `,
  })
}

export function startConversionDigest(): void {
  const timer = setInterval(() => {
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    // An hourly tick can straddle a one-hour window (timer drift, restarts near
    // 05:00), which is how the 2026-08-28 digest went missing. Accept any tick
    // in a 4-hour window; lastSentDay keeps it to one digest per day.
    const hour = now.getUTCHours()
    if (hour < SEND_HOUR_UTC || hour >= SEND_HOUR_UTC + 4 || lastSentDay === day) return
    lastSentDay = day
    sendDigest().catch((err) => {
      // Non-critical: a failed digest never takes the app down; retries tomorrow.
      console.error('[conversion-digest] send failed:', err)
    })
  }, 60 * 60 * 1000)
  timer.unref?.()
}
