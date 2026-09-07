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
const VIEWPORTS = [
  ['desktop', 1440, 1000, false],
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
      await page.waitForTimeout(600)
      const file = `${OUT}/${vp}-${name}.png`
      await page.screenshot({ path: file, fullPage: true })
      const m = await page.evaluate(() => ({
        h: document.documentElement.scrollHeight,
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
      if (status !== 200) failures.push(`${vp} ${name}: HTTP ${status}`)
      if (m.overflowX) failures.push(`${vp} ${name}: scrolls sideways`)
      if (m.leak) failures.push(`${vp} ${name}: template source leaked into the page ("${m.leak}")`)
      for (const c of m.clipped.slice(0, 4)) failures.push(`${vp} ${name}: ${c}`)
      if (errs.length) failures.push(`${vp} ${name}: ${errs.length} console error(s): ${errs[0]}`)
      rows.push(`${vp.padEnd(8)} ${name.padEnd(13)} ${status} ${String(m.h).padStart(6)}px${m.overflowX ? '  OVERFLOW-X' : ''}${errs.length ? `  ERRS:${errs.length}` : ''}${m.clipped.length ? `  CLIPPED:${m.clipped.length}` : ''}`)
    } catch (e) {
      failures.push(`${vp} ${name}: ${String(e).slice(0, 160)}`)
      rows.push(`${vp.padEnd(8)} ${name.padEnd(13)} FAILED`)
    }
    await page.close()
  }
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
