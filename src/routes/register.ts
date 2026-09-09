import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pixelSnippet } from '../lib/pixel.js'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { PANEL_CSS, requestPanel } from '../ui/panels.js'
import { sql } from '../db/index.js'
import { plain } from '../lib/ids.js'
import { randomBytes } from 'crypto'
import { Resend } from 'resend'
import { allowRegisterAttempt, recoveryInCooldown, markRecoverySent } from '../lib/register-limiter.js'
import { clientIp as resolveClientIp } from '../lib/client-ip.js'
import { publicRoute } from '../middleware/auth.js'
import { HEADLINE, INSTALL_PY, ORIGIN } from '../ui/site.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from '../ui/copy.js'
import { inlineScript } from '../lib/csp.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'
import { sendRecoveryLink } from './recover.js'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const RESEND_FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'
const SUPPORT_EMAIL = 'hello@agentbill.dev'

/**
 * Sent once, when the account is created. It carries no key and no token.
 *
 * The key itself stays where it has always been, on screen, once, so the
 * 30-second signup promise is untouched. What was missing was any record that
 * the account exists at all: someone who closed the tab had nothing, not even
 * proof of which address they had used. This is that record, and it names the
 * one route back.
 */
async function emailWelcome(email: string): Promise<boolean> {
  if (!resend) return false
  try {
    const res = await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: 'Your AgentBill account is ready',
      html: `
        <p>Your AgentBill account is open on the free tier. No card, nothing to confirm.</p>
        <p>Your API key was shown once in the browser when you registered, and it is not in this
           email on purpose: an API key that lives in a mailbox is a key anyone who reads that
           mailbox has. Keep it in an environment variable.</p>
        <p>The same key opens your console at <a href="${ORIGIN}/app">${ORIGIN}/app</a>.</p>
        <p>If you no longer have it, you can get back in at
           <a href="${ORIGIN}/recover">${ORIGIN}/recover</a>. That link lets you see the current
           key or replace it, after you prove you can read this address.</p>
        <p>The quickstart is at <a href="${ORIGIN}/docs">${ORIGIN}/docs</a>. Questions:
           ${SUPPORT_EMAIL}</p>
      `,
    })
    return !res.error
  } catch {
    return false
  }
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
async function existingAccountReply(reply: any, email: string, accountId: string) {
  const inbox = `This email already has an account. Check your inbox: we sent a link to get back in.`
  if (recoveryInCooldown(email)) {
    return reply.code(200).send({ status: 'existing_account_emailed', message: inbox })
  }
  markRecoverySent(email)
  const emailed = await sendRecoveryLink(email, accountId)
  if (emailed) {
    return reply.code(200).send({ status: 'existing_account_emailed', message: inbox })
  }
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
const reg = inlineScript(`  let apiKey = ''

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
        body: JSON.stringify({
          email:    document.getElementById('email').value,
          name:     document.getElementById('name').value || undefined,
          use_case: document.getElementById('use_case').value || undefined,
          stack:    document.getElementById('stack').value || undefined,
        }),
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
      document.getElementById('form-state').style.display = 'none'
      const s = document.getElementById('success-state')
      s.style.display = 'flex'
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
  }`)
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
      css: `${CHROME_CSS}${PANEL_CSS}${COPY_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio (pitch + product | form)
     * design-system: design.md · designed-as-app · nav: N1b shared, CTA hidden here · footer: Ft2 shared
     * enrichment: none, the request panel is real */

    :root { --shell: 1080px; }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; }

    /* Three grid items, two columns. The form is the whole right column so it
       starts at the top beside the headline; the proof panel sits under the
       pitch. On one column the order becomes pitch, form, proof: the form is
       what a phone arriving from a paid click came for. */
    /* auto 1fr: the form spans both rows, and without explicit tracks the grid
       shared its height between them, which floated the request panel some
       150px below the pitch. The first row now fits the pitch and the second
       takes the rest. */
    .reg { padding-block: 56px 88px; display: grid; gap: 40px 56px; align-items: start;
           grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
           grid-template-rows: auto 1fr;
           grid-template-areas: "pitch form" "proof form"; }
    .pitch { grid-area: pitch; } .proof { grid-area: proof; } .form-col { grid-area: form; }

    h1 { color: var(--white); font-size: clamp(30px, 3.2vw, 40px); max-width: 14ch; overflow-wrap: anywhere; min-width: 0; }
    .lede { font-size: var(--fs-lede); color: var(--muted); margin: 20px 0 28px; max-width: 44ch; line-height: 1.6; }
    .facts { list-style: none; display: grid; gap: 14px; max-width: 50ch; }
    /* Under the form the list follows the legal note directly, and two blocks of
       small muted type with nothing between them read as one paragraph. */
    .form-col .facts { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--border-soft); }
    .facts li { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 14px; align-items: baseline;
                color: var(--muted); font-size: var(--fs-small); line-height: 1.6; }
    /* Two grounds, two rungs. .facts li is --muted, so its term goes to
       --text; .trust is --dim, so its term goes to --muted. Both were the
       accent, which reads as a link: "Terms of Service" and "Privacy Policy"
       are green AND underlined about ninety pixels above "free tier" in the
       same column. One of these terms is the word "refused", which on the
       homepage is a green console chip, so the accent was carrying two
       different meanings on one word. (Both read "blocked" until 2026-09-07;
       "blocked" is now reserved for the SDK's own exception text, which still
       says it, so our prose and the artifact cannot be mistaken for each
       other.) */
    .facts b { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
               color: var(--text); font-weight: 500; }
    .trust { margin-top: 28px; font-family: var(--mono); font-size: 12.5px; color: var(--dim); }
    .trust b { color: var(--muted); font-weight: 500; }

    /* Form. Inputs and the button share one 44px floor; state changes move
       colour, outline and background, never border width, so nothing shifts.
       The whole column sits on the panel frame the rest of the site leads
       with, so the thing to fill in reads as one object, not loose fields. */
    .form-card { background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
                 border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); padding: var(--s5); }
    .form-h h2 { color: var(--white); margin-bottom: 6px; font-size: var(--fs-h3); }
    .form-h p { color: var(--muted); font-size: var(--fs-small); margin-bottom: var(--s5); }
    .form { display: grid; gap: 16px; }
    .field { display: grid; gap: 6px; }
    label { font-size: 13.5px; font-weight: 600; color: var(--text); }
    label .opt { color: var(--dim); font-weight: 400; margin-left: 4px; }
    input, select { min-height: 44px; width: 100%; background: var(--bg); color: var(--text);
                    border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 14px;
                    font-family: var(--sans); font-size: 15px;
                    outline: 2px solid transparent; outline-offset: 1px;
                    transition: border-color .15s, background-color .15s; }
    input::placeholder { color: var(--dim); }
    /* One form, one convention for "nothing here yet". The inputs greyed their
       placeholder and the selects rendered their empty option at full --text,
       identical to a real choice, so the bottom half of the form read as already
       answered and the top half as blank. No script and no extra class. */
    select:has(option[value=""]:checked) { color: var(--dim); }
    select option { color: var(--text); }
    @media (hover: hover) { input:hover, select:hover { border-color: var(--dim); } }
    input:focus-visible, select:focus-visible { outline-color: var(--green); }
    input[aria-invalid="true"] { border-color: var(--red); }
    input:disabled, select:disabled { opacity: .55; cursor: not-allowed; }
    /* The arrow is the one colour that cannot come through a token: an SVG data
       URI takes no var(). %23a0a8a3 is --muted. */
    select { appearance: none; padding-right: 36px; cursor: pointer;
             background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23a0a8a3' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
             background-repeat: no-repeat; background-position: right 12px center; }
    select option { background: var(--surface2); }
    /* Reserved slot, so an error appearing does not push the button down. */
    .msg-slot { min-height: 1lh; }
    .err { color: var(--red); font-size: 13.5px; line-height: 1.5; display: none; }
    .btn-submit { min-height: 44px; background: var(--green); color: var(--green-ink); border: 0; border-radius: 8px;
                  padding: 0 22px; font-family: var(--sans); font-size: 15px; font-weight: 700; cursor: pointer;
                  white-space: nowrap; transition: filter .15s, transform .12s; }
    @media (hover: hover) { .btn-submit:hover { filter: brightness(1.06); } }
    .btn-submit:active { transform: translateY(1px); }
    .btn-submit:disabled { opacity: .55; cursor: not-allowed; transform: none; }
    .form-note { font-size: 12.5px; color: var(--dim); line-height: 1.6; }

    /* Success. Same panel frame as everywhere else on the site. */
    .success { display: none; flex-direction: column; gap: 20px; }
    .success h2 { color: var(--white); }
    .success > p { color: var(--muted); font-size: 14.5px; line-height: 1.7; }
    /* --code-ink: design.md calls it "the base ink inside a code frame", and
       this is one. .panel carries the ground and border (panels.ts:14) and
       .panel-h the label bar, and the sibling .ns-pre below already uses this
       ink for the same reason. A long green mono string sitting beside a
       bordered Copy button read like a link. */
    .key-value { padding: 14px 18px; font-family: var(--mono); font-size: 13px; color: var(--code-ink);
                 display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .key-value span { overflow-wrap: anywhere; min-width: 0; }
    .btn-copy { min-height: 36px; padding: 0 12px; background: transparent; color: var(--text);
                border: 1px solid var(--border-strong); border-radius: 6px; font-family: var(--sans);
                font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
                transition: border-color .15s; }
    @media (hover: hover) { .btn-copy:hover { border-color: var(--text); } }
    .btn-copy:active { transform: translateY(1px); }
    .steps { padding: 6px 18px 10px; }
    .ns { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; padding: 12px 0;
          border-bottom: 1px solid var(--border-soft); align-items: start; }
    .ns:last-child { border-bottom: 0; }
    /* A list ordinal is a marker, not an action, and these sit two words from
       real green links inside .ns p (/app, /docs, /faq). --dim is this site's
       floor for 12px mono: .ask, .tile-f and .st-ms already use it. */
    .ns-num { font-family: var(--mono); font-size: 12px; color: var(--dim); padding-top: 2px; }
    .ns p { font-size: 13.5px; color: var(--muted); line-height: 1.6; }
    /* break-all was right when the only block here was one unbroken curl line;
       it shreds the Python sample in step 3 mid-identifier. overflow-wrap:
       anywhere breaks a token only when it genuinely cannot fit, so the curl
       still wraps and code still breaks at spaces. */
    .ns-pre { margin-top: 8px; background: var(--bg); border: 1px solid var(--border-soft); border-radius: 6px;
              padding: 10px 12px; font-family: var(--mono); font-size: 11.5px; color: var(--code-ink);
              white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
    /* p code, not bare code: the copy pill inside a step is also a <code>,
       and the chip ground on it drew a box inside a box. */
    .ns p code, .success > p code { font-family: var(--mono); font-size: 12px; color: var(--text); background: var(--surface3);
               padding: 1px 5px; border-radius: 3px; }
    /* The shared pill keeps its command on one line and scrolls it. Step 2's
       command carries the reader's whole key, and a key that scrolls out of a
       320px column is a key half-copied by hand. Here it wraps instead, and
       the button drops below the command when the two do not fit on one row:
       sharing the row squeezed "pip install agentbill-sdk" into a mid-word
       break at 390px. fit-content keeps the short pill hugging its text. */
    .ns .cp { margin-top: 8px; width: fit-content; max-width: 100%; padding-block: var(--s2); flex-wrap: wrap; }
    .ns .cp code { white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: visible; }

    @media (max-width: 900px) {
      .reg { grid-template-columns: minmax(0, 1fr); grid-template-rows: none;
             grid-template-areas: "pitch" "form" "proof"; gap: 36px;
             padding-block: 40px 64px; }
      .lede { margin-bottom: 20px; }
      .form-card { padding: var(--s4); }
    }
`,
    })}
