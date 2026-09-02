#!/usr/bin/env node
// Prove every published Node/TypeScript sample compiles against the shipped
// SDK's types (wrong option keys, missing exports and a top-level `return` fail
// here) and, when a block imports nothing but agentbill, that it runs with the
// SDK's own HTTP client stubbed so nothing can reach the network. Also polices
// install lines in shell blocks.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const [inventoryArg, mode = 'repo'] = process.argv.slice(2)
// The inventory is produced by extract.mjs from tracked repo files and must
// live inside this harness's work dir; nothing else is accepted as input.
const inventoryPath = resolve(inventoryArg ?? '')
if (!inventoryPath.startsWith(join(HERE, '.work') + sep)) {
  console.error(`refusing inventory outside ${join(HERE, '.work')}: ${inventoryPath}`); process.exit(2)
}
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
const WORK = join(HERE, '.work/node')
mkdirSync(WORK, { recursive: true })
const ts = createRequire(join(ROOT, 'package.json'))('typescript')

const failures = [], warnings = []
const where = (s) => `${s.source}:${s.line} (block ${s.index})`

// ---------------------------------------------------------------- shell
for (const s of inventory.filter((x) => x.kind === 'shell')) {
  for (const line of s.code.split('\n')) {
    if (/\bpip3?\s+install\s+(?:-\S+\s+)*["']?agentbill(?![-_a-z])/.test(line))
      failures.push(`${where(s)} \`${line.trim()}\` installs an unrelated PyPI package; the SDK is agentbill-sdk`)
    if (/\bnpm\s+(i|install)\s+@?agentbill[-/]/.test(line))
      failures.push(`${where(s)} \`${line.trim()}\` the npm package is plain \`agentbill\``)
  }
}

// ---------------------------------------------------------------- typecheck
const nodeBlocks = inventory.filter((x) => x.kind === 'node')
const files = []
nodeBlocks.forEach((s, n) => {
  // Each block is typechecked and run as an ES module of its own: top-level
  // await is legal there, and a top-level `return` (the README bug this
  // harness exists for) is TS1108 instead of being hidden by a wrapper.
  const f = join(WORK, `snippet_${n}.ts`)
  writeFileSync(f, `// ${where(s)}\nexport {}\n${s.code}\n`)
  const sf = ts.createSourceFile(f, s.code, ts.ScriptTarget.Latest, true)
  const external = sf.statements.filter(ts.isImportDeclaration).map((d) => d.moduleSpecifier.text)
  files.push({ s, f, external })
})
// Third-party modules the docs mention but the harness does not install.
writeFileSync(join(WORK, 'stubs.d.ts'), `declare module '@langchain/*';\ndeclare module 'langchain*';\ndeclare module 'openai';\ndeclare module 'anthropic';\ndeclare module '@anthropic-ai/*';\n`)
const tsconfig = {
  compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM'],
    strict: false, noEmit: true, skipLibCheck: true, esModuleInterop: true, allowJs: true,
    types: ['node'], typeRoots: [join(ROOT, 'node_modules/@types')],
  },
  include: ['*.ts'],
}
writeFileSync(join(WORK, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))

// Names the SDK exports: a TS2304 on one of these is a missing import, not a fragment.
const sdkPkg = JSON.parse(readFileSync(join(WORK, 'node_modules/agentbill/package.json'), 'utf8'))
const sdkDts = readFileSync(join(WORK, 'node_modules/agentbill', sdkPkg.types ?? 'dist/index.d.ts'), 'utf8')
const sdkNames = new Set([...sdkDts.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm)].map((m) => m[1]))
const fragments = new Set(), broken = new Set()
if (files.length) {
  const tsc = spawnSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', WORK, '--pretty', 'false'], { encoding: 'utf8' })
  const byFile = new Map(); let parsed = 0
  for (const line of ((tsc.stdout ?? '') + (tsc.stderr ?? '')).split('\n')) {
    const m = line.match(/^(.*?snippet_(\d+)\.ts)\((\d+),\d+\): error (TS\d+): (.*)$/)
    if (m) { parsed++; const n = Number(m[2]); const arr = byFile.get(n) ?? []; arr.push(`${m[4]} ${m[5]}`); byFile.set(n, arr); continue }
    // A diagnostic with no snippet file (missing @types/node, a bad tsconfig, stubs.d.ts)
    // suppresses every semantic error in the program, so it is a failure, not silence.
    if (/^(?:\S.*\(\d+,\d+\): )?error TS\d+/.test(line)) { parsed++; failures.push(`typecheck: ${line.trim()}`) }
  }
  if (tsc.status !== 0 && parsed === 0) failures.push(`typecheck: tsc exited ${tsc.status} without diagnostics: ${(tsc.stderr || tsc.stdout || '').trim().slice(0, 300)}`)
  files.forEach(({ s }, n) => {
    for (const e of byFile.get(n) ?? []) {
      const name = e.match(/^TS2304 Cannot find name '([^']+)'/)?.[1]
      // A name the block never defines (run_agent-style stand-ins) is a fragment:
      // warn, like the Python checker. An SDK export the block forgot to import
      // is a ReferenceError for the reader: fail. Everything else fails.
      if (name && !sdkNames.has(name)) { fragments.add(n); warnings.push(`${where(s)} fragment: ${e.replace(/^TS2304 /, '')}`) }
      else { broken.add(n); failures.push(`${where(s)} ${e}`) }
    }
  })
}

