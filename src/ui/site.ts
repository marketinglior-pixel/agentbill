// One definition of what pages exist and what each one is.
//
// Before this file, "the set of pages" was written down in five places that
// could disagree, and did: the sitemap listed 7 URLs and omitted /pricing and
// both blog posts; canonical was emitted on 4 of 10 indexable pages; og tags on
// 3; robots.txt disallowed /app, which the homepage's own CTA links to; and
// lastmod was `new Date()`, so every URL claimed it changed today, every day.
//
// head(), docsShell(), the sitemap, robots.txt, the blog index and the CI crawl
// gate all read this. A page that is not here does not get a canonical, does
// not reach the sitemap, and fails the crawl gate the moment anything links to
// it. That is the point.

export const ORIGIN = 'https://agentbill.dev'

/** The one sentence the site leads with. The homepage <title>, its h1, the
 *  share card, /pricing's description and /register's share description all
 *  render from here, so the head, the body and the PNG cannot disagree about
 *  it again: until 2026-09-07 the PNG carried a headline the other two had
 *  retired, because a grep cannot see an image. It happened a second time on
 *  2026-09-24, the other way round: `/` led with a second constant (HOME_H1)
 *  while the PNG kept this one, and a WhatsApp preview of agentbill.dev showed
 *  "A ceiling on this job, not on the month" on the old dark card beside the
 *  new description. A gate in the harness ([og]) now compares the headline the
 *  card was built from with this constant, the h1 and the <title>.
 *
 *  Decided 2026-09-24: the canvas homepage and this line, trialled on `/` from
 *  2026-09-23 as HOME_H1, are kept, live on every screen as of e6c9acc. HOME_H1
 *  was folded into this constant the same day and deleted, as its own comment
 *  asked, and og.png was rebuilt from it.
 *
 *  Why this line replaced "A ceiling on this job, not on the month", recorded
 *  so the next change is a decision and not a rediscovery: the old line named
 *  the mechanism's contrast (job versus month) rather than the reader. The
 *  2026-09-23 value pack's brief was outcome-first for builders who leave
 *  agents running unattended, and this line names that reader and the outcome
 *  in words they own. The contrast did not leave the site: it is the homepage's
 *  statement panel. Two pack options were rejected in review before this one
 *  was chosen: "Don't let one agent job run away overnight" promised that we
 *  end the run, and "A ceiling on this job, shared across every call" claimed
 *  every call when only the calls that ask preflight share it.
 *
 *  Earlier history, short: 2026-09-07 retired "A spend ceiling bound to the
 *  task, not the month" for naming a category, and its replacement ("One
 *  ceiling per task_ref...") was turned back on 2026-09-10 because a first-time
 *  reader has no task_ref yet and eight of nine live folds in this niche name
 *  an audience or an outcome in the h1.
 *
 *  It is deliberately plain text with no markup. The <title> and the PNG
 *  cannot carry a span, and a second hand-kept copy of the headline is exactly
 *  the drift this constant exists to prevent.
 *
 *  Known cost: with the "AgentBill · " prefix the homepage <title> is 68
 *  characters, so a search result that cuts near 60 loses the last word. */
export const HEADLINE = 'Give the job you leave running overnight its own ceiling'

/** The install line beside the primary action, and on the share card. */
export const INSTALL_PY = 'pip install agentbill-sdk'

/** Which share card a page uses. Cards are per section, not per page. */
export type OgCard = 'default' | 'docs' | 'blog' | 'pricing' | 'register'

export type PageMeta = {
  path: string
  section: 'marketing' | 'docs' | 'blog' | 'legal'
  /**
   * Ancestors, excluding the page itself. Drives the visible trail and the
   * BreadcrumbList from one array, so the two cannot describe different paths.
   *
   * Only the content family renders them (docs, guides, blog). /pricing and
   * /register carry a true hierarchy and deliberately do not draw it: a
   * one-ancestor trail above a top-level page is furniture with nothing to do.
   */
  crumbs: ReadonlyArray<readonly [label: string, href: string]>
  /** Short label for this page in a breadcrumb. Titles run long; trails should not. */
  crumb: string
  og: OgCard
  index: boolean
  /**
   * The date the content last meaningfully changed. Bumped by hand when a page
   * is edited, because a sitemap whose lastmod is always today is a sitemap
   * search engines learn to ignore.
   */
  updated: string
  /** Blog only. Renders the visible dateline AND datePublished, from one value. */
  published?: string
  priority: number
  changefreq: 'weekly' | 'monthly' | 'yearly'
  /**
   * Disallow in robots.txt. SEPARATE from `index`, and the separation is the
   * whole point.
   *
   * `index: false` means noindex: the page sends the directive in its head and
   * on its response, and a crawler reads it. `disallow` means the crawler may
   * not fetch the page at all, which also means it never reads the noindex,
   * which is how a Disallowed URL ends up indexed URL-only from an external
   * link. Disallow plus noindex is a pair that defeats itself.
   *
   * So this is true only for a page with no inbound links that should be out of
   * crawl entirely. /app is noindex and NOT disallowed, because it is where the
   * homepage's own "See a live console" button points. /thanks is noindex and
   * not disallowed either: no page links to it, but Polar redirects a buyer
   * there after checkout, and a Disallowed URL a real person lands on is one
   * whose noindex is never read.
   */
  disallow?: boolean
}

