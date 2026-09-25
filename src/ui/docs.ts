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
 * theme: canvas (theme.ts, the default since 2026-09-23) · design-system: design.md
 * designed-as-app · nav: N1b, shared · footer: Ft2, shared
 * enrichment: none, code blocks are the panels */
export const DOCS_CSS = `${CHROME_CSS}
  /* The nav's width, so the breadcrumb, the rail and the column start on the
     wordmark's edge. It was 1080 against the nav's 1072: 4px off on each side. */
  :root { --shell: var(--chrome-w); }

  /* One column: the breadcrumb, then <main>. A page without a rail is that
     and nothing more (/status, /blog and /thanks once opened with an empty
     220px track beside their content; a hidden rail takes no space). */
  .docs { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); padding-block: var(--s7) 96px;
          display: grid; grid-template-columns: minmax(0, 1fr); gap: 56px; align-items: start; }
  /* With a rail, <main> holds three parts in reading order: the page's head
     (h1, lede, dateline), the rail, then the body. On a wide screen they sit
     on two tracks, the rail in the first spanning both rows and sticky, head
     and body in the second, so the desktop page is what it was. On a phone
     main is one column and the DOM order IS the layout: the page starts with
     its head, like the homepage, and "On this page" follows the lede. Until
     2026-09-23 the rail sat before <main>, so at 390px it rendered above the
     h1 and pushed it to 705px on /faq, 665 on /docs/first-run: the first
     screen was eleven links and a sticky bar. */
  .docs.has-rail > .container { display: grid; grid-template-columns: 220px minmax(0, 1fr); column-gap: 56px;
                                align-items: start; }
  .docs.has-rail .rail { grid-column: 1; grid-row: 1 / span 2; }
  .doc-head, .doc-body { grid-column: 2; min-width: 0; }
  /* A grid item does not collapse margins with its neighbour, so the head's
     last margin is dropped here and the body's first h2 carries the whole gap,
     which is what the collapse used to produce. The rules below restate the
     "first h2 sits closer" rules for the split, which a "+" can no longer see
     across. */
  .doc-head > :last-child { margin-bottom: 0; }

  /* Breadcrumb.
     A full-width first row of the grid rather than the first thing inside
     <main>, so the trail is always the first line under the nav.
     Furniture, in the mono label voice's case and size but not its tracking:
     a trail is read as words. */
  .crumbs { grid-column: 1 / -1; margin-bottom: 28px; }
  .crumbs ol { list-style: none; display: flex; flex-wrap: wrap; align-items: baseline;
               gap: 0 8px; row-gap: 4px; font-family: var(--mono); font-size: var(--fs-micro); }
  .crumbs a { color: var(--dim); text-decoration: none; }
  .crumbs a:hover { color: var(--text); text-decoration: underline; }
  .crumbs .sep { color: var(--border-strong); }
  .crumbs [aria-current="page"] { color: var(--text); }

  /* The rail. Sticky beneath the nav, never over it. A hairline with the
     current section marked by an ink bar on it, the nav's own device turned
     on its side. */
  .rail { position: sticky; top: calc(var(--banner-height) + 28px); z-index: 1; }
  .rail-h { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-label); text-transform: uppercase;
            color: var(--dim); margin-bottom: 12px; }
  .rail a { display: block; color: var(--rail-ink); text-decoration: none; font-size: var(--fs-small); line-height: 1.45;
            padding: 7px 0 7px 14px; border-left: 1px solid var(--border); margin-left: 0; }
  .rail a:hover { color: var(--text); }
  .rail a[aria-current="true"] { color: var(--text); border-left: 2px solid var(--text); padding-left: 13px; font-weight: 500; }
  .rail a:active { color: var(--text); }

  .container { min-width: 0; }
  h1 { font-size: var(--fs-h1-sub); color: var(--white); margin-bottom: 12px; overflow-wrap: anywhere; max-width: 26ch;
       line-height: 1.04; }
  .lede { font-size: var(--fs-lede); color: var(--muted); max-width: 60ch; margin-bottom: 8px; line-height: 1.55; }
  /* A post's dateline: date and reading time, in the label register. */
  .meta { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); margin-bottom: 8px; }
  .meta + h2, .lede + h2 { margin-top: 44px; }
  /* A source line under a quote carries the full URL as its own text, so a
     reader can check it; at 390px that URL has to be allowed to break. */
  .meta a { overflow-wrap: anywhere; }
  blockquote { border-left: 2px solid var(--border2); padding-left: 20px; margin: 24px 0; max-width: 68ch; }
  blockquote p { color: var(--muted); font-style: italic; }
  /* Sections are separated by space, not by rules. The first h2 after the lede
     sits closer than the rest so the page does not open with a gap. */
  h2 { color: var(--white); margin: 72px 0 18px; overflow-wrap: anywhere; scroll-margin-top: calc(var(--banner-height) + 24px); }
  .lede ~ .badge + h2 { margin-top: 44px; }
  /* The same two rules on a page whose head and body are split around the rail. */
  .doc-head:has(> .lede:last-child, > .meta:last-child) ~ .doc-body > h2:first-child,
  .doc-head:has(> .lede ~ .badge:last-child) ~ .doc-body > h2:first-child { margin-top: 44px; }
  /* The third rung. Until 2026-09-23 it was set in the mono, uppercase and
     tracked, which on the dark theme separated it from the display face. On
     canvas the mono uppercase is the LABEL voice (column heads, the label over
     a figure) and a 22px heading in it read as a label shouting; every heading
     is Geist at 500 now, h3 one rung under h2, in the ink. */
  h3 { font-family: var(--display); font-size: var(--fs-h3); color: var(--text);
       margin: 34px 0 10px; letter-spacing: -0.01em; }
  /* 68ch measured 86 real characters, because ch is the width of a zero and not
     of an average character, so five stacked paragraphs read as one grey slab.
     54ch lands at 66 to 70. Code, tables and the headings keep the full column,
     and the difference between a narrow prose column and a wide panel becomes
     rhythm instead of one flat block. */
  p { font-size: var(--fs-body); color: var(--muted); line-height: 1.7; margin-bottom: 16px; max-width: 54ch; }
  /* The closing line of a step sequence, one lift above the prose around it.
     --text, not the primary's colour: nothing here is a link, and h1 a and h2 a
     already use --text on this shell for the same "brighter, not the accent" job.
     Named for its role rather than .ok, because .ok means a status indicator
     in status.ts and playground.ts and this is neither. */
  p.closer { color: var(--text); }
  li { color: var(--muted); line-height: 1.7; max-width: 54ch; }
  /* Links in prose are the ink, underlined on a quiet rule that darkens on
     hover. On canvas --green IS the ink; the underline is what says link. */
  a { color: var(--green); text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
  a:hover { text-decoration-color: currentColor; }
  b, strong { color: var(--text); font-weight: 600; }
  /* A link at display size is a title, not an action. The blog index renders each
     post as <h2><a>, so both headings inherited the prose underline and read as
     one long link. Linear, Polar and Stripe all set index links in text and
     leave the affordance for a hover. */
  h1 a, h2 a { color: var(--text); text-decoration: none; }
  h1 a:hover, h2 a:hover { color: var(--text); text-decoration: underline; text-decoration-color: currentColor; }

  /* The code frame: your code, the sample a reader copies. A warm-grey card on
     the white page, --r-inner corners and a hairline, ink mono; the same object
     as .cv-snip in the kit, under the name every docs page already renders.
     The frame does not scroll and is never masked; the pre inside it does both.
     When overflow and the fade sat on this element, the mask ate the 1px border,
     both right corners and the last 48px of the top and bottom hairlines along
     with the text, so four blocks on /docs read as a failed render. Keeping the
     scroller inside also preserves the 20px right gutter, which a scroll
     container's own padding collapses at the scroll origin. */
  .code { background: var(--snip-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
          padding: 20px; margin: 16px 0; }
  .code pre { font-family: var(--mono); font-size: var(--fs-code); color: var(--text); line-height: 1.7;
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
  /* Rendered output, not code. The class name is the one home.ts already uses,
     and scripts/snippets/extract.mjs drops any line carrying a class="out-"
     span, so a block of printed output is never parsed as a sample. */
  .out-dim { color: var(--dim); }
  /* Code set inside a sentence: the ink on the chip ground, not a syntax
     colour. --code on canvas is a warm red-brown, and a paragraph dotted with
     it spent the one accent the system reserves for the refusal. */
  .inline { font-family: var(--mono); background: var(--surface3); padding: 2px 6px; border-radius: var(--r-inline);
            font-size: .875em; color: var(--text); }

  /* Tables, in the kit's voice: mono uppercase column labels, a hairline under
     every row because docs rows carry sentences, the name column in the mono. */
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: var(--fs-small);
          font-variant-numeric: tabular-nums; }
  th { text-align: left; color: var(--th-ink); font-weight: 400; padding: 8px 12px;
       border-bottom: 1px solid var(--border2); font-family: var(--mono); font-size: var(--fs-chip);
       letter-spacing: var(--track-label); text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--row-line); color: var(--muted); vertical-align: top; }
  td:first-child { font-family: var(--mono); font-size: var(--fs-code); color: var(--text); white-space: nowrap; }
  /* The kit's .tag, keeping its case: in a parameter table it carries
     identifiers ("optional, on AgentBillClient(...)"), and uppercase would
     rewrite them. */
  .container .tag { display: inline-block; text-transform: none; letter-spacing: 0; margin-left: 8px; padding: 1px 8px; }
  .badge { display: inline-block; font-family: var(--mono); background: var(--surface2);
           border: 1px solid var(--card-line); border-radius: var(--r-pill); padding: 3px 10px; font-size: var(--fs-micro);
           color: var(--muted); margin-right: 6px; margin-bottom: 12px; }

  .also { margin-top: 64px; padding-top: 28px; border-top: 1px solid var(--border); }
  .also p { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-label); text-transform: uppercase;
            color: var(--dim); margin-bottom: 10px; }
  .also a { display: block; text-decoration: none; font-size: var(--fs-body); font-weight: 500; margin-bottom: 8px; }
  .also a:hover { text-decoration: underline; }
  .end { margin-top: 56px; }

  @media (max-width: 960px) {
    .docs { gap: 0; padding-block: 32px 72px; }
    .crumbs { margin-bottom: 20px; }
    /* One column, in DOM order: head, rail, body. */
    .docs.has-rail > .container { display: block; }
    /* The strip under the lede: between two hairlines, so it reads as the
       page's index and not as the first section of it. */
    .rail { position: static; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 18px;
            margin-block: var(--s6) var(--s5); padding-block: 20px; border-block: 1px solid var(--border); }
    .rail-h { margin: 0; flex-basis: 100%; margin-bottom: 4px; }
    .rail a { border-left: 0; padding: 8px 0; white-space: nowrap; }
    .rail a[aria-current="true"] { border-left: 0; padding-left: 0; }
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
    .code pre { font-size: var(--fs-micro); }
    table { font-size: var(--fs-small); }
    th, td { padding: 8px 8px; }
    /* The parameter tables are 420px inside a 342px box, and html/body clip the
       overflow, so half of every description was unreachable rather than merely
       cut. Stack each row instead: name and type on one line, description under
       it, full width. The header row carries no meaning once stacked. */
    table, tbody { display: block; }
    tr { display: block; border-bottom: 1px solid var(--row-line); padding: 10px 0; }
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
  /** Page scripts beyond DOCS_JS, each from inlineScript() so its hash is in the CSP. */
  scripts?: ReadonlyArray<{ html: string; hash: string }>
  title: string
  description: string
  /** Path in the registry. Drives canonical, the share card and the robots directive. */
  path: string
  extraHead?: string
  /** JSON-LD for this page, beside the automatic Organization and WebSite. */
  jsonLd?: unknown | unknown[]
  /** @id of the entity this page is about. See HeadOpts.mainEntity. */
  mainEntity?: string
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
  /**
   * Suppress the nav's "Get your API key" button and its sticky twin. Default
   * true, because almost every page on this site is talking to someone who has
   * not signed up. /thanks after a completed checkout is the exception: the
   * reader has just paid, and selling them a free key is the wrong sentence to
   * put at the top of a receipt.
   */
  navCta?: boolean
  /**
   * Suppress only the sticky twin, the full-width "Get API key" bar a phone
   * shows at the bottom of the screen; the nav keeps its button on a desktop.
   * Default true. False on the pages whose reader already has an account and
   * came to do one thing that is not signing up: /recover, where the bar sat
   * over the key page's "your console" line, and /status. It is the same
   * option /terms and /privacy pass to siteNav (legal.ts). /thanks passes it
   * too, beside navCta: after a payment both are off; on an incomplete
   * checkout the nav keeps its button and the bar stays off.
   */
  sticky?: boolean
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
      // Named so the page's WebPage node can point at it. An unnamed node is
      // one a `breadcrumb` reference would dangle against.
      '@id': `${abs(path)}#breadcrumb`,
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

