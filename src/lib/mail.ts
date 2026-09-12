import type { FastifyBaseLogger } from 'fastify'
import { Resend } from 'resend'
import { sql } from '../db/index.js'
import { ORIGIN } from '../ui/site.js'

// Every email this system sends, and the one ceiling that stands in front of
// the sends a stranger can cause.
//
// ---------------------------------------------------------------------------
// Why this file exists at all
//
// Until 2026-09-12 there were NINE `new Resend(...)` constructions in src, one
// per sender, each with the same three copy-pasted lines reading the same three
// environment variables. Nine clients is not the problem. The problem is that a
// ceiling can only live in a place every sender has to pass through, and there
// was no such place: the tenth sender would have been written the same way as
// the previous nine, with the same direct call, and nothing would have said so.
//
// So the client lives here and only here, and a grep gate in
// scripts/hygiene/run.sh fails on a `new Resend(` anywhere else. That is the
// same shape the repo already uses for the facts it refuses to let drift: one
// head emits every og tag, one file draws the mark, one module exports the
// tokens.
//
// ---------------------------------------------------------------------------
// Two doors, because the two kinds of mail carry different risk
//
// mailOwner() goes to OWNER_ALERT_EMAIL. One address, which exists, which we
// control, and which cannot bounce us into a reputation problem. It has no
// ceiling here; the senders that use it carry their own (a per-reason cooldown,
// a claim row, a daily cap), because what they are protecting is a person's
// attention rather than a sending domain.
//
// mailUser() goes to an address somebody else typed. THAT is the reputation
// surface, and the ceiling below is on it.
//
// ---------------------------------------------------------------------------
// What the ceiling bounds, and what it does not
//
// The incident of 2026-09-11 was DEPTH: the new-network alert mailed ONE
// account about eleven times a minute for two days, 13,835 sends, and Gmail
// delivery for the whole domain fell from 66% to 17%, after which ordinary mail
// bounced as collateral. Worth being exact about the mechanism, because the
// obvious reading is wrong: the flooded account was revreclaim@gmail.com, a
// real deliverable mailbox, so those were overwhelmingly Gmail REFUSING VOLUME
// to an address that exists, not hard bounces to addresses that do not. That
// hole is closed, per network and per key, by PRs #43 and #45.
//
// What was left open is BREADTH: many distinct recipients, one message each,
// which is the shape of an enumeration sweep of /register. Nothing bounded it.
// /register's own limiter is 12 attempts an hour per network, held in one
// machine's memory, and register-limiter.ts's prune() drops the oldest half of
// its buckets above 10,000 keys, handing them a fresh allowance. Across enough
// networks there was no global term at all.
//
// This ceiling is on breadth. It does not bound depth, and it is not a bounce
// rate: the honest instrument for that is Resend's bounce webhook feeding a
// breaker, which is a bigger build and is not here.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const ownerEmail = process.env.OWNER_ALERT_EMAIL
const FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'

/** Whether mail can be sent at all. Callers log their own skip line. */
export const mailerReady = (): boolean => !!resend
export const ownerMailReady = (): boolean => !!resend && !!ownerEmail

export interface Mail {
  subject: string
  html: string
}

/**
 * To OWNER_ALERT_EMAIL. Returns false when the mailer or the address is unset,
 * or when Resend refused it, and never throws.
 */
export async function mailOwner(m: Mail): Promise<boolean> {
  if (!resend || !ownerEmail) return false
  try {
    const res = await resend.emails.send({ from: FROM, to: ownerEmail, subject: m.subject, html: m.html })
    return !res.error
  } catch {
    return false
  }
}

/**
 * To an address the recipient typed themselves.
 *
 * `reason` is not decoration. It says whether this send is one a stranger can
 * cause freely, which is what decides whether the ceiling applies:
 *
 *   'welcome'  POST /register mails whatever address was typed, and anyone can
 *              type any address. This is the only send in the system with a
 *              FREE recipient, so it is the only one the ceiling gates.
 *   'account'  the recipient must already own an account: the recovery link
 *              (recover.ts answers identically and sends nothing when the
 *              address is unknown), the new-network alert, the quota alert.
 *              Breadth is bounded by the account list rather than by us, and
 *              suppressing one of these costs a real person something real: a
 *              recovery link is how a locked-out owner gets back in. Counted,
 *              never refused.
 */
