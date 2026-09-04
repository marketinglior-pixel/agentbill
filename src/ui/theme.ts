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

/** Colour, type and spacing tokens. Every route gets exactly these. */
export const TOKENS = `
  :root {
    /* ground */
    --bg: #0a0a0a; --surface: #111111; --surface2: #161616; --surface3: #1a1a1a;
    /* borders. --border is decorative; anything that carries an affordance
       must use --border-strong, which clears the 3:1 of WCAG 1.4.11. */
    --border: #232323; --border-soft: #1e1e1e; --border2: #2c2c2c; --border-strong: #5c645f;
    /* ink. All four clear AA on --bg. */
    --text: #e8ebe9; --muted: #a0a8a3; --dim: #868e88; --white: #ffffff;
    /* signal. --green is the brand and the primary action; --code is syntax
       only; --red and --amber are states that need a human. */
    --green: #22d3a0; --green-ink: #05130e; --code: #a8ff78;
    --red: #ff5757; --amber: #f5b942;
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

const FONTS = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />`

type HeadOpts = {
  /** Full <title>. Falls back to "<name> · AgentBill". */
  title: string
  description?: string
  canonical?: string
  /** Extra CSS for this page, appended after TOKENS and BASE. */
  css?: string
  /** Extra tags (og:, robots, json-ld) dropped in before </head>. */
  extraHead?: string
}

/** Doctype through <body>. Every HTML route opens with this. */
export function head({ title, description, canonical, css = '', extraHead = '' }: HeadOpts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>${description ? `
  <meta name="description" content="${description}" />` : ''}${canonical ? `
  <link rel="canonical" href="${canonical}" />` : ''}
${FONTS}
  <style>${TOKENS}${BASE}${css}
  </style>${extraHead ? `\n${extraHead}` : ''}
</head>`
}
