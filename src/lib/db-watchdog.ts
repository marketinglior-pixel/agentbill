import { sql } from '../db/index.js'
import { Resend } from 'resend'

// The May-August 2026 outage lesson: /health said "ok" for months while the
// database was dead, because it never touched the DB. This watchdog probes the
// DB from inside the running app and emails the owner on sustained failure,
// so a dead DB can never hide behind a live process again.

const CHECK_INTERVAL_MS = 5 * 60_000 // 5 minutes
const FAILURES_BEFORE_ALERT = 3      // ~15 minutes of sustained failure

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const ownerEmail = process.env.OWNER_ALERT_EMAIL

let consecutiveFailures = 0
let alertSent = false

export async function probeDb(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db probe timeout (3s)')), 3_000)),
    ])
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message }
  }
}

async function sendAlert(subject: string, html: string): Promise<void> {
  if (!resend || !ownerEmail) return
  await resend.emails.send({
    from: 'AgentBill <onboarding@resend.dev>',
    to: ownerEmail,
    subject,
    html,
  }).catch(() => {})
}

async function tick(): Promise<void> {
  const probe = await probeDb()

  if (probe.ok) {
    if (alertSent) {
      await sendAlert(
        'AgentBill: database RECOVERED',
        `<p>The production database is reachable again (probe latency ${probe.latencyMs}ms).</p>`
      )
    }
    consecutiveFailures = 0
    alertSent = false
    return
  }

  consecutiveFailures++
  if (consecutiveFailures >= FAILURES_BEFORE_ALERT && !alertSent) {
    alertSent = true // one alert per outage, not one per tick
    await sendAlert(
      'AgentBill: database UNREACHABLE. Signups and preflights are failing',
      `<p>The production database has failed ${consecutiveFailures} consecutive probes
       (~${Math.round((consecutiveFailures * CHECK_INTERVAL_MS) / 60_000)} minutes).</p>
       <p>Last error: <code>${probe.error ?? 'unknown'}</code></p>
       <p>Every /register, /preflight and /events call is currently returning 500.
       Check Supabase: <a href="https://supabase.com/dashboard/project/vduginchgtkapwswljft">agentbill-prod</a></p>`
    )
  }
}

export function startDbWatchdog(): void {
  const timer = setInterval(() => { void tick() }, CHECK_INTERVAL_MS)
  timer.unref() // never keep the process alive just for the watchdog
}
