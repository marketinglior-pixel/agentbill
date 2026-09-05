import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pixelSnippet } from '../lib/pixel.js'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { PANEL_CSS, requestPanel } from '../ui/panels.js'
import { sql } from '../db/index.js'
import { randomBytes } from 'crypto'
import { Resend } from 'resend'
import { allowRegisterAttempt, recoveryInCooldown, markRecoverySent } from '../lib/register-limiter.js'
import { clientIp as resolveClientIp } from '../lib/client-ip.js'
import { publicRoute } from '../middleware/auth.js'
import { inlineScript } from '../lib/csp.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const RESEND_FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'
const SUPPORT_EMAIL = 'marketinglior@gmail.com'

// Best-effort: mail the existing key to the account owner. Returns true only
// when Resend accepted the send. (With the sandbox sender this fails for
// arbitrary recipients until the agentbill.dev domain is verified in Resend,
// the caller falls back to a support message, never to exposing the key.)
async function emailExistingKey(email: string, apiKey: string): Promise<boolean> {
  if (!resend) return false
  try {
    const res = await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: 'Your AgentBill API key',
      html: `
        <p>Someone (hopefully you) asked for the API key of this AgentBill account.</p>
        <p>Your key: <code>${apiKey}</code></p>
        <p>Store it in your environment variables, not your code.</p>
        <p>Wasn't you? Rotate it immediately:</p>
        <pre>curl -X POST https://agentbill.dev/keys/rotate -H "Authorization: Bearer ${apiKey}"</pre>
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
async function existingAccountReply(reply: any, email: string, apiKey: string) {
  if (recoveryInCooldown(email)) {
    return reply.code(200).send({
      status: 'existing_account_emailed',
      message: `This email already has an account. We recently sent your API key to ${email}. Check your inbox.`,
    })
  }
  const emailed = await emailExistingKey(email, apiKey)
  if (emailed) {
    markRecoverySent(email)
    return reply.code(200).send({
      status: 'existing_account_emailed',
      message: `This email already has an account. We sent your API key to ${email}.`,
    })
  }
  return reply.code(409).send({
    error: 'account_exists',
    message: `This email already has an account. Lost your key? Email ${SUPPORT_EMAIL} from that address and we'll rotate it for you.`,
  })
}