const HOME = ['Home', '/'] as const
const DOCS = ['Docs', '/docs'] as const
const BLOG = ['Blog', '/blog'] as const
const INTEGRATIONS = ['Integrations', '/integrations'] as const

export const PAGES: readonly PageMeta[] = [
  { path: '/', section: 'marketing', crumbs: [], crumb: 'Home', og: 'default', index: true, updated: '2026-09-23', priority: 1.0, changefreq: 'weekly' },
  { path: '/pricing', section: 'marketing', crumbs: [HOME], crumb: 'Pricing', og: 'pricing', index: true, updated: '2026-09-09', priority: 0.8, changefreq: 'monthly' },
  { path: '/register', section: 'marketing', crumbs: [HOME], crumb: 'Get an API key', og: 'register', index: true, updated: '2026-09-12', priority: 0.8, changefreq: 'monthly' },
  // noindex and NOT disallowed, for the same reason as /app and /thanks: a real
  // person follows a link here out of their mailbox, and a Disallowed URL is one
  // whose noindex a crawler never gets to read.
  { path: '/recover', section: 'marketing', crumbs: [HOME], crumb: 'Recover access', og: 'default', index: false, updated: '2026-09-09', priority: 0, changefreq: 'yearly' },

  { path: '/faq', section: 'docs', crumbs: [HOME], crumb: 'Questions', og: 'docs', index: true, updated: '2026-09-23', priority: 0.7, changefreq: 'monthly' },
  { path: '/status', section: 'marketing', crumbs: [HOME], crumb: 'Status', og: 'default', index: true, updated: '2026-09-05', priority: 0.3, changefreq: 'weekly' },
  { path: '/about', section: 'marketing', crumbs: [HOME], crumb: 'About', og: 'default', index: true, updated: '2026-09-08', priority: 0.4, changefreq: 'yearly' },

  // The Hebrew lead magnet for the n8n/Make vertical. Indexed on purpose: it is
  // written to be forwarded and to be found, and it is the only surface here
  // addressed to the operator rather than to the developer. Its crumb is not
  // rendered (the page carries no breadcrumb), but the registry entry is what
  // gives it a canonical and a sitemap row instead of a bare 200.
  { path: '/he/cost-per-client', section: 'marketing', crumbs: [HOME], crumb: 'כמה כל לקוח עולה לך', og: 'default', index: true, updated: '2026-09-06', priority: 0.6, changefreq: 'monthly' },

  { path: '/docs', section: 'docs', crumbs: [HOME], crumb: 'Docs', og: 'docs', index: true, updated: '2026-09-23', priority: 0.9, changefreq: 'weekly' },
  { path: '/docs/task-budgets', section: 'docs', crumbs: [HOME, DOCS], crumb: 'Task budgets', og: 'docs', index: true, updated: '2026-09-23', published: '2026-08-27', priority: 0.8, changefreq: 'monthly' },
  { path: '/docs/first-run', section: 'docs', crumbs: [HOME, DOCS], crumb: 'Setup failures', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-14', priority: 0.8, changefreq: 'monthly' },
  { path: '/docs/limit-cost-per-agent-run', section: 'docs', crumbs: [HOME, DOCS], crumb: 'Cost per run', og: 'docs', index: true, updated: '2026-09-23', published: '2026-05-06', priority: 0.7, changefreq: 'monthly' },
  // /docs/langchain-billing and /docs/openai-agent-spend-ceiling are 301s to the
  // LangChain and OpenAI Agents SDK pages below since 2026-09-23, so they have no
  // row: a redirect is not a page, and a sitemap that lists one is a sitemap
  // whose entries do not answer 200.

  // What we publish and the frameworks the plain SDK slots into. The hub sits
  // under Docs in the trail because /docs is where a reader arrives from; the
  // path is top-level so each page's URL names its integration and nothing else.
  { path: '/integrations', section: 'docs', crumbs: [HOME, DOCS], crumb: 'Integrations', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-23', priority: 0.8, changefreq: 'monthly' },
  { path: '/integrations/openclaw', section: 'docs', crumbs: [HOME, DOCS, INTEGRATIONS], crumb: 'OpenClaw', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-23', priority: 0.8, changefreq: 'monthly' },
  { path: '/integrations/langchain', section: 'docs', crumbs: [HOME, DOCS, INTEGRATIONS], crumb: 'LangChain', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-23', priority: 0.7, changefreq: 'monthly' },
  { path: '/integrations/openai-agents-sdk', section: 'docs', crumbs: [HOME, DOCS, INTEGRATIONS], crumb: 'OpenAI Agents SDK', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-23', priority: 0.7, changefreq: 'monthly' },
  { path: '/integrations/crewai', section: 'docs', crumbs: [HOME, DOCS, INTEGRATIONS], crumb: 'CrewAI', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-23', priority: 0.7, changefreq: 'monthly' },
  { path: '/integrations/mcp', section: 'docs', crumbs: [HOME, DOCS, INTEGRATIONS], crumb: 'MCP server', og: 'docs', index: true, updated: '2026-09-23', published: '2026-09-23', priority: 0.6, changefreq: 'monthly' },

  { path: '/blog', section: 'blog', crumbs: [HOME], crumb: 'Blog', og: 'blog', index: true, updated: '2026-09-05', priority: 0.6, changefreq: 'monthly' },
  { path: '/blog/how-preflight-avoids-double-billing', section: 'blog', crumbs: [HOME, BLOG], crumb: 'Preflight and double-billing', og: 'blog', index: true, updated: '2026-09-05', published: '2026-05-06', priority: 0.6, changefreq: 'yearly' },
  { path: '/blog/monthly-caps-wont-save-you', section: 'blog', crumbs: [HOME, BLOG], crumb: 'Monthly caps', og: 'blog', index: true, updated: '2026-09-23', published: '2026-05-06', priority: 0.6, changefreq: 'yearly' },

  // Indexable on purpose. noindex on a policy page buys nothing (nobody is
  // competing for "AgentBill terms of service"), ad review prefers them
  // reachable, and noindex beside a canonical sends two contradictory signals
  // about one URL.
  { path: '/terms', section: 'legal', crumbs: [HOME], crumb: 'Terms', og: 'default', index: true, updated: '2026-08-27', priority: 0.2, changefreq: 'yearly' },
  { path: '/privacy', section: 'legal', crumbs: [HOME], crumb: 'Privacy', og: 'default', index: true, updated: '2026-09-18', priority: 0.2, changefreq: 'yearly' },

  // Not indexable, and here anyway: robots.txt's Disallow lines are generated
  // from this list, so a page cannot be forgotten in one place and remembered
  // in the other.
  // A landing page after writing in. Not indexable: it is the end of an action,
  // not a destination, and it says nothing a search result should promise.
  { path: '/thanks', section: 'marketing', crumbs: [], crumb: 'After checkout', og: 'default', index: false, updated: '2026-09-08', priority: 0, changefreq: 'yearly' },
  { path: '/app', section: 'marketing', crumbs: [], crumb: 'Console', og: 'default', index: false, updated: '2026-09-05', priority: 0, changefreq: 'weekly' },
  { path: '/admin', section: 'marketing', crumbs: [], crumb: 'Admin', og: 'default', index: false, disallow: true, updated: '2026-09-05', priority: 0, changefreq: 'weekly' },
]

export const byPath: ReadonlyMap<string, PageMeta> = new Map(PAGES.map((p) => [p.path, p]))

export const indexable = (): PageMeta[] => PAGES.filter((p) => p.index)

/** Absolute URL for a path in the registry. */
export const abs = (path: string): string => `${ORIGIN}${path === '/' ? '/' : path}`

/** "May 2026", from the one date that also feeds datePublished. */
export function monthYear(iso: string): string {
  const [y, m] = iso.split('-')
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December']
  return `${names[parseInt(m, 10) - 1]} ${y}`
}
