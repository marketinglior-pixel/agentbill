import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { CONTENT_CSS } from '../ui/content.js'

// /security, the plain-language twin of SECURITY.md.
//
// Written 2026-09-25 after the OWASP audit, because the question that
// triggered it ("I can't connect your API to my stuff when I don't know how
// secure it is") had no page to answer it. The rule for the "what we do" list
// is the rule for every claim on this site: only what is implemented and held
// by a gate in scripts/preflight/verify.mjs today. Keys are stored in plain
// text until the next batch, so this page says so and claims no hashing.

const CONTACT = 'hello@agentbill.dev'
const REPO = 'https://github.com/marketinglior-pixel/agentbill'

export async function securityRoute(app: FastifyInstance) {
  app.get('/security', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/security',
      title: 'Security · AgentBill',
      description: 'How to report a vulnerability in AgentBill, what the SDKs send and never send, how to revoke a leaked key, and what the service does to protect your account.',
      current: '',
      css: CONTENT_CSS,
      body: `
  <h1>Security</h1>
  <p class="lede">What to do if you find a problem, what our code sends from your machine, and what
     the service does with your account today. The same policy, for the repository, is in
     <a href="${REPO}/blob/main/SECURITY.md">SECURITY.md</a>.</p>

  <h2 id="report">Report a vulnerability</h2>
  <p>Write to <a href="mailto:${CONTACT}">${CONTACT}</a>, or use GitHub's private vulnerability
     reporting on <a href="${REPO}">the repository</a>. Please do not open a public issue. Say what you
     found, how to reproduce it, and what you think it allows. You will hear back within 48 hours.</p>
  <p>In scope: the API and every page on agentbill.dev, the console, and the open-source clients
     (the Python and Node SDKs, the MCP server, the OpenClaw plugin). Out of scope: denial of service
     or load testing against agentbill.dev, social engineering, and the services we build on (Fly.io,
     Supabase, Polar, Resend), which you should report to them.</p>
  <p>Test only against an account you created yourself. If you do that in good faith, stop as soon
     as you can reach anything that is not yours, and tell us, we will not take or support legal
     action against you for it. Please give us time to fix a problem before you publish it.</p>

  <h2 id="leaked-key">If a key leaks</h2>
  <p>Revoke it. From the next request on, it no longer authenticates.</p>
  <div class="code"><pre>
curl -X POST https://agentbill.dev/keys/revoke \\
  -H "Authorization: Bearer agb_another_key_on_the_account" \\
  -H "Content-Type: application/json" \\
  -d '{"key_prefix":"agb_1234…abcd"}'</pre></div>
  <p>That is the form <code class="inline">GET /keys</code> and the console's keys view at
     <a href="/app">agentbill.dev/app</a> show each key in; neither ever shows a key itself. The keys
     view can also revoke every key on the account at once. If you have no key left at all,
     <a href="/recover">agentbill.dev/recover</a> sends a single-use link to the account's email address,
     which makes a new key. Rotation (<code class="inline">POST /keys/rotate</code>) keeps the old key
     working for an hour unless you ask for less, which is for planned changes; for a leak, revoke.</p>

  <h2 id="what-the-clients-send">What our code sends from your machine</h2>
  <p>Every request carries your AgentBill key and goes over HTTPS.</p>
  <ul>
    <li><code class="inline">preflight()</code>, <code class="inline">record()</code> and
        <code class="inline">meter()</code> send what you pass them: the agent, the job
        (<code class="inline">task_ref</code>), the customer, the units, an idempotency key, and any
        metadata you attach.</li>
    <li><code class="inline">wrap()</code> also sends, for each model call: the provider, the model,
        the token counts the provider reported, how long the call took, the step you named, the model
        you asked for when a different one answered, the provider's service tier when it reports one,
        whether the call was streamed, and the provider's response id, used so a retried record is
        counted once.</li>
    <li><code class="inline">wrap()</code> never sends your prompts, the model's answers, or your
        provider keys. Those stay between your process and the provider.</li>
    <li>The OpenClaw plugin sends the job, the token total, the provider and model names, and a tool's
        name for a tool call. It does not send the conversation or what a tool was given or returned.</li>
  </ul>

  <h2 id="what-we-do">What the service does today</h2>
  <ul>
    <li>Every page and API call is HTTPS, with HSTS. The connection to our database is encrypted and
        its certificate is verified.</li>
    <li>Every query that reads or writes your data is scoped to your account, and one account cannot
        read another's jobs, customers, keys or refusals.</li>
    <li>A key is shown once, when it is made, and is never emailed. Keys are stored in plain text in
        our database today; storing only a hash of each key is the next change we are making.</li>
    <li>When a key is used from a network it has never been used from before, the account's owner is
        emailed. The key's very earliest network is the one exception, since nothing has changed yet.</li>
    <li>Requests are limited per key and per account, and repeated attempts with keys that do not
        exist are limited per network before our database is asked.</li>
    <li>Recovery links are single-use, expire after an hour, and are stored only as a hash. They are
        kept out of our logs, and so are query strings.</li>
    <li>No API key is issued to an email address that has not been verified. Sign-in by email is a
        link that works once, expires after fifteen minutes and is stored only as a hash; with Google
        or GitHub we accept only an address the provider says is verified, and an existing account
        is connected to one only by somebody already signed in to it, never because an address
        matches.</li>
    <li>The console's session cookie is HttpOnly, Secure and SameSite. A session opened with a key
        ends the moment its key is revoked; a signed-in person's session also ends on our side when
        they sign out, so a copy of the cookie no longer opens anything. Its forms, sign-in and sign-up refuse
        requests from other sites.</li>
    <li>The MCP server at <code class="inline">https://agentbill.dev/mcp</code> answers only a request
        carrying an API key or an access token it issued for itself. An app connects only after you
        approve it on a page that names it, says where your browser goes next and what it will be able
        to do, and you can disconnect it in the console. Its codes and tokens are stored only as a hash,
        an access token lasts an hour, and a refresh token that is used twice ends the connection. No
        MCP tool can create or show a key, or change your plan or billing.</li>
    <li>An alert webhook goes only to an https URL on a public address, checked when you save it and
        again when we send; it is signed, and a redirect is never followed.</li>
    <li>Payments are handled by Polar. We never see a card number. Polar's notifications are verified
        by signature, acted on once, and only a paid order or an active subscription for one of our
        plans changes a plan.</li>
  </ul>
  <p>If anything on this page is no longer true, that is a bug. Write to
     <a href="mailto:${CONTACT}">${CONTACT}</a> if you find one.</p>
`,
    }))
  })
}
