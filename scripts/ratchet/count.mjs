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
        // (?<!&) excludes HTML numeric entities: &#10005; is a multiplication
        // sign, not a colour, and counting it made playground.ts read as one
        // hex over its real zero.
        const hex = line.match(/(?<!&)#[0-9a-fA-F]{3,8}\b/g) || []
        if (!inRoot) h += hex.length
        if (inRoot) {
          depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
          // No `!entering` guard: a :root { } that opens and closes on one line
          // reaches depth 0 on that line, and the guard kept inRoot true for
          // the line after it, exempting whatever hex followed.
          if (depth <= 0) inRoot = false
        }
      }
    }
    if (s || h) per[f] = { sizes: s, hexes: h }
    sizes += s; hexes += h
  }
  return { sizes, hexes, per }
}
