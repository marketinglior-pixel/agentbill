import { BP } from './theme.js'
import { mark, MARK_CSS } from './mark.js'
import { KIT_CSS } from './kit.js'
// The site header and footer, defined once.
//
// Before this file there were five different header treatments across the
// public pages and exactly one footer (on the homepage). /pricing was the worst
// case: its header was a bare <div> holding the wordmark, so it had no nav
// links and the logo was not even a link. A visitor who landed there from
// search or an ad had one small inline text link as their only way out.
//
// Both parts read `--chrome-w` for their width (2026-09-23; they read the
// page's `--shell` until then), so the bar is the same bar on every page and
// the column under it keeps its own measure.
//
// CHROME_CSS carries the component kit (src/ui/kit.ts) at its head, so every
// page with the nav has the canvas buttons, chips, tags, frames and fields
// without importing a second stylesheet.
//
// The nav is three sections: wordmark left, the destinations centred, and the
// account pair right (Log in, then the one primary action). Under 720px the
// destinations, Log in and Sign up fold into a native <details> menu, no script, so
// the same markup works on pages that ship no JS. The bar is solid rather than
// frosted-on-scroll: a scroll handler on every page is motion for mood.

const GITHUB = 'https://github.com/marketinglior-pixel/agentbill'

/** One label for one action.
 *  The site shipped seven wordings of the same button: "Get API key", "Get your
 *  API key" with and without the arrow, "Get an API key" and "Create a free API
 *  key". Two `.btn` elements that differ only by whether they carry an arrow is
 *  the tell to kill first. Two labels stay outside this constant on purpose,
 *  because they are different actions: "Start free" on the price tables, and
 *  "Generate my API key" on the register submit, which says what the button
 *  does rather than where it goes. */
// 2026-09-16: 'Get your API key' -> 'Get API key', the wording locked in the
// copy session. Changed HERE rather than overridden on the homepage, because the
// whole point of this constant is that the site ships one wording; a page-local
// literal would rebuild the seven-wordings problem it was created to kill. Every
// page's button changes with it, which is the intended behaviour.
export const KEY_CTA = 'Get API key &rarr;'
export const KEY_CTA_SHORT = 'Get key'

/** The destinations, once. The centre cluster and the mobile menu both render from here. */
// MCP, 2026-09-25: the connect page for the remote MCP endpoint, on every
// page's nav and in the phone menu, where a builder looks for "how do I plug
// this into Claude". Its words are the protocol's name, the one people search.
const LINKS: ReadonlyArray<readonly [href: string, label: string]> = [
  ['/docs', 'Docs'],
  ['/integrations/mcp', 'MCP'],
  ['/pricing', 'Pricing'],
  [GITHUB, 'GitHub'],
]

