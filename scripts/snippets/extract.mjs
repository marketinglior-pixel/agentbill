#!/usr/bin/env node
// Inventory every public code sample so CI can prove each one runs against
// the shipped SDKs. Sources: <pre> blocks inside the route template literals
// (what the site serves) and fenced blocks in the READMEs (what PyPI, npm and
// GitHub show). Output: JSON array on stdout.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '../../..')
const ROUTES = join(ROOT, 'src/routes')
const MARKDOWN = ['README.md', 'sdk/python/README.md', 'sdk/node/README.md', 'mcp/README.md']

const rel = (f) => relative(ROOT, f)
const unTemplate = (s) => s.replace(/\\`/g, '`').replace(/\\\\/g, '\\')
const unHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

// Node markers that never appear in Python decide first; a TS block that calls
// client.preflight( must not be read as Python because of that call.
const NODE = /^\s*import \{|^\s*import \w+ from ['"]|^\s*(const|let|var) |=>|^\s*export (const|function|async|class|default)|^\s*(async )?function \w+\(/m
const PY = /^\s*(async )?def |^\s*@\w+(\(|\s*$)|^\s*from \w[\w.]* import |^\s*import \w[\w.]*\s*$|\bclient\.(preflight|record|gate|get_task)\(/m
const SHELL = /^\s*\$?\s*(curl|pip3?|npm|npx|export|brew|cd|python3?|node|git|uv)\b/m

export function detect(code) {
  const c = code.trim()
  if (NODE.test(c)) return 'node'
  if (PY.test(c)) return 'python'
  if (SHELL.test(c)) return 'shell'
  if (/^[\[{]/.test(c) && /[\]}]$/.test(c)) return 'json'
  return 'unknown'
}

function fromRoute(file) {
  const src = readFileSync(file, 'utf8')
  const out = []
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>/g
  let m, i = 0
  while ((m = re.exec(src))) {
    i++
    const raw = m[1]
    const at = src.slice(0, m.index).split('\n').length
    if (/\$\{/.test(raw)) { out.push({ source: rel(file), line: at, index: i, kind: 'dynamic', code: '' }); continue }
    // Rendered output (the ">>>" and error lines) is marked with out-* spans; it is not code.
    const kept = raw.split('\n').filter((l) => !/class="out-/.test(l)).join('\n')
    const code = unHtml(unTemplate(kept.replace(/<[^>]+>/g, ''))).replace(/^\n+/, '').replace(/\s+$/, '')
    if (!code.trim()) { out.push({ source: rel(file), line: at, index: i, kind: 'empty', code: '' }); continue }
    out.push({ source: rel(file), line: at, index: i, kind: detect(code), code })
  }
  return out
}

function fromMarkdown(file) {
  const src = readFileSync(file, 'utf8')
  const out = []
  const re = /^```([\w-]*)[^\n]*\n([\s\S]*?)^```/gm
  let m, i = 0
  while ((m = re.exec(src))) {
    i++
    const at = src.slice(0, m.index).split('\n').length
    const info = m[1].toLowerCase()
    const code = m[2].replace(/\s+$/, '')
    const kind = { python: 'python', py: 'python', typescript: 'node', ts: 'node', javascript: 'node', js: 'node',
      bash: 'shell', sh: 'shell', shell: 'shell', json: 'json', yaml: 'yaml', toml: 'toml', text: 'text' }[info] ?? detect(code)
    out.push({ source: rel(file), line: at, index: i, kind, code })
  }
  return out
}

const inventory = []
for (const f of readdirSync(ROUTES).filter((n) => n.endsWith('.ts')).sort()) inventory.push(...fromRoute(join(ROUTES, f)))
for (const f of MARKDOWN) { try { inventory.push(...fromMarkdown(join(ROOT, f))) } catch { /* optional file */ } }
process.stdout.write(JSON.stringify(inventory, null, 1))
