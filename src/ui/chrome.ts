import { BP } from './theme.js'
import { mark, MARK_CSS } from './mark.js'
// The site header and footer, defined once.
//
// Before this file there were five different header treatments across the
// public pages and exactly one footer (on the homepage). /pricing was the worst
// case: its header was a bare <div> holding the wordmark, so it had no nav
// links and the logo was not even a link. A visitor who landed there from
// search or an ad had one small inline text link as their only way out.
//
// Both parts read `--shell` for their content width, so a 720px docs page and
// a 960px marketing page share the markup without sharing a measurement.
//
// The nav is three sections: wordmark left, the destinations centred, and the
// account pair right (Console, then the one primary action). Under 720px the
// destinations and Console fold into a native <details> menu, no script, so
// the same markup works on pages that ship no JS. The bar is solid rather than
// frosted-on-scroll: a scroll handler on every page is motion for mood.

const GITHUB = 'https://github.com/marketinglior-pixel/agentbill'

/** The destinations, once. The centre cluster and the mobile menu both render from here. */
const LINKS: ReadonlyArray<readonly [href: string, label: string]> = [
  ['/docs', 'Docs'],
  ['/pricing', 'Pricing'],
  [GITHUB, 'GitHub'],
]

/** Header + footer CSS. Include once per page, after theme BASE. */
export const CHROME_CSS = `
  /* --banner-height is the nav's rendered height. Anything else that sticks
     docks at top: var(--banner-height) so it sits beneath the nav instead of
     painting over it during scroll. Change .nav-inner's height and this together. */
  :root { --shell: 960px; --banner-height: 60px; }

  .site-nav { position: sticky; top: 0; z-index: 10; background: rgba(10,10,10,0.92);
              backdrop-filter: blur(14px); border-bottom: 1px solid var(--border); }
  .nav-inner { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; height: var(--banner-height);
               display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
  .logo { justify-self: start; display: flex; align-items: center; gap: 9px; font-family: var(--mono);
          font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; white-space: nowrap; }
  /* The mark is a mark. It used to glow, which is the shadow-glow tell and
     implied a live status that nothing on the page measured. It was also an
     8px circle, which said nothing; it is now the drawing in src/ui/mark.ts,
     a call stopped short of a ceiling, and it is the same drawing the favicon
     is rendered from. */
${MARK_CSS}

  .nav-center { justify-self: center; display: flex; gap: 28px; }
  .nav-center a { display: inline-flex; align-items: center; height: var(--banner-height); color: var(--muted);
                  text-decoration: none; font-size: 14px; font-weight: 500; white-space: nowrap;
                  border-bottom: 2px solid transparent; transition: color .15s; }
  .nav-center a:hover { color: var(--text); }
  /* The current page is a bar flush with the hairline, not a colour shift alone. */
  .nav-center a[aria-current="page"] { color: var(--text); border-bottom-color: var(--green); }

  .nav-right { justify-self: end; display: flex; align-items: center; gap: 18px; }
  .nav-right .console { color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 500;
                        white-space: nowrap; padding: 11px 0; transition: color .15s; }
  .nav-right .console:hover { color: var(--text); }
  /* BASE colours every <a> green; the filled button keeps its ink in every state. */
  .nav-right a.btn, .nav-right a.btn:hover, .nav-right a.btn:visited { color: var(--green-ink); }
  .nav-right .btn .short { display: none; }

  .btn { display: inline-block; background: var(--green); color: var(--green-ink); padding: 11px 18px;
         border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px;
         white-space: nowrap; transition: filter .15s, transform .12s; }
  /* One hover effect, not a lift plus a glow. A coloured halo on a dark ground
     is the shadow-glow tell, and two simultaneous effects is the other one. */
  .btn:hover { filter: brightness(1.06); }
  .btn:active { transform: translateY(1px); }
  /* The site's secondary action, paired with .btn at the same height: one
     pixel less padding pays for the border. Defined once here; pages used to
     each carry their own. */
  .btn-ghost { display: inline-block; color: var(--muted); border: 1px solid var(--border-strong);
               padding: 10px 17px; border-radius: 8px; text-decoration: none; font-weight: 600;
               font-size: 14px; white-space: nowrap; transition: border-color .15s, color .15s, transform .12s; }
  .btn-ghost:hover { color: var(--text); border-color: var(--dim); }
  .btn-ghost:active { transform: translateY(1px); }

  /* The mobile menu. A native disclosure: the summary is a ghost chip, the
     list drops beneath the bar on the panel frame. It closes on a second tap,
     not on an outside click; that is the price of shipping it without a
     script, and it is paid knowingly. */
  .nav-menu { display: none; position: relative; }
  .nav-menu summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; min-height: 44px;
                      padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 8px; color: var(--muted);
                      font-size: 14px; font-weight: 600; white-space: nowrap; transition: color .15s, border-color .15s; }
  .nav-menu summary::-webkit-details-marker { display: none; }
  .nav-menu summary:hover { color: var(--text); border-color: var(--dim); }
  .nav-menu[open] summary { color: var(--text); border-color: var(--text); }
  .nav-menu ul { list-style: none; position: absolute; right: 0; top: calc(100% + 8px); min-width: 200px;
                 background: var(--surface); border: 1px solid var(--border2); border-radius: 12px; padding: 6px;
                 box-shadow: var(--edge), var(--lift); z-index: 11; }
  .nav-menu li a { display: block; padding: 12px 14px; color: var(--muted); text-decoration: none; font-size: 15px;
                   border-radius: 8px; white-space: nowrap; }
  .nav-menu li a:hover { color: var(--text); background: var(--surface2); }
  .nav-menu li a[aria-current="page"] { color: var(--text); }

  /* The footer was one row of five links and a tagline, which reads as a
     project rather than a company. Four columns of things that actually exist:
     no newsletter, no social row, no "Made with love", and no X link for an
     account there isn't one of. An empty social row is worse than none. */
  .site-foot { border-top: 1px solid var(--border); padding-block: var(--s7) var(--s7);
               margin-top: var(--s9); }
  .foot-inner { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }
  .foot-cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
               gap: var(--s6) var(--s5); margin-bottom: var(--s7); }
  .foot-col h4 { font-family: var(--mono); font-size: var(--fs-chip); font-weight: 500;
                 letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
                 margin-bottom: var(--s2); }
  .foot-col a { display: block; color: var(--muted); text-decoration: none;
                font-size: var(--fs-small); padding-block: 7px; }
  .foot-col a:hover { color: var(--text); }
  .foot-ext::after { content: " \\2197"; color: var(--dim); }
  .foot-base { display: flex; justify-content: space-between; align-items: center;
               flex-wrap: wrap; gap: var(--s3); padding-top: var(--s5);
               border-top: 1px solid var(--border); }
  .foot-brand { display: flex; align-items: center; gap: var(--s2);
                font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
  .foot-brand .mark { width: 14px; height: 14px; }
  .foot-copy { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
  @media (max-width: ${BP.md}px) {
    .foot-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s5) var(--s5); }
  }

  @media (max-width: 720px) {
    .nav-inner { grid-template-columns: auto 1fr; gap: 10px; }
    .nav-center, .nav-right .console { display: none; }
    .nav-right { gap: 10px; }
    .nav-menu { display: block; }
    .logo { font-size: 15px; gap: 7px; }
  }
  /* At 320px the wordmark, the Menu chip and the button want more than the
     272px between the gutters. The button's label shortens and the wordmark
     steps down. The mark itself stays: a brand that disappears on a phone is
     not a brand, and it is the only identity the nav carries. The 14px it
     costs is bought back by the shorter label. */
  @media (max-width: 400px) {
    .nav-right .btn { padding: 11px 12px; }
    .nav-right .btn .long { display: none; }
    .nav-right .btn .short { display: inline; }
    .logo { font-size: 14px; gap: 6px; }
    .mark { width: 15px; height: 15px; }
  }`

