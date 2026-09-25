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
  // The integration pages, 2026-09-23: the hub's five-column table and the
  // hook table on /integrations/openclaw are the two widest things on any docs
  // page, and a table is what sideways scroll comes from at 320.
  ['integrations', '/integrations'],
  ['int-openclaw', '/integrations/openclaw'],
  ['int-langchain', '/integrations/langchain'],
  ['int-openai-agents', '/integrations/openai-agents-sdk'],
  ['int-crewai', '/integrations/crewai'],
  ['int-mcp', '/integrations/mcp'],
  // Sign-in, 2026-09-25. /register and /login are one page with two sets of
  // words: Continue with Google, Continue with GitHub, and an email field.
  // The post-key screen that used to be a second entry here left /register
  // with the key: the key is made in the console now, for a verified person.
  ['register', '/register'],
  ['login', '/login'],
  ['register-sent', '/register?sent=1'],
  ['console-demo', '/app?demo=1'],
  // The two views the jobs-by-spend lane (2026-09-23) added to: the tasks
  // view under its Most used order, where every row carries a second foot line
  // for the preflight span, and the activity view with the event_type split.
  // Sample data, so the rows exist without an account.
  ['console-demo-tasks', '/app?demo=1&view=tasks&sort=used'],
  ['console-demo-activity', '/app?demo=1&view=activity'],
  // The keys view, 2026-09-25 (security batch B): every key as agb_1234…abcd,
  // the key commands, and no key in full anywhere on it.
  ['console-demo-keys', '/app?demo=1&view=keys'],
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
//
// 2026-09-25: the form's actions are three, Continue with Google, Continue with
// GitHub and the email button, and all three are held above the fold on the
// same viewports, on /register and on /login.
const FORM_ACTION_VISIBLE = new Set(['desktop', 'laptop', 'mobile'])

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

// The start screen's connect choices, 2026-09-25: above the fold at 1440,
// 1280 and 390. At 320 they are measured and printed, not enforced, for the
// reason the key screen's action is not: three stacked cards under the
// console's own bar do not fit a 568px viewport with the question above them.
const VIA_VISIBLE = new Set(['desktop', 'laptop', 'mobile'])

// `laptop`, 2026-09-25: 1280 wide at the same 735 the desktop gate holds, the
// narrowest desktop width in common use, asked for with the sign-in pages.
const VIEWPORTS = [
  ['desktop', 1440, 735, false],
  ['laptop', 1280, 735, false],
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

// Signed-in screens, when a session is handed in (never against production:
// this script does not sign in anywhere, and a screenshot is not worth a
// session there). SHOTS_COOKIE is a Cookie header for a person's session on a
// local server, e.g. from the harness's fake OAuth provider; with it the run
// adds the start screen with its first-key step and the keys view with the
// ways in, and SHOTS_KEY_COOKIE adds the keys view as a key session sees it.
// The MCP consent page and the console's connected apps, 2026-09-25. Only with
// a session handed in, so only against a local server: the run registers an
// OAuth client there, opens the consent page for it (that is the capture), and
// completes one connection so the keys view has a connected app to show.
let CONSENT_PATH = null
if (process.env.SHOTS_COOKIE) {
  const redirect = 'https://client.example/callback'
  const reg = await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Example MCP client', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) }).then((r) => r.json()).catch(() => ({}))
  const pk = (await import('node:crypto'))
  const authPath = (v) => `/app/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id ?? '', redirect_uri: redirect,
    code_challenge: pk.createHash('sha256').update(v).digest('base64url'), code_challenge_method: 'S256', state: 'shots' })}`
  if (reg.client_id) {
    CONSENT_PATH = authPath(pk.randomBytes(32).toString('base64url'))
    // One connection, approved the way the page's form does it.
    const verifier = pk.randomBytes(32).toString('base64url')
    const html = await fetch(`${BASE}${authPath(verifier)}`, { headers: { cookie: process.env.SHOTS_COOKIE } }).then((r) => r.text())
    const rid = (html.match(/name="request_id" value="([^"]+)"/) ?? [])[1]
    const csrf = (html.match(/name="csrf" value="([^"]+)"/) ?? [])[1]
    const ok = await fetch(`${BASE}/app/oauth/authorize`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', cookie: process.env.SHOTS_COOKIE },
      body: new URLSearchParams({ request_id: rid ?? '', csrf: csrf ?? '', decision: 'approve' }).toString() })
    const code = new URL(ok.headers.get('location') ?? 'http://none/').searchParams.get('code')
    const tok = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.client_id, code: code ?? '', redirect_uri: redirect, code_verifier: verifier }).toString() })
    if (tok.status !== 200) failures.push(`consent: could not complete a connection for the connected-apps capture (${tok.status})`)
  } else {
    failures.push('consent: could not register an OAuth client, so the consent page was not captured')
  }
}

