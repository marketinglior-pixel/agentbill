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
   * homepage's own "See a live console" button points. /thanks is linked from
   * the register success panel, so the same reasoning applies.
   */
  disallow?: boolean
}

const HOME = ['Home', '/'] as const
const DOCS = ['Docs', '/docs'] as const
const BLOG = ['Blog', '/blog'] as const

export const PAGES: readonly PageMeta[] = [
  { path: '/', section: 'marketing', crumbs: [], crumb: 'Home', og: 'default', index: true, updated: '2026-09-05', priority: 1.0, changefreq: 'weekly' },
  { path: '/pricing', section: 'marketing', crumbs: [HOME], crumb: 'Pricing', og: 'pricing', index: true, updated: '2026-09-05', priority: 0.8, changefreq: 'monthly' },
  { path: '/register', section: 'marketing', crumbs: [HOME], crumb: 'Get an API key', og: 'register', index: true, updated: '2026-09-05', priority: 0.8, changefreq: 'monthly' },

  { path: '/faq', section: 'docs', crumbs: [HOME], crumb: 'Questions', og: 'docs', index: true, updated: '2026-09-05', priority: 0.7, changefreq: 'monthly' },
  { path: '/status', section: 'marketing', crumbs: [HOME], crumb: 'Status', og: 'default', index: true, updated: '2026-09-05', priority: 0.3, changefreq: 'weekly' },
  { path: '/about', section: 'marketing', crumbs: [HOME], crumb: 'About', og: 'default', index: true, updated: '2026-09-05', priority: 0.4, changefreq: 'yearly' },

  // The Hebrew lead magnet for the n8n/Make vertical. Indexed on purpose: it is
  // written to be forwarded and to be found, and it is the only surface here
  // addressed to the operator rather than to the developer. Its crumb is not
  // rendered (the page carries no breadcrumb), but the registry entry is what
  // gives it a canonical and a sitemap row instead of a bare 200.
  { path: '/he/cost-per-client', section: 'marketing', crumbs: [HOME], crumb: 'כמה כל לקוח עולה לך', og: 'default', index: true, updated: '2026-09-06', priority: 0.6, changefreq: 'monthly' },

  { path: '/docs', section: 'docs', crumbs: [HOME], crumb: 'Docs', og: 'docs', index: true, updated: '2026-09-05', priority: 0.9, changefreq: 'weekly' },
  { path: '/docs/task-budgets', section: 'docs', crumbs: [HOME, DOCS], crumb: 'Task budgets', og: 'docs', index: true, updated: '2026-09-05', published: '2026-08-27', priority: 0.8, changefreq: 'monthly' },
  { path: '/docs/limit-cost-per-agent-run', section: 'docs', crumbs: [HOME, DOCS], crumb: 'Cost per run', og: 'docs', index: true, updated: '2026-09-05', published: '2026-05-06', priority: 0.7, changefreq: 'monthly' },
  { path: '/docs/langchain-billing', section: 'docs', crumbs: [HOME, DOCS], crumb: 'LangChain', og: 'docs', index: true, updated: '2026-09-05', published: '2026-05-06', priority: 0.7, changefreq: 'monthly' },
  { path: '/docs/openai-agent-spend-ceiling', section: 'docs', crumbs: [HOME, DOCS], crumb: 'OpenAI', og: 'docs', index: true, updated: '2026-09-05', published: '2026-05-06', priority: 0.7, changefreq: 'monthly' },

  { path: '/blog', section: 'blog', crumbs: [HOME], crumb: 'Blog', og: 'blog', index: true, updated: '2026-09-05', priority: 0.6, changefreq: 'monthly' },
  { path: '/blog/how-preflight-avoids-double-billing', section: 'blog', crumbs: [HOME, BLOG], crumb: 'Preflight and double-billing', og: 'blog', index: true, updated: '2026-09-05', published: '2026-05-06', priority: 0.6, changefreq: 'yearly' },
  { path: '/blog/monthly-caps-wont-save-you', section: 'blog', crumbs: [HOME, BLOG], crumb: 'Monthly caps', og: 'blog', index: true, updated: '2026-09-05', published: '2026-05-06', priority: 0.6, changefreq: 'yearly' },

  // Indexable on purpose. noindex on a policy page buys nothing (nobody is
  // competing for "AgentBill terms of service"), ad review prefers them
  // reachable, and noindex beside a canonical sends two contradictory signals
  // about one URL.
  { path: '/terms', section: 'legal', crumbs: [HOME], crumb: 'Terms', og: 'default', index: true, updated: '2026-08-27', priority: 0.2, changefreq: 'yearly' },
  { path: '/privacy', section: 'legal', crumbs: [HOME], crumb: 'Privacy', og: 'default', index: true, updated: '2026-08-27', priority: 0.2, changefreq: 'yearly' },

  // Not indexable, and here anyway: robots.txt's Disallow lines are generated
  // from this list, so a page cannot be forgotten in one place and remembered
  // in the other.
  // A landing page after writing in. Not indexable: it is the end of an action,
  // not a destination, and it says nothing a search result should promise.
  { path: '/thanks', section: 'marketing', crumbs: [], crumb: 'Thanks', og: 'default', index: false, updated: '2026-09-05', priority: 0, changefreq: 'yearly' },
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
