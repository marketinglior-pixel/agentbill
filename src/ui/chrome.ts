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

const GITHUB = 'https://github.com/marketinglior-pixel/agentbill'

/** Header + footer CSS. Include once per page, after theme BASE. */
export const CHROME_CSS = `
  /* --banner-height is the nav's rendered height. Anything else that sticks
     docks at top: var(--banner-height) so it sits beneath the nav instead of
     painting over it during scroll. Change .nav-inner's height and this together. */
  :root { --shell: 960px; --banner-height: 60px; }

  .site-nav { position: sticky; top: 0; z-index: 10; background: rgba(10,10,10,0.88);
              backdrop-filter: blur(14px); border-bottom: 1px solid var(--border); }
  .nav-inner { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; height: 60px;
               display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .logo { display: flex; align-items: center; gap: 9px; font-family: var(--mono);
          font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
  .dot { width: 8px; height: 8px; background: var(--green); border-radius: 50%;
         box-shadow: 0 0 10px rgba(34,211,160,0.7); }
  .nav-links { display: flex; align-items: center; gap: 22px; }
  .nav-links a { color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 500; }
  .nav-links a:hover { color: var(--text); }
  .nav-links a[aria-current="page"] { color: var(--text); }
  .nav-links a.btn, .nav-links a.btn:hover, .nav-links a.btn:visited { color: var(--green-ink); }
  /* nowrap is load-bearing: a wrapped label made the nav CTA 66px tall inside a
     60px header and it broke out of the bar. Button labels are all short. */
  /* 11px of block padding, not 10: it puts the button at 45px so the primary
     CTA clears the 44px touch-target guideline on a tablet too, not only
     inside the phone media query below. */
  .btn { display: inline-block; background: var(--green); color: var(--green-ink); padding: 11px 18px;
         border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px;
         white-space: nowrap; transition: transform .15s, box-shadow .15s; }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(34,211,160,0.25); }

  .site-foot { border-top: 1px solid var(--border); padding: 28px 0 48px; margin-top: 80px; }
  .foot-inner { max-width: var(--shell); margin: 0 auto; padding-inline: 24px;
                display: flex; justify-content: space-between; align-items: center;
                flex-wrap: wrap; gap: 12px; }
  .foot-links { display: flex; flex-wrap: wrap; gap: 4px 22px; }
  .foot-links a { color: var(--dim); text-decoration: none; font-size: 13.5px;
                  display: inline-block; padding: 11px 0; }
  .foot-links a:hover { color: var(--text); }
  .foot-brand { font-family: var(--mono); font-size: 12.5px; color: var(--dim); }

  @media (max-width: 640px) {
    /* Only GitHub drops on a phone. Pricing stays: it is a conversion page and
       phones are where the paid traffic lands. Keeping both text links plus a
       non-wrapping CTA is tight at 375px, so the row pays for it in gap and in
       the button's inline padding rather than by dropping a link. */
    .nav-links { gap: 14px; }
    .nav-links a.hide-sm { display: none; }
    .nav-links a:not(.btn) { padding: 11px 0; }
    .nav-links a.btn { padding: 11px 14px; }
    .logo { font-size: 15px; gap: 7px; }
  }

  /* Below ~400px the wordmark, two text links and a non-wrapping CTA want
     326px of a 272px row, so something has to go. Docs goes, not Pricing:
     Docs is also the hero's second button and a footer link, while Pricing is
     the conversion page and has neither. */
  @media (max-width: 400px) {
    .nav-links { gap: 12px; }
    .nav-links a.hide-xs { display: none; }
    .nav-links a.btn { padding: 11px 13px; }
  }`

/**
 * `current` marks the active link, e.g. "/docs" or "/pricing".
 * `cta: false` drops the "Get API key" button; /register uses it, because a
 * button that links to the page you are already on is noise beside the form.
 */
export function siteNav(current = '', { cta = true }: { cta?: boolean } = {}): string {
  const at = (href: string) => (href === current ? ' aria-current="page"' : '')
  return `  <nav class="site-nav">
    <div class="nav-inner">
      <a class="logo" href="/"><span class="dot"></span>AgentBill</a>
      <div class="nav-links">
        <a class="hide-xs" href="/docs"${at('/docs')}>Docs</a>
        <a href="/pricing"${at('/pricing')}>Pricing</a>
        <a class="hide-sm" href="${GITHUB}">GitHub</a>${cta ? `
        <a class="btn" href="/register">Get API key</a>` : ''}
      </div>
    </div>
  </nav>`
}

export function siteFooter(): string {
  return `  <footer class="site-foot">
    <div class="foot-inner">
      <div class="foot-links">
        <a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="${GITHUB}">GitHub</a>
      </div>
      <div class="foot-brand">agentbill.dev · what counts, who pays, what's blocked.</div>
    </div>
  </footer>`
}
