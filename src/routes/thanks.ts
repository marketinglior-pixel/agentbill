import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { sql } from '../db/index.js'
import { isUuid } from '../lib/ids.js'
import { checkoutIsPaid, getCheckoutSummary, PLAN_LIMITS, PLAN_PRICES } from '../integrations/polar.js'

// Where Polar returns a buyer after checkout. It is the success_url on every
// session /checkout/:tier mints, and it is the only inbound this page has:
// nothing in the site links here.
//
// Until 2026-09-08 this page was a contact-form thank-you ("that arrived, a
// person replies within one business day") that also told the reader the free
// tier needs no card and offered them an API key. Someone who had just paid
// $99 landed on a page thanking them for a message they never sent and selling
// them the free plan. The page had been written for a form that never pointed
// at it.
//
// The API key is NOT here and must never be. A key in a query parameter lands
// in browser history, in the Referer header of any outbound click, and in the
// request log of every hop in between. The key is shown once, on /register.
//
// What this page may claim is bounded by two reads, because the query string
// belongs to the buyer and can be edited:
//   1. Polar, by checkout id, says whether money moved and which product.
//   2. Our own accounts row says whether the webhook has landed yet.
// A purchase is confirmed only when both agree. When Polar says paid and our
// row does not, that is the webhook race and the page says so rather than
// promising a ceiling the account does not yet have.

const CONTACT = 'hello@agentbill.dev'

const num = (n: number) => n.toLocaleString('en-US')
const title = (tier: string) => tier[0].toUpperCase() + tier.slice(1)

/**
 * What the tier includes, from the one table that defines it. The legacy 'paid'
 * plan predates the tiers and carries no monthly cap; preflight meters it per
 * call, so it must not be described with a number it does not have.
 */
function allowance(tier: string): string {
  const limit = PLAN_LIMITS[tier]
  if (limit === undefined) return 'Every preflight call is metered, with no monthly cap.'
  return `Your account now includes <b>${num(limit)}</b> preflight calls a month, at $${PLAN_PRICES[tier]} a month.`
}

export async function thanksRoute(app: FastifyInstance) {
  app.get('/thanks', publicRoute(), async (request, reply) => {
    const q = request.query as Record<string, unknown>
    const checkoutId = typeof q?.checkout_id === 'string' ? q.checkout_id : ''

    // A strict uuid gate before any outbound call. It rejects the noise a
    // public endpoint attracts, and it also catches the one failure mode this
    // page cannot test for: if Polar ever stops substituting the placeholder,
    // the literal "{CHECKOUT_ID}" arrives here, fails this test, and the reader
    // gets the honest fallback instead of a broken lookup.
    const summary = isUuid(checkoutId) ? await getCheckoutSummary(checkoutId) : null

    let heading: string
    let body: string
    let pageTitle: string
    // Drives the nav CTA. True only once Polar says money moved, so a reader
    // who has not bought anything still gets the signup button.
    let paid = false

    if (!summary) {
      pageTitle = 'Thanks · AgentBill'
      heading = 'Thanks.'
      body = `
  <p class="lede">This link does not identify a checkout, so there is nothing for us to confirm on it.</p>
  <p>If you have just paid, <a href="/app">your console</a> is the source of truth: the Limits view
     names the plan on your account and what this month has used against it.</p>`
    } else if (!checkoutIsPaid(summary.status)) {
      // Deliberately not rendering Polar's status word. It is their string, it
      // reaches this page through a URL the reader controls, and the reader does
      // not need the enum. The three unpaid states all mean the same thing here.
      pageTitle = 'Checkout not complete · AgentBill'
      heading = 'This checkout is not complete.'
      body = `
  <p class="lede">Polar has no completed payment on this session, so nothing has changed on your account.</p>
  <p><a href="/pricing">Back to pricing</a>, or <a href="/app">open your console</a> to see the plan you are on now.</p>`
    } else {
      // Paid. Does our own state agree yet?
      paid = true
      let livePlan: string | null = null
      if (isUuid(summary.accountId)) {
        try {
          const [row] = await sql`SELECT plan FROM accounts WHERE id = ${summary.accountId}`
          livePlan = typeof row?.plan === 'string' ? row.plan : null
        } catch (err) {
          // The page still renders; it just falls to the pending copy, which
          // tells the reader to check the console. Claiming the upgrade is live
          // on a read that failed is the one thing this page must not do.
          request.log.error({ err }, 'thanks: account read failed')
        }
      }

      if (livePlan === summary.plan) {
        pageTitle = `You are on ${title(summary.plan)} · AgentBill`
        heading = `You are on ${title(summary.plan)}.`
        body = `
  <p class="lede">Payment confirmed. ${allowance(summary.plan)}</p>
  <p><a href="/app">Open your console</a>. The Limits view shows the plan and the month against it.</p>
  <p>There is nothing to install and no key to replace. The new ceiling is already live on the API
     keys you have, and your code does not change.</p>`
      } else {
        pageTitle = 'Payment received · AgentBill'
        heading = 'Payment received.'
        body = `
  <p class="lede">Polar has confirmed your ${title(summary.plan)} purchase. The account has not switched
     over yet, which usually takes a few seconds.</p>
  <p>Reload this page, or <a href="/app">open your console</a>: the Limits view names the new plan the
     moment it lands.</p>
  <p>If it still shows the old plan in a few minutes, write to
     <a href="mailto:${CONTACT}">${CONTACT}</a> and it will be put right by hand.</p>`
      }
    }

    return reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .send(docsShell({
        path: '/thanks',
        title: pageTitle,
        description: 'Your AgentBill plan after checkout.',
        current: '',
        rail: false,
        navCta: !paid,
        body: `
  <h1>${heading}</h1>
${body}
`,
      }))
  })
}
