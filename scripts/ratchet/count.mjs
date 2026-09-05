// Counts the two kinds of drift design.md forbids but nothing enforced.
//
//   sizes  a literal `font-size: <n>px` outside src/ui/theme.ts, where the
//          scale is defined. There were 152 of these against 14 uses of the
//          scale, in twelve distinct values between 10 and 15.5px.
//   hexes  a raw #rrggbb in CSS outside a `:root { ... }` block. design.md
//          allows a page-local :root and forbids hex anywhere below it.
//
// This is a ratchet, not a ban. It fails only when a count RISES above the
// checked-in baseline, so existing values can stay until their block is
// rewritten for another reason, and no new ones can be added quietly.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SIZE_EXEMPT = new Set(['src/ui/theme.ts'])   // the scale itself
const HEX_EXEMPT = new Set(['src/ui/theme.ts', 'src/ui/mark.ts', 'src/lib/icons.ts'])

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

export function count(root = 'src') {
  const per = {}
  let sizes = 0, hexes = 0
  for (const f of walk(root).sort()) {
    const src = readFileSync(f, 'utf8')
    let s = 0, h = 0
    if (!SIZE_EXEMPT.has(f)) s = (src.match(/font-size:\s*\d/g) || []).length
    if (!HEX_EXEMPT.has(f)) {
      // a raw hex counts only outside a :root block
      let depth = 0, inRoot = false
      for (const line of src.split('\n')) {
        const entering = /:root\s*\{/.test(line)
        if (entering) { inRoot = true; depth = 0 }
        if (!inRoot && /#[0-9a-fA-F]{3,8}\b/.test(line)) {
          h += (line.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length
        }
        if (inRoot) {
          depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
          if (depth <= 0 && !entering) inRoot = false
        }
      }
    }
    if (s || h) per[f] = { sizes: s, hexes: h }
    sizes += s; hexes += h
  }
  return { sizes, hexes, per }
}