/** Header + footer CSS, and the component kit. Include once per page, after theme BASE. */
export const CHROME_CSS = `${KIT_CSS}
    /* Close an unequal row.
       A two-column row whose short side stops well above its tall side reads as
       an unfinished column, not as a finished row, unless something draws its
       bottom edge. Measured across sixteen premium references, not one leaves an
       open-bottomed unequal row on flat ground; Stripe's pricing ships a row
       filling 39% with 115px of void under it and it is invisible, because a
       hairline closes it. The site already closed rows three different ways
       (--border on .tiers, --border-soft on .task and .ref-row) and not at all
       on four marketing grids. This is the one name, so the next row inherits
       the behaviour instead of the omission. Lives here because CHROME_CSS is
       the only stylesheet every page has, directly or through the docs shell. */
    .row-close { border-bottom: 1px solid var(--border); }

  /* --banner-height is the nav's rendered height. Anything else that sticks
     docks at top: var(--banner-height) so it sits beneath the nav instead of
     painting over it during scroll. Change .nav-inner's height and this together.
     --chrome-w is the nav's and the footer's width, 2026-09-23: they read the
     page's --shell until then, so the same nav was 720 wide on /terms, 960 on
     the 404, 1072 on / and 1080 on /docs. One bar now, at the homepage's width,
     whatever the column under it. --shell stays the page's content width. */
  :root { --shell: 960px; --banner-height: 60px; --chrome-w: 1072px; }

  /* --nav-bg, not a literal. This was the one colour on the site that lived
     outside theme.ts, so the nav stayed near-black on a paper page while every
     other surface followed the token block. */
  .site-nav { position: sticky; top: 0; z-index: 10; background: var(--nav-bg);
              backdrop-filter: blur(14px); border-bottom: 1px solid var(--border); }
  .nav-inner { max-width: var(--chrome-w); margin: 0 auto; padding-inline: var(--s5); height: var(--banner-height);
               display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
  .logo { justify-self: start; display: flex; align-items: center; gap: 9px; font-family: var(--mono);
          font-weight: 700; font-size: var(--fs-body); color: var(--text); text-decoration: none; white-space: nowrap; }
  /* The mark is a mark. It used to glow, which is the shadow-glow tell and
     implied a live status that nothing on the page measured. It was also an
     8px circle, which said nothing; it is now the drawing in src/ui/mark.ts,
     a call stopped short of a ceiling, and it is the same drawing the favicon
     is rendered from. */
${MARK_CSS}

  .nav-center { justify-self: center; display: flex; gap: 28px; }
  .nav-center a { display: inline-flex; align-items: center; height: var(--banner-height); color: var(--muted);
                  text-decoration: none; font-size: var(--fs-small); font-weight: 500; white-space: nowrap;
                  border-bottom: 2px solid transparent; transition: color .15s; }
  .nav-center a:hover { color: var(--text); }
  /* The current page is a bar flush with the hairline, not a colour shift alone.
     On canvas --green is the ink, so the bar is the ink. */
  .nav-center a[aria-current="page"] { color: var(--text); border-bottom-color: var(--green); }

  .nav-right { justify-self: end; display: flex; align-items: center; gap: 18px; }
  .nav-right .console { color: var(--muted); text-decoration: none; font-size: var(--fs-small); font-weight: 500;
                        white-space: nowrap; padding: 11px 0; transition: color .15s; }
  .nav-right .console:hover { color: var(--text); }
  /* BASE colours every <a> with --green; the filled button keeps its ink in every state. */
  .nav-right a.btn, .nav-right a.btn:hover, .nav-right a.btn:visited { color: var(--green-ink); }
  .nav-right .btn .short { display: none; }

  /* The mobile menu. A native disclosure: the summary is an outlined pill, the
     list drops beneath the bar on a white card. It closes on a second tap,
     not on an outside click; that is the price of shipping it without a
     script, and it is paid knowingly. */
  .nav-menu { display: none; position: relative; }
  .nav-menu summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; min-height: var(--h-lg);
                      padding: 0 14px; border: 1px solid var(--border-strong); border-radius: var(--r-pill); color: var(--muted);
                      font-size: var(--fs-small); font-weight: 600; white-space: nowrap; transition: color .15s, border-color .15s; }
  .nav-menu summary::-webkit-details-marker { display: none; }
  .nav-menu summary:hover { color: var(--text); border-color: var(--dim); }
  .nav-menu[open] summary { color: var(--text); border-color: var(--text); }
  .nav-menu ul { list-style: none; position: absolute; right: 0; top: calc(100% + 8px); min-width: 200px;
                 background: var(--surface); border: 1px solid var(--border2); border-radius: var(--r-field); padding: 6px;
                 box-shadow: var(--edge), var(--lift); z-index: 11; }
  .nav-menu li a { display: block; padding: 12px 14px; color: var(--muted); text-decoration: none; font-size: var(--fs-body);
                   border-radius: var(--r-row); white-space: nowrap; }
  .nav-menu li a:hover { color: var(--text); background: var(--surface2); }
  .nav-menu li a[aria-current="page"] { color: var(--text); }

  /* The footer was one row of five links and a tagline, which reads as a
     project rather than a company. Four columns of things that actually exist:
     no newsletter, no social row, no "Made with love", and no X link for an
     account there isn't one of. An empty social row is worse than none. */
  .site-foot { border-top: 1px solid var(--border); padding-block: var(--s7) var(--s7);
               margin-top: var(--s9); }
  .foot-inner { max-width: var(--chrome-w); margin: 0 auto; padding-inline: var(--gutter); }
  .foot-cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
               gap: var(--s6) var(--s5); margin-bottom: var(--s7); }
  .foot-col .foot-h { font-family: var(--mono); font-size: var(--fs-chip); font-weight: 500;
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

  /* The mobile CTA MOVES, it is not added.
     The nav is already sticky and already carries the primary action, so a
     bottom bar beside it would put two copies of the same button on screen at
     once. Below 720px the nav's button leaves and the bar takes it.
     Always visible, never on scroll: design.md forbids scroll-triggered
     behaviour, and a scroll handler for this would be motion for mood.
     z-index 9 keeps it under the nav's disclosure menu at 11. */
  .sticky-cta { display: none; }
  @media (max-width: ${BP.md}px) {
    .nav-inner { grid-template-columns: auto 1fr; gap: 10px; }
    .nav-center, .nav-right .console { display: none; }
    .nav-right { gap: 10px; }
    .nav-right .btn { display: none; }
    .nav-menu { display: block; }
    /* 15px has no rung on the scale; it is the wordmark's own step between
       the desktop 16 and the 320px 14, and it is the one literal left here. */
    .logo { font-size: 15px; gap: 7px; }
    .sticky-cta { display: block; position: fixed; left: 0; right: 0; bottom: 0; z-index: 9;
                  background: var(--surface); border-top: 1px solid var(--border);
                  padding: var(--s3) var(--gutter);
                  padding-bottom: calc(var(--s3) + env(safe-area-inset-bottom)); }
    /* The bar's button is the fold's one action on a phone, so it is L: 44. */
    .sticky-cta .btn { display: flex; width: 100%; min-height: var(--h-lg); padding-block: 12px; }
    /* So the bar never covers the footer's last row. */
    body:has(.sticky-cta) { padding-bottom: 76px; }
    /* The rule above was written about the NAV's button and never extended to
       the in-page one, so every page on the docs shell ended with a left-aligned
       pill and a full-width bar about 160px apart, same words, same
       href. The closing button stands down where the bar is present; the sticky
       bar is the primary on a phone. Keyed off the bar itself rather than the
       breakpoint, so a page that opts out of the bar keeps its own closing CTA. */
    body:has(.sticky-cta) .end .btn { display: none; }
    body:has(.sticky-cta) .end { margin-top: 0; }
  }
  /* At 320px the wordmark and the Menu chip want more than the 288px between
     the gutters. The wordmark steps down. The mark itself stays: a brand that
     disappears on a phone is not a brand, and it is the only identity the nav
     carries. */
  @media (max-width: ${BP.xs}px) {
    .logo { font-size: var(--fs-small); gap: 6px; }
    .mark { width: 15px; height: 15px; }
  }`

