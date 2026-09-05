# Design · AgentBill

The locked design system for every rendered page. A page redesign reads this
file before it emits anything. Extend or amend this file when the system needs
to grow; do not regenerate a system per page.

The **tokens live in `src/ui/theme.ts` and nowhere else.** This file does not
copy their values. Two representations of one fact drift the first time either
is edited, so this file names the tokens and says how to use them, and
`theme.ts` says what they are. If a page needs a colour that is not in
`theme.ts`, add it to `theme.ts` (or to the page's own `:root` block when it is
genuinely page-local), then reference it. No hex below the `:root` line of any
page.

## Genre

modern-minimal, dark. A brilliant systems engineer's page: terse, precise,
trusts the reader, hates decoration.

## Macrostructure families

- **Marketing (`/`, `/pricing`, `/register`):** Split Studio. Every claim sits
  beside a panel that shows the product doing what the claim describes. The
  panels render from the same data the console renders (`demoConsole()`,
  `PLAN_LIMITS`), never from copies. One deliberate grid break per page (on `/`
  it is the refusal band).
- **App (`/app`, `/admin`):** Workbench. Function carries the page. No
  enrichment. The console's colour semantics are law: one token, one job
  (`--flow` ordinary traffic, `--held` AgentBill stopped something, `--near`
  approaching a limit, `--fail` needs a human).
- **Content (`/docs`, `/docs/*`, `/blog/*`):** Long Document with a sticky
  "On this page" rail (S3) docked beneath the nav. Typography only. Code blocks
  are the panels.

## Type

Three faces, three jobs, no overlap (see the comment block in `theme.ts`):

- `--display` Archivo, every heading. The human voice.
- `--sans` Inter, body. Preserved deliberately; the anti-slop canon dislikes
  Inter as a body face and this project keeps it anyway, because the mono and
  the display do the differentiation and the body is meant to disappear.
- `--mono` JetBrains Mono: code, data columns, key strings, labels over
  numbers, the wordmark. The mono is a third surface here by design, not an
  outlier register. That is a knowing departure from the 2+1 rule.

Headings are roman. Never italic. Emphasis is weight or colour.

## Colour

- Paper `--bg`, surfaces `--surface` / `--surface2` / `--surface3`, elevation by
  lightness not by shadow, plus `--edge` (one lit pixel on a raised surface) and
  `--lift` (the shadow under it). Use them together or not at all.
- `--green` is the brand and the primary action. Links are `--green`.
- `--code` is **syntax only**. Not links, not emphasis, not prose.
- `--red` and `--amber` are states that need a human. Red means exactly one
  thing on a page; on the console it means a leak.
- Console semantics are global tokens in `theme.ts`, not per-page copies:
  `--flow` / `--flow-ink` (ordinary traffic), `--res` (units held by an
  unsettled reservation), the chip grounds and hairlines `--held-bg` /
  `--held-line`, `--near-bg` / `--near-line` / `--near-ink`, `--fail-bg` /
  `--fail-line` / `--fail-ink`, and `--bg-deep` (the ground under code inside a
  surface). The console aliases `--held` / `--near` / `--fail` to the brand
  green, amber and red for its own readability; those aliases stay in `app.ts`.
- Borders: `--border` is decorative. Anything that carries an affordance uses
  `--border-strong`, which clears 3:1. Assume any hand-picked dark border fails
  until measured.

## Spacing and layout

- `--shell` is the content width. Marketing and docs run 1080px, blog 780px.
  `.wrap` / `.container` own the inline axis (`padding-inline`); sections own
  the block axis (`padding-block`). Never the `padding` shorthand on either.
- Uneven rhythm on purpose. Sections do not share one padding value.
- Every grid track that can hold wide content is `minmax(0, 1fr)`.
- `html, body { overflow-x: clip }` (in `theme.ts` BASE). Inner scrollers
  (`pre`, `.req`) scroll themselves; the document never scrolls sideways.
