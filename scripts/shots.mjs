// Render every public surface at desktop and phone widths and look at it.
//
// design.md carried this line for months: "No page has ever been checked by
// eye. Every verified in the log below is grep and arithmetic. That is how a
// 230px empty panel shipped." On 2026-09-06 nine surfaces were finally checked
// against sixteen premium references and 63 findings survived review, three of
// them critical and all three invisible at 1440px. This script is what makes
// the next one cheap to catch.
//
//   npm run shots                      against production
//   BASE_URL=http://localhost:3000 npm run shots
//
// It writes full-page PNGs to scripts/shots-out/ and exits non-zero when a page
// does not return 200, scrolls sideways, or logs a console error. Those three
// are machine-checkable. The PNGs are for the part that is not: open them.

import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = process.env.BASE_URL || 'https://agentbill.dev'
const OUT = process.env.SHOTS_OUT || 'scripts/shots-out'

const PAGES = [
  ['home', '/'],
  ['pricing', '/pricing'],
  ['docs', '/docs'],
  ['register', '/register'],
  // The same route twice, on purpose. /register ships the signup form and the
  // post-key screen as two siblings in one response, and the second is hidden
  // by CSS until the submit handler reveals it, so a reader spends their first
  // minute on a screen this gate had never seen: history.replaceState writes
  // the #done in the URL and nothing reads it back, and the clipping detector
  // skips a display:none subtree. A second entry measures BOTH. Revealing it
  // on the first entry instead would hide the form and swap the coverage
  // rather than add to it, which looks identical in this output.
  ['register-done', '/register'],
  ['console-demo', '/app?demo=1'],
  ['blog', '/blog'],
  ['about', '/about'],
  ['faq', '/faq'],
  ['status', '/status'],
]

// 320 is here because two real defects have now shipped below the 390 floor,
// and this gate could not see either of them: the mobile CTA button on
// 2026-09-06, and the playground ceiling value on 2026-09-07 (`eb6c003`), where
// the ceiling row wanted more than 288px and the frame cut a digit off the
// number. Both were found by a hand-run sweep that lived and died inside one
// session. 320 is the narrowest width still in real use, so it is the floor
// that matters; 390 stays because it is the common one and the two widths
// break differently.
//
// The HEIGHTS took until 2026-09-13 to get the same treatment, and the gap cost
// four dogfood runs. `desktop` was 1440x1000, and 1000 is not a height any
// common Mac laptop has. Chrome's viewport is the screen minus the menu bar and
// its own tab strip and toolbar, so a maximised window gives roughly:
//
//   MacBook Air 13" M1 / 13" MBP   1440x900 default    ->  ~1440x760, ~725 with a bookmarks bar
//   MacBook Air 13" M2             1470x956            ->  ~1470x816
//   MacBook Pro 14"                1512x982            ->  ~1512x842
//   MacBook Pro 16"                1728x1117           ->  ~1728x977
//
// So 1000 models a 16" Pro or an external display: the LOOSEST case, and the
// one least able to show a fold problem. 735 is the 1440x900 machine with a
// bookmarks bar, which is the tightest desktop geometry in real use and the one
// the founder was sitting at. Measured here on 2026-09-15, both heights, same
// page: at 1000 the key screen's answer, export line and button are ALL above
// the fold and this gate sees nothing; at 735 the button sits below it, which
// is the truth a reader gets.
//
// Not a fourth viewport, deliberately. Nothing 1000 covers is lost: every other
// check in this file is height-independent, because `fullPage: true` captures
// the whole page at any viewport height. What IS lost is a regression that only
// appears on a tall screen, a sticky element that needs short content to show
// itself. That is the trade, and it is worth ten fewer captures on every run.
// The name stays `desktop` because every past record and filename uses it.
// How far below the fold the key screen's ONE action may sit, per viewport.
//
// Two different claims, because they are not equally negotiable.
//
// The ANSWER to "where does the key go" (.where) must be ABOVE the fold on
// every viewport, with no budget at all. That is the sentence dogfood run 4
// went looking for and did not find, and a reader who cannot see it does not
// know there is anything below to scroll to. Measured 2026-09-15 it clears with
// room everywhere: 320px of margin at desktop, 420 at mobile, 98 at narrow.
//
// The ACTION (.btn-go) is allowed below the fold, within one short scroll,
// because it cannot be lifted above 735 without deleting something the reader
// needs. Measured today it is +44 at desktop and +9 at mobile. The state that
// blocked run 4 was +312, so a 150px budget passes what ships and catches what
// shipped.
//
// `narrow` has no action budget, and that is an argument rather than an
// exemption of convenience. At 320x568 the viewport is 568px tall and the key
// panel alone, heading through export line, is taller than that; no arrangement
// puts a fourth element above the fold. A budget there would either be loose
// enough to catch nothing or force deleting content to satisfy a number. It is
// measured and printed on every run, so a regression is still visible; it is
// just not a build failure. Today it sits at +418.
const FOLD_ACTION_BUDGET = { desktop: 150, mobile: 150 }

