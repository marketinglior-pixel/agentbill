import { createHash } from 'node:crypto'

// Content-Security-Policy support.
//
// Hash, not nonce. Every inline script on this site is static per process:
// PLAYGROUND_JS interpolates module constants, DOCS_JS is a literal, and the
// register and upgrade handlers interpolate nothing per request. A nonce would
// mean randomBytes on every request, threading the value through five separate
// script-emitting call sites, and making every HTML response uncacheable, which
// fights the Cache-Control table in middleware/headers.ts. A hash costs one
// createHash per script at boot and nothing per request.

/**
 * Returns the script tag AND its hash, generated from the same string.
 *
 * This is the whole point of the function. The classic hash failure is a
 * leading or trailing newline that exists in the emitted tag but not in the
 * hashed input, and it is silent: 200 OK, correct headers, dead script.
 * Producing both halves from one input makes that mismatch structurally
 * impossible rather than merely unlikely.
 */
export function inlineScript(js: string): { html: string; hash: string } {
  return {
    html: `<script>${js}</script>`,
    hash: `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`,
  }
}

/**
 * The policy for a rendered page.
 *
 * Four things here are load-bearing and each of them, if dropped, breaks
 * something quietly rather than loudly:
 *
 *   connect-src 'self'   the homepage playground POSTs to /pulse. /app's policy
 *                        omits connect-src because /app fetches nothing, and
 *                        copying it verbatim would kill the only first-party
 *                        analytics the site has.
 *   img-src              CSP img-src governs favicons. data: is for the select
 *                        arrow on /register, the site's one inline SVG.
 *   manifest-src         head() emits a manifest link on every page.
 *   style-src            'unsafe-inline' ALONE. The moment style-src contains a
 *                        hash or a nonce, 'unsafe-inline' stops applying to
 *                        style ATTRIBUTES, and this site sets style="width:..."
 *                        on every progress bar in the playground, the homepage
 *                        panels and the admin table. They would all freeze at
 *                        zero and nothing would report an error.
 *
 * frame-ancestors is absent on purpose: it is ignored in a meta-delivered
 * policy, and X-Frame-Options: DENY from middleware/headers.ts already covers it.
 */
export type Extra = { script?: readonly string[]; img?: readonly string[]; connect?: readonly string[] }
export function policy(scriptHashes: readonly string[], extra: Extra | readonly string[] = {}): string {
  const ex: Extra = Array.isArray(extra) ? { script: extra as readonly string[] } : (extra as Extra)
  const script = [...scriptHashes, ...(ex.script ?? [])].join(' ')
  const img = ["'self'", 'data:', ...(ex.img ?? [])].join(' ')
  const connect = ["'self'", ...(ex.connect ?? [])].join(' ')
  return [
    "default-src 'none'",
    `script-src ${script || "'none'"}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src ${img}`,
    "manifest-src 'self'",
    `connect-src ${connect}`,
    "form-action 'self'",
    "base-uri 'none'",
  ].join('; ')
}
