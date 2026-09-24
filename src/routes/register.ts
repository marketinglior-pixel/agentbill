import type { FastifyInstance, FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { pixelSnippet } from '../lib/pixel.js'
import { head, BP } from '../ui/theme.js'
import { label, tag } from '../ui/kit.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { sql } from '../db/index.js'
import { plain } from '../lib/ids.js'
import { randomBytes } from 'crypto'
import { allowRegisterAttempt, recoveryInCooldown, markRecoverySent, clearRecoveryMark } from '../lib/register-limiter.js'
import { clientIp as resolveClientIp, limiterKey } from '../lib/client-ip.js'
import { publicRoute } from '../middleware/auth.js'
import { HEADLINE, ORIGIN } from '../ui/site.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPlate } from '../ui/copy.js'
import { inlineScript } from '../lib/csp.js'
import { PULSE_CLIENT_SRC } from '../ui/pulse-client.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'
import { sendRecoveryLink } from './recover.js'
import { sessionCookieFor } from './app.js'
import { alertNewSignup } from '../lib/signup-alert.js'
import { mailUser } from '../lib/mail.js'

const SUPPORT_EMAIL = 'hello@agentbill.dev'

/**
 * Sent once, when the account is created. It carries no key and no token.
 *
 * The key itself stays where it has always been, on screen, once, so the
 * 30-second signup promise is untouched. What was missing was any record that
 * the account exists at all: someone who closed the tab had nothing, not even
 * proof of which address they had used. This is that record, and it names the
 * one route back.
 *
 * It is the ONLY send in the system whose recipient is free: anyone can type
 * any address into /register, and this mails it. That is why it goes through
 * mailUser with reason 'welcome', which is the one reason the daily ceiling in
 * src/lib/mail.ts gates. Everything this mail says is also on the screen that
 * showed the key, which is what makes a suppressed one survivable; the durable
 * record in a mailbox is the part that is genuinely lost.
 */
async function emailWelcome(log: FastifyBaseLogger, email: string, accountId: string): Promise<boolean> {
  return mailUser(log, 'welcome', email, {
    subject: 'Your AgentBill account is ready',
    html: `
        <p>Your AgentBill account is open on the free tier. No card, nothing to confirm.</p>
        <p>Your API key was shown once in the browser when you registered, and it is not in this
           email on purpose: an API key that lives in a mailbox is a key anyone who reads that
           mailbox has. Keep it where your code reads it.</p>
        <p>The same key opens your console at <a href="${ORIGIN}/app">${ORIGIN}/app</a>.</p>
        <p>If you no longer have it, you can get back in at
           <a href="${ORIGIN}/recover">${ORIGIN}/recover</a>. That link shows the current key, and
           the line that sets it, after you prove you can read this address.</p>
        <p>The quickstart is at <a href="${ORIGIN}/docs">${ORIGIN}/docs</a>. Questions:
           ${SUPPORT_EMAIL}</p>
      `,
  }, accountId)
}

// Existing account: never hand the key to an unauthenticated caller, that
// would let anyone holding an email address steal the account's live key.
// (Deliberate change 2026-08-27; replaces the old "idempotent register"
// behavior.) New-account creation still shows the key instantly, so the
// 30-second signup promise is untouched.
//
// 2026-09-09: this used to mail the live key itself. That was not stealable,
// because it went to the owner's mailbox rather than the sender's, but it let a
// stranger drop a permanent bearer credential into someone's inbox, where it
// then stayed. It now sends the same single-use link /recover sends, so there
// is one recovery mechanism on the system rather than two.
async function existingAccountReply(log: FastifyBaseLogger, reply: any, email: string, accountId: string) {
  const inbox = `This email already has an account. Check your inbox: we sent a link to get back in.`
  if (recoveryInCooldown(email)) {
    return reply.code(200).send({ status: 'existing_account_emailed', message: inbox })
  }
  markRecoverySent(email)
  const emailed = await sendRecoveryLink(log, email, accountId)
  if (emailed) {
    return reply.code(200).send({ status: 'existing_account_emailed', message: inbox })
  }
  // The other half of the contract register-limiter.ts states: "a failed send
  // must not block the next attempt". /recover was given clearRecoveryMark on
  // 2026-09-12 and this site was not, so a refused send here still cost the
  // address an hour of recovery, on the branch a person reaches by trying to
  // register again with an address they already used, which is exactly what
  // somebody who has lost their key does.
  clearRecoveryMark(email)
  return reply.code(409).send({
    error: 'account_exists',
    message: `This email already has an account, but the recovery mail could not be sent. Email ${SUPPORT_EMAIL} from that address and a person will sort it out.`,
  })
}

const RegisterBody = z.object({
  // trim + lowercase: the same address in two capitalisations was two free tiers.
  // 254 is the longest address SMTP allows. Without it this was an unbounded
  // write: a 3,000-character address created an account.
  email:    z.string().trim().toLowerCase().max(254).email(),
  name:     plain(z.string().min(1).max(128)).optional(),
  use_case: plain(z.string().max(64)).optional(),
  stack:    plain(z.string().max(32)).optional(),
})

function generateApiKey(): string {
  return 'agb_' + randomBytes(24).toString('hex')
}



// Lifted out of the page template so its hash can be computed from the same
// string that is emitted. See src/lib/csp.ts.
const reg = inlineScript(`${PULSE_CLIENT_SRC}
  let apiKey = ''

  document.getElementById('reg-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = document.getElementById('submit-btn')
    const errEl = document.getElementById('err')
    errEl.style.display = 'none'
    btn.disabled = true
    btn.textContent = 'Generating…'

    try {
      const res = await fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Email only. The three optional fields left this form on 2026-09-19
        // (see the form markup for the measurement) and are asked on the key
        // screen instead, through /app/profile. The API still accepts them
        // here, for curl and for anyone reading llms.txt.
        body: JSON.stringify({ email: document.getElementById('email').value }),
      })
      const data = await res.json()

      if (!res.ok) {
        errEl.textContent = data.message ?? 'Something went wrong. Try again.'
        errEl.style.color = 'var(--red)'
        errEl.style.display = 'block'
        btn.disabled = false
        btn.textContent = 'Generate my API key →'
        return
      }

      // Existing account: a single-use recovery link went to their inbox. The key
      // is never in this response and never in an email.
      if (!data.api_key) {
        errEl.textContent = data.message ?? 'This email already has an account. Check your inbox.'
        errEl.style.color = 'var(--green)'
        errEl.style.display = 'block'
        btn.disabled = false
        btn.textContent = 'Generate my API key →'
        return
      }

      apiKey = data.api_key
      document.getElementById('key-display').textContent = apiKey
      // Step 2 of the install path carries the key itself, so what the reader
      // copies is the line they run, not a template with a gap in it. A gap is
      // how a key became agb_agb_... and a 401 on the first run (2026-09-09).
      document.getElementById('key-export').textContent = 'export AGENTBILL_API_KEY=' + apiKey
      // The one action on this screen signs the reader in with this key, so
      // the next screen is the three steps and not a login card asking for
      // the string they are looking at. Same-origin POST, form-action 'self'.
      document.getElementById('key-field').value = apiKey
      document.getElementById('form-state').style.display = 'none'
      const s = document.getElementById('success-state')
      s.style.display = 'flex'
      // The pitch is a SIBLING of the form card, so revealing the key state
      // never hid it: the reader kept the h1, the lede and a third "store it in
      // your environment" above their own key, and the answer to "where does
      // this go" started below the fold on a laptop. This class is what makes
      // the post-key reading order start at the key. scripts/shots.mjs adds it
      // too, or the one gate that sees this screen's geometry would photograph
      // a layout production never serves.
      document.querySelector('.reg').classList.add('done')
      // Give the success state a URL of its own and a title of its own, so Back
      // does not silently re-show the empty form and this state is something a
      // reader can tell they reached. replaceState, not a redirect to a route:
      // a route would need the key in a query parameter, and a key in a query
      // parameter lands in browser history, in the Referer header of every
      // outbound click, and in the request log of every hop in between.
      history.replaceState(null, '', '/register#done')
      document.title = 'Your API key · AgentBill'
      s.setAttribute('tabindex', '-1')
      s.focus()
      // Meta Pixel conversion, new accounts only (201), not returning-key lookups
      if (res.status === 201 && typeof window.fbq === 'function') {
        window.fbq('track', 'CompleteRegistration')
      }
      // Reddit Pixel conversion, new accounts only (201)
      if (res.status === 201 && typeof window.rdt === 'function') {
        window.rdt('track', 'SignUp')
      }
    } catch {
      errEl.textContent = 'Network error. Check your connection and try again.'
      errEl.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'Generate my API key →'
    }
  })

  // Bound rather than inline. A Content-Security-Policy that allows scripts by
  // hash does not cover an onclick attribute; that needs 'unsafe-hashes', which
  // is poorly supported and gives back most of what the policy was for. Doing
  // this first means the CSP can land without quietly breaking the one button
  // on the page that matters.
  document.getElementById('copy-key').addEventListener('click', copyKey)

  function copyKey() {
    navigator.clipboard.writeText(apiKey)
    const btn = document.querySelector('.btn-copy')
    btn.textContent = 'Copied'
    btn.style.color = 'var(--green)'
    setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = '' }, 2000)
  }

  // The optional context, asked once the key is on screen. A fetch and not a
  // form submit, because a submit navigates, and this screen shows the key
  // once: a reader who saved their name and lost their key would have traded
  // the thing they came for. The cookie the 201 set is scoped Path=/app, and
  // /app/profile is under it, so the request carries the session with no key
  // in the body. Nothing here is required; a reader who clicks the console
  // button instead loses nothing.
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = document.getElementById('profile-save')
    const note = document.getElementById('profile-note')
    btn.disabled = true
    try {
      const res = await fetch('/app/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:     document.getElementById('name').value || undefined,
          use_case: document.getElementById('use_case').value || undefined,
          stack:    document.getElementById('stack').value || undefined,
        }),
      })
      if (res.ok) { btn.textContent = 'Saved'; note.textContent = 'Thanks. You can change any of this later by writing in.'; return }
      const data = await res.json().catch(() => ({}))
      note.textContent = data.message ?? 'That did not save. It is optional, so carry on.'
      btn.disabled = false
    } catch {
      note.textContent = 'Network error. It is optional, so carry on.'
      btn.disabled = false
    }
  })

  // This page loaded, in our own rows. Between a landing page view on / and a
  // row in accounts there was no record at all, so a visitor who clicked
  // through and stalled on this form and a visitor who never left the homepage
  // produced the same zero. Once per load, and on load only: the account row
  // is its own record of how the visit ended.
  //
  // Last in the script, and guarded, so this one line can never take the form
  // down with it. It was first written above the submit listener; review found
  // that a helper which failed to arrive would have thrown there before the
  // listener attached, and this form's native fallback is a GET with the
  // address in the URL. Every listener is attached before this runs, and a
  // missing helper now costs one row, not a registration.
  try { pulse('register_view') } catch (e) {}`)
const REGISTER_JS = reg.html
export const REGISTER_HASH = reg.hash

export async function registerRoute(app: FastifyInstance) {

  // Registration page, GET
  app.get('/register', publicRoute(), async (_request, reply) => {
    reply.type('text/html')
    return reply.send(`${head({
      title: 'Get your API key · AgentBill',
      description: 'Free API key in 30 seconds. 1,000 preflight calls/month, hard per-task budget ceilings for AI agents. No credit card.',
      path: '/register',
      og: { description: `${HEADLINE}. Free tier, key in 30 seconds, no credit card.` },
      extraHead: pixelSnippet(),
      scriptHashes: [REGISTER_HASH, COPY_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${COPY_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: One Column (the form is the page)
     * design-system: design.md · designed-as-app · nav: N1b shared, CTA hidden here · footer: Ft2 shared
     * enrichment: none. Restyled 2026-09-12 with pressplaced.com as the craft
     * reference: one column, air, one thing to do. The request panel and the
     * three reassurance rows that sat beside the form are gone; a reader who
     * wants the argument has the homepage one click back. */

    /* Canvas, 2026-09-23, on Lior's instruction to put every screen in the
       homepage's design language. The homepage's hero shape at one column:
       the pitch centred over the frame, and the form on the warm-grey panel
       the estimator's inputs sit on. After the key, the same panel holds the
       key screen's white cards, which is the panel-in-panel frame everything
       that shows the reader's own data uses. Every value is a token. */
    :root { --shell: var(--chrome-w); }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }

    /* One column, 560 wide, centred on the shell. The head, then the panel. */
    .reg { max-width: 560px; margin: 0 auto; padding-block: var(--s9) 96px; }
    .pitch { margin-bottom: var(--s6); text-align: center; display: grid; justify-items: center; }

    /* Scoped to .pitch, because every declaration here is about the marketing
       headline: 14ch is what breaks "Give one job a ceiling." over two lines at
       the size it is set in. Unscoped, it also caught the success state's own
       h1 on 2026-09-12 and wrapped "Your API key is ready." after "API" at
       22px, which is the selector-named-for-a-component trap: the rule reads
       like "the h1 on this page" and this page now has two, in two states. */
    .pitch h1 { color: var(--white); font-size: var(--fs-h1-sub); letter-spacing: -0.03em; line-height: 1.02;
                max-width: 14ch; overflow-wrap: anywhere; min-width: 0; }
    /* The lede is setup language, not a pitch: what happens once, what the
       ceiling is on, what comes back, whose decision it is. */
    .lede { font-size: var(--fs-lede); color: var(--muted); margin: var(--s4) 0 0; max-width: 46ch; line-height: 1.55;
            text-wrap: pretty; }
    .lede code { font-family: var(--mono); font-size: .9em; color: var(--text); }
    /* The homepage's line under its hero button, in its voice. */
    .trust { margin-top: var(--s4); font-size: var(--fs-small); line-height: 20px; color: var(--dim); }
    .trust b { color: var(--muted); font-weight: 500; }

    /* The form, on the panel ground (the estimator's recipe on /): white
       fields with a 3:1 border on warm grey, one ink pill under them. Fields
       and the button share the 44px floor; a state changes colour and
       outline, never border width, so nothing shifts. */
    .form-card { background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s6); }
    .form-h h2 { color: var(--white); margin-bottom: 6px; font-size: var(--fs-h3); letter-spacing: -0.01em; }
    .form-h p { color: var(--muted); font-size: var(--fs-small); margin-bottom: var(--s5); }
    .form { display: grid; gap: var(--s4); }
    /* .cv-flabel carries its own gap under it, so the field adds none. */
    .field { display: grid; }
    label .opt { color: var(--dim); font-weight: 400; margin-left: 4px; }
    @media (hover: hover) { .cv-field:hover { border-color: var(--dim); } .cv-field:focus { border-color: var(--field-focus); } }
    .cv-field[aria-invalid="true"] { border-color: var(--red); }
    .cv-field:disabled { opacity: .55; cursor: not-allowed; }
    /* One form, one convention for "nothing here yet". The inputs greyed their
       placeholder and the selects rendered their empty option at full --text,
       identical to a real choice, so the bottom half of the form read as already
       answered and the top half as blank. No script and no extra class. */
    select.cv-field:has(option[value=""]:checked) { color: var(--field-ph); }
    select.cv-field option { color: var(--text); background: var(--surface); }
    /* The arrow, drawn from two gradients in --muted, so it follows the token
       instead of a colour baked into an SVG data URI (that URI carried the
       dark theme's --muted, a grey that no longer exists on canvas). */
    select.cv-field { appearance: none; padding-right: 40px; cursor: pointer;
                      background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%),
                                        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
                      background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
                      background-position: calc(100% - 21px) 50%, calc(100% - 16px) 50%; }
    /* Reserved slot, so an error appearing does not push the button down. */
    .msg-slot { min-height: 1lh; }
    .err { display: none; margin-top: 0; }
    /* The slot sits in the form's grid; half the gap on each side of it, so
       an empty slot reads as spacing and not as a missing line. */
    .form > .msg-slot { margin-block: calc(var(--s2) * -1); }
    /* The kit's L pill, the width of the form: the one action of this fold. */
    .btn-submit { width: 100%; }
    .form-note { font-size: var(--fs-micro); color: var(--dim); line-height: 1.6; }
    .form-note a, .success > p a { color: var(--text); text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
    .form-note a:hover, .success > p a:hover { text-decoration-color: currentColor; }

    /* Success. The panel above now holds the key screen: white cards, each
       opening on the frame's bar, on the warm-grey ground. */
    .success { display: none; flex-direction: column; gap: 20px; }
    /* Once the key is on screen the pitch above it has done its job, and it was
       the reason the answer sat below the fold.
       Measured in Chrome at 1440x735, a laptop window, success state revealed.
       Before: the key at 654, the export line at 868, the one action at 1047,
       so the last thing the reader saw was the key itself and every word about
       where it goes was below the fold. Dogfood run 4 ended exactly there, on
       "where do I paste it". After, with the pitch hidden and the two key
       panels merged: the key at 345, the answer at 415, the export line at 550.
       The action lands at 777 and cannot be lifted above 735 without deleting
       something the reader needs; what changed is that nothing above it is
       pitch, and the question is answered before the scroll rather than after.
       The whole pitch goes, h1 included, because .done-h below replaces it. */
    .reg.done .pitch { display: none; }
    .success h2, .success .done-h { color: var(--white); }
    /* The console's own h1 rung: this is the account's first screen. */
    .success .done-h { font-size: var(--fs-h1-app); line-height: 1.2; letter-spacing: -0.02em; }
    .success > p { color: var(--muted); font-size: var(--fs-small); line-height: 1.7; }
    /* The answer, inside the frame that holds the key it is about, on the
       frame's own 20px gutter, so it reads as part of the key card and not as
       a paragraph that drifted into one. */
    .success .where { padding: var(--s3) 20px 0; font-size: var(--fs-small); color: var(--muted); line-height: 1.6; }
    /* The minority path, under the line it is an alternative to. --dim, because
       a reader who has a terminal has already been served by the line above and
       should be able to skip this on sight. */
    .success .noterm { color: var(--dim); font-size: var(--fs-small); line-height: 1.6; margin-top: var(--s2); }
    /* The key itself, and the line that sets it, are both on the kit's plate
       (.cv-plate, src/ui/kit.ts): a white plate with a hairline and the
       light-filled Copy at its right, so they read as the same kind of object.
       Only the key plate's place in the card is set here. */
    .key-value { margin: var(--s4) 20px 0; }
    .steps { padding: var(--s2) 20px var(--s3); }
    .ns { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; padding: 12px 0;
          border-bottom: 1px solid var(--border-soft); align-items: start; }
    .ns:last-child { border-bottom: 0; }
    /* One row, no ordinal column: the only thing left in this frame is the
       export line, and a 22px gutter beside a lone item reads as a missing
       marker. A modifier on .ns on purpose, so the row keeps .ns's padding
       and border. */
    .ns.solo { grid-template-columns: minmax(0, 1fr); }
    .ns p { font-size: var(--fs-small); color: var(--muted); line-height: 1.6; }
    /* p code, not bare code: the copy pill inside a step is also a <code>,
       and the chip ground on it drew a box inside a box. */
    /* overflow-wrap, because these chips carry the longest unbreakable tokens
       on the page: Refused (task_ceiling_exceeded) and TaskCeilingRequiredError
       are single words to the line breaker. At 320px the step body is about
       166px and they measure 187, which pushed the panel 3px past its own
       overflow:hidden and cut the header. Found by npm run shots the first run
       after the post-key screen entered the gate. */
    .ns p code, .success > p code, .success .where code { font-family: var(--mono); font-size: .875em; color: var(--text); background: var(--surface3);
               padding: 1px 6px; border-radius: var(--r-inline); overflow-wrap: anywhere; }
    /* The export line is on the plate, not the shared one-line pill. The pill
       keeps its command on one line and scrolls it, and a line that carries
       the reader's whole key and scrolls out of a 320px column is a key
       half-copied by hand. The plate wraps it, from line one, with the Copy
       held at the right as it is on the key above. */
    /* The one action on this screen. Under the key, in its own card, and the
       button above the sentence: at 320 a button and a sentence on one row
       break the sentence mid-word. */
    .ns-go { padding: 20px; display: grid; gap: var(--s3); justify-items: start; }
    .ns-go p { font-size: var(--fs-small); color: var(--muted); line-height: 1.6; }
    /* Docs and the questions page, at the footnote register. They used to sit
       in the sentence under the button as two more links, one line below the
       one action on the screen; the 2026-09-11 audit read that as the exit a
       reader takes instead of the three steps. */
    .ns-go .aside { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
    .ns-go .aside a { color: var(--dim); text-decoration: underline; }
    .ns-go .aside a:hover { color: var(--text); }
    /* The optional context, under the one action and not above it. The key
       screen's fold gate (scripts/shots.mjs) holds .where above 735 and
       .btn-go within one short scroll of it; a panel placed above the button
       would spend that budget on questions nobody has to answer. Below it,
       the reader who wants the console never sees a form in the way, and the
       reader who lingers is the one being asked. */
    .profile { padding: 20px; display: grid; gap: var(--s4); }
    .profile > p { font-size: var(--fs-small); color: var(--muted); line-height: 1.6; }
    .profile .row { display: grid; gap: var(--s3); align-items: center; grid-template-columns: auto minmax(0, 1fr); }
    .profile .note { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); min-height: 1lh; }
    /* The kit's .btn at L, written out here rather than added as a class.
       scripts/preflight/verify.mjs holds this button's order on the page by
       its exact class attribute, a single class, so a second class beside it
       would turn that gate into -1 < n, true whatever the page says. (Never
       spell that attribute out in this comment: this stylesheet is served
       above the button, and the gate would find the comment first.) Same
       tokens as .btn.btn-lg in src/ui/kit.ts; change them together. */
    .btn-go { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); min-height: var(--h-lg);
              padding: 10px 24px; line-height: 24px; border: 0; background: var(--green); color: var(--green-ink);
              border-radius: var(--r-control); font-family: var(--sans); font-size: var(--fs-body); font-weight: 500;
              text-decoration: none; white-space: nowrap; cursor: pointer; transition: background .15s, transform .12s; }
    .btn-go:hover { background: var(--btn-hover); text-decoration: none; }
    .btn-go:active { transform: translateY(1px); }

    @media (max-width: 900px) {
      .reg { padding-block: var(--s7) var(--s8); }
      .form-card { padding: var(--s4); }
    }
    @media (max-width: ${BP.md}px) {
      .lede { font-size: var(--fs-body); }
      .success .where { padding-inline: var(--s3); }
      .key-value { margin-inline: var(--s3); }
      .steps { padding-inline: var(--s3); }
      .ns-go, .profile { padding: var(--s4) var(--s3); }
    }
`,
    })}
<body>
${siteNav('/register', { cta: false })}
<main>

<div class="reg wrap">
  <div class="pitch">
    <h1>Give one job a ceiling.</h1>
    <p class="lede">Key once. Ceiling on one <code>task_ref</code>. Preflight returns <code>approved: false</code> when that job is out. Your code decides.</p>
    <p class="trust"><b>key in 30 seconds</b> · shown once</p>
  </div>

  <div class="form-card">
    <div id="form-state">
      <div class="form-h">
        <h2>Get your API key</h2>
        <p>Takes 30 seconds. No setup call. No credit card.</p>
      </div>
      <form class="form" id="reg-form">
        <noscript><p class="msg-slot" style="display:block">This form needs JavaScript to submit. Without it, ask for a key
          from a terminal: <code>curl -X POST https://agentbill.dev/register -H 'Content-Type: application/json'
          -d '{"email":"you@company.com"}'</code></p></noscript>
        <!-- One field. Until 2026-09-19 three optional fields sat between this
             one and the button: name, what you are building, primary language,
             264px of them. Measured in Chrome with the form as the only thing
             on the page: the button's top at 904 against a 900 fold on a
             1440x900 laptop and an 864 fold on 1536x864, the most common
             desktop viewport there is. Four pixels and forty. The only action
             on the page was off the screen for the audience the ads had just
             been pointed at, and every one of the fields pushing it there was
             optional. They are asked on the key screen now, once the reader
             is registered, through /app/profile; the fold gate in
             scripts/shots.mjs measures this button against the fold so they
             cannot drift back. -->
        <div class="field">
          <label class="cv-flabel" for="email">Work email</label>
          <input class="cv-field" type="email" id="email" name="email" placeholder="you@company.com" required autocomplete="email" />
        </div>
        <div class="msg-slot"><p class="cv-err err" id="err" aria-live="polite"></p></div>
        <button type="submit" class="btn btn-lg btn-submit" id="submit-btn">Generate my API key &rarr;</button>
        <p class="form-note">By registering you agree to our <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>. No marketing email. Just a key.</p>
        <p class="form-note">Already registered and no longer have the key? <a href="/recover">Get back in</a>.</p>
      </form>
    </div>

    <div class="success" id="success-state">
      <!-- An h1, because .reg.done hides the pitch that carries the page's
           other one, so in each state exactly one h1 is visible: the pitch
           while the form is up, this while the key is. -->
      <h1 class="done-h">Your API key is ready.</h1>
      <p>Copy it now. We won't show it again. If you lose it, <a href="/recover">/recover</a> shows it
         again to whoever can read the email you just used.</p>
      <div class="cv-card">
        <div class="cv-bar"><span class="cv-bar-t">${label('API key')}</span>${tag('shown once')}</div>
        <div class="key-value cv-plate">
          <span id="key-display"></span>
          <button class="cp-btn btn-copy" id="copy-key" type="button">Copy</button>
        </div>
        <!-- The reader's question, answered in the frame that holds his key
             rather than in a paragraph above it. Dogfood run 4 asked "where do
             I paste it" while looking at this screen, and the first clause is
             the honest answer: nowhere here. Until 2026-09-12 the screen said
             "environment" or "shell" four times and never once named what the
             key attaches to, so it answered a question about storage that
             nobody had asked.

             Both named destinations are true of this repo. AGENTBILL_API_KEY is
             what the console's own lines read, and the Authorization header is
             the only auth the API has (src/middleware/auth.ts), which makes it
             the one way in for a reader whose agent lives in a browser tool and
             who has no terminal to run the line below in. That reader is the
             n8n and Make vertical, and this is the first onboarding copy on the
             site that does not hand them a shell command.

             "not your code" is gone. Our own /docs quick start passes the key
             to AgentBillClient as a literal, so the screen was forbidding what
             the next page instructs. -->
        <p class="where">Nothing on this page needs the key pasted in: your code sends it, with every
           call. In Python or Node that means <code>AGENTBILL_API_KEY</code>, and the line below sets
           it in the terminal your code runs in.</p>
        <div class="steps">
          <div class="ns solo"><div>${copyPlate('key-export', 'export AGENTBILL_API_KEY=')}<p class="noterm">No terminal? Send the key yourself as an <code>Authorization: Bearer</code> header from whatever makes the call.</p></div></div>
        </div>
      </div>
      <!-- The same key again, as the line that sets it. A gap in a copyable
           line is how a key became agb_agb_... and a 401 on the first run
           (2026-09-09), so the line carries the key itself, filled in by the
           script above.

           This used to say "this screen is the only one that can render the key
           into a runnable line". That was never true of the system, only of the
           site as it was built: the console holds the plaintext key on every
           render (app.ts, the viewer object) and masks it by policy, and
           /recover prints the whole key to anyone who can read the account's
           mailbox. It is true of THIS screen that the key is shown once and
           that a reader who leaves cannot reload their way back, which is why
           2026-09-12 gave /recover the same prefilled line rather than another
           paragraph about how to retype this one.

           Nothing else is taught here, on purpose. Until 2026-09-11 this
           screen also carried the install command as an unnumbered bullet and
           the console's three steps numbered 1/2/3 below it: five actions,
           numbering starting on the third, terminal work first and the console
           link last. Dogfood run 3 ended right here with "I do not understand
           what I need to do". The sequence has one owner, the console's start
           screen (src/ui/steps.ts, src/routes/app.ts), and the button below
           signs the reader into it. -->
      <div class="cv-card">
        <div class="ns-go">
          <!-- A form, not a link, and it moves THIS tab. The form POSTs this
               key to /app/session, the same request the console's login card
               makes, so the next screen is step 1 of 3 and not a card asking
               for the string on this one. Until 2026-09-12 it opened a new
               tab, to keep a key that is shown once on screen; the dogfood
               re-verify of 2026-09-11 read that as a button that does nothing,
               because the URL it was watching never moved. So the tab moves,
               and the sentence under the button says to run the export line
               first. The 201 that created the account already carries the
               session cookie (the POST handler below), so the header's Console
               link is this account too, whichever account this browser had
               signed into before. -->
          <form method="POST" action="/app/session" id="go-form">
            <input type="hidden" name="api_key" id="key-field" value="" />
            <input type="hidden" name="next" value="/app?view=start" />
            <button class="btn-go" type="submit">Open the console &rarr;</button>
          </form>
          <p>It signs you in with this key, so the console does not ask you to paste it. There you name a job, give it a ceiling, and see the refusal your first run produces. It asks for the key by hand again when you sign out, on another browser, or a week from now. Copy the line above first: this screen is not shown again, and the console does not print your key.</p>
          <!-- New tabs here, because a reader who opens a reference wants to
               keep the key on screen, and a footnote, not a second action. -->
          <p class="aside">Reference, when you need it: <a href="/docs" target="_blank" rel="noopener">docs</a> &middot; <a href="/faq" target="_blank" rel="noopener">questions</a>.</p>
        </div>
      </div>
      <!-- The three questions that used to sit in the signup form, asked after
           the key instead of before it. Below the console button on purpose:
           the fold gate holds that button within reach, and a reader who
           takes it has lost nothing by skipping this. Saved by fetch to
           /app/profile on the session the 201 set, so the key on screen is
           never navigated away from and never leaves this page. -->
      <div class="cv-card">
        <div class="cv-bar"><span class="cv-bar-t">${label('Optional')}</span>${tag('it can wait')}</div>
        <form class="profile" id="profile-form">
          <p>A little context, if you want to give it. Nothing here is required, and the console works the same without it.</p>
          <div class="field">
            <label class="cv-flabel" for="name">Your name <span class="opt">(optional)</span></label>
            <input class="cv-field" type="text" id="name" name="name" maxlength="128" placeholder="Ada Lovelace" autocomplete="name" />
          </div>
          <div class="field">
            <label class="cv-flabel" for="use_case">What are you building? <span class="opt">(optional)</span></label>
            <select class="cv-field" id="use_case" name="use_case">
              <option value="">Select one&hellip;</option>
              <option value="ai_saas">AI SaaS product</option>
              <option value="internal_agents">Internal agent workflows</option>
              <option value="agent_platform">Agent platform / marketplace</option>
              <option value="research">Research / experiments</option>
              <option value="other">Something else</option>
            </select>
          </div>
          <div class="field">
            <label class="cv-flabel" for="stack">Primary language <span class="opt">(optional)</span></label>
            <select class="cv-field" id="stack" name="stack">
              <option value="">Select one&hellip;</option>
              <option value="python">Python</option>
              <option value="nodejs">Node.js</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="row">
            <button class="btn-ghost btn-save" id="profile-save" type="submit">Save</button>
            <p class="note" id="profile-note" aria-live="polite"></p>
          </div>
        </form>
      </div>
    </div>
  </div>
</div>

</main>
${siteFooter()}

${REGISTER_JS}${COPY_JS}
</body>
</html>`)
  })

  // Register API, POST. New accounts get their key instantly (shown once);
  // existing emails get the key by email, never in the response.
  app.post('/register', publicRoute(), async (request, reply) => {
    // Validate first: a malformed body leaks nothing, so it must not burn a
    // rate-limit slot (bot probes and typos were draining the bucket).
    const parsed = RegisterBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: [parsed.error.issues[0]?.path?.join('.'), parsed.error.issues[0]?.message].filter(Boolean).join(': ') ?? 'Invalid request body',
      })
    }

    // Behind fly-proxy request.ip is the proxy itself, one address for every
    // visitor on earth, which turned the per-IP cap into a global 5/hour cap
    // (found 2026-09-02). Fly sets fly-client-ip authoritatively and it cannot
    // be spoofed by the client; x-forwarded-for is the fallback off Fly.
    const clientIp = resolveClientIp(request)
    if (!allowRegisterAttempt(limiterKey(request))) {
      request.log.warn({ clientIp }, 'register rate limited')
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many attempts from this address. Try again in an hour.',
      })
    }

    const { email, name, use_case, stack } = parsed.data

    try {
      // Already registered? Send the recovery link. This only needs the account
      // id now: it used to join developer_api_keys and read a live key into
      // memory in order to mail it, and nothing on this path handles a key any
      // more. An account with no key left is no longer a special case either,
      // because the recovery flow mints one when it finds none.
      const [existing] = await sql`
        SELECT id FROM accounts WHERE email = ${email}
      `

      if (existing) {
        return existingAccountReply(request.log, reply, email, existing.id as string)
      }

      // New account
      const result = await sql.begin(async (tx) => {
        // default_budget_units is NULL on purpose. It is copied onto every
        // customer the account lazily creates, and customers.used_units never
        // resets, so the 1000 that sat here until 2026-09-09 was a silent
        // lifetime cap on the customer named "default", refusing a call the
        // task ceiling had approved. A customer's ceiling is set by PUT /budget
        // and nothing else. Migration 010 cleared the inherited 1000s.
        const [account] = await tx`
          INSERT INTO accounts (email, name, plan, use_case, stack, default_budget_units)
          VALUES (${email}, ${name ?? null}, 'free', ${use_case ?? null}, ${stack ?? null}, NULL)
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `

        if (!account) {
          // Race: another request created the account between the check above
          // and this insert. Its id is all this path needs.
          const [raced] = await tx`SELECT id FROM accounts WHERE email = ${email}`
          return { type: 'existing' as const, accountId: (raced?.id as string) ?? null }
        }

        const apiKey = generateApiKey()
        const [key] = await tx`
          INSERT INTO developer_api_keys (account_id, api_key, label)
          VALUES (${account.id}, ${apiKey}, 'default')
          RETURNING id
        `

        return { type: 'created' as const, apiKey, accountId: account.id as string, keyId: key.id as string }
      })

      if (result.type === 'existing') {
        if (!result.accountId) {
          return reply.code(409).send({
            error: 'account_exists',
            message: `This email already has an account. Email ${SUPPORT_EMAIL} to recover your key.`,
          })
        }
        return existingAccountReply(request.log, reply, email, result.accountId)
      }

      // Fire and forget. The key is already in the response, so a slow or
      // failing Resend must not hold up a signup or turn one into a 500. It is
      // logged instead, because silently not sending is how the old recovery
      // gap stayed invisible.
      void emailWelcome(request.log, email, result.accountId)
        .catch((err) => request.log.error({ err }, 'welcome email threw'))

      // The owner hears about it now, not in tomorrow's digest. Same fire and
      // forget contract as the line above and for the same reason: this is the
      // request that carries the key, and nothing about telling someone may be
      // able to hold it up. The account row is already committed, so the alert
      // reads its own counts from the table (src/lib/signup-alert.ts).
      alertNewSignup(request.log, {
        accountId: result.accountId,
        email,
        name,
        stack,
        useCase: use_case,
        plan: 'free',
      })

      // The browser that made this request is signed into the console as this
      // key from here on: the cookie /app/session mints, on the same name and
      // path, so it overwrites a session another account left in this browser.
      // Without it (re-verified 2026-09-11) a fresh register followed by the
      // header's Console link opened whichever account had signed in last on
      // that browser. curl gets the header too and ignores it.
      const cookie = sessionCookieFor(result.keyId)
      if (cookie) reply.header('Set-Cookie', cookie)
      return reply.code(201).send({
        api_key: result.apiKey,
        // Says what is true of the account, not of a send that has not happened
        // yet. This used to assert "a link to get back in is on its way to your
        // inbox", which was a promise made by the response about a fire-and-
        // forget mail two lines above it: false whenever Resend refused it,
        // false with no mailer configured, and false the moment the welcome
        // ceiling in src/lib/mail.ts suppresses one. /recover is a standing
        // route rather than a mail, so the sentence that replaces it is true
        // whether or not anything was ever delivered.
        message: 'Account created. Store your API key. It will not be shown again. If you lose it, agentbill.dev/recover gets you back in with this email address.',
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
