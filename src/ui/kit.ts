import { BP } from './theme.js'
// The canvas components, defined once. Added 2026-09-23, the day Lior asked
// for every screen, the console included, in the design language he approved
// on the homepage.
//
// Before this file the homepage carried its buttons, chips, tags and labels in
// its own page-local CSS (home.ts), and the playground and the estimator read
// .eyebrow, .chip-ok and .chip-no from there, so a shared partial depended on
// one page's stylesheet. Every other screen had its own recipe for the same
// things: docs a square .tag, the console its own .chip, pricing its own
// ghost button. This is the one recipe, lifted from the homepage's computed
// values so `/` renders as it did.
//
// Every value is a token from theme.ts. No hex, no font-size literal: the
// ratchet in scripts/ratchet counts both.
//
// Included by CHROME_CSS, so every page that renders the site nav already has
// it. A page without the nav (the console, /admin) includes KIT_CSS itself,
// once, before its own CSS.
//
// Class names are the contract. The ones the homepage already used keep their
// names (.btn, .btn-lg, .btn-alt, .btn-ghost, .pill, .tag, .chip-ok, .chip-no,
// .eyebrow, .mono-in). Everything new is prefixed cv- (canvas), because the
// short names are taken by page-local rules: .panel is register's, .frame,
// .chip, .meter and .empty are the console's, .field is register's, and a
// shared rule under a taken name would leak half its declarations into a page
// that never asked for them.

