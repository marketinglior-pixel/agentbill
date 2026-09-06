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

const VIEWPORTS = [
  ['desktop', 1440, 1000, false],
  ['mobile', 390, 844, true],
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
      }))
      if (status !== 200) failures.push(`${vp} ${name}: HTTP ${status}`)
      if (m.overflowX) failures.push(`${vp} ${name}: scrolls sideways`)
      if (m.leak) failures.push(`${vp} ${name}: template source leaked into the page ("${m.leak}")`)
      if (errs.length) failures.push(`${vp} ${name}: ${errs.length} console error(s): ${errs[0]}`)
      rows.push(`${vp.padEnd(8)} ${name.padEnd(13)} ${status} ${String(m.h).padStart(6)}px${m.overflowX ? '  OVERFLOW-X' : ''}${errs.length ? `  ERRS:${errs.length}` : ''}`)
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