- Sticky anything below the nav docks at `top: var(--banner-height)`
  (declared in `chrome.ts`, matches the nav's height).
- The codebase has no named `--space-*` scale; spacing is house px values. A
  named scale is a future system change, not a per-page one.

## Motion

Nothing decorative. The playground's functional motion (bar fill, row slip,
the thrown-error pop) is the only motion on the marketing page. `theme.ts`
BASE collapses everything under `prefers-reduced-motion`. No `transition: all`,
no hover-scale, no glow transitions, no scroll-triggered reveals.

## Copy rules that bind the design

From `C-core/voice-dna.md`, enforced on every rendered surface:

- **No em dash.** Anywhere. Grep before shipping.
- **Name what the number is not.** A figure this audience can check gets its
  limit stated beside it, in the same frame.
- **Sample data says so inside its own frame**, so a screenshot carries the
  label. Never manufacture history to improve a screenshot.
- **A number shown beside another number is derived from it**, never
  maintained alongside it.
- **Claims match the code.** Copy that describes a mechanism is checked against
  the source before it ships. The locked mechanism is in `voice-dna.md`.
- **When a section moves, re-read what it now sits beside.** The refusal band
  captioned `str(TaskCeilingExceededError)` as "the response body your code gets
  back" while the playground rendered the actual body one scroll below it.
  Neither was wrong when written; the contradiction was made by the layout.
  A grep cannot find this one, and restructuring a page is exactly when it
  appears.
- **Never name a competitor.** Position against the gap.
- **One representation per fact.** Every number a page shows is rendered from
  the one place that defines it: tier limits, prices and order from
  `src/integrations/polar.ts` (`PLAN_LIMITS`, `PLAN_PRICES`, `PLAN_ORDER`,
  the same tables preflight enforces); the sample account from
  `demoConsole()` in `app.ts`; console colours from `theme.ts`. A value typed
  into a second file, even with a comment saying it matches, is a copy that
  will drift.
- **Tiers sell headroom, not capability.** Nothing in the code gates a
  feature by plan; only `PLAN_LIMITS` is read. Pricing copy therefore lists
  every shipped feature as included on every plan, and the only per-tier lines
  besides calls and price are service promises, labelled as service.

## CTA voice

- Primary: `.btn` from `chrome.ts`. Green fill, `--green-ink` text, 8px radius,
  `nowrap`, clears 44px.
- Secondary: outlined chip (`.btn-ghost`, `.chip-link`). `--border-strong`
  hairline, text colour, `nowrap`.
- One primary per fold. Labels are verbs and fit 272px at 320px viewport.

## What pages must share

The nav and footer from `chrome.ts` on marketing and content pages. The nav is
N1b, three sections: wordmark left, destinations centred (Docs, Pricing,
GitHub) with the current page marked by a bar flush with the hairline, and
the account pair right (Console, then the primary action). Under 720px the
destinations and Console fold into a native `<details>` menu, no script. The
bar is solid, not frosted-on-scroll. Both link lists render from one array in
`chrome.ts`. App pages
(`/app`, `/admin`) keep their own account bar (`nav.top`: wordmark, who is
signed in, sign out or the one CTA) and carry no marketing footer; their
closing `.foot` is an in-page note. The three faces. `--green` as the only
chromatic accent for actions. A 44px floor on every button and input. Frames
at 12px radius, controls at 8px. The code-block frame: a typographic label
bar ("python · the whole integration"), never window chrome.

## What pages may differ on

Macrostructure within their family. Shell width per family. Whether a grid
break exists (marketing yes, content no).

## Known open gates (for the all-surfaces pass)

- `.pg-fill` animates `width`. Functional progress bar; `transform: scaleX`
  would be correct and also needs the ghost overlay reworked.
- No `--space-*` scale.
- Blog shares none of the docs CSS yet.

## Log

`.hallmark/log.json` (gitignored) records each page pass. The stamp at the top
of a page's CSS names its macrostructure and this file:
`/* Hallmark · genre: modern-minimal · macrostructure: <name> · design-system: design.md · designed-as-app */`
