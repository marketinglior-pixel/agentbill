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

  The homepage (redesigned for conversion 2026-09-07, `src/routes/home.ts`)
  runs five rows under the playground, alternating, and the fifth is
  `.dip.wide`: the head keeps the diptych's columns (title left, argument
  right) and the console panel spans both beneath, so one row of a different
  shape closes the sequence instead of stamping a sixth. Two panels joined the
  set: keys (rows from `demoConsole().keys`, the endpoints from `KEY_COMMANDS`
  in `panels.ts`, which the console's keys view also renders) and a console
  overview (three tiles summed over the same series the console draws, the
  refusals by day, customers by share of spend, and the leak count). The hero's
  code frame carries a Python / Node tab strip (`src/ui/tabs.ts`): both
  samples are server-rendered and CI-executed, JavaScript off shows Python,
  and the install pill follows the tab so the pill and the sample always name
  the same package. The switch is a state change, not motion. The hero's
  second action is an in-page jump to the playground, not a second route: the
  cheapest proof is the one that runs without leaving the page.

  **Two classes outrank one.** `.dip.flip` sets its own tracks and the
  breakpoint rule named only `.dip`, so every flipped row kept two tracks on a
  phone and its panel rendered 150px wide beside its own paragraph. It shipped
  that way to production on 2026-09-06 and no gate saw it. The collapse rule
  now names the modifier too. A modifier that sets a layout property must be
  named again by every breakpoint that resets it.
- **App (`/app`, `/admin`):** Workbench. Function carries the page. No
  enrichment. The console's colour semantics are law: one token, one job
  (`--flow` ordinary traffic, `--held` AgentBill stopped something, `--near`
  approaching a limit, `--fail` needs a human).

  The console (`/app`, redesigned 2026-09-07) is an app shell: a sticky side
  rail (wordmark, account card with the plan meter, the views with their
  counts, the sample-data toggle, Docs, sign out or the one CTA) and a main
  column on the 1080 shell. Under `--lg` the same markup is a top bar and a
  horizontally scrolling view strip. The views are server-rendered by
  `?view=` (overview, activity, tasks, refusals, customers, keys, limits), so
  the rail's `aria-current` is a fact the server decided; the old "Jump to"
  rail could never carry a current state because every section rendered
  regardless. Rules that bind every view:
  - **One clock per view.** The period control in the view header scopes every
    figure that carries a window, and each such tile names the window in its
    own label (`Refused · 30d`). A figure with no window says what it is
    instead (`Live tasks · now`, `Leaked · all time`). The plan meter is about
    the billing month and lives in the account card, not among the tiles.
  - **Sums, not siblings.** Blocked, units refused and units metered are sums
    over the same `series` the chart draws, so a tile and the chart beside it
    cannot disagree. Under sample data the series is cut or tiled to the
    chosen window, so the period control means the same thing in both modes.
  - **The chart is two single-series rows sharing one x-axis**, each with its
    own scale and its own row label as its legend. Never a dual axis. Y ticks
    are nice numbers in a left gutter; one direct label, the peak; the hover
    readout is CSS (`attr(data-t)`) and lists every series at that day; the
    activity view carries the day-by-day table twin.
  - **Above the ceiling is a leak, not a trophy.** A task whose used units
    exceed its ceiling wears `--fail`, on the console and on the homepage
    panel alike; at the ceiling it is `--held`.
  - **Limits is a read-only ladder** of the four rules in the order
    `preflight.ts` evaluates them, each with where it is set, what refuses it,
    and the live counts. Nothing on the console edits a ceiling, and the page
    says so. A form for a setting the API does not have would be a lie.
  - The sample-data banner sits at the top of the main column, inside the
    frame a screenshot would carry; the account card under sample data shows
    the sample plan, because a real quota above invented tiles was the one
    number the banner's promise did not cover.
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
- **The lit edge goes on whatever is actually the top of the object.** An inset
  shadow paints on the padding box, so a panel that opens with an opaque
  `.panel-h` covers its own `--edge`; the strip carries its own. Measured before
  this was fixed, a panel's top border and its left border were both 35, meaning
  the bevel did not exist on any marketing panel.
- **A shadow has about ten levels of headroom on this ground; the frame has 245.**
  `--lift` is one close shadow only. Direction is said with
  `border-top-color: var(--border2)`, which is the mechanism the references use.
  The old outer `0 8px 24px` half moved the ground from 10 to 8 across three
  pixels and cost a paint on six call sites.
- `--code` is syntax. **`--code-ink` is the base ink inside a code frame**, and it
  is what a block gets; `--code` is for string literals and the token spans. Six
  declarations used to put `--code` on a whole block, which is how the docs SQL
  block came to measure 99% one hue against 63% achromatic on the reference set.
- A link at display size is a title, not an action: `h1 a` and `h2 a` are `--text`
  on the docs shell, with the accent left for the hover.
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

- `--shell` is the content width. Marketing, docs and blog run 1080px; legal
  runs 720px. (Blog was 780px until `280f24e` moved it onto the docs shell,
  which sets 1080. This file said 780 for a day after that stopped being true.)
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

A code frame that cannot be copied undercuts a page whose argument is "three
lines of code". `copyPill()` in `src/ui/copy.ts` is the control; one delegated
listener covers every instance, so one CSP hash does too. The label changes to
"Copied" and back, which is a state change rather than motion for mood.

The hero's install line is also the honest answer to the proof the references put
beside their primary action. Fourteen of fourteen show a logo wall or a customer
count within one screen of the CTA. This product has two external signups, so a
logo wall is unavailable and a fabricated one would break the claims rules. The
install line is what is true and actionable now: a step that needs no account.


One label for one action: `KEY_CTA` in `chrome.ts`, with `KEY_CTA_SHORT` for the
nav at its narrowest. The site carried seven wordings of this button, two of
which differed only by whether they had an arrow. Two labels stay outside the
constant because they are different actions: "Start free" on the price tables,
and "Generate my API key" on the register submit, which says what the button does
rather than where it goes.


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
`chrome.ts`. App pages carry no marketing footer; their closing `.foot` is an
in-page note. `/app` is the rail shell described under the App family;
`/admin` still keeps the older account bar (`nav.top`: wordmark, who is signed
in, sign out) and the console's login page uses the same bar. The three faces. `--green` as the only
chromatic accent for actions. A 44px floor on every button and input. Frames
at 12px radius, controls at 8px. The code-block frame: a typographic label
bar ("python · the whole integration"), never window chrome.

## What pages may differ on

Macrostructure within their family. Shell width per family. Whether a grid
break exists (marketing yes, content no).

`/pricing` is the spec-sheet variant of the marketing family, and its own stamp
records it: `enrichment: none, the table is the product surface`. The 2026-09-06
audit asked for a product panel there on the grounds that Split Studio pages put
one beside every claim. Declined: the table IS the panel on that page, and the
rule this file states is that macrostructure may differ within a family. A future
pass that wants to revisit it should change the stamp first.

## Known open gates (for the all-surfaces pass)

- `.pg-fill` animates `width`. Functional progress bar; `transform: scaleX`
  would be correct and also needs the ghost overlay reworked.
- The `--space-*` and `--radius-*` scales exist and are not yet applied
  everywhere: 86 hardcoded `font-size` literals remain, down from 152 (the
  console rewrite retired its 49, and `--fs-figure` joined the scale for the
  tile number). The
  ratchet in `scripts/ratchet` stops the count rising; a block retires its own
  values when it is next rewritten. Raw hexes below `:root` are at **zero** and
  the ratchet holds them there.
- `admin.ts` renders its own `nav.top` account bar and `app.ts`'s login page
  another. They share the mark and the tokens; the flex rules are written
  twice. The signed-in console no longer uses one.
- No `/status` page, so the footer has no honest trust link. `/health` returns
  JSON and must not be linked as one.
- `.pg-fill` animates `width`, see above.
- `legal.ts` sets prose links to `--code`, which is syntax only. Its contact
  address is still a personal gmail; that is a legal document, so it is a
  decision rather than a render fix.
- ~~No page has ever been checked by eye.~~ **Corrected 2026-09-06.** All nine
  surfaces were captured at 1440x1000 and 390x844 against production and read
  against sixteen premium references. 92 findings were raised, 29 were refuted
  because this file already argued the point, and 63 stood. They are fixed and
  deployed. The line was true for months and is the reason three of the findings
  were critical and invisible at 1440px.

  What replaces it is a habit, not a claim: **`npm run shots` renders every
  surface at both widths and fails on a non-200, a sideways scroll, a console
  error, or template source leaking into the body.** It found none of the 63.
  That is the point of keeping it: those four conditions were green throughout,
  and the page was still broken. The PNGs are the check; the exit code only
  catches what a machine can see.

## The share card

`/og.png` is a page like any other, rendered by `scripts/og/build.mts` from the
same sources as the pages it stands in for: tokens from `theme.ts`, the mark
from `mark.ts`, `HEADLINE` and `INSTALL_PY` from `site.ts`, and one refusal row
from `demoConsole()` composed by the console's own `decisionLine()`. Run
`npm run build:og` after any of those change and commit `src/lib/og-image.ts`.
The build refuses a card whose fonts fell back or whose content ran past the
frame.

It is the one surface that carries `--grad-vignette`: achromatic, and allowed
because a card is looked at rather than used. No product page may use it.

The previous card (2026-08-27, drawn in PIL) carried a retired headline, a
retired dollar claim, the 8px dot and a typewriter face for eleven days after
the head was swept, because a grep cannot see a PNG. **A copy sweep opens the
image.**

## Closing a row

An unequal two-column row is closed by a hairline, `.row-close` in `chrome.ts`.
It lives there because `chrome.ts` is the only stylesheet every page loads,
directly or through the docs shell.

The rule is about the bottom edge, not about the size of the void. A row whose
short side stops well above its tall side reads as an unfinished column unless
something draws its bottom; measured across sixteen premium references, not one
leaves an open-bottomed unequal row on flat ground, and Stripe's pricing ships a
row filling 39% with 115px under it that nobody notices because a hairline closes
it. Do not solve one of these by padding the short column or by cutting content
out of the tall one.

Applied to `.dip` on `/`, the register grid, the pricing includes grid and the
about portrait row. `.tiers` and the panels' `.task` / `.ref-row` predate the
utility and close themselves; a new marketing row uses the class.

## Alignment

Sibling sections obey one rule, visibly. Three diptychs on `/` used
`align-items: center`, which centred text blocks of three, four and three lines
against panels of three different heights, so each landed at a different
offset and the set read as generated. They are `align-items: start` with a 4px
optical nudge, and their measured offsets are 0, 0, 0.

## CTA voice, mobile

The primary action MOVES below `--md`, it is not duplicated. The nav is sticky
and already carries it, so a bottom bar beside it would put two copies of the
same button on one screen. The nav's button hides and `.sticky-cta` takes it.
Always visible; never on scroll, which this file forbids elsewhere and which
would need a scroll handler for mood.

Centred label text is permitted inside a full-bleed control and nowhere else. A
left-aligned label in a full-width button reads as broken.

Not on `/app`, `/admin`, `/register`, `/terms`, `/privacy` or `/pricing`: you are
already there, or a sticky sales button on a privacy policy is the wrong register.
`/pricing` joined that list on 2026-09-06: its whole purpose is the tier buttons,
so the bar put a second green fill on screen beside the one the reader came to
press, which is the duplication this rule exists to prevent.

The rule was written about the NAV's button and originally stopped there, so
every page on the docs shell still ended with an in-page green pill about 160px
above the full-width bar, same words and same href. A closing `.end` button now
stands down wherever the bar is present, keyed off `body:has(.sticky-cta)` rather
than off the breakpoint, so a page that opts out of the bar keeps its own.

## Resting states

The largest element on a page is never empty before interaction. A resting
state renders from the same source the interactive state renders from, and says
inside its own frame that it has not run yet. The homepage playground reserved
292px for a run it had not done and filled it with one line of text; it now
renders the plan, from the same `PLAN` the run walks, so the two cannot
disagree and the section says something with JavaScript off.

Growth in response to a click is not layout shift. The panel holds one height
through every approved call and grows once, when the refusal and the thrown
error appear, because that is new information arriving because the reader asked
for it.

## Log

`.hallmark/log.json` (gitignored) records each page pass. The stamp at the top
of a page's CSS names its macrostructure and this file:
`/* Hallmark · genre: modern-minimal · macrostructure: <name> · design-system: design.md · designed-as-app */`
