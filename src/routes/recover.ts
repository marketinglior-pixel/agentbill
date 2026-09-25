import type { FastifyInstance, FastifyRequest, FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { createHash, randomBytes } from 'crypto'
import { sql } from '../db/index.js'
import { publicRoute } from '../middleware/auth.js'
import { sameOrigin } from './app.js'
import { docsShell } from '../ui/docs.js'
import { BP } from '../ui/theme.js'
import { limiterKey } from '../lib/client-ip.js'
import { allowRecoverAttempt, recoveryInCooldown, markRecoverySent, clearRecoveryMark } from '../lib/register-limiter.js'
import { ORIGIN } from '../ui/site.js'
import { mailUser } from '../lib/mail.js'
import { insertKey } from '../lib/api-keys.js'

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
//   add      you lost your copy. The account gets a NEW key, shown once, and
//            every key it already had keeps working, so whatever is deployed
//            keeps running.
//   replace  the key may have leaked. Every key on the account stops working
//            now, and the account gets a new one. Anything still using an old
//            key is refused until it is redeployed, which is the point.
//
// Until 2026-09-25 the first choice was "reveal": it showed the existing key.
// It cannot any more, and must not: since migration 026 the server looks keys
// up by a hash (src/lib/api-keys.ts), and a key is shown once, when it is
// made. So recovery makes one. A form rendered before that change and posted
// after it says action=reveal; it is read as add, which is what the reader of
// that page wanted (a key in hand, nothing deployed broken).
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

/** One account this address can recover, and why it matched. */
type Recoverable = { id: string; via: 'registered' | 'signin' }

/**
 * Every account an address owns, for recovery (security batch C,
 * 2026-09-25). Two ways, and until now only the first was looked at:
 *
 *   registered  accounts.email is the address: the register form, or a
 *               sign-in whose address was free.
 *   signin      the account's owner (accounts.owner_user_id) is the person
 *               whose verified users.email is the address. A sign-in whose
 *               address an unverified legacy account already held creates its
 *               account with accounts.email NULL (src/lib/users.ts), so this
 *               is the only way to find that account by its address.
 *
 * accounts.email, users.email and owner_user_id are each UNIQUE, so this is
 * at most two accounts, and one when both ways reach the same one.
 */
async function recoverableAccounts(email: string): Promise<Recoverable[]> {
  const rows = await sql`
    SELECT a.id, (a.email IS NOT DISTINCT FROM ${email}) AS registered
    FROM accounts a
    LEFT JOIN users u ON u.id = a.owner_user_id
    WHERE a.email = ${email} OR u.email = ${email}
    ORDER BY a.created_at, a.id
  `
  return rows.map((r) => ({ id: r.id as string, via: r.registered ? 'registered' as const : 'signin' as const }))
}

async function sendRecoveryEmail(log: FastifyBaseLogger, email: string, links: { token: string; via: Recoverable['via'] }[]): Promise<boolean> {
  const url = (t: string) => `${ORIGIN}/recover/${t}`
  const label = (via: Recoverable['via']) => via === 'registered'
    ? 'The account registered with this address'
    : 'The account you sign in to as this address (Google, GitHub or an email link)'
  // One account: the mail it always was. Two: one link each, in one mail,
  // because one mail per account would double what a stranger can aim at
  // this mailbox.
  const body = links.length === 1
    ? `<p><a href="${url(links[0]!.token)}">Open this link</a> to get a new API key. You choose there whether the keys you have now keep working.</p>
        <p>It works once and expires in ${TTL_MINUTES} minutes. It carries no key of its own.</p>`
    : `<p>This address has ${links.length} AgentBill accounts. Each link opens one of them, and gets it a new API key; you choose there whether the keys it has now keep working.</p>
        <ul>${links.map((l) => `<li>${label(l.via)}: <a href="${url(l.token)}">open this link</a></li>`).join('')}</ul>
        <p>Each works once and expires in ${TTL_MINUTES} minutes. None carries a key of its own.</p>`
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
        <p>Someone asked for a way back into the AgentBill account${links.length === 1 ? '' : 's'} of this address.</p>
        ${body}
        <p>If this was not you, nothing has happened yet and you can ignore this. The link${links.length === 1 ? '' : 's'}
           expire${links.length === 1 ? 's' : ''} on ${links.length === 1 ? 'its' : 'their'} own, and your key has not changed.</p>
        <p>Questions: ${SUPPORT_EMAIL}</p>
      `,
  })
}

/**
 * Mint a link for every account this address owns that has not been sent one
 * within the hour, and mail them in one message. The one entry point, so no
 * caller can grow a second, subtly different recovery path (which is how the
 * old raw-key mail survived as long as it did). 'none' when the address owns
 * nothing (nothing is sent), 'cooldown' when every account it owns was sent a
 * link within the hour. Callers must not tell an unauthenticated visitor
 * which it was, because that answers whether the address has an account.
 */
export async function sendRecoveryLinks(log: FastifyBaseLogger, email: string): Promise<'none' | 'cooldown' | 'sent' | 'refused'> {
  const accounts = await recoverableAccounts(email)
  if (accounts.length === 0) return 'none'
  const links: { token: string; via: Recoverable['via'] }[] = []
  for (const a of accounts) {
    // The durable half of the cooldown, per account: the Map in the route is
    // per machine and is zeroed by a cold start.
    if (await recoveryMailedRecently(a.id)) {
      log.info({ accountId: a.id }, 'recovery link not sent: one already went out within the hour')
      continue
    }
    links.push({ token: await mintToken(a.id), via: a.via })
  }
  if (links.length === 0) return 'cooldown'
  return (await sendRecoveryEmail(log, email, links)) ? 'sent' : 'refused'
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * `band` is for a message and nothing else: the link was sent, refused, or is
 * spent. Those render in the kit's closing band (.cv-close), the one /thanks
 * uses, so every done or dead end on the site looks the same. The form, the
 * two choices and the key page are pages with work on them and stay in the
 * column.
 */
function page(title: string, body: string, band = false): string {
  return docsShell({
    path: '/recover',
    title: `${title} · AgentBill`,
    description: 'Get back into your AgentBill account if you no longer have your API key.',
    current: '',
    rail: false,
    // No sticky signup bar on a phone. Whoever is here has an account and has
    // lost its key; on the key page the bar sat over the "your console" line.
    // The nav keeps its button on a desktop, as it does on /terms.
    sticky: false,
    css: `
    /* Canvas, 2026-09-23. The form sits on the warm-grey panel with white
       fields, the recipe /register and the homepage's estimator use; the two
       choices a recovery link offers are two white cards on that panel, side
       by side, the lesser one (replace) on the outlined pill. A key and the
       line that sets it are on the kit's plate (.cv-plate), the shape the key
       screen on /register gives the same two values; no Copy here, because
       this page ships no script. A message (sent, refused, spent) is the
       kit's closing band at the column's full width. Every value is a token,
       every control the kit's. */
    /* 880 so the two choice cards sit side by side; the prose keeps its own
       measure (54ch from the docs shell, the lede 52ch). */
    .rec { max-width: 880px; }
    .rec.cv-close { max-width: none; }
    .rec .lede { max-width: 52ch; }
    .rec-form { display: grid; gap: 0; max-width: 520px; margin-block: var(--s5) var(--s4);
                background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s5); }
    .rec-form .btn { justify-self: start; margin-top: var(--s4); }
    .rec .choices { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--s4);
                    margin-top: var(--s6); }
    /* A column, so each card's button sits on the card's floor and the two
       line up whatever the paragraph above them runs to. */
    .rec .choice { padding: var(--s5); display: flex; flex-direction: column; gap: var(--s3); }
    .rec .choice h2 { font-size: var(--fs-h3); letter-spacing: -0.01em; margin: 0; }
    .rec .choice p { font-size: var(--fs-small); margin: 0; }
    .rec .choice form { margin-top: auto; padding-top: var(--s2); }
    /* The two buttons say what happens to the old keys, in words, so at 320
       and 390 they are longer than the card: they wrap inside it instead of
       running out of it (measured 2026-09-25, cut off at "keep w"). */
    .rec .choice button { white-space: normal; max-width: 100%; text-align: center; line-height: 1.35; height: auto; min-height: 44px; }
    /* Code in a sentence: the docs' inline chip, for the bare code the key
       page writes (AGENTBILL_API_KEY, the client call, the header). */
    .rec p code { font-family: var(--mono); background: var(--surface3); padding: 2px 6px; border-radius: var(--r-inline);
                  font-size: .875em; color: var(--text); overflow-wrap: anywhere; }
    .rec .cv-plate { max-width: 640px; margin-block: var(--s4) var(--s5); }
    .rec .fine { color: var(--dim); font-size: var(--fs-small); }
    @media (max-width: ${BP.md}px) {
      .rec-form { padding: var(--s4); }
      .rec .choices { grid-template-columns: minmax(0, 1fr); }
      .rec .choice { padding: 20px var(--s4); }
    }
