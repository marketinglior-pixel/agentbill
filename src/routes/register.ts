import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { randomBytes } from 'crypto'

const RegisterBody = z.object({
  email: z.string().email(),
  name:  z.string().min(1).max(128).optional(),
})

function generateApiKey(): string {
  return 'agb_' + randomBytes(24).toString('hex')
}

export async function registerRoute(app: FastifyInstance) {

  // Registration page — GET
  app.get('/register', async (_request, reply) => {
    reply.type('text/html')
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentBill — Get your API key</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0d0d0d; color: #e2e8f0;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 40px; width: 100%; max-width: 460px; }
    .logo { color: #a78bfa; font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .tagline { color: #4b5563; font-size: 12px; margin-bottom: 32px; }
    label { display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
    input { width: 100%; background: #0d0d0d; border: 1px solid #1f2937; border-radius: 6px;
            color: #e2e8f0; font-family: inherit; font-size: 14px; padding: 10px 14px; margin-bottom: 20px; outline: none; }
    input:focus { border-color: #7c3aed; }
    button { width: 100%; background: #7c3aed; border: none; border-radius: 6px; color: #fff;
             font-family: inherit; font-size: 14px; font-weight: 600; padding: 12px; cursor: pointer; }
    button:hover { background: #6d28d9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .result { display: none; margin-top: 28px; }
    .result h3 { font-size: 13px; color: #4ade80; margin-bottom: 12px; }
    .key-box { background: #0d0d0d; border: 1px solid #7c3aed; border-radius: 6px; padding: 14px;
               font-size: 13px; color: #c4b5fd; word-break: break-all; position: relative; }
    .copy-btn { margin-top: 10px; background: #1f2937; border: 1px solid #374151; border-radius: 6px;
                color: #e2e8f0; font-family: inherit; font-size: 12px; padding: 6px 14px;
                cursor: pointer; width: auto; }
    .copy-btn:hover { background: #374151; }
    .warning { margin-top: 12px; font-size: 11px; color: #f59e0b; }
    .error { color: #f87171; font-size: 13px; margin-top: 16px; display: none; }
    .docs { margin-top: 24px; font-size: 12px; color: #4b5563; text-align: center; }
    .docs a { color: #7c3aed; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">AgentBill</div>
    <div class="tagline">Usage-based billing for AI agents — 3 lines of code</div>

    <form id="form">
      <label>Email</label>
      <input type="email" id="email" placeholder="you@company.com" required />

      <label>Name (optional)</label>
      <input type="text" id="name" placeholder="Your name or company" />

      <button type="submit" id="btn">Get my API key →</button>
    </form>

    <div class="error" id="error"></div>

    <div class="result" id="result">
      <h3>✓ Your API key is ready</h3>
      <div class="key-box" id="key-value"></div>
      <button class="copy-btn" onclick="copyKey()">Copy key</button>
      <div class="warning">⚠ Save this key now — it will not be shown again.</div>
    </div>

    <div class="docs">
      <a href="https://github.com/marketinglior-pixel/agentbill" target="_blank">View docs on GitHub →</a>
    </div>
  </div>

  <script>
    let apiKey = ''
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = document.getElementById('btn')
      const errEl = document.getElementById('error')
      btn.disabled = true
      btn.textContent = 'Creating account...'
      errEl.style.display = 'none'

      const res = await fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          name: document.getElementById('name').value || undefined,
        })
      })
      const data = await res.json()

      if (!res.ok) {
        errEl.textContent = data.message ?? 'Something went wrong'
        errEl.style.display = 'block'
        btn.disabled = false
        btn.textContent = 'Get my API key →'
        return
      }

      apiKey = data.api_key
      document.getElementById('key-value').textContent = apiKey
      document.getElementById('result').style.display = 'block'
      document.getElementById('form').style.display = 'none'
    })

    function copyKey() {
      navigator.clipboard.writeText(apiKey)
      document.querySelector('.copy-btn').textContent = '✓ Copied'
      setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy key', 2000)
    }
  </script>
</body>
</html>`)
  })

  // Register API — POST
  app.post('/register', async (request, reply) => {
    const parsed = RegisterBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      })
    }

    const { email, name } = parsed.data

    try {
      const result = await sql.begin(async (tx) => {
        // Create account (or return existing if email already registered)
        const [account] = await tx`
          INSERT INTO accounts (email, name, plan)
          VALUES (${email}, ${name ?? null}, 'free')
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `

        if (!account) {
          return { type: 'already_exists' as const }
        }

        // Generate and store API key
        const apiKey = generateApiKey()
        await tx`
          INSERT INTO developer_api_keys (account_id, api_key, label)
          VALUES (${account.id}, ${apiKey}, 'default')
        `

        return { type: 'created' as const, accountId: account.id as string, apiKey }
      })

      if (result.type === 'already_exists') {
        return reply.code(409).send({
          error: 'already_exists',
          message: 'An account with this email already exists.',
        })
      }

      return reply.code(201).send({
        account_id: result.accountId,
        api_key: result.apiKey,
        message: 'Account created. Store your API key — it will not be shown again.',
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
