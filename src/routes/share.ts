import type { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { publicRoute } from '../middleware/auth.js'
import { ORIGIN } from '../ui/site.js'
import { loadShare, loadShareCard, snapshotJson, type PublicShare } from '../lib/share.js'

// A public link to an account's office (2026-09-26): /share/:token, and the
// card a feed previews at /share/:token/card.png. See src/lib/share.ts.
//
// The page draws the snapshot its owner made, and nothing else: no read of the
// account, no live number. It runs the console's own office engine
// (/app/office.js) on that snapshot, from the canvas's data attribute, so its
// one script is 'self' and nothing inline.
//
// noindex, on the page and in a header: a link is the owner's to hand out, not
// a page for search results. robots.txt does NOT disallow /share, because the
// crawlers that draw a link preview (X, LinkedIn, Slack) honour robots.txt, and
// a disallowed page would share with no image.
//
// A token that is malformed, unknown or stopped gets the site's ordinary 404:
// one answer, so the page says nothing about which tokens ever existed.

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const usdText = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function monthText(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, (mo || 1) - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** What the page and its card call it. Dollars only when the owner showed them. */
export function shareHeadline(s: PublicShare): string {
  const m = monthText(s.month), sum = s.snapshot.summary
  return s.showUsd && sum.payroll != null
    ? `${usdText(sum.payroll)} of AI agent payroll in ${m}`
    : `${plural(sum.staff, 'AI agent', 'AI agents')} at work in ${m}`
}

const CSS = `${CHROME_CSS}
    :root { --shell: 1072px; }
    .sh { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); padding-block: var(--s7) var(--s9); }
    .sh .eyebrow { margin-bottom: var(--s3); }
    .sh h1 { font-size: var(--fs-h1-sub); color: var(--white); letter-spacing: -0.03em; line-height: 1.04; max-width: 22ch; margin-bottom: var(--s4); }
    .sh .lead { color: var(--muted); font-size: var(--fs-lede); line-height: 1.55; max-width: 60ch; margin-bottom: var(--s6); text-wrap: pretty; }
    .frame { width: 100%; background: var(--surface2); border-radius: var(--r-card); padding: 24px; }
    .fr-win { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-inner); overflow: hidden; }
    .fr-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--border);
              font-size: var(--fs-micro); color: var(--muted); }
    .of-crop { overflow: hidden; aspect-ratio: 1100 / 610; }
    .of-crop canvas { display: block; width: 100%; height: auto; margin-top: -16.36%; image-rendering: pixelated; }
    .of-cap { font-size: var(--fs-micro); color: var(--muted); padding: 10px 16px 12px; }
    .sh-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--s3); margin: var(--s5) 0 0; padding: 0; list-style: none; }
    .sh-facts li { background: var(--surface2); border-radius: var(--r-field); padding: var(--s3) var(--s4); display: grid; gap: 4px; }
    .sh-facts span { font-size: var(--fs-micro); color: var(--muted); }
    .sh-facts b { font-size: var(--fs-lede); color: var(--white); font-weight: 500; overflow-wrap: anywhere; }
    .sh-cta { margin-top: var(--s8); background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s7); display: grid; justify-items: start; gap: var(--s3); }
    .sh-cta h2 { color: var(--white); letter-spacing: -0.02em; }
    .sh-cta p { color: var(--muted); max-width: 58ch; }
    .sh-go { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: center; }
    .sh-note { margin-top: var(--s5); font-size: var(--fs-micro); color: var(--muted); }
    @media (max-width: ${BP.md}px) {
      .sh { padding-block: var(--s5) var(--s8); }
      .frame { padding: 12px; border-radius: 20px; }
      .sh-cta { padding: var(--s5) 20px; }
    }
`

export function sharePage(s: PublicShare): string {
  const sum = s.snapshot.summary
  const title = shareHeadline(s)
  const hidden = [s.showNames ? '' : 'agent names', s.showUsd ? '' : 'dollar amounts'].filter(Boolean)
  const facts: [string, string][] = [
    ['Agents on staff', sum.staff.toLocaleString('en-US')],
    ['At their desk', sum.atDesk.toLocaleString('en-US')],
    ['Sent home by a spend ceiling', sum.sentHome.toLocaleString('en-US')],
    ...(sum.top ? [['Highest paid', `${sum.top.name}${s.showUsd && sum.top.sal != null ? `, ${usdText(sum.top.sal)}` : ''}`] as [string, string]] : []),
  ]
  const lead = s.showUsd
    ? 'Each salary is what that agent cost this month at public list price, from the tokens its calls reported: an estimate, not an invoice.'
    : 'An agent sits at a desk while it works, leaves with a box when a spend ceiling refuses it, and a new hire walks in and waves.'
  const image = s.hasCard ? `${ORIGIN}/share/${s.token}/card.png` : undefined
  return `${head({
    title: `${esc(title)} · AgentBill`,
    description: esc(s.snapshot.shareText),
    noindex: true,
    og: { title: esc(title), description: esc(s.snapshot.shareText) },
    ogImage: image,
    scriptHashes: [],
    scriptOrigins: { script: ["'self'"] },
    css: CSS,
  })}
<body>
${siteNav()}
  <main class="sh">
    <p class="eyebrow">Shared from AgentBill</p>
    <h1>${esc(title)}</h1>
    <p class="lead">${esc(lead)}</p>
    <figure class="frame">
      <div class="fr-win">
        <div class="fr-bar"><span>the office &middot; ${esc(monthText(s.month))}</span><span>shared ${esc(s.createdAt.toISOString().slice(0, 10))}</span></div>
        <div class="of-crop"><canvas id="office" width="1100" height="790" data-sprites="/app/office-sprites.png" data-office="${snapshotJson(s.snapshot).replace(/"/g, '&quot;')}" role="img" aria-label="${esc(`An office of ${plural(sum.staff, 'AI agent', 'AI agents')}: ${sum.atDesk} at a desk, ${sum.sentHome} sent home by a spend ceiling`)}"></canvas></div>
        <figcaption class="of-cap">Real figures from one AgentBill account, frozen when its owner made this link.${hidden.length ? ` The owner chose to hide ${esc(hidden.join(' and '))}.` : ''}</figcaption>
      </div>
    </figure>
    <ul class="sh-facts">
      ${facts.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join('\n      ')}
    </ul>
    <section class="sh-cta">
      <h2>What do your agents cost you?</h2>
      <p>AgentBill shows what every agent, client and job costs, in dollars at list price, and gives any job a ceiling your code checks before each call.</p>
      <div class="sh-go"><a class="btn btn-lg" href="/register?src=share">Get API key &rarr;</a><a class="btn-ghost" href="/?src=share">See how it works</a></div>
    </section>
    <p class="sh-note">Is something on this page wrong, or not its owner's to share? Write to hello@agentbill.dev.</p>
  </main>
${siteFooter()}
<script src="/app/office.js" defer></script>
</body>
</html>`
}

export async function shareRoute(app: FastifyInstance) {
  app.get('/share/:token', publicRoute(), async (request, reply) => {
    const { token } = request.params as { token: string }
    const s = await loadShare(token)
    if (!s) return reply.callNotFound()
    return reply.type('text/html; charset=utf-8')
      .header('X-Robots-Tag', 'noindex')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(sharePage(s))
  })

  // The card, for the preview a feed draws. Checked PNG bytes (checkCardPng),
  // served as an image and nothing else: nosniff, and a policy that would let
  // no document it could ever be mistaken for run or load anything.
  app.get('/share/:token/card.png', publicRoute(), async (request, reply) => {
    const { token } = request.params as { token: string }
    const png = await loadShareCard(token)
    if (!png) return reply.callNotFound()
    return reply.type('image/png')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=300')
      .header('X-Robots-Tag', 'noindex')
      .send(png)
  })
}