`,
    body: `<div class="rec${band ? ' cv-close' : ''}">
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
     <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`, true))
    }
    return secure(reply).send(page('Recover access', `
  <h1>Get back into your account.</h1>
  <p class="lede">An API key is shown once, when it is made. If you no longer have yours, put in the
     address you registered with and we will send a link that makes you a new one.</p>
  <form class="rec-form" method="POST" action="/recover">
    <label class="cv-flabel" for="email">Email</label>
    <input class="cv-field" id="email" name="email" type="email" placeholder="you@company.com" required autocomplete="email" autofocus />
    <button class="btn btn-lg" type="submit">Send me a link</button>
  </form>
  <p class="fine">The link works once and expires in ${TTL_MINUTES} minutes. It carries no key.</p>`))
  })

  app.post('/recover', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    if (!allowRecoverAttempt(limiterKey(request))) {
      return secure(reply).code(429).send(page('Too many attempts', `
  <h1>Too many attempts.</h1>
  <p class="lede">This address has asked for too many recovery links in the last hour.
     Try again later, or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>`, true))
    }

    const parsed = RequestBody.safeParse(request.body)

    // One answer, whatever happened. A different response for a known address
    // would turn this form into an account-existence oracle for any list of
    // emails. The work below is fire and forget for the same reason: waiting on
    // Resend would make a known address measurably slower than an unknown one.
    const done = () => reply.redirect('/recover?sent=1', 303)
    if (!parsed.success) return done()

    const email = parsed.data.email
    if (recoveryInCooldown(email)) return done()

    // Every account the address owns, looked up inside the fire-and-forget
    // work, so a known address and an unknown one answer in the same time
    // with the same redirect (the lookup used to sit before the answer).
    markRecoverySent(email)
    void (async () => {
      try {
        const outcome = await sendRecoveryLinks(request.log, email)
        if (outcome === 'none') {
          // Nothing owned, nothing sent: the mark must not hold the address
          // for an hour against an account it may own a minute from now.
          clearRecoveryMark(email)
          return
        }
        if (outcome === 'refused') {
          // The contract register-limiter.ts states in its own words: "a failed
          // send must not block the next attempt (or claim an email that never
          // went out)." Both call sites armed the mark before the send and
          // neither cleared it, so one refusal by Resend, which is exactly the
          // state a degraded sending domain produces, silently locked the
          // address out of recovery for an hour.
          clearRecoveryMark(email)
          request.log.error('recovery email was not accepted by Resend')
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
      return secure(reply).code(410).send(page('Link expired', deadLink, true))
    }

    return secure(reply).send(page('Recover access', `
  <h1>You are back in.</h1>
  <p class="lede">Either way you get a new API key, shown once on the next screen. An existing key is
     never shown again. This link is good for one of the two, then it stops working.</p>

  <div class="cv-panel choices">
  <div class="cv-card choice">
    <h2>Lost your copy of the key</h2>
    <p>Nothing has leaked, you just do not have it any more. You get a new key, and the keys the
       account already has keep working, so whatever is deployed keeps running.</p>
    <form method="POST" action="/recover/${token}">
      <input type="hidden" name="action" value="add" />
      <button class="btn" type="submit">Get a new key (the old ones keep working)</button>
    </form>
  </div>

  <div class="cv-card choice">
    <h2>The key may have leaked</h2>
    <p>You get a new key and every key the account had stops working straight away. Any agent still
       calling with an old key is refused until you deploy the new one.</p>
    <form method="POST" action="/recover/${token}">
      <input type="hidden" name="action" value="replace" />
      <button class="btn-ghost" type="submit">Replace my key (the old ones stop working)</button>
    </form>
  </div>
  </div>`))
  })

  app.post('/recover/:token', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })

    const token = (request.params as { token: string }).token
    const said = (request.body as Record<string, unknown>)?.action
    // 'reveal' is the choice a page rendered before 2026-09-25 posts; it is
    // read as 'add' (see the top of this file).
    const action = said === 'replace' ? 'replace' : said === 'add' || said === 'reveal' ? 'add' : null
    if (!TOKEN_RE.test(token) || !action) {
      return secure(reply).code(410).send(page('Link expired', deadLink, true))
    }

    const accountId = await consumeToken(token)
    if (!accountId) return secure(reply).code(410).send(page('Link expired', deadLink, true))

    if (action === 'add') {
      // A new key beside the ones the account has. Nothing is revoked.
      const minted = await insertKey(sql, { accountId, label: 'recovered' })
      request.log.info({ accountId }, 'account key added through recovery')
      return secure(reply).send(page('Your new API key', keyPage(minted.key,
        'The keys this account already had still work.')))
    }

    // Replace. Revoke NOW rather than with the grace /keys/rotate gives: this
    // branch exists for a key that may be in someone else's hands, and a grace
    // window is exactly what you do not want there. Someone who only lost
    // their copy has the other button. One transaction, so there is never a
    // moment with the old keys dead and no new one.
    const minted = await sql.begin(async (tx) => {
      await tx`
        UPDATE developer_api_keys
        SET revoked_at = NOW()
        WHERE account_id = ${accountId} AND (revoked_at IS NULL OR revoked_at > NOW())
      `
      return insertKey(tx, { accountId, label: 'recovered' })
    })
    request.log.info({ accountId }, 'account key replaced through recovery')
    return secure(reply).send(page('Your new API key', keyPage(minted.key,
      'Every key this account had stopped working just now. Deploy this one wherever the old ones were.')))
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
function keyPage(key: string, note: string): string {
  return `
  <h1>Here is your new key.</h1>
  <p class="lede">Copy it now. This page will not show it again, nothing else will, and the link you
     used is spent. ${note}</p>
  <p class="cv-plate"><span>${key}</span></p>
  <p>Nothing here needs it pasted back in: your code is what sends it, with every call. In Python or
     Node that means <code>AGENTBILL_API_KEY</code>, set in the terminal your code runs in, and this
     line does it with the key already in place:</p>
  <p class="cv-plate"><span>export AGENTBILL_API_KEY=${key}</span></p>
  <p>No terminal? Pass the key to <code>AgentBillClient(api_key=...)</code>, or send it as an
     <code>Authorization: Bearer</code> header from whatever makes the call. The same value opens
     <a href="/app">your console</a>, which asks for it once and then shows only its first and last
     characters.</p>
  <p class="fine">Lost it again? <a href="/recover">Ask for another link</a>.</p>`
}
