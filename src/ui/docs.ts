import { byPath, abs } from './site.js'
import { inlineScript } from '../lib/csp.js'
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
  /* Without a rail the 220px track was still reserved and rendered empty, so
     /status, /blog and /thanks each opened with a column of nothing beside a
     column of content. A hidden rail should take no space, not invisible space. */
  .docs.no-rail { grid-template-columns: minmax(0, 1fr); }

  /* Breadcrumb.
     A full-width first row of the grid rather than the first thing inside
     <main>. At 960px and below the rail collapses to a horizontal strip and it
     is first in DOM order, so a breadcrumb inside main would render BELOW "On
     this page" on every phone.
     Deliberately not --green: green is the brand and the primary action, and a
     green trail competes with the page's real links. This is furniture. */
  .crumbs { grid-column: 1 / -1; margin-bottom: 28px; }
  .crumbs ol { list-style: none; display: flex; flex-wrap: wrap; align-items: baseline;
               gap: 0 8px; row-gap: 4px; font-family: var(--mono); font-size: var(--fs-micro); }
  .crumbs a { color: var(--dim); text-decoration: none; }
  .crumbs a:hover { color: var(--text); text-decoration: underline; }
  .crumbs .sep { color: var(--border2); }
  .crumbs [aria-current="page"] { color: var(--muted); }

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
  h1 { font-size: var(--fs-h1-sub); color: var(--white); margin-bottom: 12px; overflow-wrap: anywhere; max-width: 26ch; }
  .lede { font-size: var(--fs-lede); color: var(--muted); max-width: 60ch; margin-bottom: 8px; }
  /* A post's dateline: date and reading time, in the label register. */
  .meta { font-family: var(--mono); font-size: 12.5px; color: var(--dim); margin-bottom: 8px; }
  .meta + h2, .lede + h2 { margin-top: 44px; }
  blockquote { border-left: 2px solid var(--border2); padding-left: 20px; margin: 24px 0; max-width: 68ch; }
  blockquote p { color: var(--dim); font-style: italic; }
  /* Sections are separated by space, not by rules. The first h2 after the lede
     sits closer than the rest so the page does not open with a gap. */
  h2 { color: var(--white); margin: 72px 0 18px; overflow-wrap: anywhere; scroll-margin-top: calc(var(--banner-height) + 24px); }
  .lede ~ .badge + h2 { margin-top: 44px; }
  /* The third rung was 12px --dim against 16px --muted body, so every h3 was
     smaller and lighter than the text it introduced and read as a caption
     belonging to the paragraph above it. It also matched the rail label, the
     breadcrumb and the table headers exactly, so the page had one furniture
     treatment doing four jobs. The mono family and the uppercase stay, which
     design.md argues for; only the rung and the weight of the ink change.
     .14em tracking is tuned for 12px and runs long at 22px. */
  h3 { font-family: var(--mono); font-size: var(--fs-h3); font-weight: 500; color: var(--text);
       margin: 34px 0 10px; text-transform: uppercase; letter-spacing: .07em; }
  p { font-size: var(--fs-body); color: var(--muted); line-height: 1.7; margin-bottom: 16px; max-width: 68ch; }
  p.ok { color: var(--green); }
  li { color: var(--muted); line-height: 1.7; }
  a { color: var(--green); }

  /* The frame does not scroll and is never masked; the pre inside it does both.
     When overflow and the fade sat on this element, the mask ate the 1px border,
     both right corners and the last 48px of the top and bottom hairlines along
     with the text, so four blocks on /docs read as a failed render. Keeping the
     scroller inside also preserves the 20px right gutter, which a scroll
     container's own padding collapses at the scroll origin. */
  .code { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 6px;
          padding: 20px; margin: 16px 0; }
  .code pre { font-family: var(--mono); font-size: 13px; color: var(--code); line-height: 1.7;
              overflow-x: auto; }
  /* A block that scrolls sideways used to look exactly like one that does not,
     so a reader saw a sentence end mid-word and had no way to know there was
     more. Four of eight blocks on /docs did this at 1280px. The script below
     marks the ones that overflow, and only those get a fade on the right edge,
     which lifts once they are scrolled to the end. Keywords, not hexes: the
     drift ratchet counts hexes below :root. */
  .code.overflows:not(.at-end) pre { mask-image: linear-gradient(90deg, black calc(100% - 48px), transparent);
                                     -webkit-mask-image: linear-gradient(90deg, black calc(100% - 48px), transparent); }
  .code.overflows pre { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
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
    .crumbs { margin-bottom: 20px; }
    .rail { position: static; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 18px;
            padding-bottom: 20px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
    .rail-h { margin: 0; flex-basis: 100%; margin-bottom: 4px; }
    .rail a { border-left: 0; padding: 8px 0; white-space: nowrap; }
    .rail a[aria-current="true"] { border-left: 0; }
    h2 { margin-top: 56px; }
  }
  /* Below --md the rail items wrap instead of being amputated. With nowrap and
     \`html, body { overflow-x: clip }\`, any item wider than the content box was
     silently cut at the viewport edge with no ellipsis and no way to scroll to
     it: on /faq at 390px one question overshot by 27px and lost its "?". Between
     720 and 960 nowrap is correct and measured clean, so only the small end moves. */
  @media (max-width: 720px) {
    .rail a { white-space: normal; max-width: 100%; }
  }
  @media (max-width: 640px) {
    .code { padding: 16px; }
    .code pre { font-size: 12.5px; }
    table { font-size: 13.5px; }
    th, td { padding: 8px 8px; }
    /* The parameter tables are 420px inside a 342px box, and html/body clip the
       overflow, so half of every description was unreachable rather than merely
       cut. Stack each row instead: name and type on one line, description under
       it, full width. The header row carries no meaning once stacked. */
    table, tbody { display: block; }
    tr { display: block; border-bottom: 1px solid var(--border-soft); padding: 10px 0; }
    tr:has(th) { display: none; }
    td { display: inline; border-bottom: 0; padding: 0; }
    /* Inline cells have no cell padding, so the name ran into its own type and
       rendered as "agent_idstring". The gap has to be a margin, not padding,
       because these are inline boxes. */
    td:first-child { white-space: normal; margin-inline-end: 10px; }
    td:last-child { display: block; margin-top: 6px; }
  }
`

/** Marks the active section in the rail. Attribute toggles only, no motion. */
const DOCS_SRC = `
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
  // The observer only speaks when a heading crosses the band, so a page opened
  // at the top had no current item until the reader scrolled. Start on the
  // first section; the observer corrects it the moment anything else is seen.
  var firstId = links[0] && links[0].getAttribute('href').slice(1);
  if (!current && firstId) mark(firstId);
  // At the top of the page no heading sits inside the band, so scrolling back
  // up left the last section marked. Above the first heading, the first
  // section is current by definition.
  window.addEventListener('scroll', function () {
    if (window.scrollY < 40 && firstId) mark(firstId);
  }, { passive: true });
})();

  // Mark code blocks that overflow, and un-mark them once scrolled to the end.
  // The pre is the scroller now, so measure and listen there; the classes stay
  // on .code because the fade is expressed as ".code.overflows ... pre".
  var codes = [].slice.call(document.querySelectorAll('.code')).filter(function (c) {
    return c.querySelector('pre');
  });
  function markOverflow() {
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i], p = c.querySelector('pre');
      c.classList.toggle('overflows', p.scrollWidth > p.clientWidth + 2);
      c.classList.toggle('at-end', p.scrollLeft + p.clientWidth >= p.scrollWidth - 2);
    }
  }
  for (var j = 0; j < codes.length; j++) codes[j].querySelector('pre').addEventListener('scroll', markOverflow, { passive: true });
  window.addEventListener('resize', markOverflow);
  markOverflow();
