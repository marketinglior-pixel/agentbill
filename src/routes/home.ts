import { HEADLINE, INSTALL_PY, ORIGIN } from '../ui/site.js'
import { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS, KEY_CTA } from '../ui/chrome.js'
import { PLAYGROUND_CSS, PLAYGROUND_JS, PLAYGROUND_HASH, playgroundSection, REFUSAL, heroRefusalBody } from '../ui/playground.js'
import { pixelSnippet } from '../lib/pixel.js'
import { demoConsole, decisionLine } from './app.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { PANEL_CSS, requestPanel, KEY_COMMANDS } from '../ui/panels.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from '../ui/copy.js'
import { TABS_CSS, TABS_JS, TABS_HASH, langTabs } from '../ui/tabs.js'
import { TIERS_CSS, tierCards, SAME_FEATURES } from '../ui/tiers.js'
import { publicRoute } from '../middleware/auth.js'
import { softwareLd } from '../ui/ld.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

// The page is a Split Studio: every claim below the fold sits beside a panel
// that shows the product doing the thing the claim describes. The panels are
// not mockups. They render the same sample rows the demo console renders,
// through the same rule the console applies, so the homepage cannot show a
// number the console would disagree with. Where a panel is sample data it
// says so inside its own frame, so a screenshot carries the label with it.
//
// Restructured 2026-09-09 for scan speed, measured against a stopwatch and
// not against taste: problem, demo, benefits, pricing, close, in that order,
// and each stop is a short head beside a product surface rather than an
// argument. The hero says what the product is in one line and how it works
// in one sentence; the playground sits directly under it as the page's one
// full-bleed band; the provider-cap argument is three sourced cards instead
// of an essay; each benefit row is an eyebrow, a head, two sentences and a
// panel; the tiers are the same four cards /pricing renders; and the list of
// what the product does not do is kept, compressed to one line per item.
// Nothing here is a logo wall, a count or a testimonial: there is nobody to
// name yet, and design.md records why the install line stands in that slot.

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => n.toLocaleString('en-US')

/** Task budgets burning down: the first three rows of the demo console. */
function taskPanel(): string {
  const rows = demoConsole().tasks.slice(0, 3).map((t) => {
    // Same two tests the console applies in app.ts: the chip reads the settled
    // number, the bar colour reads settled plus in-flight. Keep them identical.
    const ratio = (t.usedUnits + t.reservedUnits) / t.ceilingUnits
    const leaked = t.usedUnits > t.ceilingUnits
    const held = t.usedUnits >= t.ceilingUnits
    const chip = leaked
      ? '<span class="chip fail">leaked</span>'
      : held
        ? '<span class="chip held">ceiling hit</span>'
        : ratio >= 0.8 ? '<span class="chip near">close</span>' : '<span class="chip flow">running</span>'
    const barCls = leaked ? ' fail' : ratio >= 1 ? ' held' : ratio >= 0.8 ? ' near' : ''
    const usedPct = Math.min(100, (t.usedUnits / t.ceilingUnits) * 100)
    const resPct = Math.min(100 - usedPct, (t.reservedUnits / t.ceilingUnits) * 100)
    return `
        <div class="task">
          <div class="task-top">
            <span class="ref">${esc(t.taskRef)}</span>
            <span class="agent">${esc(t.agentId)}</span>
            ${chip}
          </div>
          <div class="track" aria-hidden="true">
            <i class="used${barCls}" style="width:${usedPct.toFixed(1)}%"></i>
            <i class="res" style="width:${resPct.toFixed(1)}%"></i>
          </div>
          <div class="task-nums"><b>${num(t.usedUnits)}</b> / ${num(t.ceilingUnits)} units${
            t.reservedUnits ? ` <span class="dimtxt">&middot; ${num(t.reservedUnits)} reserved</span>` : ''}</div>
        </div>`
  }).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Task budgets</span><span>one job, many calls, one ceiling</span></div>
        ${rows}
        <div class="panel-f">Sample rows, the same ones the demo console shows. Units are an integer you define.</div>
      </div>`
}

/**
 * Three refusals from three agents. The sentence on each row is composed by
 * the console's own decisionLine() from the columns the refusal carries, so
 * this panel and the console's refusals view read the same words.
 */
function refusalPanel(): string {
  const rows = demoConsole().decisions.filter((d) => d.blocked && d.taskRef).slice(0, 3).map((d) => `
        <div class="ref-row">
          <div class="ref-top">
            <span class="agent">${esc(d.agentId ?? '')}</span>
            <span class="ref">${esc(d.taskRef ?? '')}</span>
            <span class="chip held">refused</span>
            <span class="ask">asked ${num(d.estimatedUnits ?? 0)}</span>
          </div>
          <div class="ref-msg">${esc(decisionLine(d))}</div>
        </div>`).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Refusals</span><span>what the agent got back</span></div>
        ${rows}
        <div class="panel-f">Sample rows. Three agents, three tasks, one rule. "Asked" is units, not a dollar figure.</div>
      </div>`
}

