import { BRAND } from './theme.js'

// The mark.
//
// Until this file existed the brand was an 8px CSS circle beside the wordmark,
// and chrome.ts hid it below 400px, so the one piece of visual identity on the
// site disappeared on a phone. Over 4,677px of homepage there was no logo, no
// favicon and not one non-rectangular shape; /favicon.ico answered 401.
//
// The geometry is the product. A rule the width of the frame is the ceiling. A
// bar descends toward it and stops three units short. The gap is the refusal:
// the call never reaches the line, which is the whole mechanism preflight
// implements. Two rects, one colour, no gradient, no rounded joins.
//
// Sizes are in a 16-unit grid so the favicon and the nav mark are the same
// drawing rather than two drawings that agree today.

const CEILING = '<rect x="1" y="11" width="14" height="2.5"/>'
const CALL = '<rect x="6.5" y="2" width="3" height="6"/>'

/**
 * The mark as it appears in the page: stroke-only, coloured by CSS so the
 * green stays a token. Decorative beside the wordmark, so aria-hidden.
 */
export function mark(size = 18): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${CEILING}${CALL}</svg>`
}

export const MARK_CSS = `
    .mark { flex: none; display: block; }
    .mark rect { fill: var(--green); }
`

/**
 * The favicon: the same drawing, inverted onto a green ground.
 *
 * A stroke-only mark loses its gap to rounding at 16px, where a browser tab
 * renders it. Mass survives that; the two shapes are knocked out of a filled
 * square instead of drawn on nothing. Colours are literal because a standalone
 * SVG document has no :root to inherit from. See BRAND in theme.ts.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" rx="3" fill="${BRAND.green}"/><g fill="${BRAND.bg}">${CEILING}${CALL}</g></svg>`
