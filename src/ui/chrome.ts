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
  :root { --shell: 960px; }

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
  .btn { display: inline-block; background: var(--green); color: var(--green-ink); padding: 10px 18px;
         border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px;
         transition: transform .15s, box-shadow .15s; }
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
       phones are where the paid traffic lands. */
    .nav-links { gap: 16px; }
    .nav-links a.hide-sm { display: none; }
    .nav-links a:not(.btn) { padding: 10px 0; }
  }`

/** `current` marks the active link, e.g. "/docs" or "/pricing". */
export function siteNav(current = ''): string {
  const at = (href: string) => (href === current ? ' aria-current="page"' : '')
  return `  <nav class="site-nav">
    <div class="nav-inner">
      <a class="logo" href="/"><span class="dot"></span>AgentBill</a>
      <div class="nav-links">
        <a href="/docs"${at('/docs')}>Docs</a>
        <a href="/pricing"${at('/pricing')}>Pricing</a>
        <a class="hide-sm" href="${GITHUB}">GitHub</a>
        <a class="btn" href="/register">Get API key</a>
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