export type MailReason = 'welcome' | 'account'

/**
 * Every reason, and its ceiling, in one table that the type system will not let
 * the next author skip.
 *
 * This is the part that makes the ceiling unforgettable, and it is deliberately
 * stronger than a comment asking to be read. `Record<MailReason, Ceiling>` means
 * adding a member to MailReason without adding a row here does not compile, and
 * `Ceiling` offers only two shapes: a pair of numbers, or an explicit
 * `unbounded` carrying the SENTENCE that justifies it. So the next stranger
 * facing mailer cannot be shipped unbounded by omission. It can still be
 * shipped unbounded on purpose, which is correct: that is a decision, and this
 * makes somebody write it down.
 *
 * WELCOME_PER_DAY = 50, justified against production rather than chosen for
 * feel. The busiest day this system has ever had is 16 accounts (2026-09-11,
 * and ELEVEN of those sixteen had addresses that cannot receive mail at all,
 * because they were ours), the second busiest is 9, and the median day is 0.
 * Fifty is three times the record and more accounts than this product has
 * created in its whole life. From the harm side: a full day pinned at the
 * ceiling is 50 sends against the September incident's 13,835, which is 0.4%
 * of the volume that took the domain's Gmail delivery from 66% to 17%.
 *
 * WELCOME_PER_HOUR = 20, because a receiver reacts to RATE and a day-only
 * ceiling of 50 permits all fifty inside ninety seconds, which is the shape
 * that did the damage: about eleven a minute. Twenty is 2.2x the busiest hour
 * this system has ever had (9, on 2026-09-11 at 20:00 UTC, one dogfood run
 * from one network), and it comfortably clears the 12 that /register's own
 * limiter allows one network on one machine, so a workshop behind one office
 * NAT passes untouched.
 *
 * Both numbers are ceilings on a RANK, and a rank can be read low, so state the
 * overshoot rather than implying there is none. `created_at` defaults to now(),
 * which is transaction_timestamp stamped at BEGIN, and register.ts holds the
 * transaction open for a second round trip before COMMIT, so a later row's rank
 * cannot see earlier rows that are still uncommitted. The worst case is one
 * short of every account-creating transaction the system can hold open at once:
 * `max: 10` in src/db/index.ts times two machines, so 19. The day term can
 * therefore reach 69 and the hour term 39 under maximal concurrency, and in
 * practice both sit at the nominal value, because this product creates about
 * one account a day. Even at 69 a full day is half a percent of the volume that
 * did the damage in September. What the overshoot rules out is the opposite
 * error, and that is why it is the right trade: a count read at a moment can
 * refuse a real user who had room, and a rank never can.
 *
 * Both are numbers a real launch could reach. That is why crossing one mails
 * the owner: the answer to a spike is to raise it and deploy, the answer to a
 * sweep is to leave it, and both need somebody to know.
 *
 * Worth knowing while reading those numbers: 18 of the 36 accounts in
 * production have an address that could never have received the welcome mail we
 * sent it. The largest known source of hard bounces on this domain is not an
 * attacker, it is us verifying our own product, and two of those eighteen were
 * created today doing exactly that.
 */
type Ceiling = { perDay: number; perHour: number } | { unbounded: string }

export const CEILINGS: Record<MailReason, Ceiling> = {
  welcome: { perDay: 50, perHour: 20 },
  account: {
    unbounded:
      'The recipient must already own an account, so breadth is bounded by the accounts table ' +
      'rather than by the caller: /recover answers identically and sends nothing for an address ' +
      'it does not know. And the cost of being wrong is not symmetric. A suppressed recovery link ' +
      'is a silent lockout: the key is the only credential, the console masks every key it ' +
      'renders, /keys/generate needs the key you lost, and /recover cannot tell you the send ' +
      'failed without becoming an account existence oracle. A ceiling that can refuse this would ' +
      'turn a stranger sweeping /register into a customer locked out of their own account.',
  },
}

/** The welcome ceiling, read once so the gate and the copy cannot disagree. */
const welcomeCeiling = (): { perDay: number; perHour: number } => {
  const c = CEILINGS.welcome
  return 'unbounded' in c ? { perDay: Infinity, perHour: Infinity } : c
}

let failureReportedAt = 0
const FAILURE_COOLDOWN_MS = 60 * 60_000

