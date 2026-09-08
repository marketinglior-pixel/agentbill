import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { RESERVATION_TTL_MINUTES } from '../lib/reservations.js'
import { KEY_CTA } from '../ui/chrome.js'
import { softwareLd } from '../ui/ld.js'

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
    // src/routes/preflight.ts for the five reason strings and their shapes;
    // the raise-vs-return split is sdk/python/agentbill/client.py and
    // sdk/node/src/index.ts. Read 2026-09-08.
    q: 'What actually refuses a call, and what happens after it does?',
    a: `Five things, and each one names itself. ceiling_exceeded means this one call's estimate is over the per-call ceiling. task_ceiling_exceeded means used plus reserved plus this estimate would cross the ceiling on that task_ref. budget_exhausted means that customer's own limit. free_tier_exceeded and plan_limit_exceeded mean our monthly quota ran out, not yours. All five come back as a 200 with approved false, carrying the numbers the decision was made on, and preflight then raises for the three that are your spend rule so a check you forgot to read cannot be silently ignored, and returns the result with an upgrade_url for the two that are ours. What happens next is your code's decision: retry with a smaller estimate, drop to a cheaper model, return what you have, or stop. We are not in your process and cannot end it.`,
  },
  {
    // Nothing meters itself. Units move only through preflight.ts, events.ts
    // and step.ts, all of which your code calls. There is no proxy, no sidecar
    // and no provider credential anywhere in the API surface.
    q: 'Does AgentBill count my tool calls and GPU time automatically?',
    a: `No. Nothing is counted unless your code says so. Units move when you call preflight, record an event, or record a step, and they count against a job's ceiling only when the call carries the same task_ref. So a tool, a GPU run or a vector search counts if you instrument it with that task_ref, and does not exist to us if you do not. Nothing sits in your traffic to watch it, which is the trade: you get one number for a whole job across every provider, and you get it because you decided what each step was worth.`,
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
    // src/routes/preflight.ts: task_budgets is unique on (account_id, task_ref)
    // and agent_id is stored but is not in the enforcement predicate.
    q: 'Can I put a budget on one agent?',
    a: `No, and it is deliberate rather than missing. agent_id is a label: it is stored on every task, step and refusal, and you can filter tasks and decisions by it, but nothing is capped by it. Ceilings hang off a task_ref, off a customer, or off a single call. Two different agents that pass the same task_ref share one ceiling, which is usually what you wanted, because the job is the thing that costs money and the agent is whichever process happened to pick it up.`,
  },
  {
    // src/lib/reservations.ts:8 and reservation-sweeper.ts:16, read 2026-09-05.
    q: 'What happens if a job dies with units still reserved?',
    a: `Preflight reserves the units it approves, so two calls racing cannot both be told there is room for one. A reservation that is never settled expires after ${RESERVATION_TTL_MINUTES} minutes and is swept back to the budget every five minutes. Nothing is held forever because a process crashed, and nothing is released early because a process was slow.`,
  },
  {
    // src/routes/preflight.ts:26,128-158. plan_limit_exceeded is a rejection.
    q: `What happens when I reach the free tier's ${free} calls?`,
    a: `Preflight starts returning free_tier_exceeded (plan_limit_exceeded on a paid plan) and stops approving calls. It is the same shape of refusal as a task ceiling, so your code catches it the same way. Nothing is billed, nothing is silently allowed through, and the counter is checked and incremented in one statement so calls arriving together cannot all read the same number and all pass.`,
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
      mainEntity: 'https://agentbill.dev/faq#faq',
      // softwareLd() rides along so `about` below resolves inside this page.
      // /faq is also the page an answer engine is most likely to fetch on its
      // own, and the product definition is the context every answer needs.
      jsonLd: [softwareLd(), {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        '@id': 'https://agentbill.dev/faq#faq',
        about: { '@id': 'https://agentbill.dev/#software' },
        mainEntity: FAQ.map((x) => ({
          '@type': 'Question',
          name: x.q,
          acceptedAnswer: { '@type': 'Answer', text: x.a },
        })),
      }],
      body: `
  <h1>Questions</h1>
  <p class="lede">Answers checked against the source, not the marketing. Where the
     product does not do something, it says so.</p>
${FAQ.map((x) => `
  <h2>${x.q}</h2>
  <p>${x.a}</p>`).join('')}

  <p class="end"><a class="btn" href="/register">${KEY_CTA}</a></p>
`,
    }))
  })
}