// ---------------------------------------------------------------- execute
const stub = join(WORK, 'fetch-stub.mjs')
writeFileSync(stub, `
import { createRequire } from 'node:module'
// The SDK fetches through its own undici (apiFetch: import('undici')), not
// globalThis.fetch, so the stub is a MockAgent on that very instance. Anything
// it does not intercept throws instead of reaching the network.
const { MockAgent, setGlobalDispatcher } = createRequire(${JSON.stringify(join(WORK, 'node_modules/agentbill/package.json'))})('undici')
const canned = (path) => {
  if (path.startsWith('/preflight')) return { approved: true, reason: null, estimated_units: 1, remaining_units: 999, task_ref: 'job-142', task_remaining_units: 488 }
  if (path.startsWith('/events')) return { event_id: 'evt_ci', status: 'recorded', customer_created: false, customer_remaining_units: 999, task_used_units: 12, task_remaining_units: 488, task_exceeded: false }
  if (path.startsWith('/tasks')) return { task_ref: 'job-142', agent_id: 'researcher', ceiling_units: 500, used_units: 12, reserved_units: 0, remaining_units: 488, exceeded: false }
  if (path.startsWith('/budget')) return { customer_id: 'default', limit: 1000, used: 1, remaining: 999, is_blocked: false }
  return { ok: true }
}
// Not a WHATWG bad port: 127.0.0.1:9 fails as "bad port" before the dispatcher is consulted.
const BASE = 'http://agentbill.invalid'
process.env.AGENTBILL_BASE_URL = BASE
process.env.AGENTBILL_API_KEY = 'agb_ci_stub'
const agent = new MockAgent()
agent.disableNetConnect()
setGlobalDispatcher(agent)
agent.get(BASE).intercept({ path: /.*/, method: /.*/ })
  .reply(200, (req) => JSON.stringify(canned(req.path)), { headers: { 'content-type': 'application/json' } })
  .persist()
`)
files.forEach(({ s, f, external }, n) => {
  if (broken.has(n) || fragments.has(n)) return   // already red, or a fragment: typechecked only
  const third = external.filter((m) => m !== 'agentbill' && !m.startsWith('node:'))
  if (third.length) { warnings.push(`${where(s)} imports ${third.join(', ')}; typechecked only`); return }
  // .mts: ESM no matter what package.json is nearest (published mode drops a CommonJS one there)
  const runner = f.replace(/\.ts$/, '.run.mts')
  copyFileSync(f, runner)
  const r = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['--import', stub, runner], { encoding: 'utf8', cwd: WORK, timeout: 30000 })
  if (r.status !== 0) {
    const lines = (r.stderr || r.stdout || '').split('\n').filter(Boolean)
    const err = (lines.find((l) => /^\s*[A-Za-z]*(Error|Exception)\b/.test(l)) ?? (r.signal ? `killed by ${r.signal} after 30s` : lines.slice(-3).join(' | '))).trim()
    if (/^(TaskCeilingExceededError|BudgetExhaustedError):/.test(err)) return // the SDK refused on purpose
    failures.push(`${where(s)} execution: ${err}`)
  }
})

console.log(`node: ${nodeBlocks.length} blocks typechecked, ${failures.length} failures, ${warnings.length} warnings`)
for (const w of warnings) console.log('  warn:', w)
for (const f of failures) console.log('  FAIL:', f)
process.exit(failures.length ? 1 : 0)
