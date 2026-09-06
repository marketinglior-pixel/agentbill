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
  /* The pill is a control, so it clears the 44px floor like every other one. */
  .cp { display: flex; align-items: center; gap: var(--s3); min-height: 44px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        padding: 0 var(--s2) 0 var(--s4); max-width: max-content; }
  .cp code { font-family: var(--mono); font-size: var(--fs-small); color: var(--code-ink);
             white-space: nowrap; overflow-x: auto; }
  .cp-btn { flex: none; background: none; border: 1px solid var(--border-strong); border-radius: 6px;
            color: var(--muted); font-family: var(--sans); font-size: var(--fs-micro); font-weight: 600;
            min-height: 32px; padding: 0 var(--s3); cursor: pointer; white-space: nowrap;
            transition: color .15s, border-color .15s; }
  .cp-btn:hover { color: var(--text); border-color: var(--dim); }
  .cp-btn:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  /* The label changes; it does not animate. design.md forbids motion for mood,
     and a state change that says what happened is not mood. */
  .cp-btn[data-done="1"] { color: var(--green); border-color: var(--green); }
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

/** A copyable one-line command. `id` must be unique on the page. */
export function copyPill(id: string, text: string): string {
  return `<div class="cp"><code id="${id}">${text}</code>` +
    `<button type="button" class="cp-btn" data-copy="${id}" aria-label="Copy ${text}">Copy</button></div>`
}
