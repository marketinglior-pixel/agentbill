import type { FastifyBaseLogger } from 'fastify'
import { Resend } from 'resend'
import { sql } from '../db/index.js'
import { ORIGIN } from '../ui/site.js'

// A new account reaches the owner while it is still new.
//
// What existed before this file: startConversionDigest (conversion-digest.ts)
// mails one digest a day at 05:00 UTC with a "New signups (24h)" list. That is
// the right shape for a leaderboard and the wrong shape for a signup. The
// founder's own dogfood account was created at 23:44 UTC on 2026-09-11 and the
// first notice of it would have arrived five hours later, by which time the
// only window in which a first-run question can be answered had closed. The
// digest stays; it is the backstop for anything this send loses.
//
// No key, ever. The API key is shown once in the browser and is not in the
// welcome mail on purpose (register.ts); putting it in the owner's mailbox
// would recreate exactly the thing that decision avoids, in a second mailbox.
//
// ---------------------------------------------------------------------------
// The cap, and why there is one at all
//
// On 2026-09-11 an alert that compared one column mailed one account owner
// roughly eleven times a minute for two days: 13,835 sends, 8,180 of them
// bounced, and Gmail delivery for the whole domain fell from 66% to 17%, which
// took genuine welcome mail down with it (ip-origin.ts, migration 011). The
// lesson that survives is not about IP addresses. It is that a per-event owner
// alert on a PUBLIC endpoint has to carry its own ceiling, because the thing
// that decides how often it fires is a stranger.
//
// /register is capped at 12 attempts an hour per network (register-limiter.ts),
// and that is a per-network cap held in one machine's memory. It bounds one
// sweep, not the total: a caller with many networks, or a botnet, is not bound
// by it at all. So the ceiling here is counted over the thing being protected,
// which is the mailbox, and it is read from the accounts table rather than from
// module memory. Module memory would be wrong twice over: there are two Fly
// machines, so the cap would be doubled, and a restart would reset it.
//
// The count is not a claim table (account_quota_alerts, api_key_ip_origins) and
// does not need to be. Those tables exist because their events can repeat: the
// same threshold can be crossed again, the same origin can be seen again. An
// account is INSERTed exactly once, by one statement, in one transaction
// (register.ts), and this function is called on that one path, so "once per
// account" is already true without a row to enforce it.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const ownerEmail = process.env.OWNER_ALERT_EMAIL
const FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'

/**
 * How many signup emails one UTC day may produce.
 *
 * 25 is above any real day (36 accounts exist in total, 2026-09-12) and far
 * below a mailbox problem. The cap is deliberately counted in ACCOUNTS and not
 * in requests or minutes: one email per genuine new account is exactly what was
 * asked for, and the only way to reach 26 of those in a day is an event the
 * owner should hear about once, loudly, rather than two hundred times.
 */
const DAILY_CAP = 25

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const row = (label: string, value: string) =>
  `<tr><td><b>${esc(label)}</b></td><td>${value}</td></tr>`

export interface SignupAlert {
  accountId: string
  email: string
  name?: string | null
  stack?: string | null
  useCase?: string | null
  plan: string
}

/**
 * Never throws and returns nothing the caller waits on. Called with `void`.
 *
 * The caller is POST /register, which already holds the key in its 201 body.
 * An owner notification that could delay or fail a signup would be an
 * observability feature turned into an availability bug, on the one route whose
 * whole promise is that it takes thirty seconds.
 */
export function alertNewSignup(log: FastifyBaseLogger, a: SignupAlert): void {
  void send(log, a).catch((err) => log.error({ err }, 'signup alert threw'))
}

