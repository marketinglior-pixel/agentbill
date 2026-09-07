import { HEADLINE, INSTALL_PY } from '../ui/site.js'
import { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS, KEY_CTA } from '../ui/chrome.js'
import { PLAYGROUND_CSS, PLAYGROUND_JS, PLAYGROUND_HASH, playgroundSection, REFUSAL } from '../ui/playground.js'
import { pixelSnippet } from '../lib/pixel.js'
import { demoConsole } from './app.js'
import { PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'
import { PANEL_CSS, requestPanel, KEY_COMMANDS } from '../ui/panels.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from '../ui/copy.js'
import { TABS_CSS, TABS_JS, TABS_HASH, langTabs } from '../ui/tabs.js'
import { publicRoute } from '../middleware/auth.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

// The page is a Split Studio: every claim below the fold sits beside a panel
// that shows the product doing the thing the claim describes. The panels are
// not mockups. They render the same sample rows the demo console renders,
// through the same rule the console applies, so the homepage cannot show a
// number the console would disagree with. Where a panel is sample data it
// says so inside its own frame, so a screenshot carries the label with it.
//
// Redesigned 2026-09-07 for conversion, measured against the fold and not
// against taste: the hero says what the product is in one line and how it
// works in three, the second action keeps the reader on the page and runs
// the product, the code frame speaks both languages the register form asks
// about, and the two pillars the page never showed (the key lifecycle and the
// receipt) each get a row with a real panel. Nothing here is a logo wall, a
// count or a testimonial: there is nobody to name yet, and design.md records
// why the install line stands in that slot.

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => n.toLocaleString('en-US')

// Limits, prices and order all come from polar.ts, the same tables preflight
// enforces and /pricing renders, so no number here can drift from either.
const RECOMMENDED = 'team'

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

/** Three refusals from three agents, with the literal body each one got back. */
function refusalPanel(): string {
  const rows = demoConsole().decisions.filter((d) => d.blocked && d.taskRef).slice(0, 3).map((d) => {
    const body = JSON.parse(d.snapshot) as { message?: string }
    return `
        <div class="ref-row">
          <div class="ref-top">
            <span class="agent">${esc(d.agentId ?? '')}</span>
            <span class="ref">${esc(d.taskRef ?? '')}</span>
            <span class="chip held">refused</span>
            <span class="ask">asked ${num(d.estimatedUnits ?? 0)}</span>
          </div>
          <div class="ref-msg">${esc(body.message ?? d.reason)}</div>
        </div>`
  }).join('')
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

function pricingStrip(): string {
  const rows = PLAN_ORDER.map((tier) => `
        <tr class="${tier === RECOMMENDED ? 'rec' : ''}">
          <th scope="row" class="tier">${tier}</th>
          <td class="calls">${num(PLAN_LIMITS[tier])}<span class="dimtxt"> calls / mo</span></td>
          <td class="amount">$${PLAN_PRICES[tier]}${tier === 'free' ? '' : '<span class="dimtxt"> / mo</span>'}</td>
        </tr>`).join('')
  return `<table class="tiers">
        <tbody>${rows}
        </tbody>
      </table>`
}

export async function homeRoute(app: FastifyInstance) {
  app.get('/', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: `AgentBill · ${HEADLINE}`,
      description: 'Your provider cap is bound to a project, to an org over a calendar month, or to one session on the vendor’s own harness. This one is bound to a task_ref: every call carrying the same one consults it before it runs, on units you define. Free tier, API key in 30 seconds.',
      path: '/',
      og: {
        description: 'One ceiling per task_ref, consulted before each call, on units you define. Not per project, not per calendar month.',
      },
      // Offers render from PLAN_ORDER / PLAN_PRICES / PLAN_LIMITS rather than
      // being typed here. A price written twice is a price that will disagree
      // with itself, and this one would disagree with the table 200px below it.
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        '@id': 'https://agentbill.dev/#software',
        name: 'AgentBill',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any',
        description: 'A per-task spend ceiling for AI agents, bound to a task_ref and checked before each call, on units the developer defines.',
        url: 'https://agentbill.dev',
        provider: { '@id': 'https://agentbill.dev/#organization' },
        offers: PLAN_ORDER.map((tier) => ({
          '@type': 'Offer',
          name: tier[0].toUpperCase() + tier.slice(1),
          price: String(PLAN_PRICES[tier]),
          priceCurrency: 'USD',
          description: `${PLAN_LIMITS[tier].toLocaleString('en-US')} preflight calls/month`,
        })),
      },
      // meta keywords has been ignored by every major engine since 2009. It was
      // 300 bytes on the most-fetched page of the site.
      extraHead: pixelSnippet(),
      scriptHashes: [PLAYGROUND_HASH, COPY_HASH, TABS_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PLAYGROUND_CSS}${PANEL_CSS}${COPY_CSS}${TABS_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio
     * theme: design.md (paper, type and accent are theme.ts) · design-system: design.md · designed-as-app
     * nav: N1b, unchanged · footer: Ft2, unchanged · enrichment: none, real product panels
     * rows: five, alternating, the fifth wide; one grid break, the refusal band
     * pre-emit critique: P5 H5 E4 S5 R5 V4 */

    :root { --shell: 1080px;
            /* Page-local: the refusal band's ground and the code-comment ink.
               The console colours the panels use (--flow, --res, the chip
               grounds) live in theme.ts, one copy for every page. */
            --band-hi: #121212; --band-lo: #0c0c0c;
            --cmt: #79837c; }

    /* .wrap owns the inline axis; every block-axis rule below uses padding-block,
       so neither can wipe the other via the padding shorthand. */
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }

    /* Hero: a diptych. Type on the left, the whole integration on the right.
       The headline is one line of meaning at three lines of type; the subhead
       is three sentences, down from six. On a 390px phone the primary action
       now lands above the fold, which is where a paid click is spent. */
    .hero { padding-block: var(--s8) var(--s9); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: var(--gap); align-items: start; }
    h1, h2, h3 { overflow-wrap: anywhere; min-width: 0; }
    h1 { color: var(--white); max-width: 16ch; }
    .sub { font-size: var(--fs-lede); color: var(--muted); margin: var(--s5) 0 var(--s6); max-width: 46ch; }
    .hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    /* The hero pair runs one size up from the site's buttons. The ghost gives
       back the pixel its border adds so the two sit at one height. */
    .btn-lg { padding: 14px 26px; font-size: var(--fs-body); border-radius: 10px; }
    .btn-ghost.btn-lg { padding: 13px 25px; }
    .chip-link:active { transform: translateY(1px); }

    /* An identifier inside prose. The mono face is the third register in the
       system and it is what makes task_ref read as a thing in the code rather
       than as a word in a sentence. No chip ground: this is body copy. */
    .mono-in { font-family: var(--mono); font-size: .92em; color: var(--text); }

    /* The proof line beside the primary action. Every premium reference fills
       this slot with a logo wall; we have nobody who has agreed to be named, so
       it holds one sourced incident. It is set at the trust line's register, not
       the body's, because it is evidence rather than argument. */
    .proof { font-size: var(--fs-small); color: var(--dim); line-height: 1.65;
             max-width: 52ch; margin-top: var(--s4);
             padding-top: var(--s4); border-top: 1px solid var(--border); }
    .proof b { color: var(--muted); font-weight: 600; }
    .proof a { color: var(--muted); text-decoration: underline;
               text-underline-offset: 2px; text-decoration-color: var(--border-strong); }
    .proof a:hover { color: var(--text); text-decoration-color: var(--text); }

    /* The citation row under a claim. Dim on purpose: the claim carries the
       page, the links carry the claim, and a reader who wants them finds them. */
    .lead-p.src { font-size: var(--fs-small); color: var(--dim); line-height: 1.7; max-width: 78ch; }
    .lead-p.src a { color: var(--muted); }
    .trust { margin-top: 18px; font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
             display: flex; flex-wrap: wrap; gap: 0 var(--s3); }
    .trust > span:not(:last-child)::after { content: "\\00b7"; margin-left: var(--s3); color: var(--border2); }
    /* --muted, not the accent and not --text. The .trust run is --dim mono
       micro, and the house rung for a bold term on a --dim ground is --muted:
       .proof b twelve lines above does exactly this on the same ground. The
       accent said "link" on a word that is not one. */
    .trust b { color: var(--muted); font-weight: 500; }
    .hero-install { margin-top: var(--s5); }

    /* The code frame. Its label bar now carries the language tabs on the left
       and the caption on the right; the bar keeps the 44px floor every control
       on the site clears, and the selected tab is a bar on the hairline, the
       same device the nav uses for the current page.
       The sample used to end on ">>> run 42 of the retry loop:" and nothing
       after it, a dangling colon in the most looked-at element on the page.
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
    .code-body { padding: 22px 24px; overflow-x: auto; }
    .code-body pre { font-family: var(--mono); font-size: var(--fs-small); color: var(--code-ink); line-height: 1.75; }
    .cmt { color: var(--cmt); }
    .out-dim { color: var(--dim); }
    .code-out { border-top: 1px solid var(--border); padding: 14px 20px;
                font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.65;
                color: var(--red); background: var(--fail-bg); }
    .code-out b { font-weight: 700; }

    /* The refusal band. Every other section on this page is a 1080px column of
       left-aligned type; this one is full bleed with its own ground, because it
       carries the one string the whole product exists to produce. Breaking the
       grid once is what stops the page reading as a template. */
    .refusal { padding-block: 0;
               background: linear-gradient(180deg, var(--band-hi), var(--band-lo) 72%);
               border-block: 1px solid var(--border2); box-shadow: var(--edge); }
    .refusal .wrap { padding-block: 60px 56px; display: grid;
                     grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
                     gap: var(--gap); align-items: start; }
    .refusal-head { min-width: 0; }
    .refusal-name, .refusal-msg { font-family: var(--mono); }
    /* One unbreakable 24-character token, so the floor of this clamp is not a
       taste call: at 0.585em of measured mono advance, 24 chars need 14.04em,
       and 320px minus the 48px gutter leaves 272px. 17px fits; 21px does not. */
    .refusal-name { font-size: clamp(17px, 5.6vw, 40px); font-weight: 700; color: var(--red);
                    letter-spacing: -0.015em; line-height: 1.1; }
    .refusal-msg { font-size: clamp(13px, 1.5vw, 17px); color: var(--muted); line-height: 1.6;
                   margin-top: 14px; max-width: 62ch; white-space: pre-wrap; }
    .refusal-note { font-size: var(--fs-small); color: var(--dim); margin-top: 6px; max-width: none;
                    padding-top: 22px; border-top: 1px solid var(--border); }
    .refusal-note b { color: var(--muted); font-weight: 600; }

    /* The hero's second action jumps here. The nav is sticky, so without this
       the section head would land under it. */
    #playground { scroll-margin-top: calc(var(--banner-height) + var(--s4)); }

    /* Sections. Uneven on purpose: the argument opens generously, the
       guardrails section opens wider still because it changes subject, and
       pricing sits closer because it is the answer to what came before. */
    section { padding-block: 72px 0; }
    .guard { padding-block: 96px 0; }
    .not-for { padding-block: 64px 0; }

    /* Diptychs. Text on one side, the product on the other, direction alternating.
       A gutter, no rule: the two halves are one argument, not two cards. Every
       row is closed by a hairline (.row-close), because an open-bottomed unequal
       row reads as an unfinished column; text top aligns with panel top, with a
       4px optical nudge putting the h3's cap height on the panel's label bar. */
    .dip { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--gap);
           align-items: start; padding-block: 40px 40px; }
    .dip-text { padding-top: 4px; }
    .dip + .dip { padding-block: 48px 40px; }
    /* order: 2 reorders the DOM item but not the track, so the flipped row
       mirrors its tracks too, or its panel lands 161px narrower than its siblings.
       Two classes outrank one: the collapse rule under --lg names .dip.flip as
       well, or this row keeps its two tracks on a phone. It did, in production,
       and the refusals panel rendered 150px wide beside its own paragraph. */
    .dip.flip { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
    .dip.flip .dip-text { order: 2; }
    /* The wide row. The fifth row is the console, which is a workbench and
       wants the shell's full width: its head sits in the diptych's own columns
       (title left, argument right) and the panel spans both beneath. One row
       of a different shape closes the sequence instead of stamping a sixth. */
    .dip.wide { grid-template-columns: minmax(0, 1fr); row-gap: var(--s6); }
    .dip.wide .dip-text { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
                          gap: var(--gap); align-items: start; padding-top: 0; }
    .dip.wide .dip-text h3 { margin-bottom: 0; }
    .dip.wide .dip-text p { margin-top: 4px; max-width: 58ch; }
    .dip h3 { font-size: var(--fs-h3); color: var(--white); margin-bottom: 16px; max-width: 16ch; }
    .dip p { color: var(--muted); line-height: 1.7; max-width: 46ch; }
    .chip-link { display: inline-flex; align-items: center; gap: 0.5em; margin-top: 22px; min-height: 44px;
                 padding: 0 18px; border: 1px solid var(--border-strong); border-radius: var(--r-control);
                 color: var(--text); text-decoration: none; font-weight: 600; font-size: var(--fs-small);
                 white-space: nowrap; transition: border-color .15s; }
    .chip-link:hover { border-color: var(--text); }
    .lead-h2 { color: var(--white); margin-bottom: 8px; max-width: 22ch; }
    .lead-p { color: var(--muted); max-width: 58ch; }

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

    /* Pricing: a spec sheet, not four cards. The recommended tier carries weight
       through type, and the numbers line up because they are a table. */
    .tiers { width: 100%; border-collapse: collapse; margin-top: 28px; font-variant-numeric: tabular-nums; }
    .tiers th { font-weight: inherit; text-align: left; }
    .tiers th, .tiers td { padding: 16px 0; border-bottom: 1px solid var(--border); color: var(--muted); font-size: var(--fs-body); }
    .tiers tr:first-child > * { border-top: 1px solid var(--border); }
    .tiers .tier { font-family: var(--mono); text-transform: uppercase; letter-spacing: .12em; font-size: var(--fs-micro);
                   color: var(--dim); width: 18%; }
    .tiers .amount { text-align: right; font-family: var(--display); font-size: var(--fs-h3); font-weight: 700;
                     color: var(--text); letter-spacing: -0.02em; }
    /* --white, joining .calls and .amount on the line below. The base .tier
       here is --dim, so this is still a two-rung lift; the accent only made the
       one word in the row you cannot click the greenest thing in it. */
    .tiers tr.rec .tier { color: var(--white); }
    .tiers tr.rec .calls, .tiers tr.rec .amount { color: var(--white); }
    .price-links { margin-top: 26px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }

    /* What it does not do: two columns of short rules. The list is the honest
       substitute for the proof this page cannot show, so it stays; two columns
       keep it to one screen instead of a scroll. */
    .not-for ul { list-style: none; columns: 2; column-gap: var(--gap); margin-top: var(--s5); }
    .not-for li { color: var(--muted); font-size: var(--fs-small); line-height: 1.6; margin-bottom: 14px;
                  padding-left: 22px; position: relative; break-inside: avoid; }
    .not-for li b { color: var(--text); font-weight: 600; }
    /* A short rule reads as negation, needs no icon set, and speaks the mark's
       own vocabulary: a line that stops something. */
    .not-for li::before { content: ""; position: absolute; left: 0; top: 0.62em;
                          width: 11px; height: 1.5px; background: var(--red); }

    .final { padding-block: var(--s9) var(--s5); }
    .final h2 { color: var(--white); margin-bottom: 10px; }
    .final p { color: var(--muted); margin-bottom: 26px; max-width: 54ch; }

    @media (max-width: ${BP.lg}px) {
      .hero, .dip, .dip.flip, .refusal .wrap, .dip.wide .dip-text { grid-template-columns: minmax(0, 1fr); gap: 32px; }
      .dip.wide .dip-text { gap: 0; }
      .refusal .wrap { gap: 26px; }
      .refusal-note { border-top: 1px solid var(--border); padding-top: 22px; }
      .dip.flip .dip-text { order: 0; }
      .dip-text { padding-top: 0; }
      .hero { padding-block: var(--s7) var(--s8); }
      .sub { max-width: 54ch; }
      section { padding-block: 56px 0; }
      .guard { padding-block: 72px 0; }
      .con-grid { grid-template-columns: minmax(0, 1fr); }
      .con-r { border-left: 0; border-top: 1px solid var(--border); }
    }
    @media (max-width: ${BP.md}px) {
      .not-for ul { columns: 1; }
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
      .tiers td { font-size: var(--fs-small); }
      /* 18% of a 342px table is 61.6px; BUILDER at 12px mono with .12em tracking
         needs more, and the neighbouring cell has no inline padding to absorb it. */
      .tiers .tier { width: auto; padding-right: var(--s4); letter-spacing: .06em; }
    }
`,
    })}
<body>
${siteNav('/')}
<main>

  <header class="hero wrap">
    <div>
      <h1>${HEADLINE}.</h1>
      <p class="sub">Your provider cap is bound to a project, to an org over a calendar month, or to
      one session on the vendor's own harness. This one is bound to <span class="mono-in">job-142</span>.
      You pass two numbers: the ceiling for the task, and what this call is worth, both in units you
      define. Every call carrying the same <span class="mono-in">task_ref</span> consults that ceiling
      before it runs, and the reservation is atomic, so two calls cannot both be approved for the last
      8 units.</p>
      <div class="hero-cta">
        <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
        <a class="btn-ghost btn-lg" href="#playground">Run it in your browser</a>
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
        <p class="cp-note">or read the <a href="/docs">two-minute quickstart</a></p>
      </div>
      <p class="trust"><span><b>free tier</b></span><span>${num(PLAN_LIMITS.free)} preflight calls/mo</span><span>no card</span><span>key in 30 seconds</span></p>
      <!-- The slot every premium reference fills with a logo wall. We have nobody who
           has agreed to be named, so it holds a sourced incident with a link instead.
           The number belongs to the reporter, in his own issue, and the point is made
           by the two units disagreeing: the limit is a month, the incident was a weekend. -->
      <p class="proof">One reporter, one issue, on an <b>Enterprise plan ($3,000/month limit)</b>:
      <a href="https://github.com/anthropics/claude-code/issues/64744" rel="nofollow noopener">
      &ldquo;~$300 of unintended API usage over a single weekend with no way to detect or stop it
      from the CLI&rdquo;</a>, on a loop that ran ~864 iterations. The limit is stated per month.
      The incident was a weekend.</p>
    </div>

    <div class="code-block">
      <div class="code-head">${langTabs([['python', 'Python'], ['node', 'Node']], 'python', 'Language of the sample')}<span>the whole integration</span></div>
      <div class="code-body">
        <pre id="code-python" role="tabpanel" aria-labelledby="tab-python" data-lang="python">from agentbill import AgentBillClient

client = AgentBillClient(
    api_key="agb_your_key")

<span class="cmt"># 1 unit = 1 cent here. job-142 dies</span>
<span class="cmt"># at 500 units, across every call</span>
<span class="cmt"># that passes the same task_ref.</span>
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
<span class="cmt">// 1 unit = 1 cent here. job-142 dies</span>
<span class="cmt">// at 500 units, across every call</span>
<span class="cmt">// that passes the same taskRef.</span>
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
      <div class="code-out"><b>${REFUSAL.name}:</b> ${REFUSAL.message}</div>
    </div>
  </header>

  <section class="refusal">
    <div class="wrap">
      <div class="refusal-head">
        <div class="refusal-name">${REFUSAL.name}</div>
        <div class="refusal-msg">${REFUSAL.message}</div>
      </div>
      <p class="refusal-note">That is the exception your code catches, raised the moment the ceiling
      is checked and before the call goes out, not a log line written after the fact. <b>The call
      never ran.</b> The response body it was built from is below, and you can produce it yourself.</p>
    </div>
  </section>

${playgroundSection()}

  <section class="wrap why">
    <h2 class="lead-h2">Your job is not an account, and it does not last a month.</h2>
    <p class="lead-p">The cap is real. Turn it on and keep it on. It fires, and it is documented. What it
    is bound to is a project, an organization, or one session on one vendor's own harness, measured over
    a calendar month. Two things follow from where that line is drawn. A run too small to move a monthly
    number never crosses it. And a monthly number low enough to catch that run takes every agent in the
    organization down with it when it fires, until the month turns.</p>
    <p class="lead-p src">Their own documentation, read at source on 2026-09-07:
    <a href="https://developers.openai.com/api/docs/guides/spend-limits" rel="nofollow noopener">a
    hard limit returns <span class="mono-in">429 project_spend_limit_exceeded</span> and enforcement
    &ldquo;is not instantaneous, so recorded spend can slightly exceed the configured amount&rdquo;</a>
    &middot; <a href="https://platform.claude.com/docs/en/api/rate-limits" rel="nofollow noopener">a
    tier cap pauses usage &ldquo;until 00:00 UTC on the first day of the next month&rdquo;</a>
    &middot; <a href="https://ai.google.dev/gemini-api/docs/billing" rel="nofollow noopener">&ldquo;Long-running
    tasks like batch mode and agents may continue to consume credits beyond your balance before
    the system can process and halt usage.&rdquo;</a></p>

    <div class="dip row-close">
      <div class="dip-text">
        <h3>Per-task ceilings</h3>
        <p>One job, many calls, one budget. "This task dies at 500 units," and you decide what a
        unit is worth. The ceiling is consulted before each call, and the total across the whole
        job cannot pass it.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=tasks">Watch budgets burn down &rarr;</a>
      </div>
      ${taskPanel()}
    </div>

    <div class="dip flip row-close">
      <div class="dip-text">
        <h3>One ceiling, one task, across processes</h3>
        <p>Something draws down this ceiling <b>only if it calls preflight with the same
        <span class="mono-in">task_ref</span></b>. That is why anything can, and why nothing does on
        its own. The row is unique on <span class="mono-in">(account_id, task_ref)</span>, so a
        fan-out spread across four processes and two machines draws down one number, and a later
        call passing a different ceiling for the same task does not move it. You pass what each call
        is worth. We never look at your provider bill.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=refusals">See the refusals &rarr;</a>
      </div>
      ${refusalPanel()}
    </div>

    <div class="dip row-close">
      <div class="dip-text">
        <h3>No proxy in your request path</h3>
        <p>No base URL to change, none of your traffic routed through us, no third party holding
        your provider keys. What you do add is one synchronous HTTP call before your own: the SDK posts
        to <span class="mono-in">/preflight</span> with a five second timeout and no fail-open, so
        if we are unreachable that raises inside your process and your except block decides whether
        to run anyway. A gateway would have made that decision for you.</p>
        <a class="chip-link" href="/docs#reservation">How the reservation works &rarr;</a>
      </div>
      ${requestPanel()}
    </div>
  </section>

  <section class="wrap guard">
    <h2 class="lead-h2">Guardrails on the key. A receipt for every refusal.</h2>
    <p class="lead-p">A ceiling stops a job from overspending. A leaked key is a different failure, and
    it has its own controls, each of them one HTTP call away. And every refusal is written down with the
    body the agent got back, so what the ceiling saved you from is a row you can open, not a log line
    you have to go and find.</p>

    <div class="dip flip row-close">
      <div class="dip-text">
        <h3>Keys you can kill in one call</h3>
        <p>Revoke a key and it is refused on its next request: the check is one predicate in SQL, on
        the database clock, so no skew between our app and our database can keep a dead key alive.
        Rotate, and the old key keeps working for 24 hours, then revokes itself. Give a key a label
        and an expiry in days. Every key is limited to 100 requests a minute, and a request from a
        new IP address emails the account owner with the previous address and the new one. None of
        this touches your provider keys. We never hold them.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=keys">See the keys view &rarr;</a>
      </div>
      ${keysPanel()}
    </div>

    <div class="dip wide row-close">
      <div class="dip-text">
        <h3>Every refusal is written down</h3>
        <div>
          <p>Each <span class="mono-in">approved: false</span> is persisted with the literal body the
          agent received, per agent and per task. The console reads those rows: calls refused and units
          refused over a window, the tasks burning down now, and every customer by share of spend. A
          record that lands past a ceiling because preflight was skipped is kept as a leak, not hidden.</p>
          <a class="chip-link" href="/app?demo=1">Open the sample console &rarr;</a>
        </div>
      </div>
      ${consolePanel()}
    </div>
  </section>

  <section class="wrap">
    <h2 class="lead-h2">Free to start. Cheap enough to leave on.</h2>
    ${pricingStrip()}
    <div class="price-links">
      <a class="btn" href="/register">Start free</a>
      <a class="btn-ghost" href="/pricing">Full pricing</a>
    </div>
  </section>

  <section class="wrap not-for">
    <h2 class="lead-h2">What AgentBill does NOT do</h2>
    <ul>
      <li><b>Stop your run.</b> Preflight answers <span class="mono-in">approved: false</span> and
      the SDK raises. Your code decides what happens next. Nothing here can terminate a process.</li>
      <li><b>Read your provider bill.</b> No access to your provider account, no reconciliation
      against an invoice, no estimate of what a call costs.</li>
      <li><b>Invent a dollar number.</b> You decide what a unit is worth. Units refused is what was
      asked for and denied; it is not a dollar figure.</li>
      <li><b>See a call that never asks.</b> An uninstrumented tool, a subprocess someone added last
      week, a retry buried in a library: invisible to the ceiling, because there is no proxy to see
      it.</li>
      <li><b>Bind a caller.</b> The ceiling is keyed on
      <span class="mono-in">(account_id, task_ref)</span>, so a loop that opens a new
      <span class="mono-in">task_ref</span> gets a new ceiling. It binds the task you named, not
      whoever is running it.</li>
      <li><b>Unwind a multi-step workflow.</b> Calls are refused, not reversed. Refusing the next
      call does not undo the calls that already ran.</li>
      <li><b>Guarantee the TTL fits your job.</b> A reservation not settled inside the TTL, 60
      minutes by default, is reclaimed by a sweeper that runs every five minutes, while your call
      may still be running. Set it longer than your longest call.</li>
      <li><b>Publish a latency SLO.</b> We do not have one. The free tier is
      ${num(PLAN_LIMITS.free)} calls with no card, which is enough to measure the added latency on
      your own workload instead of taking a number off this page.</li>
      <li><b>Replace observability.</b> It does not trace, sample or explain a run after it
      finished. If you want to know what last night cost, that is a different tool. Keep it.</li>
      <li><b>Replace your payment processor.</b> It sits in front of it.</li>
      <li><b>Give your ops team a no-code dashboard.</b> There is a console. The product is an SDK
      and one endpoint.</li>
      <li><b>Show you a logo wall, a customer count or a testimonial.</b> There is nobody yet who
      has agreed to be named. The install line, the free tier and the response bodies above are what
      is checkable instead.</li>
    </ul>
  </section>

  <div class="final wrap">
    <h2>Give one job a ceiling.</h2>
    <p>Free tier. No card. If this page took you longer to read than the integration takes, we did our job.</p>
    <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
  </div>

</main>
${siteFooter()}
${PLAYGROUND_JS}${COPY_JS}${TABS_JS}
</body>
</html>
    `)
  })
}
