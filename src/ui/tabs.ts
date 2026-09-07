import { inlineScript } from '../lib/csp.js'
// A language switch for the hero's code frame, and the surfaces it drives.
//
// The hero used to show one language. The register form asks which stack a
// reader is on, Python or Node, and a reader on the other side of that split
// had to take "the whole integration" on faith. Both samples are rendered by
// the server; this control only decides which one is visible, so with
// JavaScript off the page shows Python and says nothing false.
//
// One delegated listener, one hash. Every element carrying data-lang follows
// the choice: the two code samples and the two install pills beside the
// primary action. One control moves every surface, so they cannot disagree.
//
// No motion. The switch is a state change and it is instant. design.md forbids
// motion for mood, and a crossfade between two code samples would be exactly
// that. The selected tab is marked the way the nav marks the current page: a
// bar flush with the hairline under it.

export const TABS_CSS = `
  .tabs { display: flex; gap: var(--s4); align-self: stretch; }
  .tab { appearance: none; background: none; border: 0; padding: 0; cursor: pointer;
         display: inline-flex; align-items: center; min-height: 44px;
         font-family: var(--mono); font-size: var(--fs-label); letter-spacing: 1.1px;
         color: var(--dim); border-bottom: 2px solid transparent; margin-bottom: -1px;
         transition: color .15s; }
  .tab:hover { color: var(--text); }
  .tab:active { transform: translateY(1px); }
  .tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--green); }
  .tab:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
  /* The hidden attribute is a UA rule, and an author display on the element
     (the install pill is display: flex) would win over it. This keeps hidden
     meaning hidden on every surface the control drives. */
  [data-lang][hidden] { display: none !important; }
`

const src = `  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]')
    if (!tab) return
    var lang = tab.getAttribute('data-tab')
    var list = tab.closest('[role="tablist"]')
    var tabs = list ? list.querySelectorAll('[data-tab]') : [tab]
    for (var i = 0; i < tabs.length; i++) tabs[i].setAttribute('aria-selected', tabs[i] === tab ? 'true' : 'false')
    var panes = document.querySelectorAll('[data-lang]')
    for (var j = 0; j < panes.length; j++) panes[j].hidden = panes[j].getAttribute('data-lang') !== lang
  })
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    var tab = e.target && e.target.closest ? e.target.closest('[data-tab]') : null
    if (!tab) return
    var tabs = Array.prototype.slice.call(tab.closest('[role="tablist"]').querySelectorAll('[data-tab]'))
    var next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    next.focus()
    next.click()
    e.preventDefault()
  })`

const t = inlineScript(src)
export const TABS_JS = t.html
export const TABS_HASH = t.hash

/**
 * The tab strip. Each key names the data-lang value it reveals and the id of
 * the code sample it controls (code-<key>), which the page must render.
 */
export function langTabs(
  langs: ReadonlyArray<readonly [key: string, label: string]>,
  selected: string,
  listLabel: string,
): string {
  return `<div class="tabs" role="tablist" aria-label="${listLabel}">` +
    langs.map(([k, l]) =>
      `<button type="button" class="tab" role="tab" id="tab-${k}" data-tab="${k}" ` +
      `aria-controls="code-${k}" aria-selected="${k === selected ? 'true' : 'false'}">${l}</button>`).join('') +
    `</div>`
}