/**
 * The key lifecycle: the two sample keys the console lists, in the status
 * vocabulary keys.ts computes, and the three endpoints that move a key
 * through it. Statuses are re-derived here from the same fields keys.ts reads
 * (revoked_at, expires_at); the sample holds two active keys, one with an
 * expiry, and the panel says so rather than inventing a revoked one.
 */
function keysPanel(): string {
  const now = Date.now()
  const rows = demoConsole().keys.map((k) => {
    const days = k.expiresAt ? Math.round((k.expiresAt.getTime() - now) / 86_400_000) : null
    const status = k.revokedAt ? 'revoked' : days != null && days <= 0 ? 'expired' : 'active'
    return `
        <div class="key">
          <div class="key-top">
            <span class="ref">${esc(k.label ?? 'key')}</span>
            <span class="agent">${esc(k.apiKey.slice(0, 12))}&hellip;</span>
            <span class="chip ${status === 'active' ? 'flow' : 'fail'}">${status}</span>
          </div>
          <div class="key-meta">${days != null ? `expires in ${num(days)}d` : 'no expiry'}
            <span class="dimtxt">&middot; last seen from ${esc(k.lastSeenIp ?? 'nowhere yet')}</span></div>
        </div>`
  }).join('')
  const cmds = KEY_COMMANDS.map(([ep, what]) => `
        <div class="cmd"><b>${esc(ep)}</b><span>${esc(what)}</span></div>`).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Keys</span><span>revoke, rotate, expire</span></div>
        ${rows}
        <div class="cmds">${cmds}
        </div>
        <div class="panel-f">Sample keys, the same ones the demo console lists. Neither authenticates anything.</div>
      </div>`
}

/**
 * The console's overview, reduced: three tiles summed over the same thirty
 * day series the console draws, the refusals by day under them, and every
 * customer by share of spend. The tiles are sums over the series, never
 * typed, so this panel and the console cannot disagree; the window is named
 * in each label, the way the console names it.
 */
function consolePanel(): string {
  const d = demoConsole()
  const blocked = d.series.reduce((a, x) => a + x.blocks, 0)
  const refused = d.series.reduce((a, x) => a + x.refused, 0)
  const avgAsk = blocked ? Math.round(refused / blocked) : 0
  const max = Math.max(1, ...d.series.map((s) => s.blocks))
  const bars = d.series.map((s) => s.blocks > 0
    ? `<i style="height:${Math.max(6, Math.round((s.blocks / max) * 100))}%"></i>`
    : '<i class="zero"></i>').join('')
  const total = d.customerTotal
  const customers = [...d.customers].sort((a, b) => b.usedUnits - a.usedUnits).map((c) => {
    const share = total > 0 ? Math.round((c.usedUnits / total) * 100) : 0
    const atLimit = c.limitUnits != null && c.usedUnits >= c.limitUnits
    return `
          <div class="cust">
            <span class="ref">${esc(c.customerRef)}</span>
            <span class="cust-n">${num(c.usedUnits)}<span class="dimtxt"> units</span></span>
            <span class="sbar" aria-hidden="true"><i class="${atLimit ? 'held' : ''}" style="width:${Math.max(2, share)}%"></i></span>
            <span class="cust-s">${share}%</span>
          </div>`
  }).join('')
  return `<div class="panel con">
        <div class="panel-h"><span>Console &middot; overview</span><span>sample account, last 30 days</span></div>
        <div class="con-grid">
          <div class="con-l">
            <div class="tiles">
              <div class="tile">
                <div class="tile-l">Refused &middot; 30d</div>
                <div class="tile-v held">${num(blocked)}</div>
                <div class="tile-f">calls that never ran</div>
              </div>
              <div class="tile">
                <div class="tile-l">Units refused &middot; 30d</div>
                <div class="tile-v">${num(refused)}</div>
                <div class="tile-f">${num(avgAsk)} units per refused call</div>
              </div>
              <div class="tile">
                <div class="tile-l">Live tasks &middot; now</div>
                <div class="tile-v">${num(d.taskLive)}</div>
                <div class="tile-f">${d.taskNear ? `${num(d.taskNear)} within a fifth of the ceiling` : 'all under their ceilings'}</div>
              </div>
            </div>
            <div class="tile-l">Refused, by day &middot; 30d</div>
            <div class="spark" aria-hidden="true">${bars}</div>
          </div>
          <div class="con-r">
            <div class="tile-l">Customers by share of spend &middot; all time</div>
            ${customers}
            <div class="con-note">${num(d.overruns)} call recorded past a ceiling, kept as a leak. The one number here that should be zero.</div>
          </div>
        </div>
        <div class="panel-f">Sample account, the same rows the demo console shows. Refused is calls; units refused is what they asked for, not a dollar figure.</div>
      </div>`
}

/**
 * The answer under the hero's code frame: the body POST /preflight sends when
 * the sample's own call is refused, painted the way the playground paints a
 * response. The object comes from playground.ts, which owns the run's numbers.
 */
function heroAnswer(): string {
  const body = heroRefusalBody()
  const fields = Object.entries(body).map(([k, v]) => {
    const val = v === false
      ? '<span class="f">false</span>'
      : typeof v === 'string' ? `<span class="s">"${esc(v)}"</span>` : `<span class="n">${esc(String(v))}</span>`
    return `<span class="k">"${k}"</span>: ${val}`
  })
  return `{ ${fields.join(', ')} }`
}

/**
 * The provider-cap argument, as evidence rather than prose. Three sources,
 * each read at the URL beside it on 2026-09-07. The claim on the page is only
 * what each ceiling is BOUND to; nothing here says a provider lacks a cap,
 * because the first card is a provider's cap firing.
 */
function sourceCards(): string {
  return `<div class="src-grid">
        <div class="src">
          <span class="src-l">OpenAI &middot; spend limits</span>
          <p>A hard limit answers <b class="mono-in">429 project_spend_limit_exceeded</b>, and enforcement
          &ldquo;is not instantaneous, so recorded spend can slightly exceed the configured amount.&rdquo;
          The boundary is the project or the organization.</p>
          <a href="https://developers.openai.com/api/docs/guides/spend-limits" rel="nofollow noopener">developers.openai.com</a>
        </div>
        <div class="src">
          <span class="src-l">Anthropic &middot; rate limits</span>
          <p>A tier spend cap pauses API usage &ldquo;until 00:00 UTC on the first day of the next month.&rdquo;
          The boundary is the organization, and the clock is the calendar.</p>
          <a href="https://platform.claude.com/docs/en/api/rate-limits" rel="nofollow noopener">platform.claude.com</a>
        </div>
        <div class="src">
          <span class="src-l">claude-code &middot; issue 64744, open</span>
          <p>Enterprise plan, <b>$3,000/month limit</b>: &ldquo;~$300 of unintended API usage over a single
          weekend with no way to detect or stop it from the CLI.&rdquo; The limit is a month. The incident
          was a weekend.</p>
          <a href="https://github.com/anthropics/claude-code/issues/64744" rel="nofollow noopener">github.com</a>
        </div>
      </div>`
}

export async function homeRoute(app: FastifyInstance) {
  app.get('/', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: `AgentBill · ${HEADLINE}`,
      description: 'A ceiling on this job, not on the month. Preflight says no when this job is out of the units you define. Your code decides what next. Free tier, API key in 30 seconds, no card.',
      path: '/',
      og: {
        description: 'A ceiling on this job, not on the month. Preflight says no when this job is out of units. Your code decides what next.',
      },
      // The product entity lives in ui/ld.ts and is emitted identically here
      // and on /pricing under one @id. It used to be typed in both files and
      // the two copies had already drifted apart.
      jsonLd: softwareLd(),
      mainEntity: `${ORIGIN}/#software`,
      // meta keywords has been ignored by every major engine since 2009. It was
      // 300 bytes on the most-fetched page of the site.
      extraHead: pixelSnippet(),
      scriptHashes: [PLAYGROUND_HASH, COPY_HASH, TABS_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PLAYGROUND_CSS}${PANEL_CSS}${COPY_CSS}${TABS_CSS}${TIERS_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio
     * theme: design.md (paper, type and accent are theme.ts) · design-system: design.md · designed-as-app
     * nav: N1b, unchanged · footer: Ft2, unchanged · enrichment: none, real product panels
     * order: hero, playground band, three sourced cards, five rows (the fifth wide), four tier cards,
     *        the not-list, the close · one grid break, the playground band
     * pre-emit critique: P5 H5 E4 S5 R5 V4 */

    :root { --shell: 1080px;
            /* Page-local: the playground band's ground and the code-comment ink.
               The console colours the panels use (--flow, --res, the chip
               grounds) live in theme.ts, one copy for every page. */
            --band-hi: #121212; --band-lo: #0c0c0c;
            --cmt: #79837c; }

    /* .wrap owns the inline axis; every block-axis rule below uses padding-block,
       so neither can wipe the other via the padding shorthand. */
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }
    h1, h2, h3 { overflow-wrap: anywhere; min-width: 0; }

    /* The label over a section or a row. Tracked mono, the same register as a
       panel's label bar, so the eye reads it as a tag and not as a sentence. */
    .eyebrow { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .14em;
               text-transform: uppercase; color: var(--dim); margin-bottom: var(--s3); }

    /* An identifier inside prose. The mono face is the third register in the
       system and it is what makes task_ref read as a thing in the code rather
       than as a word in a sentence. No chip ground: this is body copy. */
    .mono-in { font-family: var(--mono); font-size: .92em; color: var(--text); font-weight: 500; }

    /* Hero: a diptych. One line of what it is and one sentence of how it works
       on the left, the whole integration on the right. Centred against each
       other because this is one row, not a sibling of other rows; the diptychs
       below align start, per design.md. */
    .hero { padding-block: var(--s8) var(--s8); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: var(--gap); align-items: center; }
    h1 { color: var(--white); max-width: 15ch; }
    .sub { font-size: var(--fs-lede); color: var(--muted); margin: var(--s5) 0 var(--s6); max-width: 42ch; line-height: 1.55; }
    .hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    /* The hero pair runs one size up from the site's buttons. The ghost gives
       back the pixel its border adds so the two sit at one height. */
    .btn-lg { padding: 14px 26px; font-size: var(--fs-body); border-radius: 10px; }
    .btn-ghost.btn-lg { padding: 13px 25px; }
    .hero-install { margin-top: var(--s5); }
    .trust { margin-top: 18px; font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
             display: flex; flex-wrap: wrap; gap: 0 var(--s3); }
    .trust > span:not(:last-child)::after { content: "\\00b7"; margin-left: var(--s3); color: var(--border2); }
    .trust b { color: var(--muted); font-weight: 500; }

    /* The code frame. Its label bar carries the language tabs on the left and
       the caption on the right; the bar keeps the 44px floor every control on
       the site clears, and the selected tab is a bar on the hairline, the same
       device the nav uses for the current page.
       The answer sits OUTSIDE the code element on purpose: the snippet harness
       executes every one of those against the SDKs, and an interpolation inside
       one marks the whole block dynamic and silently drops it from CI. Never
       write that tag's name in a comment in this file: the extractor scans for
       it and would run from the comment to the real closing tag. */
    .code-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-frame);
                  border-top-color: var(--border2); overflow: hidden; min-width: 0; box-shadow: var(--edge), var(--lift); }
    .code-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s4);
                 padding: 0 var(--s4); min-height: 44px; border-bottom: 1px solid var(--border); background: var(--surface2);
                 box-shadow: var(--edge);
                 font-family: var(--mono); font-size: var(--fs-label); letter-spacing: 1.1px; color: var(--dim); }
    .code-head > span { white-space: nowrap; }
    .code-body { padding: 20px 24px; overflow-x: auto; }
    .code-body pre { font-family: var(--mono); font-size: var(--fs-small); color: var(--code-ink); line-height: 1.7; }
    .cmt { color: var(--cmt); }
    .out-dim { color: var(--dim); }
    /* The answer: the wire body the sample's call gets back on the run where
       8 units remain, then the exception the SDK raises from it. Body first,
       because the body is what is checkable against POST /preflight. */
    .code-out { border-top: 1px solid var(--border); padding: 14px 20px 16px; background: var(--bg-deep);
                font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.65; }
    .co-l { display: flex; justify-content: space-between; gap: var(--s3); font-size: var(--fs-chip);
            letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
    .co-l .no { color: var(--red); }
    .co-json { display: block; color: var(--code-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
    .co-json .k { color: var(--muted); }
    .co-json .s, .co-json .n { color: var(--code); }
    .co-json .f { color: var(--red); font-weight: 700; }
    .co-n { margin-top: 8px; color: var(--dim); }
    .co-n b { color: var(--muted); font-weight: 500; }

    /* The hero's docs link is a route; the playground is one scroll down. The
       nav is sticky, so the anchor lands beneath it rather than under it. */
    #playground { scroll-margin-top: calc(var(--banner-height) + var(--s4)); }

    /* Sections. Uneven on purpose: the argument opens generously, the rows sit
       closer to each other than to the sections that frame them, and pricing
       opens wide because it changes subject. */
    section { padding-block: 88px 0; }
    .rows { padding-block: 24px 0; }
    .pricing { padding-block: 104px 0; }
    .not-for { padding-block: 88px 0; }

    /* The why. One head, one paragraph, three cards of evidence. */
    .why h2 { color: var(--white); max-width: 22ch; margin-bottom: var(--s4); }
    .lead-p { color: var(--muted); max-width: 62ch; line-height: 1.7; }
    .src-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s4); margin-top: var(--s6); }
    .src { min-width: 0; display: flex; flex-direction: column; gap: var(--s3);
           background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
           border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); padding: var(--s4) var(--s5) var(--s5); }
    .src-l { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
    .src p { color: var(--muted); font-size: var(--fs-small); line-height: 1.65; flex: 1; }
    .src p b { color: var(--text); font-weight: 600; }
    /* Source links at the citation register: --muted and underlined, the way
       .proof a used to be, because the claim carries the page and the link
       carries the claim. */
    .src a { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); text-decoration: underline;
             text-underline-offset: 2px; text-decoration-color: var(--border-strong); }
    .src a:hover { color: var(--text); text-decoration-color: var(--text); }
    .src-note { margin-top: var(--s4); font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); max-width: 70ch; }

    /* Rows. Text on one side, the product on the other, direction alternating.
       A gutter, no rule: the two halves are one argument, not two cards. Every
       row is closed by a hairline (.row-close), because an open-bottomed unequal
       row reads as an unfinished column; text top aligns with panel top, with a
       4px optical nudge putting the head's cap height on the panel's label bar. */
    .dip { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--gap);
           align-items: start; padding-block: 48px 48px; }
    .dip-text { padding-top: 4px; }
    /* order: 2 reorders the DOM item but not the track, so the flipped row
       mirrors its tracks too, or its panel lands 161px narrower than its siblings.
       Two classes outrank one: the collapse rule under --lg names .dip.flip as
       well, or this row keeps its two tracks on a phone. It did, in production,
       and the refusals panel rendered 150px wide beside its own paragraph. */
    .dip.flip { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
    .dip.flip .dip-text { order: 2; }
    /* The wide row. The fifth row is the console, which is a workbench and
       wants the shell's full width: its head sits in the row's own columns
       (eyebrow and head left, argument right) and the panel spans both beneath. */
    .dip.wide { grid-template-columns: minmax(0, 1fr); row-gap: var(--s6); }
    .dip.wide .dip-text { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
                          gap: var(--gap); align-items: start; padding-top: 0; }
    .dip.wide .dip-text h2 { margin-bottom: 0; }
    .dip.wide .dip-text p { margin-top: 4px; max-width: 58ch; }
    .dip h2 { color: var(--white); margin-bottom: var(--s4); max-width: 14ch; }
    .dip p { color: var(--muted); line-height: 1.7; max-width: 44ch; }
    .chip-link { display: inline-flex; align-items: center; gap: 0.5em; margin-top: 22px; min-height: 44px;
                 padding: 0 18px; border: 1px solid var(--border-strong); border-radius: var(--r-control);
                 color: var(--text); text-decoration: none; font-weight: 600; font-size: var(--fs-small);
                 white-space: nowrap; transition: border-color .15s; }
    .chip-link:hover { border-color: var(--text); }
    .chip-link:active { transform: translateY(1px); }

    /* Panel contents. The frame (.panel) comes from ui/panels.ts; what goes
       inside is this page's, in the console's own vocabulary. */
    .task, .key { padding: 16px 18px; border-bottom: 1px solid var(--border-soft); }
    .task:last-of-type { border-bottom: 0; }
    .task-top, .ref-top, .key-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .key-top { margin-bottom: 6px; }
    .ref { font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
    .agent { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
    .task-nums, .key-meta { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted);
                            font-variant-numeric: tabular-nums; }
    .task-nums { margin-top: 8px; }
    .task-nums b { color: var(--text); font-weight: 500; }
    .dimtxt { color: var(--dim); }
    .track { height: 8px; background: var(--surface3); border-radius: var(--r-pill); overflow: hidden; display: flex; }
    .track i { display: block; height: 100%; }
    .track i.used { background: var(--flow); }
    .track i.used.near { background: var(--amber); }
    .track i.used.held { background: var(--green); }
    .track i.used.fail { background: var(--red); }
    .track i.res { background: var(--res); }
    .chip { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em; text-transform: uppercase;
            padding: 3px 9px; border-radius: var(--r-chip); border: 1px solid; margin-left: auto; }
    .chip.held { color: var(--green); border-color: var(--held-line); background: var(--held-bg); }
    .chip.fail { color: var(--fail-ink); border-color: var(--fail-line); background: var(--fail-bg); }
    .chip.near { color: var(--amber); border-color: var(--near-line); background: var(--near-bg); }
    .chip.flow { color: var(--muted); border-color: var(--border2); background: var(--surface3); }
    .ask { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); font-variant-numeric: tabular-nums; }
    .ref-row { padding: 14px 18px; border-bottom: 1px solid var(--border-soft); }
    .ref-row:last-of-type { border-bottom: 0; }
    .ref-row .chip { margin-left: 0; }
    .ref-msg { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); line-height: 1.6; }

    /* The key endpoints, under the key rows: a ledger, not a table. */
    .cmds { padding: 6px 18px 10px; }
    .cmd { display: grid; grid-template-columns: minmax(0, 11em) minmax(0, 1fr); gap: var(--s3);
           padding: 9px 0; border-bottom: 1px solid var(--border-soft); font-size: var(--fs-small); }
    .cmd:last-child { border-bottom: 0; }
    .cmd b { font-family: var(--mono); font-weight: 500; color: var(--text); white-space: nowrap; }
    .cmd span { color: var(--muted); line-height: 1.55; }

    /* The console panel. Two columns inside the frame, the split the console
       itself draws between activity and customers. Tiles are the console's
       tiles: a tracked label, the figure, one line of footnote. */
    .con-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
    .con-l { padding: 18px 20px 20px; }
    .con-r { padding: 18px 20px 20px; border-left: 1px solid var(--border); background: var(--bg-deep); }
    .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s4); margin-bottom: var(--s5); }
    .tile { min-width: 0; }
    .tile-l { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .12em; text-transform: uppercase;
              color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile-v { font-family: var(--display); font-size: var(--fs-figure); font-weight: 700; letter-spacing: -0.02em;
              line-height: 1.1; color: var(--text); margin-top: 6px; font-variant-numeric: tabular-nums; }
    .tile-v.held { color: var(--green); }
    .tile-f { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); margin-top: 6px; line-height: 1.5; }
    .spark { display: flex; align-items: flex-end; gap: 3px; height: 64px; margin-top: 10px;
             border-bottom: 1px solid var(--border); padding-bottom: 1px; }
    .spark i { flex: 1 1 0; min-width: 0; display: block; background: var(--green); border-radius: 1px 1px 0 0; }
    .spark i.zero { height: 2px; background: var(--surface3); }
    .cust { display: grid; grid-template-columns: minmax(0, 1fr) auto 72px 3.2em; gap: var(--s3); align-items: center;
            padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
    .cust:first-of-type { margin-top: 6px; }
    .cust-n { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); font-variant-numeric: tabular-nums;
              white-space: nowrap; }
    .sbar { display: block; height: 8px; background: var(--surface3); border-radius: var(--r-pill); overflow: hidden; }
    .sbar i { display: block; height: 100%; background: var(--flow); border-radius: var(--r-pill); }
    .sbar i.held { background: var(--green); }
    .cust-s { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); text-align: right;
              font-variant-numeric: tabular-nums; }
    .con-note { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fail-ink); line-height: 1.55;
                margin-top: var(--s4); padding-top: var(--s3); border-top: 1px solid var(--border-soft); }

    /* Pricing: the four cards /pricing renders, from ui/tiers.ts. */
    .pricing h2 { color: var(--white); margin-bottom: var(--s2); max-width: 22ch; }
    .price-links { margin-top: var(--s5); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }

    /* What it does not do: one line per item, two columns, on hairlines. The
       list is the honest substitute for the proof this page cannot show, so it
       stays; one line per item keeps it to a glance instead of a scroll. */
    .not-for h2 { color: var(--white); margin-bottom: var(--s2); }
    .nots { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--gap);
            margin-top: var(--s5); }
    .nots li { color: var(--muted); font-size: var(--fs-small); line-height: 1.6; padding: 12px 0 12px 22px;
               border-bottom: 1px solid var(--border-soft); position: relative; }
    .nots li b { color: var(--text); font-weight: 600; }
    /* A short rule reads as negation, needs no icon set, and speaks the mark's
       own vocabulary: a line that stops something. */
    .nots li::before { content: ""; position: absolute; left: 0; top: calc(12px + 0.62em);
                       width: 11px; height: 1.5px; background: var(--red); }

    /* The close. Calm: a head, one line, the button and the install line. On a
       phone the sticky bar is the primary, so .end stands the button down. */
    .final { padding-block: var(--s9) var(--s5); }
    .final h2 { color: var(--white); margin-bottom: 10px; }
    .final p { color: var(--muted); margin-bottom: var(--s5); max-width: 54ch; }
    .final-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }

    @media (max-width: ${BP.lg}px) {
      .hero, .dip, .dip.flip, .dip.wide .dip-text { grid-template-columns: minmax(0, 1fr); gap: 32px; }
      .hero { align-items: start; padding-block: var(--s7) var(--s7); }
      .dip.wide .dip-text { gap: 0; }
      .dip.flip .dip-text { order: 0; }
      .dip-text { padding-top: 0; }
      .dip { padding-block: 36px 36px; }
      section { padding-block: 64px 0; }
      .rows { padding-block: 16px 0; }
      .pricing { padding-block: 80px 0; }
      .sub { max-width: 54ch; }
      .src-grid { grid-template-columns: minmax(0, 1fr); }
      .con-grid { grid-template-columns: minmax(0, 1fr); }
      .con-r { border-left: 0; border-top: 1px solid var(--border); }
    }
    @media (max-width: ${BP.md}px) {
      .nots { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: ${BP.sm}px) {
      /* One column: the subhead takes the column's width at body size, and the
         two hero buttons go full width and centred, the sanctioned exception
         recorded in design.md. */
      .sub { max-width: none; font-size: var(--fs-body); margin: 18px 0 26px; }
      .hero { padding-block: var(--s6) var(--s7); }
      .hero-cta { display: grid; grid-template-columns: 1fr; gap: var(--s3); }
      .hero-cta > a { text-align: center; }
      .cp { max-width: none; }
      .code-body { padding: 18px 16px; }
      .code-body pre { font-size: var(--fs-micro); }
      /* The caption in the label bar yields to the tabs at 390px; the tabs
         carry the meaning and the caption repeats the section under it. */
      .code-head > span { display: none; }
      .tiles { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
      /* A tracked label that cannot fit a 150px tile wraps here rather than
         losing its window to an ellipsis. */
      .tile-l { white-space: normal; overflow: visible; text-overflow: clip; }
      .cust { grid-template-columns: minmax(0, 1fr) auto 3.2em; }
      .cust .sbar { display: none; }
      .cmd { grid-template-columns: minmax(0, 1fr); gap: 2px; }
      .final-row { display: grid; grid-template-columns: minmax(0, 1fr); }
    }
`,
    })}
<body>
${siteNav('/')}
<main>

  <header class="hero wrap">
    <div>
      <h1>${HEADLINE}.</h1>
      <p class="sub">Preflight says no when this job is out of units. Your code decides
      what next.</p>
      <div class="hero-cta">
        <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
        <a class="btn-ghost btn-lg" href="/docs">Read the docs</a>
      </div>
      <!-- The step that needs no account. The references all put proof beside the
           primary action; this product has two external signups, so a logo wall is
           unavailable and inventing one would break the claims rules. The install
           line is the honest equivalent: something the reader can act on now. It
           follows the language tab in the code frame, so the pill and the sample
           always name the same package. -->
      <div class="hero-install">
        <div data-lang="python">${copyPill('install-py', INSTALL_PY)}</div>
        <div data-lang="node" hidden>${copyPill('install-node', 'npm install agentbill')}</div>
      </div>
      <p class="trust"><span><b>free tier</b></span><span>${num(PLAN_LIMITS.free)} preflight calls/mo</span><span>no card</span><span>key in 30 seconds</span></p>
    </div>

    <div class="code-block">
      <div class="code-head">${langTabs([['python', 'Python'], ['node', 'Node']], 'python', 'Language of the sample')}<span>the whole integration</span></div>
      <div class="code-body">
        <pre id="code-python" role="tabpanel" aria-labelledby="tab-python" data-lang="python">from agentbill import AgentBillClient

client = AgentBillClient(
    api_key="agb_your_key")

<span class="cmt"># You decide what a unit is worth.</span>
<span class="cmt"># job-142 gets 500 of them, across</span>
<span class="cmt"># every call passing this task_ref.</span>
client.preflight(agent_id="researcher",
                 task_ref="job-142",
                 task_ceiling=500,
                 estimated_units=12)

<span class="cmt"># your provider call goes here</span>

<span class="cmt"># settle, or the units stay held</span>
<span class="cmt"># until the reservation expires.</span>
client.record(agent_id="researcher",
              task_ref="job-142",
              units=12)

<span class="out-dim">&gt;&gt;&gt; run 42 of the retry loop:</span></pre>
        <pre id="code-node" role="tabpanel" aria-labelledby="tab-node" data-lang="node" hidden>import { preflight, record }
  from 'agentbill'

<span class="cmt">// Reads AGENTBILL_API_KEY from env.</span>
<span class="cmt">// You decide what a unit is worth.</span>
<span class="cmt">// job-142 gets 500 of them, across</span>
<span class="cmt">// every call passing this taskRef.</span>
await preflight({ agentId: 'researcher',
                  taskRef: 'job-142',
                  taskCeiling: 500,
                  estimatedUnits: 12 })

<span class="cmt">// your provider call goes here</span>

<span class="cmt">// settle, or the units stay held</span>
<span class="cmt">// until the reservation expires.</span>
await record({ agentId: 'researcher',
               taskRef: 'job-142',
               units: 12 })

<span class="out-dim">// run 42 of the retry loop:</span></pre>
      </div>
      <div class="code-out">
        <div class="co-l"><span>POST /preflight</span><span class="no">200 &middot; refused</span></div>
        <code class="co-json">${heroAnswer()}</code>
        <p class="co-n">The SDK raises <b>${REFUSAL.name}</b>. Your code decides what happens next.</p>
      </div>
    </div>
  </header>

${playgroundSection()}

  <section class="wrap why">
    <p class="eyebrow">Why a task, not a month</p>
    <h2>Your job is not an account, and it does not last a month.</h2>
    <p class="lead-p">The provider cap is real and it fires. It is bound to a project, to an organization
    over a calendar month, or to one session on the vendor's own harness. A run too small to move a
    monthly number never trips it. A number low enough to catch that run stops every agent in the
    organization until the month turns.</p>
    ${sourceCards()}
    <p class="src-note">Read at source on 2026-09-07. What differs is not whether a cap fires. It is what
    the cap is bound to.</p>
  </section>

  <section class="wrap rows">
    <div class="dip row-close">
      <div class="dip-text">
        <p class="eyebrow">Per-task ceilings</p>
        <h2>One job, many calls, one ceiling.</h2>
        <p>Give the job a ceiling in the console, or pass <span class="mono-in">task_ceiling</span> on
        its first call, and the same <span class="mono-in">task_ref</span> on every call after it.
        Every call is checked against that one number, in units you define. The console's last save
        is the ceiling in force; code cannot raise it.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=tasks">Watch budgets burn down &rarr;</a>
      </div>
      ${taskPanel()}
    </div>

    <div class="dip flip row-close">
      <div class="dip-text">
        <p class="eyebrow">No proxy</p>
        <h2>Two calls. Nothing in your request path.</h2>
        <p><span class="mono-in">preflight</span> before your provider call,
        <span class="mono-in">record</span> after it. No base URL to change, no traffic routed through
        us, no provider keys held. If we are unreachable, the SDK raises inside your process and your
        code decides.</p>
        <a class="chip-link" href="/docs#reservation">How the reservation works &rarr;</a>
      </div>
      ${requestPanel()}
    </div>

    <div class="dip row-close">
      <div class="dip-text">
        <p class="eyebrow">The receipt</p>
        <h2>Every refusal is written down.</h2>
        <p>Each <span class="mono-in">approved: false</span> is persisted with the body the agent
        received, per agent and per task. A record that lands past a ceiling because preflight was
        skipped is kept as a leak, not hidden.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=refusals">See the refusals &rarr;</a>
      </div>
      ${refusalPanel()}
    </div>

    <div class="dip flip row-close">
      <div class="dip-text">
        <p class="eyebrow">Keys</p>
        <h2>Keys you can revoke in one call.</h2>
        <p>Revoke, and the key is refused on its next request. Rotate, and the old key works for
        24 hours, then revokes itself. Labels, expiry in days, 100 requests a minute per key, and an
        email when a key is used from a new address. Your provider keys never touch us.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=keys">See the keys view &rarr;</a>
      </div>
      ${keysPanel()}
    </div>

    <div class="dip wide row-close">
      <div class="dip-text">
        <div>
          <p class="eyebrow">Console</p>
          <h2>What the ceiling saved you from, as rows.</h2>
        </div>
        <div>
          <p>Calls refused and units refused over a window, the tasks burning down now, every customer
          by share of spend, and the one number that should be zero.</p>
          <a class="chip-link" href="/app?demo=1">Open the sample console &rarr;</a>
        </div>
      </div>
      ${consolePanel()}
    </div>
  </section>

  <section class="wrap pricing" id="pricing">
    <p class="eyebrow">Pricing</p>
    <h2>Free to start. Cheap enough to leave on.</h2>
    <p class="lead-p">${SAME_FEATURES}</p>
    ${tierCards((tier) => `/app/upgrade/${tier}`)}
    <div class="price-links">
      <a class="btn-ghost" href="/pricing">Full pricing &rarr;</a>
    </div>
  </section>

  <section class="wrap not-for">
    <h2>What AgentBill does not do</h2>
    <ul class="nots">
      <li><b>Stop your run.</b> Preflight answers <span class="mono-in">approved: false</span> and the
      SDK raises. Your code decides what happens next.</li>
      <li><b>Read your provider bill.</b> No access to your provider account, no invoice, no dollar
      estimate. Units are yours to define, and units refused is not money.</li>
      <li><b>See a call that never asks.</b> No proxy, so an uninstrumented tool or a retry buried in a
      library is invisible to the ceiling.</li>
      <li><b>Bind a caller.</b> The ceiling is keyed on
      <span class="mono-in">(account_id, task_ref)</span>. A loop that opens a new
      <span class="mono-in">task_ref</span> gets a new ceiling.</li>
      <li><b>Unwind a workflow.</b> Calls are refused, not reversed. Refusing the next call does not
      undo the ones that already ran.</li>
      <li><b>Guarantee the TTL fits your job.</b> A reservation not settled inside 60 minutes is
      reclaimed by a sweeper while your call may still be running.</li>
      <li><b>Publish a latency SLO.</b> There is none. The free tier is ${num(PLAN_LIMITS.free)} calls
      with no card, enough to measure the added latency on your own workload.</li>
      <li><b>Replace observability or payments.</b> No tracing, no invoices, no money moved. Polar bills
      you for AgentBill; nothing bills anyone on your behalf.</li>
      <li><b>Give your ops team a no-code dashboard.</b> There is a console. The product is an SDK and
      one endpoint.</li>
      <li><b>Show a logo wall or a testimonial.</b> Nobody has agreed to be named yet. The install line,
      the free tier and the response bodies above are what is checkable.</li>
    </ul>
  </section>

  <section class="wrap final end">
    <h2>Give one job a ceiling.</h2>
    <p>Free tier, no card, ${num(PLAN_LIMITS.free)} preflight calls a month. If this page took longer to
    read than the integration takes, we did our job.</p>
    <div class="final-row">
      <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
      <div data-lang="python">${copyPill('install-py-2', INSTALL_PY)}</div>
      <div data-lang="node" hidden>${copyPill('install-node-2', 'npm install agentbill')}</div>
    </div>
  </section>

</main>
${siteFooter()}
${PLAYGROUND_JS}${COPY_JS}${TABS_JS}
</body>
</html>
    `)
  })
}