const RegisterBody = z.object({
  // trim + lowercase: the same address in two capitalisations was two free tiers.
  email:    z.string().trim().toLowerCase().email(),
  name:     z.string().min(1).max(128).optional(),
  use_case: z.string().max(64).optional(),
  stack:    z.string().max(32).optional(),
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

      // Existing account: the key went to their inbox, not to this response.
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
      const fc = document.getElementById('first-curl')
      if (fc) fc.textContent = "curl -s -X POST https://agentbill.dev/preflight -H \\"Authorization: Bearer " + apiKey + "\\" -H \\"Content-Type: application/json\\" -d '{\\"agent_id\\":\\"first-run\\",\\"estimated_units\\":5,\\"ceiling\\":1}'"
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
      og: { description: 'Hard budget ceilings for AI agents. Free tier, key in 30 seconds, no credit card.' },
      extraHead: pixelSnippet(),
      scriptHashes: [REGISTER_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PANEL_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio (pitch + product | form)
     * design-system: design.md · designed-as-app · nav: N1b shared, CTA hidden here · footer: Ft2 shared
     * enrichment: none, the request panel is real */

    :root { --shell: 1080px; }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; }

    /* Three grid items, two columns. The form is the whole right column so it
       starts at the top beside the headline; the proof panel sits under the
       pitch. On one column the order becomes pitch, form, proof: the form is
       what a phone arriving from a paid click came for. */
    .reg { padding-block: 56px 88px; display: grid; gap: 40px 56px; align-items: start;
           grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
           grid-template-areas: "pitch form" "proof form"; }
    .pitch { grid-area: pitch; } .proof { grid-area: proof; } .form-col { grid-area: form; }

    h1 { color: var(--white); font-size: clamp(30px, 3.2vw, 40px); max-width: 14ch; overflow-wrap: anywhere; min-width: 0; }
    .lede { font-size: var(--fs-lede); color: var(--muted); margin: 20px 0 28px; max-width: 44ch; line-height: 1.6; }
    .facts { list-style: none; display: grid; gap: 14px; max-width: 50ch; }
    .facts li { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 14px; align-items: baseline;
                color: var(--muted); font-size: var(--fs-small); line-height: 1.6; }
    .facts b { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
               color: var(--green); font-weight: 500; }
    .trust { margin-top: 28px; font-family: var(--mono); font-size: 12.5px; color: var(--dim); }
    .trust b { color: var(--green); font-weight: 500; }

    /* Form. Inputs and the button share one 44px floor; state changes move
       colour, outline and background, never border width, so nothing shifts. */
    .form-h h2 { color: var(--white); margin-bottom: 6px; }
    .form-h p { color: var(--muted); font-size: 14.5px; margin-bottom: 28px; }
    .form { display: grid; gap: 16px; max-width: 440px; }
    .field { display: grid; gap: 6px; }
    label { font-size: 13.5px; font-weight: 600; color: var(--text); }
    label .opt { color: var(--dim); font-weight: 400; margin-left: 4px; }
    input, select { min-height: 44px; width: 100%; background: var(--surface); color: var(--text);
                    border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 14px;
                    font-family: var(--sans); font-size: 15px;
                    outline: 2px solid transparent; outline-offset: 1px;
                    transition: border-color .15s, background-color .15s; }
    input::placeholder { color: var(--dim); }
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
    .success { display: none; flex-direction: column; gap: 20px; max-width: 440px; }
    .success h2 { color: var(--white); }
    .success > p { color: var(--muted); font-size: 14.5px; line-height: 1.7; }
    .key-value { padding: 14px 18px; font-family: var(--mono); font-size: 13px; color: var(--green);
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
    .ns-num { font-family: var(--mono); font-size: 12px; color: var(--green); padding-top: 2px; }
    .ns p { font-size: 13.5px; color: var(--muted); line-height: 1.6; }
    .ns-pre { margin-top: 8px; background: var(--bg); border: 1px solid var(--border-soft); border-radius: 6px;
              padding: 10px 12px; font-family: var(--mono); font-size: 11.5px; color: var(--code);
              white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
    .ns code { font-family: var(--mono); font-size: 12px; color: var(--text); background: var(--surface3);
               padding: 1px 5px; border-radius: 3px; }

    @media (max-width: 900px) {
      .reg { grid-template-columns: minmax(0, 1fr); grid-template-areas: "pitch" "form" "proof"; gap: 36px;
             padding-block: 40px 64px; }
      .lede { margin-bottom: 20px; }
      .form, .success { max-width: none; }
    }
`,
    })}
<body>
${siteNav('/register', { cta: false })}
<main>

<div class="reg wrap">
  <div class="pitch">
    <h1>Give one job a ceiling.</h1>
    <p class="lede">Start with 1,000 free preflight calls per month. One decorator. Runaway runs blocked. Ship.</p>
    <ul class="facts">
      <li><b>free tier</b><span>1,000 preflight calls a month, per account. No card, no expiry.</span></li>
      <li><b>blocked</b><span>Before the call goes out, not after the bill. The ceiling is consulted first.</span></li>
      <li><b>any provider</b><span>One ceiling per task. You pass what each call is worth; we never look at your provider bill.</span></li>
    </ul>
    <p class="trust"><b>key in 30 seconds</b> · shown once · store it in your environment</p>
  </div>

  <div class="proof">${requestPanel()}</div>

  <div class="form-col">
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
          <label for="use_case">What are you building?</label>
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
          <label for="stack">Primary language</label>
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
      </form>
    </div>

    <div class="success" id="success-state">
      <h2>Your API key is ready.</h2>
      <p>Copy it now. We won't show it again. Store it in your environment variables, not your code.</p>
      <div class="panel">
        <div class="panel-h"><span>API key</span><span>shown once</span></div>
        <div class="key-value">
          <span id="key-display"></span>
          <button class="btn-copy" id="copy-key" type="button">Copy</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-h"><span>Next</span><span>see it refuse a call, right now</span></div>
        <div class="steps">
          <div class="ns"><span class="ns-num">1</span><div><p>Paste this in a terminal. It asks for 5 units against a ceiling of 1, so it is blocked before anything runs.</p><pre class="ns-pre" id="first-curl"></pre></div></div>
          <div class="ns"><span class="ns-num">2</span><p>Open <a href="/app">your console</a> and paste the key. That refusal is the first row on it.</p></div>
          <div class="ns"><span class="ns-num">3</span><p>Then wire it in: <code>pip install agentbill-sdk</code>, <code>export AGENTBILL_API_KEY=your_key</code>, and <code>@meter(event="agent_run", preflight=True)</code> on your agent function. <a href="/docs">Docs</a>, or <a href="/faq">the questions page</a>.</p></div>
        </div>
      </div>
    </div>
  </div>
</div>

</main>
${siteFooter()}

${REGISTER_JS}
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
      // Check if account already exists, return existing key instead of 409
      const [existing] = await sql`
        SELECT k.api_key
        FROM accounts a
        JOIN developer_api_keys k ON k.account_id = a.id
        WHERE a.email = ${email}
        ORDER BY k.created_at ASC
        LIMIT 1
      `

      if (existing) {
        return existingAccountReply(reply, email, existing.apiKey)
      }

      // New account
      const result = await sql.begin(async (tx) => {
        const [account] = await tx`
          INSERT INTO accounts (email, name, plan, use_case, stack, default_budget_units)
          VALUES (${email}, ${name ?? null}, 'free', ${use_case ?? null}, ${stack ?? null}, 1000)
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `

        if (!account) {
          // Race condition: another request created the account between our check and insert.
          // Fetch the key created by the other request.
          const [raceKey] = await tx`
            SELECT k.api_key FROM accounts a
            JOIN developer_api_keys k ON k.account_id = a.id
            WHERE a.email = ${email}
            ORDER BY k.created_at ASC LIMIT 1
          `
          return { type: 'existing' as const, apiKey: raceKey?.apiKey ?? null }
        }

        const apiKey = generateApiKey()
        await tx`
          INSERT INTO developer_api_keys (account_id, api_key, label)
          VALUES (${account.id}, ${apiKey}, 'default')
        `

        return { type: 'created' as const, apiKey }
      })

      if (result.type === 'existing') {
        if (!result.apiKey) {
          return reply.code(409).send({
            error: 'account_exists',
            message: `This email already has an account. Email ${SUPPORT_EMAIL} to recover your key.`,
          })
        }
        return existingAccountReply(reply, email, result.apiKey)
      }

      return reply.code(201).send({
        api_key: result.apiKey,
        message: 'Account created. Store your API key. It will not be shown again.',
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