/**
 * Split a body at its first top-level <h2>: the head (h1, lede, dateline) and
 * everything from that heading on. The rail goes between them.
 *
 * Null when there is no <h2>, or when the first one sits inside a container
 * that opened before it: cutting there would close a <div> in the wrong part.
 * The caller then keeps the body whole and puts the rail first, which is how
 * every page rendered before this split existed.
 */
const CONTAINERS = 'div|section|article|aside|ul|ol|table|blockquote|details|figure'
export function splitHead(body: string): { head: string; rest: string } | null {
  const i = body.search(/<h2[\s>]/)
  if (i < 0) return null
  const head = body.slice(0, i)
  const opened = (head.match(new RegExp(`<(${CONTAINERS})[\\s>]`, 'g')) || []).length
  const closed = (head.match(new RegExp(`</(${CONTAINERS})>`, 'g')) || []).length
  return opened === closed ? { head, rest: body.slice(i) } : null
}

export function docsShell({ title, description, path, extraHead, jsonLd, mainEntity, og, css = '', current = '/docs', rail: wantRail = true, navCta = true, sticky = true, scripts = [], body }: ShellOpts): string {
  const crumb = breadcrumb(path)
  const ld = [...(jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []), ...(crumb ? [crumb.ld] : [])]
  const { body: anchored, toc } = withAnchors(body)
  const hasRail = wantRail && toc.length > 0
  const rail = hasRail
    ? `  <nav class="rail" aria-label="On this page">
    <p class="rail-h">On this page</p>
${toc.map((t) => `    <a href="#${t.id}">${t.label}</a>`).join('\n')}
  </nav>`
    : ''
  const parts = hasRail ? splitHead(anchored) : null
  const inner = !hasRail
    ? anchored
    : parts
      ? `  <div class="doc-head">
${parts.head}
  </div>
${rail}
  <div class="doc-body">
${parts.rest}
  </div>`
      : `${rail}
  <div class="doc-body">
${anchored}
  </div>`
  return `${head({ title, description, path, jsonLd: ld, mainEntity, breadcrumb: !!crumb, og,
                    css: `${DOCS_CSS}${css}`, extraHead, scriptHashes: [DOCS_HASH, ...scripts.map((x) => x.hash)] })}
<body>
${siteNav(current, { cta: navCta, sticky })}
<div class="docs ${hasRail ? 'has-rail' : 'no-rail'}">
${crumb ? crumb.html : ''}
  <main class="container">
${inner}
  </main>
</div>
${siteFooter()}
${DOCS_JS}${scripts.map((x) => `\n${x.html}`).join('')}
</body>
</html>`
}