/**
 * `current` marks the active link, e.g. "/docs" or "/pricing".
 * `cta: false` drops the "Get API key" button; /register uses it, because a
 * button that links to the page you are already on is noise beside the form.
 */
export function siteNav(current = '', { cta = true }: { cta?: boolean } = {}): string {
  const at = (href: string) => (href === current ? ' aria-current="page"' : '')
  const center = LINKS.map(([href, label]) => `<a href="${href}"${at(href)}>${label}</a>`).join('\n        ')
  const menu = [...LINKS, ['/app', 'Console'] as const]
    .map(([href, label]) => `<li><a href="${href}"${at(href)}>${label}</a></li>`).join('\n            ')
  return `  <nav class="site-nav">
    <div class="nav-inner">
      <a class="logo" href="/">${mark(18)}AgentBill</a>
      <div class="nav-center">
        ${center}
      </div>
      <div class="nav-right">
        <a class="console" href="/app">Console</a>
        <details class="nav-menu">
          <summary>Menu</summary>
          <ul>
            ${menu}
          </ul>
        </details>${cta ? `
        <a class="btn" href="/register"><span class="long">Get API key</span><span class="short">Get key</span></a>` : ''}
      </div>
    </div>
  </nav>`
}

// Only destinations that exist. Every external one was fetched before it was
// written here: both PyPI projects and the GitHub repo return 200, and npm's
// 403 to curl is bot protection, not a missing package (registry.npmjs.org
// reports agentbill at 0.4.0).
//
// No "Status" link. /health returns JSON, and a JSON endpoint behind a link
// labelled Status is the opposite of a trust signal. A real /status page is
// the most valuable thing this footer still lacks.
const FOOT: ReadonlyArray<readonly [heading: string, links: ReadonlyArray<readonly [string, string, boolean]>]> = [
  ['Product', [
    ['/docs', 'Docs', false],
    ['/pricing', 'Pricing', false],
    ['/app', 'Console', false],
    ['/register', 'Get an API key', false],
  ]],
  ['Developers', [
    [GITHUB, 'GitHub', true],
    ['https://pypi.org/project/agentbill-sdk/', 'Python SDK', true],
    ['https://www.npmjs.com/package/agentbill', 'Node SDK', true],
    ['https://pypi.org/project/agentbill-mcp/', 'MCP server', true],
  ]],
  ['Company', [
    ['/about', 'About', false],
    ['/blog', 'Blog', false],
    ['/faq', 'Questions', false],
    ['mailto:marketinglior@gmail.com', 'Contact', false],
  ]],
  ['Legal', [
    ['/terms', 'Terms', false],
    ['/privacy', 'Privacy', false],
  ]],
]

export function siteFooter(): string {
  return `  <footer class="site-foot">
    <div class="foot-inner">
      <div class="foot-cols">
${FOOT.map(([heading, links]) => `        <div class="foot-col">
          <h4>${heading}</h4>
${links.map(([href, label, ext]) => `          <a href="${href}"${ext ? ' class="foot-ext" rel="noopener"' : ''}>${label}</a>`).join('\n')}
        </div>`).join('\n')}
      </div>
      <div class="foot-base">
        <div class="foot-brand">${mark(14)}agentbill.dev · what counts, who pays, what's blocked.</div>
        <div class="foot-copy">&copy; 2026 AgentBill</div>
      </div>
    </div>
  </footer>`
}