/**
 * This send's own position in the UTC day and in the UTC hour, counting from 0.
 *
 * RANKS, not counts, and the difference is not academic. The obvious version,
 * "how many accounts exist today", is read at a moment, and a moment is the
 * wrong thing to read on a path where the row was committed by a different
 * transaction milliseconds earlier. Measured on Postgres 16 in exactly this
 * geometry, a count-at-a-moment gate fails in BOTH directions under
 * concurrency, and the dominant failure is UNDER-sending: a legitimate signup
 * reads a number inflated by rows that committed after its own and loses its
 * welcome mail while there was room. Overshooting a ceiling by a few is
 * harmless; refusing a real user's mail because of a race is not.
 *
 * A rank cannot do that, because it is a property of THIS row rather than of
 * the instant the query ran: it counts only rows created strictly earlier in
 * the same window, so every send owns one integer per window, and an
 * uncommitted neighbour can only make it smaller. It is the same shape as the
 * cap in signup-alert.ts, measured against production: 2026-09-11's sixteen
 * accounts take day-ranks 0 through 15, one each.
 *
 * The day-rank is also what decides the announcement, so that is one mail per
 * UTC day decided by the database rather than by a cooldown in one machine's
 * memory. Under auto_stop_machines a module cooldown gives somewhere between
 * one notice and one per cold start per machine, which is not a number anybody
 * can reason about.
 *
 * Two honest limits. Both count rows that still exist, so deleting a day's
 * throwaway accounts, which verifying this product does routinely, re-arms the
 * ceiling; that is our own housekeeping, and a sweep's accounts are not ours to
 * delete. And both windows are pinned to UTC in the query rather than left to
 * the session TimeZone, which nothing in src/db sets.
 *
 * Returns nulls when the account row cannot be found, and the caller sends: an
 * unreadable counter must not be able to suppress a real user's mail.
 */
async function welcomeRanks(accountId: string): Promise<{ day: number; hour: number } | null> {
  const [row] = await sql<{ day: number; hour: number }[]>`
    WITH me AS (SELECT created_at FROM accounts WHERE id = ${accountId})
    SELECT (SELECT count(*)::int FROM accounts, me
             WHERE accounts.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
               AND accounts.created_at < me.created_at) AS day,
           (SELECT count(*)::int FROM accounts, me
             WHERE accounts.created_at >= date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
               AND accounts.created_at < me.created_at) AS hour
    FROM me
  `
  return row ? { day: row.day, hour: row.hour } : null
}

/**
 * Never throws. Returns false when nothing was sent, for any reason, and the
 * caller logs that: a send that fails silently is how the Polar webhook
 * rejected every real payment for months.
 *
 * The ceiling check reads a count at a moment, so concurrent sends can overshoot
 * it by the number in flight. That is stated rather than fixed: the purpose here
 * is to bound an order of magnitude, and a lock or a serializable transaction on
 * a path that must never fail would be a worse trade than an overshoot of a
 * handful.
 */
export async function mailUser(
  log: FastifyBaseLogger,
  reason: MailReason,
  to: string,
  m: Mail,
  accountId?: string,
): Promise<boolean> {
  if (!resend) {
    log.warn({ reason }, 'user mail not sent: RESEND_API_KEY is unset')
    return false
  }

  // Only 'welcome' is gated, and only when the caller handed over the row this
  // send belongs to. Without an accountId there is no rank to be, and the send
  // goes: a ceiling that cannot identify its own row has no business refusing.
  if (reason === 'welcome' && accountId) {
    const { perDay, perHour } = welcomeCeiling()
    const r = await welcomeRanks(accountId)
    const overDay = r !== null && r.day >= perDay
    const overHour = r !== null && r.hour >= perHour
    if (r !== null && (overDay || overHour)) {
      const window = overDay ? 'day' : 'hour'
      log.warn({ reason, day: r.day, hour: r.hour, window }, 'welcome mail suppressed: past the ceiling')
      // Exactly one announcement per window, decided by the row rather than by
      // a clock: only one send in a UTC day has day-rank perDay, and only one
      // in a UTC hour has hour-rank perHour.
      if (r.day === perDay || (!overDay && r.hour === perHour)) {
        void announceCeiling(log, window, overDay ? r.day + 1 : r.hour + 1)
      }
      return false
    }
  }

  try {
    const res = await resend.emails.send({ from: FROM, to, subject: m.subject, html: m.html })
    if (res.error) {
      log.error({ reason, err: res.error }, 'user mail was not accepted by Resend')
      void reportFailure(log, reason, String((res.error as { message?: string }).message ?? res.error))
      return false
    }
    return true
  } catch (err) {
    log.error({ reason, err }, 'user mail threw')
    void reportFailure(log, reason, err instanceof Error ? err.message : 'threw')
    return false
  }
}

