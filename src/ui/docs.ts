// The content-page shell: /docs and every /docs/* guide.
//
// Before this file, docs.ts, guides.ts and blog.ts each carried their own copy
// of the same code-block, heading and table CSS, three recipes for one thing,
// and none of them gave the reader a way to move around a long page. This is
// the one copy, plus the rail.
//
// The rail is built from the body's own <h2>s, so a page cannot list a section
// it does not have. Headings that already carry an id keep it (home.ts links
// to /docs#reservation); the rest get one derived from their text.

import { head } from './theme.js'
import { siteNav, siteFooter, CHROME_CSS } from './chrome.js'

/* Hallmark · genre: modern-minimal · macrostructure: Long Document + sticky rail (S3)
 * design-system: design.md · designed-as-app · nav: N1b, shared · footer: Ft2, shared
 * enrichment: none, code blocks are the panels */
export const DOCS_CSS = `${CHROME_CSS}
  :root { --shell: 1080px; }

  .docs { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; padding-block: 48px 96px;
          display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 56px; align-items: start; }

  /* The rail. Sticky beneath the nav, never over it. */
  .rail { position: sticky; top: calc(var(--banner-height) + 28px); z-index: 1; }
  .rail-h { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
            color: var(--dim); margin-bottom: 12px; }
  .rail a { display: block; color: var(--dim); text-decoration: none; font-size: 13.5px; line-height: 1.45;
            padding: 7px 0 7px 12px; border-left: 1px solid var(--border); }
  .rail a:hover { color: var(--text); }
  .rail a[aria-current="true"] { color: var(--text); border-left-color: var(--green); }
  .rail a:active { color: var(--white); }

  .container { min-width: 0; }
  h1 { font-size: clamp(28px, 3.6vw, 40px); color: var(--white); margin-bottom: 12px; overflow-wrap: anywhere; }
  .lede { font-size: var(--fs-lede); color: var(--muted); max-width: 60ch; margin-bottom: 8px; }
  /* Sections are separated by space, not by rules. The first h2 after the lede
     sits closer than the rest so the page does not open with a gap. */
  h2 { color: var(--white); margin: 72px 0 18px; overflow-wrap: anywhere; scroll-margin-top: calc(var(--banner-height) + 24px); }
  .lede + h2, .lede ~ .badge + h2 { margin-top: 44px; }
  h3 { font-family: var(--mono); font-size: var(--fs-micro); font-weight: 500; color: var(--dim);
       margin: 34px 0 10px; text-transform: uppercase; letter-spacing: .14em; }
  p { font-size: var(--fs-body); color: var(--muted); line-height: 1.7; margin-bottom: 16px; max-width: 68ch; }
  p.ok { color: var(--green); }
  li { color: var(--muted); line-height: 1.7; }
  a { color: var(--green); }

  .code { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 6px;
          padding: 20px; margin: 16px 0; overflow-x: auto; }
  .code pre { font-family: var(--mono); font-size: 13px; color: var(--code); line-height: 1.7; }
  .comment { color: var(--dim); }
  .inline { font-family: var(--mono); background: var(--surface3); padding: 2px 8px; border-radius: 4px;
            font-size: 13px; color: var(--code); }

  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;
          font-variant-numeric: tabular-nums; }
  th { text-align: left; color: var(--dim); font-weight: normal; padding: 8px 12px;
       border-bottom: 1px solid var(--border2); font-family: var(--mono); font-size: 11.5px;
       letter-spacing: .1em; text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border-soft); color: var(--muted); vertical-align: top; }
  td:first-child { font-family: var(--mono); font-size: 13px; color: var(--code); white-space: nowrap; }
  .tag { display: inline-block; font-family: var(--mono); background: var(--surface3); color: var(--dim);
         font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; }
  .badge { display: inline-block; font-family: var(--mono); background: var(--surface3);
           border: 1px solid var(--border2); border-radius: 4px; padding: 2px 8px; font-size: 12px;
           color: var(--dim); margin-right: 6px; margin-bottom: 12px; }

  .also { margin-top: 64px; padding-top: 28px; border-top: 1px solid var(--border); }
  .also p { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
            color: var(--dim); margin-bottom: 10px; }
  .also a { display: block; text-decoration: none; font-size: 14.5px; margin-bottom: 8px; }
  .also a:hover { text-decoration: underline; }
  .end { margin-top: 56px; }

  @media (max-width: 960px) {
    .docs { grid-template-columns: minmax(0, 1fr); gap: 0; padding-block: 32px 72px; }
    .rail { position: static; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 18px;
            padding-bottom: 20px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
    .rail-h { margin: 0; flex-basis: 100%; margin-bottom: 4px; }
    .rail a { border-left: 0; padding: 8px 0; white-space: nowrap; }
    .rail a[aria-current="true"] { border-left: 0; }
    h2 { margin-top: 56px; }
  }
  @media (max-width: 640px) {
    .code { padding: 16px; }
    .code pre { font-size: 12.5px; }
    table { font-size: 13.5px; }
    th, td { padding: 8px 8px; }
  }
`

/** Marks the active section in the rail. Attribute toggles only, no motion. */
export const DOCS_JS = `<script>
(function () {
  var links = [].slice.call(document.querySelectorAll('.rail a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var byId = {}, current = null;
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  function mark(id) {
    if (current) current.removeAttribute('aria-current');
    current = byId[id] || null;
    if (current) current.setAttribute('aria-current', 'true');
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) mark(e.target.id); });
  }, { rootMargin: '-80px 0px -70% 0px' });
  Object.keys(byId).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) io.observe(el);
  });
})();
</script>`

const slug = (s: string) =>
  s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/g, '').toLowerCase()
   .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * Give every <h2> an id (keeping any it already has) and return the rail
 * entries in document order. Ids are deduplicated with a counter.
 */
export function withAnchors(body: string): { body: string; toc: { id: string; label: string }[] } {
  const toc: { id: string; label: string }[] = []
  const seen = new Map<string, number>()
  const out = body.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (_m, attrs: string | undefined, inner: string) => {
    const existing = attrs?.match(/\bid="([^"]+)"/)?.[1]
    let id = existing ?? slug(inner)
    if (!existing) {
      const n = seen.get(id) ?? 0
      seen.set(id, n + 1)
      if (n) id = `${id}-${n + 1}`
    }
    const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    toc.push({ id, label })
    const rest = existing ? attrs : `${attrs ?? ''} id="${id}"`
    return `<h2${rest}>${inner}</h2>`
  })
  return { body: out, toc }
}

type ShellOpts = {
  title: string
  description: string
  canonical?: string
  extraHead?: string
  /** The page body. Its <h2>s become the rail. */
  body: string
}

/** Doctype through </html> for a content page: shared CSS, nav, rail, body, footer. */
export function docsShell({ title, description, canonical, extraHead, body }: ShellOpts): string {
  const { body: anchored, toc } = withAnchors(body)
  const rail = toc.length
    ? `  <nav class="rail" aria-label="On this page">
    <p class="rail-h">On this page</p>
${toc.map((t) => `    <a href="#${t.id}">${t.label}</a>`).join('\n')}
  </nav>`
    : '  <div></div>'
  return `${head({ title, description, canonical, css: DOCS_CSS, extraHead })}
<body>
${siteNav('/docs')}
<div class="docs">
${rail}
  <main class="container">
${anchored}
  </main>
</div>
${siteFooter()}
${DOCS_JS}
</body>
</html>`
}
