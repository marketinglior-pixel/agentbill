// A copy control, and the install line it was built for.
//
// The 2026-09-06 reference read found a copy affordance on Helicone, Langfuse,
// Modal, Resend, Upstash and Clerk, and none anywhere on this site. On a page
// whose whole argument is "three lines of code", a block you cannot copy
// undercuts the claim.
//
// It is also the honest version of the proof the references put beside their
// primary action. Fourteen of fourteen of them show logo walls or customer
// counts within one screen of the CTA; this product has two external signups,
// so a logo wall is unavailable and a fabricated one would break the claims
// rules outright. What is available is the commitment step that needs no
// account: the install line, copyable, next to the button.
//
// The script is static so its hash is stable. It reads the text off the DOM
// rather than being generated per call site, which is what lets one hash cover
// every copy control on the page.

import { inlineScript } from '../lib/csp.js'

export const COPY_CSS = `
  /* The pill is a control, so it clears the 44px floor like every other one.
     Canvas since 2026-09-23: a pill with a light-filled Copy button inside it,
     the homepage's close-band install line, which was a page-local override
     on / until the rest of the site took the same shape. */
  /* The radius is 30px, not --r-pill. Any radius at or past half a box's
     height draws a full pill (the browser scales it down), and every one-line
     pill here is 44 to 50 tall, so those render as they did; a pill that wraps
     (the export line on the key screen carries a whole key, and the close
     band wraps at 320) becomes a soft rectangle instead of an oval. */
  .cp { display: flex; align-items: center; gap: var(--s3); min-height: var(--h-lg);
        background: var(--bg); border: 1px solid var(--border); border-radius: calc(var(--h-lg) / 2 + var(--s2));
        padding: 0 var(--s2) 0 var(--s4); max-width: max-content; }
  .cp code { font-family: var(--mono); font-size: var(--fs-small); color: var(--code-ink);
             white-space: nowrap; overflow-x: auto; }
  .cp-btn { flex: none; background: var(--surface3); border: 0; border-radius: var(--r-pill);
            color: var(--text); font-family: var(--sans); font-size: var(--fs-micro); font-weight: 500;
            height: var(--h-sm); min-height: var(--h-sm); padding: 0 var(--s3); cursor: pointer; white-space: nowrap;
            transition: background .15s; }
  .cp-btn:hover { background: var(--border); color: var(--text); }
  .cp-btn:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  /* The label changes; it does not animate. design.md forbids motion for mood,
     and a state change that says what happened is not mood. */
  .cp-btn[data-done="1"] { color: var(--green); }
  .cp-note { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); margin-top: var(--s3); }
  .cp-note a { color: var(--dim); text-decoration: underline; }
  .cp-note a:hover { color: var(--text); }
`

const src = `  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]')
    if (!btn) return
    var target = document.getElementById(btn.getAttribute('data-copy'))
    if (!target || !navigator.clipboard) return
    navigator.clipboard.writeText(target.textContent.trim()).then(function () {
      var was = btn.textContent
      btn.textContent = 'Copied'
      btn.setAttribute('data-done', '1')
      setTimeout(function () { btn.textContent = was; btn.removeAttribute('data-done') }, 2000)
    })
  })`

const c = inlineScript(src)
export const COPY_JS = c.html
export const COPY_HASH = c.hash

const copyButton = (id: string, text: string): string =>
  `<button type="button" class="cp-btn" data-copy="${id}" aria-label="Copy ${text}">Copy</button>`

/** A copyable one-line command. `id` must be unique on the page. */
export function copyPill(id: string, text: string): string {
  return `<div class="cp"><code id="${id}">${text}</code>` + copyButton(id, text) + `</div>`
}

/**
 * The same control on the kit's plate (.cv-plate in src/ui/kit.ts), for a
 * value that wraps: a key, or the line that sets one. Same button, same
 * data-copy, same script; only the shape around it differs, a rounded
 * rectangle that wraps its text with the Copy held at the right.
 */
export function copyPlate(id: string, text: string): string {
  return `<div class="cv-plate"><code id="${id}">${text}</code>` + copyButton(id, text) + `</div>`
}