export const KIT_CSS = `
  /* ---- The mono label voice. A small tracked uppercase label in the mono:
     the column heads of a table (CALL, UNITS), the label over a figure (THIS
     JOB), a section kicker. Never a heading and never a sentence. */
  .eyebrow { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: var(--track-label);
             text-transform: uppercase; color: var(--dim); margin-bottom: var(--s3); }
  .cv-label { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-label);
              text-transform: uppercase; color: var(--dim); }
  /* A code word inside a sentence: approved: false, task_ref. */
  .mono-in { font-family: var(--mono); font-size: .9em; color: var(--text); font-weight: 400; }

  /* ---- Actions. Pills at two heights, from the Figma Button component:
     L 44 (--h-lg) for the one action of a fold, M 40 (--h-md) everywhere
     else. One filled primary per fold (.btn, ink); the secondary beside it is
     a light fill (.btn-alt), never a second ink fill; an outlined pill
     (.btn-ghost) is an action that is not the fold's. */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2);
         min-height: var(--h-md); padding: 10px 20px; line-height: 20px; border: 0;
         background: var(--green); color: var(--green-ink); border-radius: var(--r-control);
         font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; text-decoration: none;
         white-space: nowrap; cursor: pointer; transition: background .15s, transform .12s; }
  /* One hover effect. A brightness filter on near-black moves nothing, so the
     ink lifts one step instead. */
  .btn:hover { background: var(--btn-hover); }
  .btn:active { transform: translateY(1px); }
  .btn-lg { min-height: var(--h-lg); padding: 10px 24px; line-height: 24px; font-size: var(--fs-body); }
  .btn-alt { display: inline-flex; align-items: center; justify-content: center; min-height: var(--h-lg);
             padding: 10px 24px; line-height: 24px; border: 0; border-radius: var(--r-control);
             background: var(--surface3); color: var(--text); text-decoration: none; font-family: var(--sans);
             font-weight: 500; font-size: var(--fs-body); white-space: nowrap; cursor: pointer; transition: background .15s; }
  .btn-alt:hover { background: var(--border); }
  .btn-alt:active { transform: translateY(1px); }
  /* 40 tall with its border: 9 + 20 + 9 + 2. */
  .btn-ghost { display: inline-flex; align-items: center; justify-content: center; min-height: var(--h-md);
               padding: 9px 19px; line-height: 20px; border: 1px solid var(--border2); border-radius: var(--r-control);
               background: transparent; color: var(--text); font-family: var(--sans); font-size: var(--fs-small);
               font-weight: 500; text-decoration: none; white-space: nowrap; cursor: pointer;
               transition: border-color .15s, color .15s, transform .12s; }
  .btn-ghost:hover { color: var(--text); border-color: var(--dim); }
  .btn-ghost:active { transform: translateY(1px); }
  .btn:disabled, .btn-alt:disabled, .btn-ghost:disabled { opacity: .45; cursor: not-allowed; transform: none; }

  /* ---- The announcement pill over a hero: a mono tag inside a light pill. */
  .pill { display: inline-flex; align-items: center; gap: 10px; padding: 5px 14px 5px 5px; border-radius: var(--r-pill);
          background: var(--surface2); border: 1px solid var(--border); font-size: var(--fs-small); color: var(--text); }
  .pill-tag { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-label); text-transform: uppercase;
              background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-pill); padding: 2px 10px; }

  /* ---- Tags and chips. A .tag names a thing (SAMPLE, an id with .tag-id);
     a chip is a decision, with a dot. .chip-ok is neutral on purpose: an
     approved call is not a colour. .chip-no is the refusal, the one place the
     signal hue is outlined. .chip-fail is a leak, the signal filled: spend
     that got past a ceiling and needs a human. .chip-near is approaching a
     limit, the one non-signal state colour. */
  .tag { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-chip); text-transform: uppercase;
         color: var(--muted); border: 1px solid var(--chip-line); border-radius: var(--r-pill);
         padding: 3px 10px; white-space: nowrap; background: var(--surface); }
  .tag-id { text-transform: none; letter-spacing: 0; }
  .chip-ok, .chip-no, .chip-near, .chip-fail { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono);
         font-size: var(--fs-micro); border-radius: var(--r-pill); padding: 3px 10px; white-space: nowrap; }
  .chip-ok { background: var(--chip-bg); color: var(--chip-ink); }
  .chip-no { background: var(--chip-no-bg); color: var(--chip-no-ink); border: 1px solid var(--chip-no-line); }
  .chip-near { background: var(--near-bg); color: var(--near-ink); }
  .chip-fail { background: var(--signal); color: var(--signal-ink); }
  .chip-ok::before, .chip-no::before, .chip-near::before, .chip-fail::before { content: ""; width: 6px; height: 6px;
         border-radius: 50%; background: currentColor; }
  /* What your code can do next: non-interactive pills, the frame's
     "Return what you have / Skip this step / Replan". Not buttons. */
  .cv-picks { display: flex; flex-wrap: wrap; gap: var(--s2); }
  .cv-pick { font-size: var(--fs-small); color: var(--text); padding: 6px 12px; border-radius: var(--r-pill);
             border: 1px solid var(--border2); background: var(--surface); }

  /* ---- Panel in panel: the frame for anything that shows product data.
     A pale warm-grey outer panel (--r-card) holds a white card (--r-inner)
     with a hairline. The card opens with a bar: an id tag, a muted label, and
     SAMPLE at the right when the data is not the reader's own. A split card
     gives its right column the warm-grey ground (.cv-side), which is where
     the one figure, its meter and the machine's answer sit. */
  .cv-panel { background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s5); min-width: 0; }
  .cv-card { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
             overflow: hidden; min-width: 0; }
  .cv-bar { display: flex; justify-content: space-between; align-items: center; gap: var(--s3);
            padding: var(--s3) 20px; border-bottom: 1px solid var(--card-line); }
  .cv-bar-t { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: var(--fs-small); color: var(--muted); }
  .cv-body { padding: var(--s3) 20px 20px; min-width: 0; }
  .cv-split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
  .cv-side { background: var(--side-bg); border-left: 1px solid var(--card-line); padding: var(--s5);
             display: grid; gap: 14px; align-content: start; min-width: 0; }

  /* ---- The figure: one big number over its unit, a thick meter with the
     ceiling as a signal tick at its end, and the one-line note under it. */
  .cv-stat b { font-family: var(--display); font-size: var(--fs-stat); font-weight: 500; letter-spacing: -0.02em;
               font-variant-numeric: tabular-nums; }
  .cv-stat span { color: var(--muted); }
  .cv-meter { position: relative; height: 10px; background: var(--meter-track); border-radius: var(--r-pill); }
  .cv-meter > i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--meter-fill); border-radius: var(--r-pill); }
  .cv-meter > u { position: absolute; right: -1px; top: -8px; width: 2px; height: 26px; background: var(--meter-tick); }
  .cv-no { font-size: var(--fs-small); color: var(--signal); }

  /* ---- Tables. Mono uppercase column labels, mono names, right-aligned
     tabular numbers (.num). Quiet by default, as the frame draws its log: no
     rule between rows, and the refused row tinted and rounded (tr.is-no).
     .is-ruled adds a hairline under every row, for dense or multi-line data.
     Wrap a table that can outgrow a phone in .cv-scroll. */
  .cv-scroll { overflow-x: auto; min-width: 0; }
  .cv-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-small);
              font-variant-numeric: tabular-nums; }
  .cv-table th { font-family: var(--mono); font-size: var(--fs-chip); font-weight: 400; letter-spacing: var(--track-label);
                 text-transform: uppercase; color: var(--th-ink); text-align: left; padding: 6px 10px; white-space: nowrap; }
  .cv-table td { padding: 9px 10px; color: var(--text); vertical-align: middle; }
  .cv-table .m { font-family: var(--mono); }
  .cv-table .num { text-align: right; }
  .cv-table .mut { color: var(--muted); }
  .cv-table tr.is-no td { background: var(--row-no-bg); color: var(--row-no-ink); }
  .cv-table tr.is-no td:first-child { border-radius: var(--r-row) 0 0 var(--r-row); }
  .cv-table tr.is-no td:last-child { border-radius: 0 var(--r-row) var(--r-row) 0; }
  .cv-table.is-ruled th, .cv-table.is-ruled td { border-bottom: 1px solid var(--row-line); }
  .cv-table.is-ruled tr:last-child td { border-bottom: 0; }
  .cv-table.is-ruled tr.is-no td { border-radius: 0; }

  /* ---- Code. Two frames, by who produced the text. The machine's answer (a
     wire body, a refusal, printed output) is on the near-black plate
     (.cv-code; .is-sm inside a side column). Your code, the sample a reader
     copies, is on a light card with a label bar (.cv-snip), grey on the white
     page and white inside a panel. */
  .cv-code { background: var(--plate); color: var(--plate-ink); border-radius: var(--r-inner); padding: 18px 20px;
             font-family: var(--mono); font-size: var(--fs-small); line-height: 1.7; overflow-x: auto; min-width: 0; }
  .cv-code.is-sm { border-radius: var(--r-field); padding: 14px 16px; font-size: var(--fs-micro); line-height: 1.5; }
  .cv-code .dim { color: var(--plate-dim); }
  .cv-code .no { color: var(--plate-signal); }
  .cv-snip { background: var(--snip-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner); min-width: 0; }
  .cv-panel .cv-snip { --snip-bg: var(--surface); }
  .cv-snip-h { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); min-height: var(--h-lg);
               padding: 0 16px; border-bottom: 1px solid var(--card-line); font-family: var(--mono);
               font-size: var(--fs-label); color: var(--dim); }
  .cv-snip pre { padding: 14px 18px; overflow-x: auto; font-family: var(--mono); font-size: var(--fs-code);
                 line-height: 1.7; color: var(--text); }
  .cv-snip .cmt { color: var(--dim); }
  /* The plate: one value a reader copies whole, a key or the line that sets
     it. A white plate with a hairline at --r-field, the value in the mono,
     and the Copy (.cp-btn, src/ui/copy.ts) at the right, where the homepage's
     copy pill has it. A rounded rectangle and not a pill, because a
     52-character key wraps at every phone width. break-all, because the line
     that sets a key starts with a short word: with only overflow-wrap the
     break falls after "export" and one command reads as two lines. A plate
     with no Copy (the recovery page, which ships no script) keeps the shape. */
  .cv-plate { display: flex; align-items: center; justify-content: space-between; gap: var(--s3);
              padding: 6px var(--s4); background: var(--surface); border: 1px solid var(--border);
              border-radius: var(--r-field); font-family: var(--mono); font-size: var(--fs-code);
              line-height: 1.5; color: var(--code-ink); min-width: 0; }
  .cv-plate:has(> button) { padding-right: 6px; }
  .cv-plate > code, .cv-plate > span { font: inherit; color: inherit; min-width: 0; padding-block: 5px;
              overflow-wrap: anywhere; word-break: break-all; }
  .cv-plate > button { flex: none; }

  /* ---- The close: the homepage's closing band, the warm-grey ground at
     --r-card with its heading and sentences centred. The one shape for a
     screen that is a done or a dead end: the receipt after checkout, and a
     recovery link that was sent, refused or spent. Words and prose links
     only; nothing in it is a second action. */
  .cv-close { background: var(--panel-bg); border-radius: var(--r-card); padding: 80px var(--s7);
              display: grid; justify-items: center; text-align: center; }
  .cv-close h1 { max-width: 22ch; margin-bottom: var(--s4); }
  .cv-close p { margin-inline: auto; max-width: 52ch; text-wrap: pretty; }
  .cv-close p:last-child { margin-bottom: 0; }

  /* ---- Callout: a note that belongs to the page, not to a row. Sample-data
     banners, "what this view reads from", a refusal notice (.is-no). */
  .cv-callout { display: grid; gap: 6px; background: var(--callout-bg); border: 1px solid var(--callout-line);
                border-radius: var(--r-inner); padding: var(--s4) 20px; font-size: var(--fs-small); color: var(--muted);
                line-height: 1.55; }
  .cv-callout b, .cv-callout strong { color: var(--text); font-weight: 500; }
  .cv-callout.is-no { background: var(--fail-bg); border-color: var(--fail-line); }
  .cv-callout.is-no .cv-label { color: var(--signal); }

  /* ---- Fields. 44 tall, --r-field corners, a 3:1 border, ink focus. The
     label sits above in the sans; .m sets the value in the mono (numbers,
     keys, ids). An error is one line of --red, never a filled block. */
  .cv-flabel { display: block; font-size: var(--fs-small); font-weight: 500; color: var(--muted); margin-bottom: var(--s2); }
  .cv-field { display: block; width: 100%; min-width: 0; min-height: var(--h-lg); padding: 10px 16px;
              background: var(--field-bg); border: 1px solid var(--field-line); border-radius: var(--r-field);
              color: var(--text); font-family: var(--sans); font-size: var(--fs-body); line-height: 22px; }
  .cv-field.m { font-family: var(--mono); }
  .cv-field::placeholder { color: var(--field-ph); }
  .cv-field:focus, .cv-field:focus-visible { outline: none; border-color: var(--field-focus); box-shadow: 0 0 0 1px var(--field-focus); }
  .cv-hint { font-size: var(--fs-micro); color: var(--dim); margin-top: 6px; line-height: 1.5; }
  .cv-err { font-size: var(--fs-small); color: var(--red); margin-top: 6px; line-height: 1.5; }

  /* ---- Segmented control: a period switch, a mode switch. 40 tall. */
  .cv-seg { display: inline-flex; align-items: center; gap: 2px; padding: 3px; background: var(--surface3);
            border-radius: var(--r-pill); }
  .cv-seg > a, .cv-seg > button { display: inline-flex; align-items: center; min-height: 34px; padding: 0 14px; border: 0;
            border-radius: var(--r-pill); background: none; color: var(--muted); font-family: var(--sans);
            font-size: var(--fs-small); text-decoration: none; white-space: nowrap; cursor: pointer; }
  .cv-seg > a:hover, .cv-seg > button:hover { color: var(--text); text-decoration: none; }
  .cv-seg > [aria-current], .cv-seg > [aria-pressed="true"], .cv-seg > [aria-selected="true"] {
            background: var(--surface); color: var(--text); box-shadow: 0 0 0 1px var(--border); }

  /* ---- A rail link: the console's views, any vertical list of places.
     The current one is a white pill on the rail's grey ground. .n is its count. */
  .cv-navlink { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); min-height: var(--h-md);
                padding: 0 var(--s3); border-radius: var(--r-row); color: var(--rail-ink); font-size: var(--fs-small);
                text-decoration: none; }
  .cv-navlink:hover { background: var(--rail-hover-bg); color: var(--text); text-decoration: none; }
  .cv-navlink[aria-current="page"] { background: var(--rail-on-bg); color: var(--rail-on-ink); font-weight: 500;
                box-shadow: 0 0 0 1px var(--border); }
  .cv-navlink .n { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; }

  /* ---- Empty state: the dashed frame. Says what would be here and the one
     step that fills it. Not for a screen that has content to show. */
  .cv-empty { display: grid; justify-items: center; gap: var(--s2); text-align: center; padding: var(--s6) var(--s5);
              background: var(--empty-bg); border: 1px dashed var(--empty-line); border-radius: var(--r-inner);
              color: var(--muted); font-size: var(--fs-small); line-height: 1.55; }
  .cv-empty b { color: var(--text); font-size: var(--fs-body); font-weight: 500; }

  @media (max-width: ${BP.lg}px) {
    .cv-split { grid-template-columns: minmax(0, 1fr); }
    .cv-side { border-left: 0; border-top: 1px solid var(--card-line); }
  }
  @media (max-width: ${BP.md}px) {
    .cv-panel { padding: var(--s3); border-radius: var(--r-card-sm); }
    .cv-bar { padding: 10px 12px; }
    .cv-body { padding: var(--s2) var(--s2) 14px; }
    .cv-side { padding: var(--s4); }
    .cv-table th, .cv-table td { padding-inline: 6px; }
    .cv-close { padding: var(--s7) 20px; }
  }
`

/** A decision chip. `no` is the refusal (approved: false) and nothing else. */
export type ChipKind = 'ok' | 'no' | 'near' | 'fail'
export const chip = (kind: ChipKind, text: string): string => `<span class="chip-${kind}">${text}</span>`

/** A tag that names a thing. `id` keeps the case, for a job name or a key prefix. */
export const tag = (text: string, id = false): string => `<span class="tag${id ? ' tag-id' : ''}">${text}</span>`

/** The label every sample frame carries in its own bar, so a screenshot carries it too. */
export const SAMPLE_TAG = tag('sample')

/** A mono label. */
export const label = (text: string): string => `<span class="cv-label">${text}</span>`

/**
 * The meter: used over ceiling, the ceiling a signal tick at the end. The
 * share is computed here from the two numbers, never passed in, so the bar
 * cannot disagree with the figure printed beside it.
 */
export function meter(used: number, ceiling: number): string {
  const pct = ceiling > 0 ? Math.min(100, Math.round((used / ceiling) * 1000) / 10) : 0
  return `<div class="cv-meter" aria-hidden="true"><i style="width:${pct}%"></i><u></u></div>`
}
