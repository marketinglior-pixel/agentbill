import type { FastifyInstance, FastifyRequest, FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { createHash, randomBytes } from 'crypto'
import { sql } from '../db/index.js'
import { publicRoute } from '../middleware/auth.js'
import { sameOrigin } from './app.js'
import { docsShell } from '../ui/docs.js'
import { limiterKey } from '../lib/client-ip.js'
import { allowRecoverAttempt, recoveryInCooldown, markRecoverySent, clearRecoveryMark } from '../lib/register-limiter.js'
import { ORIGIN } from '../ui/site.js'
import { mailUser } from '../lib/mail.js'

// Getting back into an account whose key is gone.
//
// The API key is shown once, in the browser, and it is also the console
// password: /app authenticates by pasting it. So closing that tab used to end
// the account, and the only route back was mailing a human and asking them to
// rotate it by hand.
//
// This adds no second secret. There is still one credential on an account, the
// API key. What this flow proves is control of the registered mailbox, and it
// then offers exactly two things, because a lost key and a leaked key are
// opposite problems:
//
//   reveal   you lost your copy. Whatever is deployed keeps running.
//   replace  the key may have leaked. It stops working now, and the account
//            gets a new one. Anything still using the old key is refused until
//            it is redeployed, which is the point.
//
// A previous version of this mailed the live API key to whoever typed the
// address into the register form. That reached the owner's mailbox rather than
// the sender's, so it was not directly stealable, but it deposited a permanent
// bearer credential in a mailbox on a stranger's trigger, and it left it there
// forever. Nothing in this file ever puts a key in an email.

const SUPPORT_EMAIL = 'hello@agentbill.dev'

/** Long enough to read the mail and click, short enough that a stale link in a
 *  mailbox is not a standing key to the account. */
const TTL_MINUTES = 60

const RequestBody = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
})

// base64url of 32 bytes. Checked before it reaches a query, so a malformed
// token costs one regex rather than a database round trip.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

function generateApiKey(): string {
  return 'agb_' + randomBytes(24).toString('hex')
}

/**
 * Mint a link for an account, retiring that account's other outstanding links
 * first so a mailbox cannot accumulate a stack of live keys to the same door.
 * Returns the raw token, which exists in memory here and in one email, and is
 * never stored.
 */
/**
 * Has this account already been sent a recovery link in the last hour?
 *
 * Read from `account_recovery_tokens`, not from module memory, and that is the
 * whole point of the function. `recoveryInCooldown` intends exactly this and
 * delivers something weaker: its Map is per process, so with two Fly machines
 * the real allowance is two an hour, and `auto_stop_machines = 'stop'` zeroes it
 * on every cold start, which makes the true figure unbounded rather than 1.
 *
 * That matters because a STRANGER drives this mail. POST /register's
 * existing-account branch, and POST /recover itself, both mail a recovery link
 * to any address a stranger types, as long as that address already has an
 * account. Breadth is bounded by the accounts table; depth per mailbox was
 * bounded only by that leaky Map. Depth to a real mailbox is precisely the
 * shape of the September incident, where about eleven messages a minute to one
 * genuine Gmail address took the whole domain's delivery from 66% to 17%.
 *
 * This makes the intent true rather than adding a new ceiling, and the
 * direction is important: nothing a legitimate locked-out owner could do
 * before is refused now. They need one link, and one link is what this permits.
 * The row is written by mintToken before the send, so a refused send still
 * counts, which is deliberate: the thing being rationed is mail aimed at a
 * mailbox, and an attempt that Resend rejected still aimed at it.
 */
async function recoveryMailedRecently(accountId: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM account_recovery_tokens
    WHERE account_id = ${accountId} AND created_at > NOW() - INTERVAL '1 hour'
  `
  return (row?.n ?? 0) > 0
}

async function mintToken(accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await sql.begin(async (tx) => {
    await tx`
      UPDATE account_recovery_tokens
      SET consumed_at = NOW()
      WHERE account_id = ${accountId} AND consumed_at IS NULL
    `
    await tx`
      INSERT INTO account_recovery_tokens (account_id, token_hash, expires_at)
      VALUES (${accountId}, ${hashToken(token)}, NOW() + (${TTL_MINUTES} * INTERVAL '1 minute'))
    `
  })
  return token
}

/**
 * Spend a token. The check and the write are one statement, so two requests
 * racing the same link cannot both win, and the deadline is compared by the
 * database clock rather than this process's.
 */
async function consumeToken(token: string): Promise<string | null> {
  const [row] = await sql`
    UPDATE account_recovery_tokens
    SET consumed_at = NOW()
    WHERE token_hash = ${hashToken(token)}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING account_id
  `
  return row ? (row.accountId as string) : null
}

/** Is this link still spendable? Read only, because an email scanner will GET
 *  the link before the person does and must not burn it. */
async function tokenIsLive(token: string): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 AS ok FROM account_recovery_tokens
    WHERE token_hash = ${hashToken(token)}
      AND consumed_at IS NULL
      AND expires_at > NOW()
  `
  return Boolean(row)
}

