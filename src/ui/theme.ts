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
    /* type */
    --sans: 'Inter', system-ui, -apple-system, sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  }`

/** Reset plus the element defaults every page shares. */
export const BASE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  html, body { overflow-x: clip; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans);
         font-size: 16px; line-height: 1.65; -webkit-font-smoothing: antialiased; }
  a { color: var(--green); }
  .mono { font-family: var(--mono); }
  :focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    * { transition: none !important; animation: none !important; }
  }`

const FONTS = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />`

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
