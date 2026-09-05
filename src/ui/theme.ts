import { ORIGIN, abs, byPath } from './site.js'
import { policy } from '../lib/csp.js'
// The single source of truth for the site's design tokens and page shell.
//
// Before this file existed every route carried its own inline <style> with its
// own hex values: 11 style blocks, 57 unique colours, five h1 sizes and two
// display typefaces across nine files. Nothing enforced consistency, so each
// edit drifted a little further from the last.
//
// The tokens stay inline rather than moving to a served .css file on purpose.
// /app renders a live API key under `default-src 'none'` and only allows
// `style-src 'unsafe-inline'`; serving a stylesheet would mean widening that
// header on the one page where it matters most. Inlining a shared constant
// fixes the divergence, which is the actual defect, without touching CSP.

/**
 * Breakpoints.
 *
 * A CSS custom property cannot be used in a media query, so this is the one
 * place a breakpoint is written and every file interpolates it. There were six
 * ad hoc values across the codebase (960, 900, 820, 720, 640, 400), each picked
 * per file. 900 folds into lg, which is where /docs already collapses.
 *
 * 820 is left alone for now: it is the playground's own content pressure, not
 * a layout breakpoint, and it should be settled by looking at the page rather
 * than by decree.
 */
export const BP = { lg: 960, md: 720, sm: 640, xs: 400 } as const

/**
 * The three brand colours, as values rather than as CSS custom properties.
 *
 * This is not a second representation of a token: TOKENS below interpolates
 * these, so :root is rendered from them and there is still one definition.
 * They exist because three surfaces cannot read a CSS variable at all. A
 * <meta name="theme-color"> takes a colour, not a var(). So does the web app
 * manifest, which is JSON. And the favicon is a standalone SVG document with
 * no :root of the page to inherit from.
 */
export const BRAND = {
  bg: '#0a0a0a',
  green: '#22d3a0',
  greenInk: '#05130e',
} as const

/** Colour, type and spacing tokens. Every route gets exactly these. */
export const TOKENS = `
  :root {
    /* Both the meta and the property. The meta tells the UA before CSS parses;
       this is what actually drives native scrollbars, form controls and the
       autofill background, and without it a dark page still gets light ones. */
    color-scheme: dark;
    /* ground */
    --bg: ${BRAND.bg}; --surface: #111111; --surface2: #161616; --surface3: #1a1a1a;
    /* borders. --border is decorative; anything that carries an affordance
       must use --border-strong, which clears the 3:1 of WCAG 1.4.11. */
    --border: #232323; --border-soft: #1e1e1e; --border2: #2c2c2c; --border-strong: #5c645f;
    /* ink. All four clear AA on --bg. */
    --text: #e8ebe9; --muted: #a0a8a3; --dim: #868e88; --white: #ffffff;
    /* signal. --green is the brand and the primary action; --code is syntax
       only; --red and --amber are states that need a human. */
    --green: ${BRAND.green}; --green-ink: ${BRAND.greenInk}; --code: #a8ff78;
    --red: #ff5757; --amber: #f5b942;
    /* Console semantics, shared by every page that shows the console's rows
       (the console itself, the homepage panels). --flow is ordinary traffic,
       --res is units held by a reservation that has not settled, the *-bg /
       *-line pairs are chip grounds and hairlines, --bg-deep is the ground
       under code that sits inside a surface. One copy, here: app.ts and
       home.ts each used to carry their own. */
    --flow: #5d6b75; --flow-ink: #97a6b0; --res: #3a444b; --bg-deep: #0d0d0d;
    --held-bg: #0e2a20; --held-line: #1b4a3a;
    --near-bg: #2b220e; --near-line: #4a3a12; --near-ink: #e0cfa0;
    --fail-bg: #2a1212; --fail-line: #4a1d1d; --fail-ink: #ff8a80;
    /* Type. Three faces, three jobs, no overlap.
       --display carries every heading. It is a narrow industrial grotesque, so
       it reads as infrastructure and, more importantly, it contrasts with the
       mono instead of imitating it: the headings are the human voice and the
       code output is the machine's. Setting headings in mono, which is what
       this site did everywhere, collapses that distinction into costume.
       --mono is for code, data columns, key strings and the wordmark. Nothing
       else. */
    --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif;
    --sans: 'Inter', system-ui, -apple-system, sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

    /* A five-step scale with large intervals. The old set ran
       46 / 26 / 15.5 / 15, so a card title and its body text were half a pixel
       apart and nothing read as a hierarchy. Weight and colour carry the rest. */
    --fs-display: clamp(34px, 5.4vw, 58px);
    --fs-h2: clamp(26px, 3.4vw, 34px);
    --fs-h3: 19px;
    --fs-lede: 18px;
    --fs-body: 16px;
    --fs-small: 13.5px;
    --fs-micro: 12px;

    /* The two rungs below --fs-micro. About sixty of the hardcoded sizes in
       this codebase live down here, and they were twelve distinct values
       between 10 and 15.5px, half a pixel apart in places, which is the same
       "nothing reads as a hierarchy" defect the scale above was created to fix,
       one rung lower. The real vocabulary is two things: a tracked uppercase
       label, and a chip. */
    --fs-label: 11.5px;
    --fs-chip: 11px;

    /* The two h1 sizes that already existed implicitly. --fs-h1-sub was typed
       identically into docs.ts and upgrade.ts, and register.ts had a third
       value two pixels away that nobody chose. --fs-h1-app is the workbench
       heading on /app and /admin, which should not inherit a marketing clamp. */
    --fs-h1-sub: clamp(28px, 3.6vw, 40px);
    --fs-h1-app: 28px;

    /* Spacing. Deliberately not a geometric scale: this codebase uses 28
       distinct values, and a 4px base would force rounding 7, 9, 11, 22 and 26
       and move pixels on every page. These name what is already load bearing.
       New CSS uses them; an existing odd value stays until its block is
       rewritten for another reason. Never a find-and-replace pass. */
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px;
    --s6: 32px; --s7: 48px; --s8: 64px; --s9: 88px;
    --gutter: 24px;   /* the inline padding of every .wrap and .container */
    --gap: 56px;      /* the column gap of the hero and the diptychs */

    /* Radius. design.md already states the 12/8 rule; as tokens a violation
       becomes a named bug instead of an opinion. Known offenders, all
       scheduled: .pg at 3px, .pg-btn and .pg-status at 2px, docs .code at 6px,
       and every radius in admin.ts. */
    --r-frame: 12px;    /* panels, cards, tables, anything that holds content */
    --r-control: 8px;   /* buttons, inputs, selects */
    --r-chip: 4px;      /* chips, tags, badges */
    --r-pill: 999px;    /* progress tracks */

    /* Depth. A dark surface one shade off the ground reads flat and cheap; the
       thing that makes it read as a raised object is a single lit pixel along
       its top edge, the way real light falls on a bevel. --edge is that pixel
       and --lift is the shadow under it. Use them together on anything that is
       supposed to sit ON the page rather than be cut out of it. */
    --edge: inset 0 1px 0 rgba(255,255,255,0.055);
    --lift: 0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.28);
  }`