<body>
${siteNav('/register', { cta: false })}
<main>

<div class="reg wrap row-close">
  <div class="pitch">
    <h1>Give one job a ceiling.</h1>
    <p class="lede">Start with 1,000 free preflight calls per month. One decorator. Runaway runs refused. Ship.</p>
    <p class="trust"><b>key in 30 seconds</b> · shown once · store it in your environment</p>
  </div>

  <div class="proof">${requestPanel()}</div>

  <div class="form-col">
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
        <div class="field">
          <label for="email">Work email</label>
          <input type="email" id="email" name="email" placeholder="you@company.com" required autocomplete="email" />
        </div>
        <div class="field">
          <label for="name">Your name <span class="opt">(optional)</span></label>
          <input type="text" id="name" name="name" maxlength="128" placeholder="Ada Lovelace" autocomplete="name" />
        </div>
        <div class="field">
          <label for="use_case">What are you building? <span class="opt">(optional)</span></label>
          <select id="use_case" name="use_case">
            <option value="">Select one&hellip;</option>
            <option value="ai_saas">AI SaaS product</option>
            <option value="internal_agents">Internal agent workflows</option>
            <option value="agent_platform">Agent platform / marketplace</option>
            <option value="research">Research / experiments</option>
            <option value="other">Something else</option>
          </select>
        </div>
        <div class="field">
          <label for="stack">Primary language <span class="opt">(optional)</span></label>
          <select id="stack" name="stack">
            <option value="">Select one&hellip;</option>
            <option value="python">Python</option>
            <option value="nodejs">Node.js</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="msg-slot"><p class="err" id="err" aria-live="polite"></p></div>
        <button type="submit" class="btn-submit" id="submit-btn">Generate my API key &rarr;</button>
        <p class="form-note">By registering you agree to our <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>. No marketing email. Just a key.</p>
        <p class="form-note">Already registered and no longer have the key? <a href="/recover">Get back in</a>.</p>
      </form>

      <!-- Under the button, not beside it. The right column stopped 410px above
           the left and the page terminated ragged on the one surface that has to
           convert; moving the reassurance here balances the columns and puts it
           where the reader is deciding rather than where they have already been. -->
    <ul class="facts">
      <li><b>free tier</b><span>1,000 preflight calls a month, per account. No card, no expiry.</span></li>
      <li><b>refused</b><span>Before the call goes out, not after the bill. The ceiling is consulted first.</span></li>
      <li><b>any provider</b><span>One ceiling per task. You pass what each call is worth; we never look at your provider bill.</span></li>
    </ul>
    </div>

    <div class="success" id="success-state">
      <h2>Your API key is ready.</h2>
      <p>Copy it now. We won't show it again. Store it in your environment variables, not your code.
         If you lose it, <a href="/recover">/recover</a> will get you back in with the email you
         just used. We have sent that address a note saying so, with no key in it.</p>
      <div class="panel">
        <div class="panel-h"><span>API key</span><span>shown once</span></div>
        <div class="key-value">
          <span id="key-display"></span>
          <button class="btn-copy" id="copy-key" type="button">Copy</button>
        </div>
      </div>
      <!-- What the key is, and what the next preflight does, in the words the
           reader will meet in their own terminal. The two code spans are the
           wire answer and the SDK's exception text; nothing here says that
           anything of theirs is stopped, because nothing is: their code
           catches the exception and decides. -->
      <p>You have a free account: 1,000 preflight calls a month, no card. A preflight checks one
         call against the ceiling you gave its <code>task_ref</code>, before that call goes out.
         Past the ceiling it answers <code>approved: false</code>, the SDK raises
         <code>Refused (task_ceiling_exceeded)</code>, and your code decides what the job does next.</p>
      <div class="panel">
        <div class="panel-h"><span>Install</span><span>four steps, one action each</span></div>
        <div class="steps">
          <div class="ns"><span class="ns-num">1</span><div><p>Install the SDK.</p>${copyPill('install-py', INSTALL_PY)}</div></div>
          <div class="ns"><span class="ns-num">2</span><div><p>Put the key in your environment. This line already carries it.</p>${copyPill('key-export', 'export AGENTBILL_API_KEY=')}</div></div>
          <div class="ns"><span class="ns-num">3</span><div><p>Preflight before the call, record after it. The first preflight of a new <code>task_ref</code> fixes its ceiling: here <code>job-1</code> gets 10 units across every call that names it.</p><pre class="ns-pre">import os
