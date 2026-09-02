import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pixelSnippet } from '../lib/pixel.js'
import { sql } from '../db/index.js'
import { randomBytes } from 'crypto'
import { Resend } from 'resend'
import { allowRegisterAttempt, recoveryInCooldown, markRecoverySent } from '../lib/register-limiter.js'
import { clientIp as resolveClientIp } from '../lib/client-ip.js'

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
  email:    z.string().email(),
  name:     z.string().min(1).max(128).optional(),
  use_case: z.string().max(64).optional(),
  stack:    z.string().max(32).optional(),
})

function generateApiKey(): string {
  return 'agb_' + randomBytes(24).toString('hex')
}


export async function registerRoute(app: FastifyInstance) {

  // Registration page, GET
  app.get('/register', async (_request, reply) => {
    reply.type('text/html')
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Get your API key · AgentBill</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0f; --surface: #111118; --surface2: #1a1a24;
      --border: #ffffff10; --border2: #ffffff1a;
      --text: #e8e8f0; --muted: #8888a0;
      --accent: #6c63ff; --green: #22d3a0; --red: #ff5757;
    }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif;
           font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased;
           min-height: 100vh; display: flex; flex-direction: column; }
    nav { background: rgba(10,10,15,0.9); backdrop-filter: blur(16px);
          border-bottom: 1px solid var(--border); padding: 0 24px; height: 60px;
          display: flex; align-items: center; justify-content: space-between; }
    .nav-logo { font-size: 16px; font-weight: 700; color: var(--text); text-decoration: none;
                display: flex; align-items: center; gap: 8px; }
    .dot { width: 7px; height: 7px; background: var(--green); border-radius: 50%; }
    .page { flex: 1; display: grid; grid-template-columns: 1fr 1fr; min-height: calc(100vh - 60px); }
    .left { background: var(--surface); border-right: 1px solid var(--border);
            padding: 64px 48px; display: flex; flex-direction: column; justify-content: center; }
    .left-label { font-size: 11px; font-weight: 700; text-transform: uppercase;
                  letter-spacing: 2px; color: var(--accent); margin-bottom: 24px; }
    .left h1 { font-size: 30px; font-weight: 800; color: #fff; line-height: 1.2;
               letter-spacing: -1px; margin-bottom: 16px; }
    .left p { font-size: 15px; color: var(--muted); line-height: 1.7; margin-bottom: 40px; max-width: 380px; }
    .feature-list { list-style: none; display: flex; flex-direction: column; gap: 18px; }
    .fi { display: flex; align-items: flex-start; gap: 12px; }
    .fi-check { width: 22px; height: 22px; background: rgba(34,211,160,0.1);
                border: 1px solid rgba(34,211,160,0.2); border-radius: 6px;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0; font-size: 11px; color: var(--green); font-weight: 700; margin-top: 1px; }
    .fi-text h4 { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 2px; }
    .fi-text p { font-size: 13px; color: var(--muted); margin: 0; line-height: 1.5; }
    .quote { margin-top: 40px; padding: 18px 20px; background: rgba(108,99,255,0.06);
             border: 1px solid rgba(108,99,255,0.12); border-radius: 10px; }
    .quote p { font-size: 13px; font-style: italic; color: var(--muted); margin-bottom: 6px; line-height: 1.6; }
    .quote span { font-size: 11px; color: #555570; font-family: 'JetBrains Mono', monospace; }
    .right { padding: 64px 48px; display: flex; flex-direction: column; justify-content: center; }
    .form-header { margin-bottom: 36px; }
    .form-header h2 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 6px; letter-spacing: -0.5px; }
    .form-header p { font-size: 14px; color: var(--muted); }
    .form { display: flex; flex-direction: column; gap: 18px; max-width: 420px; }
    .field { display: flex; flex-direction: column; gap: 7px; }
    label { font-size: 13px; font-weight: 600; color: var(--text); }
    label .opt { color: var(--muted); font-weight: 400; margin-left: 4px; }
    input, select { background: var(--surface); border: 1px solid var(--border2); border-radius: 8px;
                    padding: 11px 14px; font-size: 14px; color: var(--text);
                    font-family: 'Inter', sans-serif; outline: none; width: 100%;
                    transition: border-color 0.15s, box-shadow 0.15s; }
    input::placeholder { color: #444460; }
    input:focus, select:focus { border-color: rgba(108,99,255,0.5); box-shadow: 0 0 0 3px rgba(108,99,255,0.1); }
    select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238888a0' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
             background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px; cursor: pointer; }
    select option { background: #1a1a24; }
    .btn-submit { background: var(--accent); color: white; border: none; padding: 13px 24px;
                  border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer;
                  font-family: 'Inter', sans-serif; transition: all 0.2s; margin-top: 4px; }
    .btn-submit:hover { background: #8b5cf6; transform: translateY(-1px); box-shadow: 0 8px 20px rgba(108,99,255,0.3); }
    .btn-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
    .form-note { font-size: 12px; color: var(--muted); line-height: 1.6; }
    .err { color: var(--red); font-size: 13px; display: none; }

    /* Success state */
    .success { display: none; flex-direction: column; gap: 22px; max-width: 420px; }
    .success-icon { width: 52px; height: 52px; background: rgba(34,211,160,0.1);
                    border: 1px solid rgba(34,211,160,0.2); border-radius: 13px;
                    display: flex; align-items: center; justify-content: center; font-size: 22px; }
    .success h2 { font-size: 22px; font-weight: 700; color: #fff; letter-spacing: -0.5px; }
    .success > p { font-size: 14px; color: var(--muted); line-height: 1.7; }
    .key-box { background: var(--surface); border: 1px solid var(--border2); border-radius: 10px; overflow: hidden; }
    .key-label { padding: 9px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase;
                 letter-spacing: 1.5px; color: var(--muted); border-bottom: 1px solid var(--border); background: var(--surface2); }
    .key-value { padding: 14px; font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--green);
                 display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .btn-copy { background: rgba(108,99,255,0.1); border: 1px solid rgba(108,99,255,0.2); color: var(--accent);
                padding: 5px 11px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
                font-family: 'Inter', sans-serif; transition: all 0.15s; white-space: nowrap; }
    .btn-copy:hover { background: rgba(108,99,255,0.18); }
    .next-steps { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .next-steps h4 { font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 12px;
                     text-transform: uppercase; letter-spacing: 1px; }
    .ns { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); align-items: flex-start; }
    .ns:last-child { border-bottom: none; }
    .ns-num { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; color: var(--accent);
              background: rgba(108,99,255,0.1); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; margin-top: 1px; }
    .ns p { font-size: 13px; color: var(--muted); line-height: 1.5; }
    .ns > div { min-width: 0; flex: 1; }
    .ns-pre { margin-top: 8px; background: var(--bg); border: 1px solid var(--border2); border-radius: 6px;
              padding: 10px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--green);
              white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
    .ns code { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text);
               background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 3px; }
    .mobile-promises { display: none; }
    @media (max-width: 768px) { .page { grid-template-columns: 1fr; } .left { display: none; }
      .right { padding: 32px 20px; }
      .mobile-promises { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 24px;
        font-size: 12.5px; color: var(--green); font-weight: 600; }
    }
  </style>
  <meta name="description" content="Free API key in 30 seconds. 1,000 preflight calls/month, hard per-task budget ceilings for AI agents. No credit card." />
  <link rel="canonical" href="https://agentbill.dev/register" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/register" />
  <meta property="og:title" content="Get your API key · AgentBill" />
  <meta property="og:description" content="Hard budget ceilings for AI agents. Free tier, key in 30 seconds, no credit card." />
  <meta property="og:image" content="https://agentbill.dev/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://agentbill.dev/og.png" />
  ${pixelSnippet()}
</head>
<body>
<nav>
  <a href="/" class="nav-logo"><div class="dot"></div> AgentBill</a>
</nav>
<div class="page">
  <div class="left">
    <div class="left-label">Free forever &middot; No credit card</div>
    <h1>Your agents deserve<br/>proper governance.</h1>
    <p>Start with 1,000 free preflight calls per month. One decorator. Runaway runs blocked. Ship.</p>
    <ul class="feature-list">
      <li class="fi"><div class="fi-check">&#10003;</div><div class="fi-text"><h4>1,000 free preflight calls/month</h4><p>No expiry. Full API access on the free tier.</p></div></li>
      <li class="fi"><div class="fi-check">&#10003;</div><div class="fi-text"><h4>Per-request ceiling enforcement</h4><p>Block before compute starts. Not after the invoice.</p></div></li>
      <li class="fi"><div class="fi-check">&#10003;</div><div class="fi-text"><h4>Multi-tenant out of the box</h4><p>Independent credit balances per customer_id. Zero config.</p></div></li>
      <li class="fi"><div class="fi-check">&#10003;</div><div class="fi-text"><h4>Production in 5 minutes</h4><p>One decorator. One env var. That's the integration.</p></div></li>
    </ul>
    <div class="quote">
      <p>"The moment you're using Stripe as your safety net, you've already lost the run."</p>
      <span>scarlett1908 · r/LangChain</span>
    </div>
  </div>

  <div class="right">
    <div class="mobile-promises"><span>&#10003; Free forever</span><span>&#10003; No credit card</span><span>&#10003; 1,000 preflight calls/mo</span></div>
    <div id="form-state">
      <div class="form-header">
        <h2>Get your API key</h2>
        <p>Takes 30 seconds. No setup call. No credit card.</p>
      </div>
      <form class="form" id="reg-form">
        <div class="field">
          <label for="email">Work email</label>
          <input type="email" id="email" placeholder="you@company.com" required autocomplete="email" />
        </div>
        <div class="field">
          <label for="name">Your name <span class="opt">(optional)</span></label>
          <input type="text" id="name" placeholder="Ada Lovelace" autocomplete="name" />
        </div>
        <div class="field">
          <label for="use_case">What are you building?</label>
          <select id="use_case">
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
          <select id="stack">
            <option value="">Select one&hellip;</option>
            <option value="python">Python</option>
            <option value="nodejs">Node.js</option>
            <option value="other">Other</option>
          </select>
        </div>
        <p class="err" id="err"></p>
        <button type="submit" class="btn-submit" id="submit-btn">Generate my API key &rarr;</button>
        <p class="form-note">By registering you agree to our <a href="/terms" style="color:var(--accent)">Terms of Service</a> and <a href="/privacy" style="color:var(--accent)">Privacy Policy</a>. No marketing email. Just a key.</p>
      </form>
    </div>

    <div class="success" id="success-state">
      <div class="success-icon">&#128273;</div>
      <h2>Your API key is ready.</h2>
      <p>Copy it now. We won't show it again. Store it in your environment variables, not your code.</p>
      <div class="key-box">
        <div class="key-label">API Key</div>
        <div class="key-value">
          <span id="key-display"></span>
          <button class="btn-copy" onclick="copyKey()">Copy</button>
        </div>
      </div>
      <div class="next-steps">
        <h4>See it refuse a call, right now</h4>
        <div class="ns"><span class="ns-num">1</span><div><p>Paste this in a terminal. It asks for 5 units against a ceiling of 1, so it is blocked before anything runs.</p><pre class="ns-pre" id="first-curl"></pre></div></div>
        <div class="ns"><span class="ns-num">2</span><p>Open <a href="/app" style="color:var(--accent)">your receipt</a> and paste the key. That refusal is the first line on it.</p></div>
        <div class="ns"><span class="ns-num">3</span><p>Then wire it in: <code>pip install agentbill-sdk</code>, <code>export AGENTBILL_API_KEY=your_key</code>, and <code>@meter(event="agent_run", preflight=True)</code> on your agent function. <a href="/docs" style="color:var(--accent)">Docs</a>.</p></div>
      </div>
    </div>
  </div>
</div>

<script>
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

  function copyKey() {
    navigator.clipboard.writeText(apiKey)
    const btn = document.querySelector('.btn-copy')
    btn.textContent = 'Copied!'
    btn.style.color = 'var(--green)'
    setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = '' }, 2000)
  }
</script>
</body>
</html>`)
  })

  // Register API, POST. New accounts get their key instantly (shown once);
  // existing emails get the key by email, never in the response.
  app.post('/register', async (request, reply) => {
    // Validate first: a malformed body leaks nothing, so it must not burn a
    // rate-limit slot (bot probes and typos were draining the bucket).
    const parsed = RegisterBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
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