/** Reset plus the element defaults every page shares. */
export const BASE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  html, body { overflow-x: clip; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans);
         font-size: var(--fs-body); line-height: 1.65; -webkit-font-smoothing: antialiased; }
  h1, h2, h3, h4 { font-family: var(--display); text-wrap: balance; }
  h1 { font-size: var(--fs-display); font-weight: 800; letter-spacing: -0.03em; line-height: 1.04; }
  h2 { font-size: var(--fs-h2); font-weight: 700; letter-spacing: -0.022em; line-height: 1.12; }
  h3 { font-size: var(--fs-h3); font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; }
  a { color: var(--green); }
  .mono { font-family: var(--mono); }
  :focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    * { transition: none !important; animation: none !important; }
  }`

// Three families, nine weights, one render-blocking request.
//
// It was twelve. Archivo 500 and 600 and Inter 800 were requested on every page
// load and used by nothing: measured by walking every rendered element on nine
// surfaces (/, /docs, /pricing, /register, /terms, a guide, a post, the 404 and
// /app?demo=1) and collecting the computed family and weight. Archivo resolves
// only to 700 and 800, Inter to 400/500/600/700, JetBrains to 400/500/700.
//
// If a future rule sets a weight on a --display element that is not 700 or 800,
// the browser will synthesise it and it will look subtly wrong rather than
// break. Add the weight here rather than letting it synthesise.
const FONTS = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />`

type HeadOpts = {
  /** Full <title>, including the " · AgentBill" suffix. */
  title: string
  description?: string
  /**
   * The page's path in the registry. Canonical, the share card and the robots
   * directive are all derived from it, so a page that passes `path` cannot end
   * up with a canonical that disagrees with its sitemap entry.
   */
  path?: string
  /** Escape hatch for a page not in the registry. `path` wins if both are set. */
  canonical?: string
  /** Extra CSS for this page, appended after TOKENS and BASE. */
  css?: string
  /** Genuinely page-specific tags. Not og, not canonical, not icons. */
  extraHead?: string
  /** Overrides for the share card. Title and description default to the page's. */
  og?: { type?: string; title?: string; description?: string }
  /** JSON-LD for this page. The sitewide Organization and WebSite are automatic. */
  jsonLd?: unknown | unknown[]
  /** Emit robots noindex. Derived from the registry when `path` is given. */
  noindex?: boolean
  /**
   * Hashes of the inline scripts this page emits. Passing them turns the CSP
   * on for the page; omitting them leaves the page without one, which is the
   * safe default for anything not yet wired. Pass [] for a page with no script
   * at all and it gets script-src 'none'.
   */
  scriptHashes?: readonly string[]
  /** Extra origins for a configured pixel (script, img, connect). Normally empty. */
  scriptOrigins?: readonly string[] | { script?: readonly string[]; img?: readonly string[]; connect?: readonly string[] }
}