async function send(log: FastifyBaseLogger, a: SignupAlert): Promise<void> {
  // Audible whether or not a mailer is configured. The Polar webhook rejected
  // every real payment for months because its failure branch returned a status
  // and told nobody, not even a log (webhook-alert.ts). Every branch below
  // leaves a line.
  log.info({ accountId: a.accountId, email: a.email, stack: a.stack, useCase: a.useCase }, 'new signup')

  if (!resend || !ownerEmail) {
    log.warn({ accountId: a.accountId }, 'signup alert not sent: RESEND_API_KEY or OWNER_ALERT_EMAIL is unset')
    return
  }

  // The cap decision is a property of the ROW, not of when this query ran.
  //
  // `rank` counts the accounts still on the table that were created earlier in
  // the same UTC day than this one, so it is this signup's own 0-based position
  // in the day. That matters because the obvious version, "how many accounts
  // exist in the last 24 hours", is read at a MOMENT: two signups arriving
  // together can both read the same number and both believe they crossed the
  // same line, and a rolling window can fall back under the cap as old rows age
  // out and then be crossed a second time on the same day. A rank does neither.
  // Every account has a distinct created_at, so every integer belongs to exactly
  // one signup, which is the argument thresholdCrossed relies on in
  // quota-alert.ts, and 2026-09-11's sixteen accounts bear it out: ranks 0
  // through 15, one each.
  //
  // Two things it is honest about rather than exact about. It counts rows that
  // STILL EXIST, so deleting a day's throwaway accounts (which verifying this
  // product does, every time) lowers every later rank and re-arms the cap; the
  // alternative is a claim table that outlives the account, and one mail per
  // deleted test account is not worth a migration. And the day boundary is
  // pinned to UTC in the query rather than left to `date_trunc('day', now())`,
  // whose answer depends on a session TimeZone that nothing in src/db sets.
  //
  // `total` is only for the body. Both numbers come from the accounts table, so
  // they are the numbers /admin and the daily digest would report, and neither
  // can drift with a restart or differ between the two machines.
  const [counts] = await sql<{ total: number; rank: number }[]>`
    SELECT (SELECT count(*)::int FROM accounts) AS total,
           (SELECT count(*)::int FROM accounts
             WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
               AND created_at < (SELECT created_at FROM accounts WHERE id = ${a.accountId})) AS rank
  `
  const total = counts?.total ?? 0
  const rank = counts?.rank ?? 0

  if (rank >= DAILY_CAP) {
    log.warn({ accountId: a.accountId, rank }, 'signup alert suppressed: over the daily cap')
    // Silence, but say so once. Exactly one signup a day has rank DAILY_CAP, so
    // this is one notice however many follow it, and the next one is tomorrow.
    if (rank === DAILY_CAP) {
      await resend.emails.send({
        from: FROM,
        to: ownerEmail,
        subject: `AgentBill: past ${DAILY_CAP} signups today, per signup mail is off until tomorrow`,
        html: `
          <p>This is account number ${esc(String(rank + 1))} created today, which is past the
             per-signup cap of ${DAILY_CAP}. No further signup mail goes out until tomorrow, and
             this is the only notice.</p>
          <p>Either something good happened or /register is being swept. The accounts table is the
             record either way, and tomorrow morning's digest still counts every one of them.</p>
          <p><a href="${ORIGIN}/admin">Open the dashboard</a></p>
        `,
      })
    }
    return
  }

  const res = await resend.emails.send({
    from: FROM,
    to: ownerEmail,
    subject: `AgentBill: new signup, ${a.email}`,
    html: `
      <table border="1" cellpadding="6" cellspacing="0">
        ${row('email', `<code>${esc(a.email)}</code>`)}
        ${a.name ? row('name', esc(a.name)) : ''}
        ${row('stack', a.stack ? esc(a.stack) : 'not given')}
        ${row('use case', a.useCase ? esc(a.useCase) : 'not given')}
        ${row('plan', esc(a.plan))}
        ${row('account', `<code>${esc(a.accountId)}</code>`)}
        ${row('accounts now', `${esc(String(total))} total, and this is number ${esc(String(rank + 1))} today`)}
      </table>
      <p>They have a key and nothing else yet: no job, no ceiling, no call. The next thing that
         has to happen is the console's start screen, and until a job has a ceiling there is
         nothing for a preflight to be checked against.</p>
      <p>The key is not in this email and cannot be: it is shown once, in their browser.</p>
      <p><a href="${ORIGIN}/admin">Open the dashboard</a></p>
    `,
  })

  if (res.error) log.error({ accountId: a.accountId, err: res.error }, 'signup alert was not accepted by Resend')
  else log.info({ accountId: a.accountId }, 'signup alert sent')
}
