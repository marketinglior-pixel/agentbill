import type { Dash, Bucket, Ranked } from '../lib/dashboard.js'
import { DASH_RANGES } from '../lib/dashboard.js'
import { usdAmount } from '../lib/task-ceiling.js'

// The dashboard's cards (M2, 2026-09-26), drawn on the server as inline SVG.
// The console ships no script (APP_CSP in src/routes/app.ts), so every chart
// is markup: an area or a line over the window's buckets, a <title> on each
// bucket for the hover, and a donut built from stroke-dasharray. Colours are
// the theme's own roles (--dc-* in DASH_CSS alias theme tokens), never a hex.

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const usd = (n: number) => usdAmount(n)

/** 1.2K, 3.4M: a figure in a small card. */
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`
  return num(n)
}
function dollars(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return usd(n)
}
function latency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

function when(t: string, hourly: boolean): string {
  const d = new Date(t)
  return hourly
    ? String(d.getUTCHours()).padStart(2, '0') + ':00 UTC'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Against the window immediately before it, in neutral ink. */
function delta(now: number | null, prev: number | null, short: string): string {
  if (now == null || prev == null) return ''
  if (prev === 0) return now === 0 ? '' : `<span class="dc-d">new vs prior ${esc(short)}</span>`
  const pct = Math.round(((now - prev) / prev) * 100)
  if (pct === 0) return `<span class="dc-d">flat vs prior ${esc(short)}</span>`
  return `<span class="dc-d">${pct > 0 ? '&uarr;' : '&darr;'} ${Math.abs(pct)}% vs prior ${esc(short)}</span>`
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const W = 600, H = 150

/** Points for a series over the chart box, top padded so the peak is never clipped. */
function pts(vals: number[], max: number): [number, number][] {
  const m = max > 0 ? max : 1
  const step = vals.length > 1 ? W / (vals.length - 1) : W
  return vals.map((v, i) => [Math.round(i * step * 10) / 10, Math.round((H - 6 - (v / m) * (H - 16)) * 10) / 10])
}
const poly = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(' ')

/** The hover layer: one transparent column per bucket with its own <title>. */
function hovers(n: number, titles: string[]): string {
  const w = W / n
  return titles.map((t, i) => `<rect class="dc-hit" x="${Math.round(i * w * 10) / 10}" y="0" width="${Math.ceil(w)}" height="${H}"><title>${esc(t)}</title></rect>`).join('')
}

function grid(): string {
  return [0.25, 0.5, 0.75].map((f) => `<line class="dc-grid" x1="0" x2="${W}" y1="${Math.round(H * f)}" y2="${Math.round(H * f)}"/>`).join('')
}

function areaChart(vals: number[], titles: string[], label: string): string {
  const max = Math.max(...vals, 0)
  const p = pts(vals, max)
  const area = `0,${H} ${poly(p)} ${W},${H}`
  return `<svg class="dc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      ${grid()}<polygon class="dc-area" points="${area}"/><polyline class="dc-line" points="${poly(p)}" vector-effect="non-scaling-stroke"/>
      ${hovers(vals.length, titles)}</svg>`
}

function twoLines(a: number[], b: number[], titles: string[], label: string): string {
  const max = Math.max(...a, ...b, 0)
  return `<svg class="dc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      ${grid()}<polygon class="dc-area" points="0,${H} ${poly(pts(a, max))} ${W},${H}"/><polyline class="dc-line dc-ok" points="${poly(pts(a, max))}" vector-effect="non-scaling-stroke"/>
      <polyline class="dc-line dc-no" points="${poly(pts(b, max))}" vector-effect="non-scaling-stroke"/>
      ${hovers(a.length, titles)}</svg>`
}

function bars(vals: number[], titles: string[], label: string): string {
  const max = Math.max(...vals, 0) || 1
  const w = W / vals.length
  const gap = Math.min(4, w * 0.25)
  return `<svg class="dc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      ${grid()}${vals.map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / max) * (H - 10)) : 0
        return `<rect class="dc-bar" x="${Math.round((i * w + gap / 2) * 10) / 10}" y="${Math.round((H - h) * 10) / 10}" width="${Math.max(1, Math.round((w - gap) * 10) / 10)}" height="${Math.round(h * 10) / 10}"><title>${esc(titles[i])}</title></rect>`
      }).join('')}</svg>`
}

/** A donut of shares, with the total in the hole. Segment order is the legend's. */
function donut(parts: { n: number; cls: string; title: string }[], centre: string, sub: string): string {
  const total = parts.reduce((a, p) => a + p.n, 0)
  const R = 42, C = 2 * Math.PI * R
  let off = 0
  const rings = total > 0 ? parts.filter((p) => p.n > 0).map((p) => {
    const len = (p.n / total) * C
    const s = `<circle class="dc-seg ${p.cls}" r="${R}" cx="60" cy="60" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${esc(p.title)}</title></circle>`
    off += len
    return s
  }).join('') : ''
  return `<div class="dc-donut"><svg viewBox="0 0 120 120" role="img" aria-label="${esc(sub)}">
      <circle class="dc-seg dc-track" r="${R}" cx="60" cy="60"/>${rings}</svg>
      <div class="dc-hole"><b>${centre}</b><span>${esc(sub)}</span></div></div>`
}

function axis(b: Bucket[], hourly: boolean): string {
  if (!b.length) return ''
  return `<div class="dc-axis"><span>${esc(when(b[0].t, hourly))}</span><span>${esc(when(b[b.length - 1].t, hourly))}</span></div>`
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

type Opts = { sample: string; hrefAll: { models?: string; agents: string; customers: string; refusals: string; activity: string } }

function card(title: string, body: string, o: Opts, cls = '', aside = ''): string {
  return `<section class="dc${cls ? ` ${cls}` : ''}"><header class="dc-h"><h3>${title}</h3>${aside}${o.sample}</header>${body}</section>`
}

function board(rows: Ranked[], kind: 'model' | 'agent' | 'customer', priced: boolean): string {
  if (!rows.length) return `<p class="dc-empty">${kind === 'customer'
    ? 'No record in this window carries a customer_id.'
    : kind === 'model' ? 'No record in this window names a model.' : 'Nothing recorded in this window.'}</p>`
  const metric = (r: Ranked) => (priced ? r.usd ?? 0 : r.calls)
  const max = Math.max(...rows.map(metric), 0) || 1
  return `<ol class="dc-board">${rows.map((r) => {
    const v = metric(r)
    const name = r.name ?? (kind === 'model' ? '(no model named)' : '(none)')
    const right = priced ? (r.usd == null ? '<span class="dc-un">unpriced</span>' : dollars(r.usd)) : compact(r.calls)
    const meta = [r.sub ? esc(r.sub) : '', `${compact(r.calls)} calls`, r.refused ? `${num(r.refused)} refused` : ''].filter(Boolean).join(' · ')
    return `<li><span class="dc-fill" style="width:${Math.max(2, Math.round((v / max) * 100))}%"></span>
        <span class="dc-name" title="${esc(name)}">${esc(name)}</span><span class="dc-v">${right}</span><span class="dc-meta">${meta}</span></li>`
  }).join('')}</ol>`
}

const REASON_TEXT: Record<string, string> = {
  task_ceiling_exceeded: 'Job ceiling', ceiling_exceeded: 'Call ceiling', budget_exhausted: 'Customer budget',
  free_tier_exceeded: 'Free tier', plan_limit_exceeded: 'Plan limit', task_overrun_recorded: 'Overrun recorded',
}

/** The dashboard grid, for the overview. `short` is the period in two characters (7D). */
export function dashboardGrid(d: Dash, o: Opts): string {
  const r = DASH_RANGES[d.range]
  const hourly = r.step === 'hour'
  const b = d.buckets
  const t = d.totals
  const priced = t.priced > 0
  const unpricedCalls = t.calls - t.priced

  const costTitles = b.map((x) => `${when(x.t, hourly)} · ${x.priced ? `${usd(x.usd)} est.` : 'no priced call'} · ${num(x.calls)} calls`)
  const cost = card('Cost', `
      <div class="dc-fig"><b>${priced ? dollars(t.usd ?? 0) : '<span class="dc-un">no priced call</span>'}</b>${delta(t.usd, d.prev.usd, r.short)}</div>
      <p class="dc-note">List-price estimate${unpricedCalls > 0 && priced ? `, ${num(unpricedCalls)} unpriced call${unpricedCalls === 1 ? '' : 's'} left out` : ''}.</p>
      ${bars(b.map((x) => x.usd), costTitles, 'Estimated cost per bucket')}${axis(b, hourly)}`, o, 'dc-wide')

  const callTitles = b.map((x) => `${when(x.t, hourly)} · ${num(x.calls)} recorded · ${num(x.refused)} refused`)
  const calls = card('Calls', `
      <div class="dc-fig"><b>${compact(t.calls)}</b>${delta(t.calls, d.prev.calls, r.short)}</div>
      <p class="dc-note"><span class="dc-key dc-ok"></span>recorded <span class="dc-key dc-no"></span>refused</p>
      ${twoLines(b.map((x) => x.calls), b.map((x) => x.refused), callTitles, 'Recorded and refused calls per bucket')}${axis(b, hourly)}`, o, 'dc-wide')

  const reasonParts = d.reasons.map((x, i) => ({ n: x.n, cls: `dc-r${Math.min(i, 3)}`, title: `${REASON_TEXT[x.reason] ?? x.reason}: ${num(x.n)}` }))
  const refusals = card('Refusals', t.refused
    ? `${donut(reasonParts, compact(t.refused), 'refused')}
      <ul class="dc-legend">${d.reasons.map((x, i) => `<li><span class="dc-key dc-r${Math.min(i, 3)}"></span>${esc(REASON_TEXT[x.reason] ?? x.reason)}<b>${num(x.n)}</b></li>`).join('')}</ul>
      ${t.leaks ? `<p class="dc-note dc-leak">${num(t.leaks)} ran past a ceiling after approval.</p>` : ''}`
    : `<p class="dc-empty">Nothing refused in this window.</p>`, o, '', `<a class="dc-all" href="${o.hrefAll.refusals}">All &rarr;</a>`)

  const models = card('Top models', board(d.models, 'model', priced), o)
  const agents = card('Top agents', board(d.agents, 'agent', priced), o, '', `<a class="dc-all" href="${o.hrefAll.agents}">All &rarr;</a>`)
  const customers = card('Top customers', board(d.customers, 'customer', priced), o, '', `<a class="dc-all" href="${o.hrefAll.customers}">All &rarr;</a>`)

  const tokTitles = b.map((x) => `${when(x.t, hourly)} · ${num(x.tokens)} tokens`)
  const tokens = card('Tokens', `
      <div class="dc-fig"><b>${compact(t.tokensIn + t.tokensOut)}</b></div>
      <p class="dc-note">${compact(t.tokensIn)} in · ${compact(t.tokensOut)} out, as providers reported them.</p>
      ${areaChart(b.map((x) => x.tokens), tokTitles, 'Tokens per bucket')}${axis(b, hourly)}`, o)

  const latVals = b.map((x) => x.latMs ?? 0)
  const latTitles = b.map((x) => `${when(x.t, hourly)} · ${x.latMs == null ? 'no timed call' : latency(x.latMs) + ' / call'}`)
  const lat = card('Latency', t.latMs == null
    ? `<p class="dc-empty">No record in this window carries duration_ms. wrap() records it for every call.</p>`
    : `<div class="dc-fig"><b>${latency(t.latMs)}</b><span class="dc-d">per call</span></div>
      <p class="dc-note">Mean over ${compact(t.latCalls)} timed call${t.latCalls === 1 ? '' : 's'}.</p>
      ${areaChart(latVals, latTitles, 'Mean latency per bucket')}${axis(b, hourly)}`, o, 'dc-full')

  return `<div class="dash">${cost}${refusals}${calls}${models}${agents}${customers}${tokens}${lat}</div>`
}

/** The overview's own period control: 24H 7D 1M 3M. */
export function dashRangeControl(current: string, hrefFor: (k: string) => string): string {
  return `<span class="cv-seg" aria-label="Period">${Object.entries(DASH_RANGES).map(([k, r]) =>
    `<a href="${hrefFor(k)}" title="${esc(r.label)}"${k === current ? ' aria-current="true"' : ''}>${r.short}</a>`).join('')}</span>`
}

export const DASH_CSS = `
  :root { --dc-ink: var(--text); --dc-area: var(--surface3); --dc-flow: var(--flow); --dc-no: var(--signal);
          --dc-grid: var(--border-soft); --dc-fill: var(--surface2); --dc-r1: var(--amber); --dc-r2: var(--flow); --dc-r3: var(--border2); }
  .dash { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s4); margin: var(--s5) 0 var(--s6); }
  .dc { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner); padding: var(--s4) var(--s4) var(--s3); min-width: 0; }
  .dc-wide { grid-column: span 2; }
  .dc-full { grid-column: 1 / -1; }
  .dc-h { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s2); }
  .dc-h h3 { font: 500 var(--fs-small)/1.2 var(--sans); color: var(--muted); margin: 0; flex: 1; letter-spacing: 0; }
  .dc-all { font-size: var(--fs-micro); color: var(--muted); text-decoration: none; }
  .dc-all:hover { color: var(--text); }
  .dc-fig { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
  .dc-fig b { font: 500 30px/1.1 var(--display); color: var(--text); letter-spacing: -0.01em; }
  .dc-d { font-size: var(--fs-micro); color: var(--muted); }
  .dc-note { font-size: var(--fs-micro); color: var(--dim); margin: 4px 0 var(--s2); }
  .dc-un { font: 400 var(--fs-small) var(--sans); color: var(--dim); }
  .dc-svg { display: block; width: 100%; height: 150px; overflow: visible; }
  .dc-grid { stroke: var(--dc-grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .dc-area { fill: var(--dc-area); }
  .dc-line { fill: none; stroke: var(--dc-ink); stroke-width: 2; stroke-linejoin: round; }
  .dc-line.dc-ok { stroke: var(--dc-ink); }
  .dc-line.dc-no { stroke: var(--dc-no); }
  .dc-bar { fill: var(--dc-ink); }
  .dc-bar:hover, .dc-hit:hover { fill-opacity: .7; }
  .dc-hit { fill: transparent; }
  .dc-axis { display: flex; justify-content: space-between; font: 400 var(--fs-tick) var(--mono); color: var(--dim); margin-top: 6px; }
  .dc-key { display: inline-block; width: 10px; height: 3px; border-radius: 2px; vertical-align: middle; margin: 0 4px 0 8px; background: var(--dc-ink); }
  .dc-key:first-child { margin-left: 0; }
  .dc-key.dc-no, .dc-key.dc-r0 { background: var(--dc-no); } .dc-key.dc-r1 { background: var(--dc-r1); }
  .dc-key.dc-r2 { background: var(--dc-r2); } .dc-key.dc-r3 { background: var(--dc-r3); }
  .dc-donut { position: relative; width: 150px; height: 150px; margin: var(--s2) auto var(--s3); }
  .dc-donut svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .dc-seg { fill: none; stroke-width: 14; }
  .dc-track { stroke: var(--surface3); }
  .dc-r0 { stroke: var(--dc-no); } .dc-r1 { stroke: var(--dc-r1); } .dc-r2 { stroke: var(--dc-r2); } .dc-r3 { stroke: var(--dc-r3); }
  .dc-hole { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .dc-hole b { font: 500 26px/1 var(--display); color: var(--text); }
  .dc-hole span { font-size: var(--fs-micro); color: var(--dim); margin-top: 4px; }
  .dc-legend { list-style: none; padding: 0; margin: 0; font-size: var(--fs-micro); color: var(--muted); }
  .dc-legend li { display: flex; align-items: center; padding: 3px 0; }
  .dc-legend li .dc-key { margin-left: 0; }
  .dc-legend b { margin-left: auto; font-weight: 500; color: var(--text); }
  .dc-leak { color: var(--signal); }
  .dc-board { list-style: none; padding: 0; margin: 0; }
  .dc-board li { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 var(--s2); padding: 7px 10px; margin-bottom: 4px; border-radius: var(--r-row); overflow: hidden; }
  .dc-fill { position: absolute; inset: 0 auto 0 0; background: var(--dc-fill); border-radius: var(--r-row); z-index: 0; }
  .dc-name, .dc-v, .dc-meta { position: relative; z-index: 1; }
  .dc-name { font: 500 var(--fs-small)/1.3 var(--mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dc-v { font: 500 var(--fs-small)/1.3 var(--sans); color: var(--text); text-align: right; }
  .dc-meta { grid-column: 1 / -1; font-size: var(--fs-micro); color: var(--dim); }
  .dc-empty { font-size: var(--fs-small); color: var(--dim); margin: var(--s4) 0; }
  @media (max-width: 1100px) { .dash { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 720px) { .dash { grid-template-columns: minmax(0, 1fr); } .dc-wide, .dc-full { grid-column: auto; } }
`