`

const dj = inlineScript(DOCS_SRC)
export const DOCS_JS = dj.html
export const DOCS_HASH = dj.hash


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
  /** Path in the registry. Drives canonical, the share card and the robots directive. */
  path: string
  extraHead?: string
  /** JSON-LD for this page, beside the automatic Organization and WebSite. */
  jsonLd?: unknown | unknown[]
  /** Share-card overrides. Type and description only; the title is the page's. */
  og?: { type?: string; title?: string; description?: string }
  /** Page-specific CSS, appended after DOCS_CSS. */
  css?: string
  /** Which nav link is current. Docs and guides pass "/docs"; a blog post passes "" (none). */
  current?: string
  /**
   * Suppress the "On this page" rail. An index page's h2s ARE its content, so
   * a rail listing them is the page written twice.
   */
  rail?: boolean
  /** The page body. Its <h2>s become the rail. */
  body: string
}

/** Doctype through </html> for a content page: shared CSS, nav, rail, body, footer. */
/**
 * The visible trail and the BreadcrumbList render from ONE array, so the thing
 * a reader sees and the thing a crawler reads cannot describe different paths.
 *
 * The <ol> is what makes this a breadcrumb to assistive technology, so it stays
 * a list. The separator is a real element with aria-hidden rather than ::before
 * content, because screen readers announce generated content inconsistently.
 * The last entry is a span, not a link to the page you are on.
 */
function breadcrumb(path: string): { html: string; ld: unknown } | null {
  const meta = byPath.get(path)
  if (!meta || meta.crumbs.length === 0) return null
  const trail = [...meta.crumbs.map(([label, href]) => ({ label, href })), { label: meta.crumb, href: path }]
  const items = trail.map((t, i) =>
    i === trail.length - 1
      ? `<li><span aria-current="page">${t.label}</span></li>`
      : `<li><a href="${t.href}">${t.label}</a></li><li class="sep" aria-hidden="true">/</li>`
  ).join('')
  return {
    html: `  <nav class="crumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`,
    ld: {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: trail.map((t, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: t.label,
        // Google's documented form omits `item` on the current page.
        ...(i === trail.length - 1 ? {} : { item: abs(t.href) }),
      })),
    },
  }
}

export function docsShell({ title, description, path, extraHead, jsonLd, og, css = '', current = '/docs', rail: wantRail = true, body }: ShellOpts): string {
  const crumb = breadcrumb(path)
  const ld = [...(jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []), ...(crumb ? [crumb.ld] : [])]
  const { body: anchored, toc } = withAnchors(body)
  const rail = wantRail && toc.length
    ? `  <nav class="rail" aria-label="On this page">
    <p class="rail-h">On this page</p>
${toc.map((t) => `    <a href="#${t.id}">${t.label}</a>`).join('\n')}
  </nav>`
    : ''
  return `${head({ title, description, path, jsonLd: ld, og, css: `${DOCS_CSS}${css}`, extraHead,
                    scriptHashes: [DOCS_HASH] })}
<body>
${siteNav(current)}
<div class="docs${wantRail ? '' : ' no-rail'}">
${crumb ? crumb.html : ''}
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
