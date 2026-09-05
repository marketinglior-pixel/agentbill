// A one-way valve on design drift. Fails when a count rises above the baseline.
//
// Not a ban: the 149 hardcoded font sizes and the 49 raw hexes that exist today
// are allowed to stay until the block they live in is rewritten for another
// reason. What is not allowed is adding to them. Without this, every commit in
// a redesign quietly grows the number the redesign exists to shrink.
import { readFileSync, writeFileSync } from 'node:fs'
import { count } from './count.mjs'

const BASELINE = new URL('./baseline.json', import.meta.url)
const now = count()

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify({ sizes: now.sizes, hexes: now.hexes }, null, 2) + '\n')
  console.log(`baseline written: ${now.sizes} font-size literals, ${now.hexes} raw hexes`)
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
let bad = false
for (const k of ['sizes', 'hexes']) {
  const label = k === 'sizes' ? 'hardcoded font-size literals' : 'raw hexes outside :root'
  if (now[k] > base[k]) {
    console.error(`FAIL  ${label}: ${now[k]}, baseline ${base[k]} (+${now[k] - base[k]})`)
    bad = true
  } else if (now[k] < base[k]) {
    console.log(`ok    ${label}: ${now[k]}, down from ${base[k]}. Lower the baseline: npm run check:ratchet -- --write`)
  } else {
    console.log(`ok    ${label}: ${now[k]}`)
  }
}
if (bad) {
  console.error('\nPer file:')
  for (const [f, v] of Object.entries(now.per)) console.error(`  ${String(v.sizes).padStart(4)} ${String(v.hexes).padStart(4)}  ${f}`)
  console.error('\nUse the tokens in src/ui/theme.ts. If a value genuinely has no token,')
  console.error('add one there rather than raising this baseline.')
  process.exit(1)
}