// The signup form's one action, against the fold, on the viewports where it
// must be visible without a scroll. No budget: unlike the key screen, nothing
// on the form needs to sit above the button, so there is no argument for
// letting it slip. Measured 2026-09-19 with three optional fields still in the
// form: the button's top at 904 against 900 on a 1440x900 laptop and against
// 864 on 1536x864, and against this gate's own 735 it was 213px down. Every
// viewport in this set fails on that layout, which is the point. `narrow` is
// measured and printed, not enforced, for the same reason the key screen's
// action has no budget there: a 568px viewport under the shared header does
// not hold a headline, a lede and a form, and a number that can only be met
// by deleting the lede is not a gate. The BOTTOM edge is what is compared,
// not the top: a button whose top clears the fold by ten pixels is a button
// cut in half.
const FORM_ACTION_VISIBLE = new Set(['desktop', 'mobile'])

// The homepage hero's one button, against the fold, 2026-09-22. The sub under
// the h1 became a locked three-sentence paragraph, longer than the one it
// replaced, and nothing in this file read the hero at all: every fold check
// above is /register's. Enforced on the desktop geometry the campaign buys
// (1440x735, the tightest laptop in real use). On a phone the sticky bar is
// the primary action and the hero's button is measured and printed, not
// enforced, for the same reason the key screen's action has no budget at
// `narrow`: the plate under the copy is taller than the viewport there and a
// number that can only be met by deleting the sentence is not a gate.
const HERO_ACTION_VISIBLE = new Set(['desktop'])

const VIEWPORTS = [
  ['desktop', 1440, 735, false],
  ['mobile', 390, 844, true],
  ['narrow', 320, 568, true],
]

/** Find a Chromium. Prefer an explicit path, then the Playwright cache, then a
 *  local Chrome. Pinning one cache version rots the moment Playwright updates. */
function findBrowser() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache)
      .filter((d) => d.startsWith('chromium'))
      .sort((a, b) => (parseInt(b.split('-')[1], 10) || 0) - (parseInt(a.split('-')[1], 10) || 0))
    for (const d of dirs) {
      for (const rel of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = path.join(cache, d, rel)
        if (fs.existsSync(p)) return p
      }
    }
  }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(chrome)) return chrome
  return null
}

const exe = findBrowser()
if (!exe) {
  console.error('No Chromium found. Set CHROMIUM_PATH, or run: npx playwright install chromium')
  process.exit(2)
}

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: exe })
const failures = []
const rows = []