async function sendRecoveryEmail(log: FastifyBaseLogger, email: string, token: string): Promise<boolean> {
  const link = `${ORIGIN}/recover/${token}`
  // reason 'account', not 'welcome': /recover answers identically for an
  // unknown address and sends nothing (the POST handler returns before minting
  // when no account matches), so the recipient of this mail always already owns
  // an account and breadth is bounded by the account list rather than by us.
  // It is counted and never refused, because this mail is the only way a
  // locked-out owner gets back in, and a ceiling that can refuse it would turn
  // a sweep by a stranger into a lockout for a customer.
  return mailUser(log, 'account', email, {
    subject: 'Get back into your AgentBill account',
    html: `
        <p>Someone asked for a way back into the AgentBill account registered to this address.</p>
        <p><a href="${link}">Open this link</a> to see your current API key, or to replace it with a new one.</p>
        <p>It works once and expires in ${TTL_MINUTES} minutes. It carries no key of its own.</p>
        <p>If this was not you, nothing has happened yet and you can ignore this. The link
           expires on its own, and your key has not changed.</p>
        <p>Questions: ${SUPPORT_EMAIL}</p>
      `,
  })
}

/**
 * Mint a link and mail it. The one entry point for anything outside this file,
 * so /register cannot grow a second, subtly different recovery path (which is
 * how the old raw-key mail survived as long as it did). Returns whether Resend
 * accepted the send; callers must not tell an unauthenticated visitor which it
 * was, because that answers whether the address has an account.
 */
export async function sendRecoveryLink(log: FastifyBaseLogger, email: string, accountId: string): Promise<boolean> {
  if (await recoveryMailedRecently(accountId)) {
    log.info({ accountId }, 'recovery link not sent: one already went out within the hour')
    return true
  }
  const token = await mintToken(accountId)
  return sendRecoveryEmail(log, email, token)
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function page(title: string, body: string): string {
  return docsShell({
    path: '/recover',
    title: `${title} · AgentBill`,
    description: 'Get back into your AgentBill account if you no longer have your API key.',
    current: '',
    rail: false,
    css: `
    .rec { max-width: 46ch; }
    .rec form { display: grid; gap: var(--s2); margin-block: var(--s4); }
    .rec label { font-weight: 600; color: var(--text); }
    .rec input { min-height: 44px; background: var(--bg); color: var(--text);
                 border: 1px solid var(--border-strong); border-radius: var(--r-control);
                 padding: 0 14px; font-family: var(--sans); font-size: var(--fs-body); }
    .rec input::placeholder { color: var(--dim); }
    .rec input:focus-visible { outline: 2px solid var(--green); outline-offset: 1px; }
    .rec .btn, .rec .btn-ghost { min-height: 44px; border-radius: var(--r-control); padding: 0 22px;
                 font-family: var(--sans); font-size: var(--fs-body); font-weight: 700; cursor: pointer;
                 justify-self: start; }
    .rec .btn { background: var(--green); color: var(--green-ink); border: 0; }
    .rec .btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border-strong); }
    .rec .choice { border-top: 1px solid var(--border-soft); padding-top: var(--s4); margin-top: var(--s4); }
    .rec .keyout { font-family: var(--mono); font-size: var(--fs-small); color: var(--code-ink);
                   background: var(--surface2); border: 1px solid var(--border-soft);
                   border-radius: var(--r-frame); padding: 14px 18px; overflow-wrap: anywhere; }
    .rec .fine { color: var(--dim); font-size: var(--fs-small); }
`,
    body: `<div class="rec">
${body}
</div>`,
  })
}

/** Nothing on this path may be cached, and the token must not travel offsite in
 *  a Referer. same-origin rather than no-referrer on purpose: under no-referrer
 *  browsers send Origin: null on the page's own POSTs, which is what made every
 *  real-browser login to /app 403 while curl passed. */
function secure(reply: any) {
  return reply
    .type('text/html')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'same-origin')
    .header('X-Robots-Tag', 'noindex')
    .header('X-Content-Type-Options', 'nosniff')
}