/**
 * A failed send to a real person reaches a person.
 *
 * This exists because of what /recover cannot say. Its page answers identically
 * for a known and an unknown address, on purpose, so that the form is not an
 * account-existence oracle; the consequence is that it tells every visitor "a
 * link is on its way" and has no branch in which it can say otherwise. When the
 * send then fails, the user waits for a mail that is not coming, and the only
 * record was a log line. That is a silent lockout on the one path whose whole
 * job is to end one, and it is the same defect as the Polar webhook branch that
 * returned a status and told nobody for months.
 *
 * Only 'account' sends are worth waking someone for. A failed 'welcome' costs a
 * duplicate of what the screen already said; a failed recovery link costs
 * somebody their account until they write to us. No recipient address is
 * included: the owner can find the attempt in the logs, and an address in an
 * alert is an address in a second mailbox.
 *
 * One an hour, in module memory, which is the right tool here for once: if
 * Resend is refusing everything then this mail fails too, and the honest
 * failure mode of an outage is a few duplicate notices rather than silence.
 */
async function reportFailure(log: FastifyBaseLogger, reason: MailReason, detail: string): Promise<void> {
  if (reason !== 'account') return
  const now = Date.now()
  if (now - failureReportedAt < FAILURE_COOLDOWN_MS) return
  failureReportedAt = now
  const ok = await mailOwner({
    subject: 'AgentBill: a mail somebody is waiting for did not go out',
    html: `
      <p>A send to a customer's own address was refused. This matters because the pages that
         trigger these cannot say so: /recover answers "a link is on its way" for every address,
         known or not, so that it is not an account-existence oracle, and a visitor whose link
         never arrives has no way to tell the difference.</p>
      <p><b>What Resend said:</b> ${detail.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
      <p>The three sends this covers are the recovery link, the new-network alert and the quota
         warning. Check the logs for the attempt, and check the sending domain's standing in
         Resend: a reputation problem shows up here first.</p>
      <p><a href="${ORIGIN}/admin">Open the dashboard</a></p>
    `,
  })
  if (!ok) log.error({ reason }, 'the failed-send notice itself did not go out')
}

/**
 * The owner hears that the ceiling is holding, at most every six hours.
 *
 * Module memory on purpose, and it is the one place in this file where that is
 * the right tool: there are two machines and they cold-start, so the worst case
 * is a handful of duplicate notices a day. Over-announcing a sweep costs the
 * owner an email. Under-announcing it means a real launch lost its welcome mail
 * and nobody knew, which is the failure this whole file is about.
 */
async function announceCeiling(log: FastifyBaseLogger, window: 'day' | 'hour', sent: number): Promise<void> {
  const { perDay, perHour } = welcomeCeiling()
  const ceiling = window === 'day' ? perDay : perHour
  const ok = await mailOwner({
    subject: `AgentBill: past ${ceiling} signups this ${window}, welcome mail is paused`,
    html: `
      <p>${sent} accounts have been created in the last UTC ${window}, past the ceiling of
         ${ceiling} welcome mails per ${window}. Accounts are still being created and keys are
         still being issued; only the welcome note is paused, and everything it says is already on
         the screen that showed the key and on a public URL.</p>
      <p>If this is a real spike, raise <code>WELCOME_PER_${window === 'day' ? 'DAY' : 'HOUR'}</code>
         in <code>src/lib/mail.ts</code> and deploy. If it is a sweep of /register, leave it and
         look at the new rows.</p>
      <p>The ceiling exists because welcome mail goes to whatever address was typed, and our
         sending domain is shared with every alert, including this one. The hourly term is there
         because a receiver reacts to rate: in September, 8,180 of 13,835 messages were refused at
         about eleven a minute and the domain's delivery fell from 66% to 17%.</p>
      <p><a href="${ORIGIN}/admin">Open the dashboard</a></p>
    `,
  })
  if (!ok) log.error({ window }, 'welcome ceiling notice was not sent')
}
