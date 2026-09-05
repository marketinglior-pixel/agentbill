import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { RESERVATION_TTL_MINUTES } from '../lib/reservations.js'

// Questions the docs answer indirectly or not at all, and every answer checked
// against the source before it was written. The file each claim was read from
// is named in a comment beside it, so the next person to edit this page can
// re-check rather than trust.
//
// One array drives the visible <h2>/<p> pairs and the FAQPage mainEntity.
// Google requires the answer text to be on the page, so a second copy in the
// structured data would be both a lie and a duplicate.

const free = PLAN_LIMITS.free.toLocaleString('en-US')

type QA = { q: string; a: string }

const FAQ: readonly QA[] = [
  {
    // src/routes/preflight.ts: units are an integer the caller passes. Nothing
    // in the codebase converts them to currency.
    q: 'What is a unit?',
    a: `An integer you define and pass. AgentBill counts units and compares them to a ceiling; it never converts them to money and never reads your provider bill. If one unit is one cent for you, a ceiling of 500 is five dollars. If one unit is one document, a ceiling of 500 is five hundred documents. The meaning is yours and the arithmetic is ours.`,
  },
  {
    // llms.txt and preflight.ts both: no provider credentials, no bill access.
    q: 'Does AgentBill see my provider bill?',
    a: `No. It never has access to your OpenAI, Anthropic or cloud account, and it does not read, estimate or reconcile against your invoice. It knows what your code told it a call was worth. That is a deliberate limit and it is why a unit is whatever you say it is.`,
  },
  {
    // src/routes/preflight.ts:128-158. One conditional UPDATE, not read-then-write.
    q: 'How is a task budget different from a monthly spend cap?',
    a: `A monthly cap resets on a calendar. A task budget is attached to a task_ref, so every call in one job draws down one ceiling regardless of which provider it goes to, and the ceiling is consulted before each call rather than totalled at the end of a period. A budget that resets tomorrow does not stop the loop that is running tonight.`,
  },
  {
    // src/lib/reservations.ts:8 and reservation-sweeper.ts:16, read 2026-09-05.
    q: 'What happens if a job dies with units still reserved?',
    a: `Preflight reserves the units it approves, so two calls racing cannot both be told there is room for one. A reservation that is never settled expires after ${RESERVATION_TTL_MINUTES} minutes and is swept back to the budget every five minutes. Nothing is held forever because a process crashed, and nothing is released early because a process was slow.`,
  },
  {
    // src/routes/preflight.ts:26,128-158. plan_limit_exceeded is a rejection.
    q: `What happens when I reach the free tier's ${free} calls?`,
    a: `Preflight starts returning plan_limit_exceeded and stops approving calls. It is the same shape of refusal as a task ceiling, so your code catches it the same way. Nothing is billed, nothing is silently allowed through, and the counter is checked and incremented in one statement so calls arriving together cannot all read the same number and all pass.`,
  },
  {
    // Verified: nothing in src/ branches on plan except quota, display and the
    // admin classification. design.md records this as a copy rule.
    q: 'Which features are on which plan?',
    a: `All of them, on all of them. Nothing in the code gates a feature by plan: the only thing a plan changes is how many preflight calls a month it includes, and who answers when you write in. Tiers here sell headroom, not capability.`,
  },
  {
    // src/routes/preflight.ts is an endpoint your code calls; there is no proxy.
    q: 'Does AgentBill sit in my request path?',
    a: `No. It is an endpoint your code calls before it calls a provider, not a gateway your traffic routes through. Nothing to point your base URL at, nothing new that can be down between you and OpenAI, and no third party holding your provider keys. If AgentBill is unreachable your code decides what to do, which is a decision a proxy would have taken away from you.`,
  },
  {
    // src/routes/keys.ts + src/middleware/auth.ts, all shipped.
    q: 'What can I do if a key leaks?',
    a: `Revoke it, and it stops authenticating on the next request rather than at the end of a billing period. You can also rotate it, which issues a new key and keeps the old one working for 24 hours so a deploy is not an outage; set an expiry when you generate it; and hold several labelled keys per account. Keys are rate limited, and a key used from a new address emails you.`,
  },
]

export async function faqRoute(app: FastifyInstance) {
  app.get('/faq', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/faq',
      title: 'Questions · AgentBill',
      description: 'What a unit is, what happens when a job dies holding a reservation, how a task budget differs from a monthly cap, and which features are on which plan.',
      current: '',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ.map((x) => ({
          '@type': 'Question',
          name: x.q,
          acceptedAnswer: { '@type': 'Answer', text: x.a },
        })),
      },
      body: `
  <h1>Questions</h1>
  <p class="lede">Answers checked against the source, not the marketing. Where the
     product does not do something, it says so.</p>
${FAQ.map((x) => `
  <h2>${x.q}</h2>
  <p>${x.a}</p>`).join('')}

  <p class="end"><a class="btn" href="/register">Get your API key</a></p>
`,
    }))
  })
}