const deadLink = `
  <h1>This link has expired.</h1>
  <p class="lede">A recovery link works once and lasts ${TTL_MINUTES} minutes. This one has been
     used already, or it has run out.</p>
  <p><a href="/recover">Ask for a new one</a>. Your key has not changed.</p>`

export async function recoverRoute(app: FastifyInstance) {
  app.get('/recover', publicRoute(), async (request, reply) => {
    const sent = (request.query as Record<string, unknown>)?.sent === '1'
    if (sent) {
      return secure(reply).send(page('Check your inbox', `
  <h1>Check your inbox.</h1>
  <p class="lede">If that address has an AgentBill account, a link is on its way. It works once
     and expires in ${TTL_MINUTES} minutes.</p>
  <p class="fine">Nothing has changed on your account yet, and the mail carries no key.
     Not arrived in a few minutes? Check spam, then write to
     <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`))
    }
    return secure(reply).send(page('Recover access', `
  <h1>Get back into your account.</h1>
  <p class="lede">Your API key is shown once when you register, and it is also how you open the
     console. If you no longer have it, put in the address you registered with.</p>
  <form method="POST" action="/recover">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" placeholder="you@company.com" required autocomplete="email" autofocus />
    <button class="btn" type="submit">Send me a link</button>
  </form>
  <p class="fine">The link works once and expires in ${TTL_MINUTES} minutes. It carries no key.</p>`))
  })

  app.post('/recover', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    if (!allowRecoverAttempt(limiterKey(request))) {
      return secure(reply).code(429).send(page('Too many attempts', `
  <h1>Too many attempts.</h1>
  <p class="lede">This address has asked for too many recovery links in the last hour.
     Try again later, or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`))
    }

    const parsed = RequestBody.safeParse(request.body)

    // One answer, whatever happened. A different response for a known address
    // would turn this form into an account-existence oracle for any list of
    // emails. The work below is fire and forget for the same reason: waiting on
    // Resend would make a known address measurably slower than an unknown one.
    const done = () => reply.redirect('/recover?sent=1', 303)
    if (!parsed.success) return done()

    const email = parsed.data.email
    const [account] = await sql`SELECT id FROM accounts WHERE email = ${email}`
    if (!account) return done()
    if (recoveryInCooldown(email)) return done()

    markRecoverySent(email)
    void (async () => {
      try {
        // The durable half of the same cooldown, and the one that actually
        // holds: the Map above is per machine and is zeroed by a cold start.
        if (await recoveryMailedRecently(account.id as string)) {
          request.log.info({ accountId: account.id }, 'recovery link not sent: one already went out within the hour')
          return
        }
        const token = await mintToken(account.id as string)
        const ok = await sendRecoveryEmail(request.log, email, token)
        if (!ok) {
          // The contract register-limiter.ts states in its own words: "a failed
          // send must not block the next attempt (or claim an email that never
          // went out)." Both call sites armed the mark before the send and
          // neither cleared it, so one refusal by Resend, which is exactly the
          // state a degraded sending domain produces, silently locked the
          // address out of recovery for an hour.
          clearRecoveryMark(email)
          request.log.error({ email }, 'recovery email was not accepted by Resend')
        }
      } catch (err) {
        clearRecoveryMark(email)
        request.log.error({ err }, 'recovery link could not be minted')
      }
    })()

    return done()
  })

  // Read only, deliberately. Mail clients and link scanners GET this before the
  // person does, and a single-use token consumed by a scanner is a link that is
  // already dead when its owner clicks it. Spending it needs the POST below.
  app.get('/recover/:token', publicRoute(), async (request, reply) => {
    const token = (request.params as { token: string }).token
    if (!TOKEN_RE.test(token) || !(await tokenIsLive(token))) {
      return secure(reply).code(410).send(page('Link expired', deadLink))
    }

    return secure(reply).send(page('Recover access', `
  <h1>You are back in.</h1>
  <p class="lede">This link is good for one of the two things below, then it stops working.</p>

  <div class="choice">
    <h2>Lost your copy of the key</h2>
    <p>Nothing has leaked, you just do not have it any more. Whatever is already deployed
       keeps running on it.</p>
    <form method="POST" action="/recover/${token}">
      <input type="hidden" name="action" value="reveal" />
      <button class="btn" type="submit">Show my key</button>
    </form>
  </div>

  <div class="choice">
    <h2>The key may have leaked</h2>
    <p>The account gets a new key and the old one stops working straight away. Any agent still
       calling with the old key is refused until you deploy the new one.</p>
    <form method="POST" action="/recover/${token}">
      <input type="hidden" name="action" value="replace" />
      <button class="btn-ghost" type="submit">Replace my key</button>
    </form>
  </div>`))
  })

  app.post('/recover/:token', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })

    const token = (request.params as { token: string }).token
    const action = (request.body as Record<string, unknown>)?.action
    if (!TOKEN_RE.test(token) || (action !== 'reveal' && action !== 'replace')) {
      return secure(reply).code(410).send(page('Link expired', deadLink))
    }

    const accountId = await consumeToken(token)
    if (!accountId) return secure(reply).code(410).send(page('Link expired', deadLink))

    if (action === 'reveal') {
      // Every key still good, because an account may hold more than one and the
      // reader needs whichever one their deployment is using.
      const rows = await sql`
        SELECT api_key, label FROM developer_api_keys
        WHERE account_id = ${accountId}
          AND (revoked_at IS NULL OR revoked_at > NOW())
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at ASC
      `
      if (!rows.length) {
        // Recoverable rather than a dead end: the account is real, it simply has
        // nothing live to show, so mint one instead of sending them away.
        const fresh = generateApiKey()
        await sql`
          INSERT INTO developer_api_keys (account_id, api_key, label)
          VALUES (${accountId}, ${fresh}, 'recovered')
        `
        return secure(reply).send(page('Your API key', keyPage([{ apiKey: fresh, label: 'recovered' }],
          'This account had no active key left, so here is a new one.')))
      }
      return secure(reply).send(page('Your API key', keyPage(rows as any,
        rows.length > 1 ? 'Every key currently active on the account.' : '')))
    }

    // Replace. Revoke NOW rather than with the 24h grace /keys/rotate uses:
    // this branch exists for a key that may be in someone else's hands, and a
    // grace window is exactly what you do not want there. Someone who only lost
    // their copy has the other button.
    const fresh = generateApiKey()
    await sql.begin(async (tx) => {
      await tx`
        UPDATE developer_api_keys
        SET revoked_at = NOW()
        WHERE account_id = ${accountId} AND (revoked_at IS NULL OR revoked_at > NOW())
      `
      await tx`
        INSERT INTO developer_api_keys (account_id, api_key, label)
        VALUES (${accountId}, ${fresh}, 'recovered')
      `
    })
    request.log.info({ accountId }, 'account key replaced through recovery')
    return secure(reply).send(page('Your new API key', keyPage([{ apiKey: fresh, label: 'recovered' }],
      'The old key stopped working just now. Deploy this one wherever the old one was.')))
  })
}

