// [openclaw] and [connect-marks], 2026-09-25.
//
// [openclaw]: the OpenClaw plugin where people look for it. The connect page's
// OpenClaw tab carries the exact ClawHub link and the exact install command,
// both the plugin README's own, the version from SDK_VERSIONS (which must be
// the plugin's package version), the README's config byte for byte, and never
// calls the plugin MCP. The homepage links to the listing and to the guide, and
// every footer's Developers column lists the plugin.
//
// [connect-marks]: every tab and every panel on /integrations/mcp carries its
// mark, aria-hidden beside its text label, and every mark has its record in
// src/ui/connect-marks.ts: where the asset was looked for, which guideline was
// read, and what was decided.
import { readFileSync } from 'node:fs'

export async function openclawGates({ API, ok }) {
  console.log('\n[openclaw] the OpenClaw plugin on the site, and the marks on the connect page')
  let reached = false
  try { await gates({ API, ok }); reached = true } catch (err) { ok('[openclaw] a gate threw', false, String(err?.stack ?? err).slice(0, 500)) }
  ok('[openclaw] every gate ran to the end', reached)
}

async function gates({ API, ok }) {
  const ROOT = new URL('../../', import.meta.url).pathname
  const CLAWHUB = 'https://clawhub.ai/agentbill/plugins/openclaw'
  const readme = readFileSync(`${ROOT}plugins/openclaw/README.md`, 'utf8')
  const fenced = [...readme.matchAll(/^```[\w-]*\n([\s\S]*?)\n^```/gm)].map((m) => m[1])
  const CMD = fenced.find((b) => b.startsWith('openclaw plugins install')) ?? ''
  const CONFIG = fenced.find((b) => b.includes('"allowConversationAccess"')) ?? ''
  const pkg = JSON.parse(readFileSync(`${ROOT}plugins/openclaw/package.json`, 'utf8')).version
  const { SDK_VERSIONS } = await import('../../dist/lib/llms.js')
  const { MCP_TAB_IDS } = await import('../../dist/ui/mcp-connect.js')
  const { CONNECT_MARKS } = await import('../../dist/ui/connect-marks.js')
  const unesc = (h) => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const visible = (h) => unesc(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

  const html = await fetch(`${API}/integrations/mcp`).then((r) => r.text())
  const panel = (id) => (html.match(new RegExp(`<section class="mcp-panel" id="${id}">([\\s\\S]*?)</section>`)) ?? [])[1] ?? ''
  const claw = panel('openclaw')
  const tab = html.match(/<a class="mcp-tab" id="tab-openclaw" href="#openclaw">([\s\S]*?)<\/a>/)
  const link = (claw.match(/<a [^>]*id="connect-openclaw"[^>]*>([^<]*)<\/a>/) ?? [])
  const linkHref = ((link[0] ?? '').match(/href="([^"]*)"/) ?? [])[1]
  const cmdShown = unesc((claw.match(/<code id="cmd-openclaw">([^<]*)<\/code>/) ?? [])[1] ?? '')
  ok('[openclaw] the connect page has an OpenClaw tab whose primary action is "View on ClawHub", linking to the listing exactly',
     !!tab && visible(tab[1]) === 'OpenClaw' && claw.length > 0 && link[1] === 'View on ClawHub' && linkHref === CLAWHUB, `${tab?.[1]?.slice(0, 80)} | ${link[0]}`)
  ok('[openclaw] its install command is the plugin README\'s own line, byte for byte, with a Copy button bound to it',
     CMD === 'openclaw plugins install clawhub:@agentbill/openclaw' && cmdShown === CMD && claw.includes('data-copy="cmd-openclaw"'), `${cmdShown} vs ${CMD}`)
  const cfgShown = unesc((claw.match(/<code id="openclaw-json">([\s\S]*?)<\/code>/) ?? [])[1] ?? '')
  ok('[openclaw] the config it shows is the README\'s, byte for byte', CONFIG.length > 50 && cfgShown === CONFIG, cfgShown.slice(0, 120))
  const text = visible(claw)
  ok('[openclaw] the version is SDK_VERSIONS.openclaw, which is the plugin\'s own package version',
     SDK_VERSIONS.openclaw === pkg && text.includes(`version ${pkg}`), `${SDK_VERSIONS.openclaw} vs ${pkg}`)
  ok('[openclaw] the tab never calls the plugin MCP: it says it is not, and that it is a native plugin checking each session before every model turn and tool call',
     text.includes('This one is not MCP') && text.includes('native OpenClaw plugin') && text.includes('before every model turn and every tool call')
       && !/\bMCP (server|client|tool|connector|endpoint)\b/i.test(text) && !/\bClaude Code\b|\bn8n\b/i.test(text), text.slice(0, 300))
  ok('[openclaw] its steps are three, in order: install, the key (plugin config or AGENTBILL_API_KEY, conversation hooks on), restart',
     (claw.match(/<ol class="mcp-steps">([\s\S]*?)<\/ol>/)?.[1].match(/<li>/g) ?? []).length === 3
       && /Run the install command[\s\S]*apiKey[\s\S]*AGENTBILL_API_KEY[\s\S]*allowConversationAccess[\s\S]*Restart the Gateway/.test(claw), '')

  const home = await fetch(`${API}/`).then((r) => r.text())
  const homeClaw = (home.match(/<a href="([^"]*)" id="home-clawhub"[^>]*>([^<]*)</) ?? [])
  const homeGuide = (home.match(/<a href="([^"]*)" id="home-openclaw">/) ?? [])[1]
  ok('[openclaw] the homepage links to the ClawHub listing and to the OpenClaw guide, beside the MCP line',
     homeClaw[1] === CLAWHUB && /OpenClaw plugin on ClawHub/.test(homeClaw[2] ?? '') && homeGuide === '/integrations/openclaw'
       && home.indexOf('id="home-mcp"') > -1 && home.indexOf('id="home-clawhub"') > home.indexOf('id="home-mcp"'), `${homeClaw[1]} ${homeGuide}`)
  const pages = ['/', '/docs', '/pricing', '/integrations', '/integrations/mcp', '/integrations/openclaw', '/faq']
  const foots = await Promise.all(pages.map(async (p) => {
    const h = await fetch(`${API}${p}`).then((r) => r.text())
    return [p, /<footer[\s\S]*href="\/integrations\/openclaw"[^>]*>OpenClaw plugin<\/a>[\s\S]*<\/footer>/.test(h)]
  }))
  ok('[openclaw] every footer\'s Developers column lists the OpenClaw plugin', foots.every(([, y]) => y), foots.filter(([, y]) => !y).map(([p]) => p).join(', '))

  // ---- [connect-marks]
  const tabs = [...html.matchAll(/<a class="mcp-tab" id="tab-([a-z-]+)" href="#[a-z-]+">([\s\S]*?)<\/a>/g)].map((m) => [m[1], m[2]])
  const markOk = (h) => /^<svg class="mcp-mark"[^>]* aria-hidden="true" focusable="false">/.test(h.trim()) && /<span>[^<]+<\/span>$/.test(h.trim())
  ok('[connect-marks] every tab carries its mark first, aria-hidden, with its text label after it',
     tabs.length === MCP_TAB_IDS.length && tabs.length === 8 && tabs.every(([, h]) => markOk(h)), tabs.filter(([, h]) => !markOk(h)).map(([id]) => id).join(', '))
  const panelsOk = MCP_TAB_IDS.filter((id) => {
    const p = panel(id)
    return /^\s*<div class="mcp-ptop" aria-hidden="true"><svg class="mcp-mark"/.test(p) && /<h2 id="[^"]+"><svg class="mcp-mark"/.test(p)
  })
  ok('[connect-marks] and every panel carries it at its top', panelsOk.length === MCP_TAB_IDS.length, MCP_TAB_IDS.filter((id) => !panelsOk.includes(id)).join(', '))
  const src = readFileSync(`${ROOT}src/ui/connect-marks.ts`, 'utf8')
  const header = src.split('\n').filter((l) => l.startsWith('//')).join('\n')
  const entries = header.split(/\n(?=\/\/ {3}[a-z][a-z-]*(?:,| \(|\n))/).slice(1)
  const recorded = new Map()
  for (const e of entries) {
    const ids = (e.match(/^\/\/ {3}([a-z][a-z, -]*?)(?: \(|\n)/) ?? [])[1]?.split(',').map((s) => s.trim()) ?? []
    const full = /\/\/ +source: +\S/.test(e) && /\/\/ +guideline: +\S/.test(e) && /\/\/ +decision: +\S/.test(e)
    for (const id of ids) recorded.set(id, full)
  }
  const missing = MCP_TAB_IDS.filter((id) => !CONNECT_MARKS[id] || recorded.get(id) !== true)
  const officialUnrecorded = Object.entries(CONNECT_MARKS).filter(([id, m]) => m.kind === 'official' && !/decision: +(use|official)/.test(entries.find((e) => e.includes(`//   ${id}`)) ?? ''))
  ok('[connect-marks] every tab\'s mark has its record in connect-marks.ts: the source looked at, the guideline read, the decision; and an official mark only where the decision says so',
     missing.length === 0 && officialUnrecorded.length === 0 && recorded.size >= MCP_TAB_IDS.length, `missing ${missing.join(',')} official ${officialUnrecorded.map(([i]) => i).join(',')}`)
}