// The start screen's three answers to "how will you connect?" and the
// activity view in dollars, 2026-09-25. Each path is its own capture; the
// dollar view needs an account with a priced call, so it is captured with
// SHOTS_COOKIE only (a local server's session), never against production.
const START_VIAS = ['mcp', 'python', 'node']
const SIGNED_IN = [
  ...(process.env.SHOTS_COOKIE ? [['console-start', '/app?view=start', process.env.SHOTS_COOKIE], ['console-keys', '/app?view=keys', process.env.SHOTS_COOKIE],
    ...START_VIAS.map((v) => [`console-start-${v}`, `/app?view=start&via=${v}`, process.env.SHOTS_COOKIE]),
    ['console-activity', '/app?view=activity', process.env.SHOTS_COOKIE]] : []),
  ...(process.env.SHOTS_KEY_COOKIE ? [['console-keysess', '/app?view=keys', process.env.SHOTS_KEY_COOKIE]] : []),
  ...(CONSENT_PATH ? [['mcp-consent', CONSENT_PATH, process.env.SHOTS_COOKIE]] : []),
]

for (const [vp, width, height, isMobile] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile })
  for (const [name, route, cookie] of [...PAGES, ...SIGNED_IN]) {
    const page = await ctx.newPage()
    if (cookie) await page.setExtraHTTPHeaders({ cookie })
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
        // The sign-in block's three actions, on /register and /login. Keyed on
        // the email form, which every configuration of the block draws; a
        // provider button that is missing where the form exists is reported,
        // not skipped, so a renamed class cannot turn this gate off.
        form: (() => {
          const f = document.getElementById('email-form')
          if (!f || f.offsetParent === null) return null
          const bottom = (sel) => {
            const e = document.querySelector(sel)
            return e && e.offsetParent !== null ? Math.round(e.getBoundingClientRect().bottom + window.scrollY) : null
          }
          return { vh: window.innerHeight, google: bottom('.pbtn.is-google'), github: bottom('.pbtn.is-github'), email: bottom('.btn-email') }
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
        // The nav, 2026-09-25, when MCP joined it: every destination on one
        // line, the bar at its 60px, and the MCP link reachable at every width
        // (in the bar on a desktop, in the menu on a phone).
        nav: (() => {
          const inner = document.querySelector('.nav-inner')
          if (!inner) return null
          const links = [...document.querySelectorAll('.nav-center a')]
          return {
            h: Math.round(inner.getBoundingClientRect().height),
            wrapped: links.filter((a) => a.offsetParent !== null && a.getClientRects().length > 1).map((a) => a.textContent),
            mcpBar: !!links.find((a) => a.getAttribute('href') === '/integrations/mcp' && a.offsetParent !== null),
            mcpMenu: !!document.querySelector('.nav-menu a[href="/integrations/mcp"]'),
            menuShown: (() => { const m = document.querySelector('.nav-menu'); return !!m && m.offsetParent !== null })(),
          }
        })(),
        apps: !!document.getElementById('connected-apps'),
        // The start screen's three choices, against the fold: the question is
        // the screen, so every answer to it is visible without a scroll.
        vias: (() => {
          const cards = [...document.querySelectorAll('.vias .via')]
          if (!cards.length) return null
          return { vh: window.innerHeight, n: cards.length, bottom: Math.max(...cards.map((c) => Math.round(c.getBoundingClientRect().bottom + window.scrollY))),
                   current: cards.filter((c) => c.hasAttribute('aria-current')).map((c) => c.getAttribute('href')) }
        })(),
        cost: !!document.getElementById('cost-chart'),
        approve: (() => { const b = document.getElementById('approve'); return b && b.offsetParent !== null ? Math.round(b.getBoundingClientRect().bottom + window.scrollY) : null })(),
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
        // A renamed button is a failure, not a skip. SHOTS_NO_PROVIDERS=1 is for
        // a server with no client pair set, where the two buttons are
        // correctly absent and only the email button is held.
        const want = process.env.SHOTS_NO_PROVIDERS === '1' ? ['email'] : ['google', 'github', 'email']
        for (const k of want) {
          if (m.form[k] === null) failures.push(`${vp} ${name}: no ${k} button in the sign-in block, so the fold check measured nothing`)
          else if (FORM_ACTION_VISIBLE.has(vp) && m.form[k] > m.form.vh) {
            failures.push(`${vp} ${name}: the ${k} button's bottom edge is ${m.form[k] - m.form.vh}px BELOW the fold`)
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
      if (m.nav) {
        if (m.nav.h !== 60) failures.push(`${vp} ${name}: the nav bar is ${m.nav.h}px tall, not 60`)
        if (m.nav.wrapped.length) failures.push(`${vp} ${name}: nav link(s) wrap: ${m.nav.wrapped.join(', ')}`)
        if (!(m.nav.menuShown ? m.nav.mcpMenu : m.nav.mcpBar)) failures.push(`${vp} ${name}: no MCP link in the ${m.nav.menuShown ? 'menu' : 'nav bar'}`)
      }
      if (name.startsWith('console-start')) {
        // A renamed class is a failure, not a skip.
        if (!m.vias) failures.push(`${vp} ${name}: no .vias .via cards on the start screen, so the fold check measured nothing`)
        else {
          if (m.vias.n !== 3) failures.push(`${vp} ${name}: ${m.vias.n} connect choices, expected 3`)
          if (VIA_VISIBLE.has(vp) && m.vias.bottom > m.vias.vh) failures.push(`${vp} ${name}: the connect choices end ${m.vias.bottom - m.vias.vh}px BELOW the fold`)
          const want = name === 'console-start' ? [] : [`/app?view=start&via=${name.replace('console-start-', '')}`]
          if (JSON.stringify(m.vias.current) !== JSON.stringify(want)) failures.push(`${vp} ${name}: chosen ${JSON.stringify(m.vias.current)}, expected ${JSON.stringify(want)}`)
          rows.push(`${' '.repeat(8)} ${' '.repeat(13)}     fold ${m.vias.vh}  choices-bottom ${m.vias.bottom}${m.vias.bottom <= m.vias.vh ? '' : ` (+${m.vias.bottom - m.vias.vh} BELOW)`}`)
        }
      }
      if (name === 'console-activity' && !m.cost) failures.push(`${vp} ${name}: the activity view is not the cost chart (seed a priced call first)`)
      if (name === 'console-keys' && !m.apps) failures.push(`${vp} ${name}: no connected-apps table on the keys view`)
      if (name === 'mcp-consent' && m.approve === null) failures.push(`${vp} ${name}: no visible Allow button on the consent page`)
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
        const d = (v) => v === null ? '?' : `${v}${v <= m.form.vh ? '' : ` (+${v - m.form.vh} BELOW)`}`
        rows.push(`${' '.repeat(8)} ${' '.repeat(13)}     fold ${m.form.vh}  google ${d(m.form.google)}  github ${d(m.form.github)}  email ${d(m.form.email)}`)
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
// ---------------------------------------------------------------- /integrations/mcp: every tab, the keys, and no script
//
// 2026-09-25. The connect page is a tab list: one capture per tab at desktop
// and phone width, each asserting that exactly its own panel is shown and its
// one Connect action is visible; then the keyboard (ArrowRight, End, Home move
// the selection and the focus, as WAI-ARIA tabs do); then the page with
// JavaScript off, where the tab row is plain links and every panel is shown.
{
  const TABS = ['claude', 'chatgpt', 'claude-code', 'codex', 'cursor', 'antigravity', 'openclaw', 'other']
  const ACTION = { claude: 'connect-claude', chatgpt: 'connect-chatgpt', 'claude-code': 'connect-claude-code', codex: 'connect-codex',
                   cursor: 'connect-cursor', antigravity: 'connect-antigravity', openclaw: 'connect-openclaw', other: 'connect-vscode' }
  for (const [vp, width, height, isMobile] of [['desktop', 1440, 735, false], ['laptop', 1280, 735, false], ['mobile', 390, 844, true]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile })
    const page = await ctx.newPage()
    const errs = []
    page.on('console', (msg) => { if (msg.type() === 'error') errs.push(msg.text()) })
    await page.goto(`${BASE}/integrations/mcp`, { waitUntil: 'networkidle' })
    for (const id of TABS) {
      await page.click(`#tab-${id}`)
      await page.waitForTimeout(150)
      const st = await page.evaluate(([id, action]) => ({
        shown: [...document.querySelectorAll('.mcp-panel')].filter((p) => !p.hidden && p.offsetParent !== null).map((p) => p.id),
        selected: document.querySelector('.mcp-tab[aria-selected="true"]')?.id,
        action: (() => { const b = document.getElementById(action); return !!b && b.offsetParent !== null })(),
        hash: location.hash,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      }), [id, ACTION[id]])
      await page.screenshot({ path: `${OUT}/${vp}-mcp-tab-${id}.png`, fullPage: true })
      if (st.shown.length !== 1 || st.shown[0] !== id) failures.push(`${vp} mcp tab ${id}: panels shown ${JSON.stringify(st.shown)}`)
      if (st.selected !== `tab-${id}`) failures.push(`${vp} mcp tab ${id}: selected tab is ${st.selected}`)
      if (!st.action) failures.push(`${vp} mcp tab ${id}: its Connect action #${ACTION[id]} is not visible`)
      if (st.hash !== `#${id}`) failures.push(`${vp} mcp tab ${id}: the address says ${st.hash}`)
      if (st.overflowX) failures.push(`${vp} mcp tab ${id}: scrolls sideways`)
    }
    // The tab row, 2026-09-25: a mark in every tab, one line of tabs (a
    // phone scrolls the row inside itself), and no sideways page scroll.
    const row = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.mcp-tab')]
      const tops = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)))
      const list = document.querySelector('.mcp-tabs')
      return { marks: tabs.filter((t) => t.querySelector('svg.mcp-mark[aria-hidden="true"]')).length, n: tabs.length, rows: tops.size,
               scrolls: list ? list.scrollWidth > list.clientWidth + 1 : false, pageX: document.documentElement.scrollWidth > window.innerWidth + 1 }
    })
    await page.locator('.mcp-tabs').screenshot({ path: `${OUT}/${vp}-mcp-tabrow.png` })
    if (row.marks !== row.n) failures.push(`${vp} mcp tab row: ${row.marks} of ${row.n} tabs carry a mark`)
    if (isMobile ? row.rows !== 1 : row.rows > 2) failures.push(`${vp} mcp tab row: ${row.rows} rows of tabs`)
    if (row.pageX) failures.push(`${vp} mcp tab row: the page scrolls sideways`)
    rows.push(`${vp.padEnd(8)} mcp-tabrow    ${row.marks}/${row.n} marks, ${row.rows} row(s)${row.scrolls ? ', row scrolls inside itself' : ''}`)
    if (errs.length) failures.push(`${vp} mcp tabs: ${errs.length} console error(s): ${errs[0]}`)
    rows.push(`${vp.padEnd(8)} mcp-tabs      ${TABS.length} tabs captured`)
    await ctx.close()
  }
  // The keyboard.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 735 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/integrations/mcp`, { waitUntil: 'networkidle' })
    await page.focus('#tab-claude')
    const at = () => page.evaluate(() => ({ sel: document.querySelector('.mcp-tab[aria-selected="true"]')?.id, focus: document.activeElement?.id,
      tabindex: [...document.querySelectorAll('.mcp-tab')].map((t) => t.getAttribute('tabindex')).join(''), role: document.querySelector('.mcp-tabs')?.getAttribute('role') }))
    await page.keyboard.press('ArrowRight'); const a1 = await at()
    await page.keyboard.press('End'); const a2 = await at()
    await page.keyboard.press('Home'); const a3 = await at()
    await page.keyboard.press('ArrowLeft'); const a4 = await at()
    const good = a1.sel === 'tab-chatgpt' && a1.focus === 'tab-chatgpt' && a2.sel === 'tab-other' && a3.sel === 'tab-claude' && a3.focus === 'tab-claude'
      && a4.sel === 'tab-other' && a1.role === 'tablist' && a3.tabindex === '0' + '-1'.repeat(TABS.length - 1)
    if (!good) failures.push(`mcp tabs keyboard: ${JSON.stringify([a1, a2, a3, a4])}`)
    rows.push(`browser  mcp-keys      ArrowRight ${a1.sel}, End ${a2.sel}, Home ${a3.sel}, ArrowLeft ${a4.sel}`)
    await ctx.close()
  }
  // No script: every panel is shown, and the tab row is links to them.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/integrations/mcp`, { waitUntil: 'networkidle' })
    const st = await page.evaluate(() => ({
      shown: [...document.querySelectorAll('.mcp-panel')].filter((p) => p.offsetParent !== null).length,
      links: [...document.querySelectorAll('.mcp-tab')].filter((a) => /^#/.test(a.getAttribute('href') ?? '')).length,
      role: document.querySelector('.mcp-tabs')?.getAttribute('role'),
    }))
    await page.screenshot({ path: `${OUT}/mobile-mcp-nojs.png`, fullPage: true })
    if (st.shown !== TABS.length || st.links !== TABS.length || st.role) failures.push(`mcp without script: ${JSON.stringify(st)}`)
    rows.push(`nojs     mcp           ${st.shown}/${TABS.length} panels shown, ${st.links} tab links`)
    await ctx.close()
  }
}