from agentbill import AgentBillClient

key = os.environ["AGENTBILL_API_KEY"]
client = AgentBillClient(api_key=key)

client.preflight(
    agent_id="researcher",
    task_ref="job-1",
    task_ceiling=10,
    estimated_units=3,
)
# your model call runs here
client.record(
    agent_id="researcher",
    task_ref="job-1",
    units=3,
)</pre></div></div>
          <div class="ns"><span class="ns-num">4</span><div><p>Open <a href="/app">your console</a> and paste the key. <code>job-1</code> is under Recent tasks at 3 / 10, and Task budgets in the rail lists every task burning down. <a href="/docs">Docs</a>, or <a href="/faq">the questions page</a>.</p></div></div>
        </div>
      </div>
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
    if (!allowRegisterAttempt(clientIp)) {
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
        return existingAccountReply(reply, email, existing.id as string)
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
        await tx`
          INSERT INTO developer_api_keys (account_id, api_key, label)
          VALUES (${account.id}, ${apiKey}, 'default')
        `

        return { type: 'created' as const, apiKey, accountId: account.id as string }
      })

      if (result.type === 'existing') {
        if (!result.accountId) {
          return reply.code(409).send({
            error: 'account_exists',
            message: `This email already has an account. Email ${SUPPORT_EMAIL} to recover your key.`,
          })
        }
        return existingAccountReply(reply, email, result.accountId)
      }

      // Fire and forget. The key is already in the response, so a slow or
      // failing Resend must not hold up a signup or turn one into a 500. It is
      // logged instead, because silently not sending is how the old recovery
      // gap stayed invisible.
      void emailWelcome(email)
        .then((ok) => { if (!ok) request.log.error({ email }, 'welcome email was not accepted by Resend') })
        .catch((err) => request.log.error({ err }, 'welcome email threw'))

      return reply.code(201).send({
        api_key: result.apiKey,
        message: 'Account created. Store your API key. It will not be shown again. A link to get back in if you lose it is on its way to your inbox.',
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
