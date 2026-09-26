// Renders the 1200x630 Open Graph card and writes src/lib/og-image.ts.
//
// Run: ./scripts/og/build.sh   (or: npm run build:og)
//
// The card is a page like any other. It takes its tokens from theme.ts (the
// canvas block every page renders since 2026-09-23), its components from
// kit.ts, its mark from mark.ts, its headline and install line from site.ts,
// and its one frame from the same RUN the homepage fold renders
// (ui/playground.ts), so the card and the fold show one job with one set of
// numbers. Nothing on it is typed twice.
//
// History, because a grep cannot see a PNG and both failures below lived
// inside one: the 2026-08-27 card (drawn in PIL) outlived the headline, the
// claims audit and the mark by weeks. The 2026-09-09 card was built from this
// file on the dark theme and kept "A ceiling on this job, not on the month"
// after `/` moved to canvas and a new h1; on 2026-09-24 a WhatsApp preview of
// agentbill.dev showed that old headline on the old dark card beside the new
// description. The module this writes now carries the headline it rendered
// (OG_HEADLINE) and a hash of its own bytes (OG_VERSION), and the harness's
// [og] gates compare the first with HEADLINE, the h1 and the <title>, and the
// second with the bytes /og.png serves and the URL every head emits.
//
// The build refuses to write a card whose fonts fell back or whose content
// ran past the frame: both would ship silently otherwise.
import { chromium } from 'playwright-core'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { TOKENS_CANVAS, ROLES, BASE } from '../../src/ui/theme.js'
import { KIT_CSS, chip, tag, SAMPLE_TAG } from '../../src/ui/kit.js'
import { mark, MARK_CSS } from '../../src/ui/mark.js'
import { HEADLINE, INSTALL_PY, ORIGIN } from '../../src/ui/site.js'
import { RUN, usdCents } from '../../src/ui/playground.js'

const host = new URL(ORIGIN).host
const last = RUN.approved[RUN.approved.length - 1]
if (!last) throw new Error('RUN has no approved call before its refusal; the card has no row to draw')

// The frame is the fold's frame cut to its last two rows: the call that took
// the job to its figure, and the call preflight answered approved: false. The
// words under it are the fold's own ("Your code decides what happens next"),
// because what the product does at that moment is answer, and what happens
// next is the reader's code. Labelled sample in its own bar, like the fold.
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..800&family=Geist+Mono:wght@400..700&display=swap" rel="stylesheet" />
<style>${TOKENS_CANVAS}${ROLES}${BASE}${KIT_CSS}${MARK_CSS}
  html, body { width: 1200px; height: 630px; overflow: hidden; background: var(--bg); }
  /* The kit's sizes are set for a page read at arm's length. A card is read at
     a thumbnail's width, so the roles are scaled here and nowhere else. */
  .card { --fs-chip: 17px; --fs-small: 21px;
          width: 1200px; height: 630px; padding: 46px 64px 44px; display: flex; flex-direction: column; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .logo { display: flex; align-items: center; gap: 13px; font-family: var(--mono); font-weight: 700;
          font-size: 28px; color: var(--text); }
  .host { font-family: var(--mono); font-size: 22px; color: var(--muted); }
  h1 { margin: 30px 0 32px; font-size: 68px; line-height: 1.04; max-width: 1040px; color: var(--text); }
  .frame { margin-top: auto; background: var(--panel-bg); border-radius: var(--r-card); padding: 16px; }
  .win { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner); overflow: hidden; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 20px;
         border-bottom: 1px solid var(--card-line); }
  .bar-t { display: flex; align-items: center; gap: 12px; font-size: var(--fs-small); color: var(--muted); }
  .tag { padding: 3px 12px; }
  .rows { padding: 8px 12px 12px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) 330px 210px 230px; gap: 16px; align-items: center;
         padding: 9px 12px; border-radius: var(--r-row); font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
  /* nowrap so a value too long for its column overflows, which the check
     below catches, instead of wrapping to a second line, which it cannot. */
  .row > span { white-space: nowrap; min-width: 0; }
  .row .u, .row .t { text-align: right; font-variant-numeric: tabular-nums; }
  .row .u { color: var(--muted); }
  .row .a { justify-self: end; }
  .row.no { background: var(--row-no-bg); }
  .row.no .c, .row.no .u, .row.no .t { color: var(--row-no-ink); }
  .chip-ok, .chip-no { font-size: 18px; padding: 5px 14px; gap: 9px; }
  .chip-ok::before, .chip-no::before { width: 9px; height: 9px; }
  .foot { margin-top: 18px; display: flex; justify-content: space-between; align-items: baseline;
          font-size: 22px; color: var(--muted); }
  .foot b { font-weight: 500; color: var(--text); }
  .foot .m { font-family: var(--mono); font-size: 20px; }
