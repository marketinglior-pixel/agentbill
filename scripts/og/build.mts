// Renders the 1200x630 Open Graph card and writes src/lib/og-image.ts.
//
// Run: ./scripts/og/build.sh   (or: npm run build:og)
//
// The card is a page like any other. It takes its tokens from theme.ts, its
// mark from mark.ts, its headline and install line from site.ts, and its
// refusal row from the same demoConsole() the console and the homepage panels
// render, composed by the console's own decisionLine(). Nothing on it is typed
// twice. The previous card (2026-08-27, drawn in PIL) outlived the headline,
// the claims audit and the mark by weeks, because a grep cannot see a PNG.
//
// The build refuses to write a card whose fonts fell back or whose content
// ran past the frame: both would ship silently otherwise.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { TOKENS, BASE } from '../../src/ui/theme.js'
import { mark, MARK_CSS } from '../../src/ui/mark.js'
import { HEADLINE, INSTALL_PY, ORIGIN } from '../../src/ui/site.js'
import { demoConsole, decisionLine, REASON_LABEL } from '../../src/routes/app.js'

const row = demoConsole().decisions.find((d) => d.blocked)
if (!row) throw new Error('demoConsole() has no blocked decision to put on the card')
const line = decisionLine(row)
const label = REASON_LABEL[row.reason] ?? row.reason
const host = new URL(ORIGIN).host

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet" />
<style>${TOKENS}${BASE}${MARK_CSS}
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  .card { width: 1200px; height: 630px; padding: 64px 72px; background: var(--grad-vignette);
          display: flex; flex-direction: column; justify-content: space-between; }
  .logo { display: flex; align-items: center; gap: 15px; font-family: var(--mono); font-weight: 700;
          font-size: 27px; letter-spacing: -0.01em; color: var(--text); }
  h1 { font-size: 78px; max-width: 980px; color: var(--white); }
  .rr { display: flex; align-items: flex-start; gap: 18px; width: max-content; max-width: 100%;
        font-family: var(--mono); font-size: 22px; line-height: 1.5; color: var(--muted);
        background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
        border-radius: var(--r-frame); padding: 18px 24px; box-shadow: var(--edge), var(--lift); }
  .chip { flex: none; display: inline-flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 500;
          padding: 6px 12px; margin-top: 4px; border-radius: var(--r-chip); white-space: nowrap;
          background: var(--held-bg); color: var(--green); border: 1px solid var(--held-line); }
  .chip::before { content: ''; width: 9px; height: 9px; border-radius: 2px; background: var(--green); }
  .ft { display: flex; justify-content: space-between; align-items: center;
        font-family: var(--mono); font-size: 20px; color: var(--dim); }
  .ft b { color: var(--green); font-weight: 500; }
</style></head>
<body><div class="card">
  <div class="logo">${mark(30)}AgentBill</div>
  <h1>${HEADLINE}.</h1>
  <div class="rr"><span class="chip">${label}</span><span>${line}</span></div>
  <div class="ft"><b>${host}</b><span>${INSTALL_PY}</span></div>
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
  display: document.fonts.check('800 78px Archivo'),
  mono: document.fonts.check('700 27px "JetBrains Mono"'),
}))
if (!fonts.display || !fonts.mono) throw new Error(`fonts did not load (${JSON.stringify(fonts)}); the card would ship in a fallback face`)
const past = await page.evaluate(() => Array.from(document.querySelectorAll('.card *'))
  .filter((e) => { const r = e.getBoundingClientRect(); return r.right > 1200 || r.bottom > 630 })
  .map((e) => e.tagName + (e.className ? '.' + e.className : '')))
if (past.length) throw new Error('card content runs past the frame: ' + past.join(', '))
const png = await page.screenshot({ type: 'png' })
await browser.close()

const date = new Date().toISOString().slice(0, 10)
const out = `// 1200x630 Open Graph card. Generated ${date} by scripts/og/build.mts. Do not
// edit by hand: rerun \`npm run build:og\`, or the card stops rendering from the
// same tokens, mark, headline and sample row as the pages it stands in for.
export const OG_PNG: Buffer = Buffer.from(
  '${png.toString('base64')}',
  'base64'
)
`
fs.writeFileSync('src/lib/og-image.ts', out)
if (process.env.OG_OUT) fs.writeFileSync(process.env.OG_OUT, png)
console.log(`wrote src/lib/og-image.ts (${png.length} bytes png) · row: ${label} · ${line}`)