/**
 * \`current\` marks the active link, e.g. "/docs" or "/pricing".
 * \`cta: false\` drops the "Get API key" button; /register uses it, because a
 * button that links to the page you are already on is noise beside the form.
 */
export function siteNav(
  current = '',
  { cta = true, sticky = true }: { cta?: boolean; sticky?: boolean } = {},
): string {
  const at = (href: string) => (href === current ? ' aria-current="page"' : '')
  const center = LINKS.map(([href, label]) => `<a href="${href}"${at(href)}>${label}</a>`).join('\n        ')
  // Log in and Sign up, 2026-09-25, when the site got accounts. On a desktop
  // the pair is the "Log in" link and the one primary button, whose words stay
  // KEY_CTA because that is what sign-up ends in. /login sends a browser that
  // is already signed in straight to the console, so it is also the way back
  // to it; the footer keeps a plain Console link.
  const menu = [...LINKS, ['/login', 'Log in'] as const, ['/register', 'Sign up'] as const]
    .map(([href, label]) => `<li><a href="${href}"${at(href)}>${label}</a></li>`).join('\n            ')
  return `  <nav class="site-nav" aria-label="Primary">
    <div class="nav-inner">
      <a class="logo" href="/">${mark(18)}AgentBill</a>
      <div class="nav-center">
        ${center}
      </div>
      <div class="nav-right">
        <a class="console" href="/login"${at('/login')}>Log in</a>
        <details class="nav-menu">
          <summary>Menu</summary>
          <ul>
            ${menu}
          </ul>
        </details>${cta ? `
        <a class="btn" href="/register"><span class="long">${KEY_CTA}</span><span class="short">${KEY_CTA_SHORT}</span></a>` : ''}
      </div>
    </div>
  </nav>${cta && sticky ? `
  <div class="sticky-cta"><a class="btn" href="/register">${KEY_CTA}</a></div>` : ''}`
}

// Only destinations that exist. Every external one was fetched before it was
// written here: both PyPI projects and the GitHub repo return 200, and npm's
// 403 to curl is bot protection, not a missing package (registry.npmjs.org
// reports agentbill at 0.4.0).
//
// The Status link points at /status, a page that runs its checks when it
// loads. It is NOT /health: a JSON endpoint behind a link labelled Status is
// the opposite of a trust signal to a person.
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
    ['/integrations/mcp', 'MCP server', false],
  ]],
  ['Company', [
    ['/about', 'About', false],
    ['/blog', 'Blog', false],
    ['/faq', 'Questions', false],
    ['/status', 'Status', false],
    ['mailto:hello@agentbill.dev', 'Contact', false],
  ]],
  ['Legal', [
    ['/terms', 'Terms', false],
    ['/privacy', 'Privacy', false],
    ['/security', 'Security', false],
  ]],
]

export function siteFooter(): string {
  return `  <footer class="site-foot">
    <div class="foot-inner">
      <div class="foot-cols">
${FOOT.map(([heading, links]) => `        <div class="foot-col">
          <p class="foot-h">${heading}</p>
${links.map(([href, label, ext]) => `          <a href="${href}"${ext ? ' class="foot-ext" rel="noopener"' : ''}>${label}</a>`).join('\n')}
        </div>`).join('\n')}
      </div>
      <div class="foot-base">
        <div class="foot-brand">${mark(14)}agentbill.dev · what counts, who pays, what's refused.</div>
        <div class="foot-copy">&copy; 2026 AgentBill</div>
      </div>
    </div>
  </footer>`
}
