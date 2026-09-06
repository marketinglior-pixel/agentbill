import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'

// Where a reader lands after writing in, and where the register page's success
// panel points for what happens next.
//
// The API key is NOT here and must never be. A key in a query parameter lands
// in browser history, in the Referer header of any outbound click, and in the
// request log of every hop in between. The key is shown once, in the panel on
// /register, and this page is the part that can safely have a URL.

/**
 * The reply-time promise. It is a promise, so it has to be true on the day it
 * ships and stay true. One person answers mail here; if that stops being
 * one business day, change it here rather than hoping nobody checks.
 */
const REPLY_WITHIN = 'one business day'
const CONTACT = 'hello@agentbill.dev'

export async function thanksRoute(app: FastifyInstance) {
  app.get('/thanks', publicRoute(), async (_, reply) => {
    return reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .send(docsShell({
        path: '/thanks',
        title: 'Thanks · AgentBill',
        description: 'What happens next.',
        current: '',
        rail: false,
        body: `
  <h1>Thanks. That arrived.</h1>
  <p class="lede">A person reads this address, and replies within ${REPLY_WITHIN}.
     If it has been longer, the mail went somewhere it should not have: write
     again to <a href="mailto:${CONTACT}">${CONTACT}</a> and it will be found.</p>

  <h2>While you wait</h2>
  <p>Nothing here needs a reply from us first. The free tier does not need a
     card, the key works the moment it is issued, and the fastest way to know
     whether this fits your loop is to watch it refuse a call.</p>
  <p><a href="/register">Get an API key</a> · <a href="/docs">Read the docs</a> ·
     <a href="/app?demo=1">Open the sample console</a></p>

  <h2>If you were asking about something specific</h2>
  <p><a href="/faq">The questions page</a> answers what a unit is, what happens
     when a job dies holding a reservation, and which features are on which
     plan. The answer to the last one is all of them.</p>
`,
      }))
  })
}