for (const [vp, width, height, isMobile] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile })
  for (const [name, route] of PAGES) {
    const page = await ctx.newPage()
    const errs = []
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
    try {
      const res = await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45000 })
      const status = res ? res.status() : 0
      // The post-key screen has never been in this gate, and it is the screen
      // a new account spends its first minute on. It is not addressable: it is
      // one div in every /register response, hidden by CSS, and revealed only
      // by the submit handler; the #done in the URL is written by
      // history.replaceState and read by nothing. So loading /register#done
      // shows the empty form, and the clipping detector below skips a
      // display:none subtree, which is why a 320px regression there would ship
      // unseen.
      //
      // Revealed here the way the page reveals it, with a key-shaped string
      // that is not a key. Nothing signs in and nothing is registered: this
      // script's default BASE_URL is production, and a screenshot is not worth
      // a session there.
      // The post-key screen, revealed the way the page reveals it. Nothing
      // signs in and nothing registers: this script's default BASE_URL is
      // production and a screenshot is not worth a session there, so the key
      // is key-shaped and is not a key.
      if (name === 'register-done') {
        await page.evaluate(() => {
          const k = 'agb_' + '0'.repeat(48)
          document.getElementById('key-display').textContent = k
          document.getElementById('key-export').textContent = 'export AGENTBILL_API_KEY=' + k
          document.getElementById('form-state').style.display = 'none'
          document.getElementById('success-state').style.display = 'flex'
          // The class the page itself adds on reveal. Without it this gate
          // photographs a layout production never serves: the pitch above the
          // key stays, and the geometry that made dogfood run 4 ask where the
          // key goes is exactly what this script exists to catch.
          document.querySelector('.reg').classList.add('done')
        })
      }
      await page.waitForTimeout(600)
      const file = `${OUT}/${vp}-${name}.png`
      await page.screenshot({ path: file, fullPage: true })
      const m = await page.evaluate(() => ({
        h: document.documentElement.scrollHeight,
        // Where the key screen's answer and its action sit, against the fold.
        //
        // This is the one thing this gate could not see on 2026-09-12, and the
        // reason it passed 30/30 through four blocked dogfood runs. Every other
        // check here is height-independent: `fullPage: true` captures the whole
        // page whatever the viewport, so status, sideways scroll, leaks and
        // clipping all read the same at any height. The fold does not, and the
        // fold is what a reader actually gets.
        //
        // Measured only where the success state is really visible. The markup
        // is in every /register response but display:none until the reveal, and
        // getBoundingClientRect on a hidden subtree returns zeros, which would
        // report a comfortable 0px on the one page that has the problem.
        // The signup form's button, where the form is the visible state.
        // Same offsetParent rule as the key screen below: a hidden subtree
        // measures as zeros, and zero is above every fold.
        form: (() => {
          const f = document.getElementById('form-state')
          if (!f || f.offsetParent === null) return null
          const b = document.getElementById('submit-btn')
          if (!b || b.offsetParent === null) return { vh: window.innerHeight, bottom: null }
          return { vh: window.innerHeight, bottom: Math.round(b.getBoundingClientRect().bottom + window.scrollY) }
        })(),
        fold: (() => {
          const s = document.getElementById('success-state')
          if (!s || s.offsetParent === null) return null
          const top = (sel) => {
            const e = document.querySelector(sel)
            return e && e.offsetParent !== null ? Math.round(e.getBoundingClientRect().top + window.scrollY) : null
          }
          return { vh: window.innerHeight, answer: top('.where'), line: top('#key-export'), action: top('.btn-go') }
        })(),
        // How the hero's locked sentence actually breaks. Only a browser can
        // answer this: the served HTML is one string and says nothing about
        // where a line ends. Two claims, 2026-09-22.
        //
        // (1) A phrase inside a .nb span never wraps. getClientRects() returns
        //     one rect per line a span occupies, so a length above 1 IS the
        //     break we are banning, measured rather than inferred.
        // (2) The last line is not an orphan. This is here because the first
        //     attempt at the fix produced one: gluing "autonomous AI agents."
        //     pushed the paragraph to five lines ending in "or replan." alone,
        //     which is a different defect, not a fix. Without this half, that
        //     version would have shipped green.
        sub: (() => {
          const el = document.querySelector('.hero .sub')
          if (!el || el.offsetParent === null) return null
          const nb = [...el.querySelectorAll('.nb')].map((s) => ({
            text: s.textContent.replace(/\s+/g, ' ').trim(), lines: s.getClientRects().length,
          }))
          // Group the words by the top of their own rect: that is the visual line.
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          const lines = new Map(); const r = document.createRange(); let n
          while ((n = walker.nextNode())) {
            const t = n.textContent; let i = 0
            while (i < t.length) {
              while (i < t.length && /\s/.test(t[i])) i++
              if (i >= t.length) break
              let j = i; while (j < t.length && !/\s/.test(t[j])) j++
              r.setStart(n, i); r.setEnd(n, j)
              const top = Math.round(r.getBoundingClientRect().top)
              if (!lines.has(top)) lines.set(top, 0)
              lines.set(top, lines.get(top) + 1)
              i = j
            }
          }
          // Tops within a few pixels are the same visual line. The monospace
          // spans sit on the shared baseline but their rect starts a pixel or
          // two higher, and an exact-top grouping split them: this printed
          // "9 lines" for a paragraph of five on the 320px capture. Merging
          // by a tolerance keeps the number honest at every width.
          const tops = [...lines.entries()].sort((a, b) => a[0] - b[0])
          const counts = []
          let prev = null
          for (const [top, c] of tops) {
            if (prev !== null && top - prev <= 6) counts[counts.length - 1] += c
            else { counts.push(c); prev = top }
          }
          return { nb, lineCount: counts.length, lastLineWords: counts[counts.length - 1] ?? 0 }
        })(),
        // The homepage hero's button. The selector exists on / alone, so every
        // other page reads null here and the check below is keyed on the page.
        hero: (() => {
          const b = document.querySelector('.hero-cta a.btn-lg')
          if (!b || b.offsetParent === null) return null
          return { vh: window.innerHeight, bottom: Math.round(b.getBoundingClientRect().bottom + window.scrollY) }
        })(),
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        // An escaped `\${` inside a template literal emits the expression as
        // TEXT. It renders as a paragraph of source at the top of the page, it
        // returns 200, it logs nothing, and typecheck is happy. One shipped to
        // /pricing on 2026-09-06 and only a human looking at the render caught
        // it, which is exactly the gap this script exists to close.
        leak: (document.body.innerText.match(/\$\{|\bsiteNav\(|\bsiteFooter\(/) || [])[0] || null,
        // Text cut off inside its own box, which the overflowX check above
        // cannot see: `overflow-x: hidden` on a panel stops the DOCUMENT from
        // scrolling sideways, so the page-level test goes green while the panel
        // silently eats its own content. That is not hypothetical. The homepage
        // playground shipped "500 UNIT" and "0 CAL" at 320px behind exactly
        // that rule, months after a fix that was supposed to have handled it.
        //
        // Two exclusions, or this reports the whole site. `text-overflow:
        // ellipsis` is a deliberate truncation with a visible affordance, and
        // an ancestor that actually scrolls means the content is reachable.
        clipped: (() => {
          // Text actually cut off, which the overflowX check above cannot see:
          // `overflow-x: hidden` on a panel stops the DOCUMENT from scrolling
          // sideways, so the page-level test goes green while the panel
          // silently eats its own content. Not hypothetical. The homepage
          // playground shipped "500 UNIT" and "0 CAL" at 320px behind exactly
          // that rule, months after a fix that was supposed to have handled it.
          //
          // The test is "is this content clipped by something", NOT
          // "scrollWidth > clientWidth". Those differ, and the difference is
          // most of the noise: an element whose overflow is `visible` spills
          // past its own box and stays perfectly readable. Only an ancestor
          // that actually clips turns a spill into a cut. Written this way
          // because the first version reported eleven of those spills as
          // failures, and a gate that cries wolf gets switched off.
          const hits = []
          const clips = (cs) => cs.overflowX === 'hidden' || cs.overflowX === 'clip'
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el)
            if (cs.display === 'none' || cs.visibility === 'hidden') continue
            const text = (el.innerText || '').trim().replace(/\s+/g, ' ')
            if (!text) continue
            const r = el.getBoundingClientRect()
            if (r.width === 0) continue
            // an ellipsis is a deliberate truncation with a visible affordance
            if (cs.textOverflow === 'ellipsis') continue
            let cut = 0, by = null
            // the element can clip its own children
            if (clips(cs) && el.scrollWidth > el.clientWidth + 1) { cut = el.scrollWidth - el.clientWidth; by = 'itself' }
            // or an ancestor can cut it off
            let p = el.parentElement, depth = 0
            while (p && depth < 8) {
              const pc = getComputedStyle(p)
              // A scrollable ancestor is reached FIRST or not at all. Without
              // this the walk sails past a scrolling <pre> and blames the
              // `overflow-x: hidden` on body, reporting every long code comment
              // on /docs as cut when the block scrolls perfectly well.
              if (/(auto|scroll)/.test(pc.overflowX)) { cut = 0; by = null; break }
              if (clips(pc)) {
                const pr = p.getBoundingClientRect()
                const over = Math.round(r.right - (pr.right - parseFloat(pc.borderRightWidth || 0)))
                if (over > 1 && over > cut) { cut = over; by = p.tagName.toLowerCase() + '.' + (String(p.className).trim().split(/\s+/)[0] || '?') }
                break
              }
              p = p.parentElement; depth++
            }
            if (!cut) continue
            hits.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0] || '?'} cut ${cut}px by ${by}: "${text.slice(0, 38)}"`)
          }
          return hits
        })(),
      }))
      if (m.form) {
        // As with the key screen: a renamed button is a failure, not a skip.
        if (m.form.bottom === null) {
          failures.push(`${vp} ${name}: no #submit-btn on the signup form, so the fold check measured nothing`)
        } else if (FORM_ACTION_VISIBLE.has(vp) && m.form.bottom > m.form.vh) {
          failures.push(`${vp} ${name}: the signup button's bottom edge is ${m.form.bottom - m.form.vh}px BELOW the fold`)
        }
      }
      if (m.fold) {
        // A missing element is a failure, not a skip. If .where or .btn-go is
        // renamed away, every check below it silently stops running and this
        // gate goes quiet on the exact screen it was added for.
        if (m.fold.answer === null) {
          failures.push(`${vp} ${name}: no .where on the key screen, so the fold check measured nothing`)
        } else if (m.fold.answer >= m.fold.vh) {
          failures.push(`${vp} ${name}: the answer to "where does the key go" is ${m.fold.answer - m.fold.vh}px BELOW the fold`)
        }
        const budget = FOLD_ACTION_BUDGET[vp]
        if (budget !== undefined) {
          if (m.fold.action === null) failures.push(`${vp} ${name}: no .btn-go on the key screen, so the action budget measured nothing`)
          else if (m.fold.action > m.fold.vh + budget) {
            failures.push(`${vp} ${name}: the one action is ${m.fold.action - m.fold.vh}px below the fold, past the ${budget}px budget`)
          }
        }
      }
      if (name === 'home') {
        // The sentence's line breaks. Enforced at desktop, where the measure is
        // fixed at 54ch and every reader from 1180px up gets the same breaks;
        // printed but not enforced at mobile and narrow, where the column is
        // fluid and a break moves with the viewport.
        if (!m.sub) failures.push(`${vp} ${name}: no .hero .sub, so the line-break check measured nothing`)
        else {
          if (m.sub.nb.length !== 2) failures.push(`${vp} ${name}: ${m.sub.nb.length} .nb phrase(s) in the sub, expected 2`)
          for (const p of m.sub.nb) {
            if (p.lines > 1) failures.push(`${vp} ${name}: the phrase "${p.text}" is broken across ${p.lines} lines`)
          }
          if (vp === 'desktop' && m.sub.lastLineWords <= 2) {
            failures.push(`${vp} ${name}: the sub's last line is an orphan, ${m.sub.lastLineWords} word(s) over ${m.sub.lineCount} lines`)
          }
        }
        // A renamed or missing button is a failure, not a skip: otherwise this
        // gate goes quiet on the one page it was added for.
        if (!m.hero) failures.push(`${vp} ${name}: no .hero-cta a.btn-lg on the homepage, so the hero fold check measured nothing`)
        else if (HERO_ACTION_VISIBLE.has(vp) && m.hero.bottom > m.hero.vh) {
          failures.push(`${vp} ${name}: the hero button's bottom edge is ${m.hero.bottom - m.hero.vh}px BELOW the fold`)
        }
      }
      if (status !== 200) failures.push(`${vp} ${name}: HTTP ${status}`)
      if (m.overflowX) failures.push(`${vp} ${name}: scrolls sideways`)
      if (m.leak) failures.push(`${vp} ${name}: template source leaked into the page ("${m.leak}")`)
      for (const c of m.clipped.slice(0, 4)) failures.push(`${vp} ${name}: ${c}`)
      if (errs.length) failures.push(`${vp} ${name}: ${errs.length} console error(s): ${errs[0]}`)
      if (name === 'home' && m.sub) {
        rows.push(`${' '.repeat(8)} ${' '.repeat(13)}     sub ${m.sub.lineCount} lines, last ${m.sub.lastLineWords} word(s), phrases ${m.sub.nb.map((p) => `${p.lines}`).join('/')}`)
      }
      if (name === 'home' && m.hero) {
        const b = m.hero.bottom
        rows.push(`${' '.repeat(8)} ${' '.repeat(13)}     fold ${m.hero.vh}  hero-button-bottom ${b}${b <= m.hero.vh ? '' : ` (+${b - m.hero.vh} BELOW)`}`)
      }
      if (m.form) {
        const b = m.form.bottom
        rows.push(`${' '.repeat(8)} ${' '.repeat(13)}     fold ${m.form.vh}  submit-bottom ${b === null ? '?' : `${b}${b <= m.form.vh ? '' : ` (+${b - m.form.vh} BELOW)`}`}`)
      }
      if (m.fold) {
        const d = (v) => v === null ? '?' : `${v}${v < m.fold.vh ? '' : ` (+${v - m.fold.vh} BELOW)`}`
        rows.push(`${' '.repeat(8)} ${' '.repeat(13)}     fold ${m.fold.vh}  answer ${d(m.fold.answer)}  line ${d(m.fold.line)}  action ${d(m.fold.action)}`)
      }
      rows.push(`${vp.padEnd(8)} ${name.padEnd(13)} ${status} ${String(m.h).padStart(6)}px${m.overflowX ? '  OVERFLOW-X' : ''}${errs.length ? `  ERRS:${errs.length}` : ''}${m.clipped.length ? `  CLIPPED:${m.clipped.length}` : ''}`)
    } catch (e) {
      failures.push(`${vp} ${name}: ${String(e).slice(0, 160)}`)
      rows.push(`${vp.padEnd(8)} ${name.padEnd(13)} FAILED`)
    }
    await page.close()
  }
  await ctx.close()
}
// ---------------------------------------------------------------- the ?src= rewrite, in a browser
//
// The only check that can prove this one. The homepage's seven links to
// /register (six until 2026-09-23; the redesign's estimator card added one) are tagged by script at load, so the served HTML says /register
// and the DOM the visitor clicks says /register?src=x. Every grep, every
// string-presence gate in verify.mjs and every curl reads the FIRST of those
// and would stay green with the rewrite deleted.
//
// Two assertions, and the second is the one that matters: not that the loop is
// in the file, but that after a real page load every anchor a visitor can
// press carries the label, and that pressing one lands on a /register whose
// own beacon will therefore carry it too.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const beacons = []
  await page.route('**/pulse', async (route) => {
    try { beacons.push(JSON.parse(route.request().postData() ?? '{}')) } catch {}
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto(`${BASE}/?src=shotsgate`, { waitUntil: 'networkidle' })

  // The load itself, 2026-09-22: exactly one page_view per load, carrying the
  // label, sent before anyone clicks anything. The route above answers it, so
  // nothing here reaches the live table.
  const pv = beacons.filter((b) => b.event === 'page_view')
  if (pv.length !== 1 || pv[0].source !== 'shotsgate') {
    failures.push(`page-view: ${pv.length} page_view beacon(s) on a tagged load, first ${JSON.stringify(pv[0] ?? null)}; expected exactly one carrying source shotsgate`)
  }

  const hrefs = await page.$$eval('a[href^="/register"]', (as) => as.map((a) => a.getAttribute('href')))
  const tagged = hrefs.filter((h) => h === '/register?src=shotsgate').length
  if (hrefs.length !== 7 || tagged !== 7) {
    failures.push(`src-rewrite: ${tagged}/${hrefs.length} /register links tagged after load (expected 7/7) -> ${JSON.stringify(hrefs)}`)
  }

  // And the click itself: the listener still fires on the rewritten href, and
  // the payload carries the label. This is the pair that broke once already --
  // an exact a[href="/register"] selector matches nothing after the rewrite,
  // and the beacon goes silent on precisely the traffic the label measures.
  await page.click('.hero-cta a.btn-lg', { noWaitAfter: true })
  await page.waitForTimeout(400)
  const cta = beacons.find((b) => b.event === 'cta_click')
  if (!cta || cta.source !== 'shotsgate') {
    failures.push(`src-rewrite: click sent ${JSON.stringify(cta ?? null)}; expected a cta_click carrying source shotsgate`)
  }

  // An untagged visit must be left exactly as it was, and its load is counted
  // with no source, never a guessed one.
  const plain = await ctx.newPage()
  const plainBeacons = []
  await plain.route('**/pulse', async (route) => {
    try { plainBeacons.push(JSON.parse(route.request().postData() ?? '{}')) } catch {}
    await route.fulfill({ status: 204, body: '' })
  })
  await plain.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const plainHrefs = await plain.$$eval('a[href^="/register"]', (as) => as.map((a) => a.getAttribute('href')))
  if (plainHrefs.some((h) => h !== '/register')) {
    failures.push(`src-rewrite: an untagged homepage grew a parameter -> ${JSON.stringify(plainHrefs)}`)
  }
  const plainPv = plainBeacons.filter((b) => b.event === 'page_view')
  if (plainPv.length !== 1 || 'source' in plainPv[0]) {
    failures.push(`page-view: ${plainPv.length} page_view beacon(s) on an untagged load, first ${JSON.stringify(plainPv[0] ?? null)}; expected exactly one with no source`)
  }
  rows.push(`browser  src-rewrite   ${tagged}/7 tagged, click ${cta?.source ?? 'none'}, plain ${plainHrefs.every((h) => h === '/register') ? 'clean' : 'DIRTY'}`)
  rows.push(`browser  page-view     tagged load ${pv.length} beacon(s) src ${pv[0]?.source ?? 'none'}, plain load ${plainPv.length} beacon(s) src ${plainPv[0]?.source ?? 'none'}`)
  await ctx.close()
}

await browser.close()

console.log(`\n${BASE}\n`)
console.log(rows.join('\n'))
console.log(`\n${PAGES.length * VIEWPORTS.length} captures in ${OUT}/`)

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`)
  for (const f of failures) console.error('  ' + f)
  console.error('\nThese are the machine-checkable ones. Now open the PNGs, which is the point.')
  process.exit(1)
}
console.log('\nNo non-200, no sideways scroll, no console errors. Now open the PNGs: every')
console.log('one of the 2026-09-06 findings passed all three of those checks and was still broken.')