// ---------------------------------------------------------------- the ?src= rewrite, in a browser
//
// The only check that can prove this one. The homepage's eight links to
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

  // Eight since 2026-09-25: the nav menu's Sign up joined the seven.
  const hrefs = await page.$$eval('a[href^="/register"]', (as) => as.map((a) => a.getAttribute('href')))
  const tagged = hrefs.filter((h) => h === '/register?src=shotsgate').length
  if (hrefs.length !== 8 || tagged !== 8) {
    failures.push(`src-rewrite: ${tagged}/${hrefs.length} /register links tagged after load (expected 8/8) -> ${JSON.stringify(hrefs)}`)
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
  rows.push(`browser  src-rewrite   ${tagged}/8 tagged, click ${cta?.source ?? 'none'}, plain ${plainHrefs.every((h) => h === '/register') ? 'clean' : 'DIRTY'}`)
  rows.push(`browser  page-view     tagged load ${pv.length} beacon(s) src ${pv[0]?.source ?? 'none'}, plain load ${plainPv.length} beacon(s) src ${plainPv[0]?.source ?? 'none'}`)
  await ctx.close()
}

// ---------------------------------------------------------------- keys: /recover and Revoke all, 2026-09-25
//
// Security batch B. Only with tokens and a session handed in, so only against
// a local server: SHOTS_RECOVER_TOKEN is a live recovery link's token for an
// account (a GET never spends it, so every viewport captures the choices),
// and the desktop capture then presses "Replace" and captures the one page a
// new key is shown on. SHOTS_REVOKE_COOKIE is a key session on a throwaway
// account: the keys view with the Revoke all block, then the box ticked and
// the button pressed, and the page that lands on. Both end what they open.
{
  const FULL = /agb_[0-9a-f]{48}/g
  const tok = process.env.SHOTS_RECOVER_TOKEN
  if (tok) {
    for (const [vp, width, height, isMobile] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile })
      const page = await ctx.newPage()
      const res = await page.goto(`${BASE}/recover/${tok}`, { waitUntil: 'networkidle' })
      await page.screenshot({ path: `${OUT}/${vp}-recover-choices.png`, fullPage: true })
      const st = await page.evaluate(() => ({ html: document.documentElement.outerHTML, overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        buttons: [...document.querySelectorAll('.choice button')].map((b) => b.textContent.trim()) }))
      if (res?.status() !== 200) failures.push(`${vp} recover-choices: HTTP ${res?.status()}`)
      if ((st.html.match(FULL) ?? []).length) failures.push(`${vp} recover-choices: a whole key on the page`)
      if (st.buttons.length !== 2) failures.push(`${vp} recover-choices: ${st.buttons.length} choices, expected 2`)
      if (st.overflowX) failures.push(`${vp} recover-choices: scrolls sideways`)
      rows.push(`${vp.padEnd(8)} recover-choices ${res?.status()} ${st.buttons.join(' | ')}`)
      await ctx.close()
    }
    // Last, because it spends the link.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 735 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/recover/${tok}`, { waitUntil: 'networkidle' })
    await Promise.all([page.waitForNavigation(), page.click('form:has(input[value="replace"]) button')])
    await page.screenshot({ path: `${OUT}/desktop-recover-replaced.png`, fullPage: true })
    const keys = [...new Set((await page.content()).match(FULL) ?? [])]
    if (keys.length !== 1) failures.push(`desktop recover-replaced: ${keys.length} distinct keys on the page, expected the one new key`)
    rows.push(`desktop  recover-replaced ${keys.length} new key shown`)
    await ctx.close()
  }
  const revoke = process.env.SHOTS_REVOKE_COOKIE
  if (revoke) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 735 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    await page.setExtraHTTPHeaders({ cookie: revoke })
    await page.goto(`${BASE}/app?view=keys`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: `${OUT}/desktop-console-keys-revoke-all.png`, fullPage: true })
    const block = page.locator('#revoke-all')
    if (!(await block.count())) failures.push('revoke-all: no Revoke all block on the keys view of a key session')
    else {
      await block.scrollIntoViewIfNeeded()
      await page.locator('.revall').screenshot({ path: `${OUT}/desktop-console-revoke-all-block.png` })
      await page.check('.revall input[name="confirm"]')
      await Promise.all([page.waitForNavigation(), page.click('.revall button[type="submit"]')])
      await page.screenshot({ path: `${OUT}/desktop-console-revoked-all.png`, fullPage: true })
      const html = await page.content()
      if (!html.includes('agentbill.dev/recover')) failures.push('revoke-all: the page it lands on does not point to /recover')
      if ((html.match(FULL) ?? []).length) failures.push('revoke-all: a whole key on the page it lands on')
      rows.push(`desktop  revoke-all    landed on ${new URL(page.url()).pathname}${new URL(page.url()).search}`)
    }
    await ctx.close()
  }
}

await browser.close()

console.log(`\n${BASE}\n`)
console.log(rows.join('\n'))
console.log(`\n${(PAGES.length + SIGNED_IN.length) * VIEWPORTS.length} captures in ${OUT}/`)

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`)
  for (const f of failures) console.error('  ' + f)
  console.error('\nThese are the machine-checkable ones. Now open the PNGs, which is the point.')
  process.exit(1)
}
console.log('\nNo non-200, no sideways scroll, no console errors. Now open the PNGs: every')
console.log('one of the 2026-09-06 findings passed all three of those checks and was still broken.')