</style></head>
<body><div class="card">
  <div class="top"><div class="logo">${mark(30)}AgentBill</div><span class="host">${host}</span></div>
  <h1>${HEADLINE}</h1>
  <div class="frame"><div class="win">
    <div class="bar"><span class="bar-t">${tag(RUN.taskRef, true)}<span>your agent&rsquo;s log &middot; ceiling ${usdCents(RUN.ceiling)}</span></span>${SAMPLE_TAG}</div>
    <div class="rows">
      <div class="row"><span class="c">${last.name}</span><span class="u">+${usdCents(last.units)}</span><span class="t">${usdCents(last.cum)}</span><span class="a">${chip('ok', 'approved')}</span></div>
      <div class="row no"><span class="c">${RUN.refused.name}</span><span class="u">asks ${usdCents(RUN.refused.asked)} &middot; ${usdCents(RUN.remaining)} left</span><span class="t">${usdCents(RUN.used + RUN.refused.asked)} &gt; ${usdCents(RUN.ceiling)}</span><span class="a">${chip('no', 'approved: false')}</span></div>
    </div>
  </div></div>
  <div class="foot"><span><b>Your code decides what happens next.</b></span><span class="m">${INSTALL_PY}</span></div>
</div></body></html>`

/** Same lookup as scripts/shots.mjs: the Playwright cache, then a desktop Chrome. */
function findBrowser(): string | null {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache)
      .filter((d) => d.startsWith('chromium'))
      .sort((a, b) => (parseInt(b.split('-')[1], 10) || 0) - (parseInt(a.split('-')[1], 10) || 0))
    for (const d of dirs) {
      for (const rel of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(cache, d, rel)
        if (fs.existsSync(p)) return p
      }
    }
  }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return fs.existsSync(chrome) ? chrome : null
}

const exe = findBrowser()
if (!exe) {
  console.error('No Chromium found. Set CHROMIUM_PATH, or run: npx playwright install chromium')
  process.exit(2)
}
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
const fonts = await page.evaluate(() => ({
  display: document.fonts.check('500 68px Geist'),
  mono: document.fonts.check('700 28px "Geist Mono"'),
}))
if (!fonts.display || !fonts.mono) throw new Error(`fonts did not load (${JSON.stringify(fonts)}); the card would ship in a fallback face`)
// The headline has to be whole and at most two lines: a third line pushes the
// frame into the footer at a thumbnail's size, where nobody reads it.
const h1 = await page.evaluate(() => {
  const e = document.querySelector('h1')!
  return { text: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }
})
if (h1.text !== HEADLINE) throw new Error(`card h1 reads "${h1.text}", HEADLINE is "${HEADLINE}"`)
if (h1.lines > 2) throw new Error(`card h1 wraps to ${h1.lines} lines; it must fit two`)
// Past the frame, or clipped inside its own box: a row whose text is wider
// than its column overflows without moving any rect past 1200x630.
const past = await page.evaluate(() => Array.from(document.querySelectorAll('.card *'))
  .filter((e) => {
    const r = e.getBoundingClientRect()
    return r.right > 1200 || r.bottom > 630 || e.scrollWidth > e.clientWidth + 1
  })
  .map((e) => e.tagName + (typeof e.className === 'string' && e.className ? '.' + e.className : '')))
if (past.length) throw new Error('card content runs past the frame: ' + past.join(', '))
const png = await page.screenshot({ type: 'png' })
await browser.close()

// The cache key for every og:image URL the head emits (/og.png?v=OG_VERSION).
// WhatsApp, Slack and X cache a card by URL, so a card that changes under the
// same URL keeps showing the old one; this hash changes exactly when the bytes
// do, and it is computed here from them rather than typed.
const version = createHash('sha256').update(png).digest('hex').slice(0, 12)
const date = new Date().toISOString().slice(0, 10)
const out = `// 1200x630 Open Graph card. Generated ${date} by scripts/og/build.mts. Do not
// edit by hand: rerun \`npm run build:og\`, or the card stops rendering from the
// same tokens, mark, headline and sample run as the pages it stands in for.

/** The headline the PNG below was rendered with. The harness compares it with
 *  HEADLINE, the homepage h1 and its <title>: a headline change that did not
 *  rebuild the card goes red there instead of in someone's chat preview. */
export const OG_HEADLINE = ${JSON.stringify(HEADLINE)}

/** sha256 of the PNG bytes, first 12 hex characters. The query string on every
 *  og:image URL, so the URL changes when the card does. */
export const OG_VERSION = '${version}'

export const OG_PNG: Buffer = Buffer.from(
  '${png.toString('base64')}',
  'base64'
)
`
fs.writeFileSync('src/lib/og-image.ts', out)
if (process.env.OG_OUT) fs.writeFileSync(process.env.OG_OUT, png)
console.log(`wrote src/lib/og-image.ts (${png.length} bytes png, v=${version}) · h1: ${HEADLINE} (${h1.lines} lines) · row: ${RUN.refused.name} asks ${RUN.refused.asked}, ${RUN.remaining} left`)