/**
 * The key, and the line that sets it, both with nothing left to fill in.
 *
 * The export line is here because of what /register cannot do. /register#done
 * is a client-side replaceState over /register, so the prefilled line it shows
 * is gone the moment the reader reloads or navigates, and the console will not
 * print it: it masks every key it renders. Until 2026-09-12 the console told
 * the reader to go and use "the export line on the screen that showed your
 * key", which by then was a screen with no way back, and the only surface that
 * could have ended that loop said "store it in an environment variable" and
 * left the reader to retype it. This page already holds the plaintext key, so
 * it costs one line to be the answer instead of a second pointer.
 *
 * Both blocks are complete on purpose. A gap in a line a reader copies is how a
 * key became agb_agb_... and a 401 on a first run (2026-09-09).
 */
function keyPage(keys: { apiKey: string; label: string | null }[], note: string): string {
  return `
  <h1>Here is your key.</h1>
  <p class="lede">Copy it now. This page will not show it again, and the link you used is spent.
     ${note}</p>
  ${keys.map((k) => `<p class="keyout">${k.apiKey}</p>`).join('\n  ')}
  <p>Nothing here needs it pasted back in: your code is what sends it, with every call. In Python or
     Node that means <code>AGENTBILL_API_KEY</code>, set in the terminal your code runs in, and this
     line does it with the key already in place:</p>
  ${keys.map((k) => `<p class="keyout">export AGENTBILL_API_KEY=${k.apiKey}</p>`).join('\n  ')}
  <p>No terminal? Pass the key to <code>AgentBillClient(api_key=...)</code>, or send it as an
     <code>Authorization: Bearer</code> header from whatever makes the call. The same value opens
     <a href="/app">your console</a>, which asks for it once and then does not show it.</p>
  <p class="fine">Lost it again? <a href="/recover">Ask for another link</a>.</p>`
}
