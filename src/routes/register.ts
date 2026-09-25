import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pixelSnippet, pixelHashes, pixelExtra } from '../lib/pixel.js'
import { plain } from '../lib/ids.js'
import { allowRegisterAttempt } from '../lib/register-limiter.js'
import { clientIp as resolveClientIp, limiterKey } from '../lib/client-ip.js'
import { publicRoute } from '../middleware/auth.js'
import { HEADLINE } from '../ui/site.js'
import { inlineScript } from '../lib/csp.js'
import { PULSE_CLIENT_SRC } from '../ui/pulse-client.js'
import { sameOrigin } from './app.js'
import { signinPage, queueSignInLink, allowLinkRequest, CHECK_EMAIL } from './auth.js'

// /register, since 2026-09-25: sign up with Google, GitHub or an email link,
// and no key until the address is verified.
//
// Until that day this page and POST /register created an account on any
// address typed into it and handed back a live API key in the same response,
// in thirty seconds, with nothing checked. That was finding S6 of the
// 2026-09-25 audit: mass signups from one /48, and a different answer for an
// address that already had an account, which made the form an account-existence
// oracle. Lior's decision was "email verification before the key". So:
//
//   the page      is the sign-in block (src/ui/signin.ts), the same one /login
//                 draws. The first sign-in of a person makes their account; the
//                 console's start screen then makes the key and shows it once.
//   POST, JSON    the call curl, the SDK docs and llms.txt used. It no longer
//                 returns a key. It mails a sign-in link to the address and
//                 answers 202 with the same body for every address, new or
//                 known, so it says nothing about who has an account.
//   POST, form    the page's no-script fallback, now the same as /auth/email.
//
// The optional name / use_case / stack fields are still accepted so an old
// client's body does not turn into a 422, and are not stored: an account does
// not exist yet when this answers. The console's /app/profile takes them.

const RegisterBody = z.object({
  email:    z.string().trim().toLowerCase().max(254).email(),
  name:     plain(z.string().min(1).max(128)).optional(),
  use_case: plain(z.string().max(64)).optional(),
  stack:    plain(z.string().max(32)).optional(),
})

// The funnel beacon and nothing else. The form is a plain POST, so the page
// works with no script at all; this only records that the page loaded, and it
// runs last so it can never stand in front of anything.
const reg = inlineScript(`${PULSE_CLIENT_SRC}
  try { pulse('register_view') } catch (e) {}`)
const REGISTER_JS = reg.html
export const REGISTER_HASH = reg.hash

export async function registerRoute(app: FastifyInstance) {

  app.get('/register', publicRoute(), async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    reply.type('text/html')
    return reply.send(signinPage({
      path: '/register',
      title: 'Create your account · AgentBill',
      description: 'A free AgentBill account: sign up with Google, GitHub or an email link, and make your API key in the console. 1,000 preflight calls a month, hard per-task budget ceilings for AI agents. No credit card.',
      og: { description: `${HEADLINE}. Free tier, no credit card.` },
      h1: 'Give one job a ceiling.',
      lede: 'Key once. Ceiling on one <code>task_ref</code>. Preflight returns <code>approved: false</code> when that job is out. Your code decides.',
      trust: '<b>free</b> · no card · your key is made in the console, shown once',
      h2: 'Create your account',
      sub: 'Sign up, and the console makes your API key. No card.',
      sent: q.sent === '1',
      err: typeof q.err === 'string' ? q.err : '',
      next: '',
      extraHead: pixelSnippet(),
      scriptHashes: [REGISTER_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      script: REGISTER_JS,
    }))
  })

  app.post('/register', publicRoute(), async (request, reply) => {
    // Cross-site requests refused (S11, batch A): a form on another site must
    // not be able to make this server mail anybody on its say-so. curl and the
    // SDKs send neither Sec-Fetch-Site nor Origin and are not affected.
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden', message: 'Cross-site requests to /register are refused.' })

    const json = String(request.headers['content-type'] ?? '').includes('application/json')
    const parsed = RegisterBody.safeParse(request.body)
    if (!parsed.success) {
      // A malformed body leaks nothing, so it burns no rate-limit slot.
      if (!json) return reply.redirect('/register', 303)
      return reply.code(422).send({
        error: 'validation_error',
        message: [parsed.error.issues[0]?.path?.join('.'), parsed.error.issues[0]?.message].filter(Boolean).join(': ') || 'Invalid request body',
      })
    }

    // Both per-network counters: /register's own, and the one every sign-in
    // link shares, so this path is not a second allowance for the same mail.
    if (!allowRegisterAttempt(limiterKey(request)) || !allowLinkRequest(request)) {
      request.log.warn({ clientIp: resolveClientIp(request) }, 'register rate limited')
      if (!json) return reply.redirect('/register?err=rate', 303)
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many attempts from this address. Try again in an hour.' })
    }

    queueSignInLink(request.log, parsed.data.email, '')
    if (!json) return reply.redirect('/register?sent=1', 303)
    return reply.code(202).send(CHECK_EMAIL)
  })
}