/**
 * JSON-LD is injected into a <script> element, so a description containing
 * "</script>" would close the block and drop the rest of the page's markup into
 * the document as text. Escaping "<" is the whole fix and it must never be
 * removed for tidiness.
 */
const ld = (o: unknown): string => JSON.stringify(o).replace(/</g, '\\u003c')

/** Emitted on every indexable page. The publisher of everything else. */
function sitewideLd(): unknown[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${ORIGIN}/#organization`,
      name: 'AgentBill',
      url: ORIGIN,
      logo: { '@type': 'ImageObject', url: `${ORIGIN}/apple-touch-icon.png`, width: 180, height: 180 },
      sameAs: [
        'https://github.com/marketinglior-pixel/agentbill',
        'https://pypi.org/project/agentbill-sdk/',
        'https://pypi.org/project/agentbill-mcp/',
        'https://www.npmjs.com/package/agentbill',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${ORIGIN}/#website`,
      url: ORIGIN,
      name: 'AgentBill',
      inLanguage: 'en-US',
      publisher: { '@id': `${ORIGIN}/#organization` },
    },
  ]
}

/** Doctype through <body>. Every HTML route opens with this. */
/**
 * Emitted by every page. Until this existed the site had no favicon at all and
 * /favicon.ico answered 401, so a tab showed the browser's default globe.
 *
 * color-scheme is here rather than in TOKENS because it also has to reach
 * /admin, which does not go through the token block, and because without it a
 * dark page still gets light native scrollbars, form controls and autofill.
 */
const ICONS = `  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="${BRAND.bg}" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="32x32" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />`

export function head({ title, description, path, canonical, css = '', extraHead = '', og, jsonLd, noindex, scriptHashes, scriptOrigins = {} }: HeadOpts): string {
  const meta = path ? byPath.get(path) : undefined
  const hidden = noindex ?? (meta ? !meta.index : false)
  // A canonical on a noindex page is two contradictory signals about one URL.
  const href = hidden ? undefined : (path ? abs(path) : canonical)
  // One card for every page, for now. head() used to point non-default sections
  // at /og/<section>.png, and those routes were never built, so every share of
  // /docs, /pricing, /register and /blog carried a broken image for a day. The
  // registry keeps the per-section `og` field so cards can exist later; until a
  // route serves them, nothing may reference them.
  const card = `${ORIGIN}/og.png`
  const ogTitle = og?.title ?? title
  const ogDesc = og?.description ?? description ?? ''
  const blocks = hidden ? [] : [...sitewideLd(), ...(jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [])]
  // Delivered as a meta rather than a header so it lives beside the head it
  // describes, and because the one directive a meta cannot carry,
  // frame-ancestors, is already covered by X-Frame-Options: DENY in
  // middleware/headers.ts. It is emitted FIRST so it governs every resource
  // reference below it.
  const csp = scriptHashes
    ? `  <meta http-equiv="Content-Security-Policy" content="${policy(scriptHashes, scriptOrigins)}" />\n`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
${csp}${ICONS}
  <title>${title}</title>${description ? `
  <meta name="description" content="${description}" />` : ''}${href ? `
  <link rel="canonical" href="${href}" />` : ''}${hidden ? `
  <meta name="robots" content="noindex" />` : ''}
  <meta property="og:type" content="${og?.type ?? 'website'}" />
  <meta property="og:site_name" content="AgentBill" />
  <meta property="og:locale" content="en_US" />${href ? `
  <meta property="og:url" content="${href}" />` : ''}
  <meta property="og:title" content="${ogTitle}" />${ogDesc ? `
  <meta property="og:description" content="${ogDesc}" />` : ''}
  <meta property="og:image" content="${card}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />${ogDesc ? `
  <meta name="twitter:description" content="${ogDesc}" />` : ''}
  <meta name="twitter:image" content="${card}" />
${FONTS}
  <style>${TOKENS}${BASE}${css}
  </style>${blocks.map((b) => `\n  <script type="application/ld+json">${ld(b)}</script>`).join('')}${extraHead ? `\n${extraHead}` : ''}
</head>`
}
