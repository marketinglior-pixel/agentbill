# Redesign plan: from competent to premium

> **CONSOLE REDESIGN 2026-09-07 (`/app`, `src/routes/app.ts`), merged and deployed: live = `5287cc6`, Fly v104.**
>
> After the first deploy (v100) a by-eye verification of production found one high defect the
> local captures had missed: on a phone the view strip scrolled sideways, so on three of the
> seven views the current item was off screen with no highlight. Under 960px the views now
> live in a native disclosure that names the current view, the pattern the site nav already
> uses. The same pass moved the x labels under their bars, turned the customers and keys
> tables into cards on a phone, and dropped the refused strip's peak label, which sat on the
> units chart's zero tick. Captured and looked at on every view at 390px this time.
>
> A second production pass (v101) found the scroll-edge fade dimming digits on tables that no
> longer scroll, the JSON body scrolling inside a phone card, the login card without a
> gutter, Docs unreachable from a phone, and the sample data claiming two leaks while listing
> one. All fixed in `fa8d4a1`; the sample's one leak is now derived from its rows.
>
> A completeness critic then ran the signed-in SQL verbatim against a database built from the
> repo's migrations (postgres.js 3.4.9, empty fragments included) and found an int4 product in
> the near-ceiling count that a task ceiling above 536,870,911 would have turned into a 500.
> Cast to bigint in `23d356b`, with the day table fitting a 375px phone.
>
> Before the merge an adversarial review of the diff (four lenses, three refuters per
> finding) confirmed six defects and raised eleven lower ones. The worst: array lengths
> of the 20-row pages were rendered as account totals in the rail, the Live tasks tile,
> the limits ladder and the "All N" headings, beside a refusals count that was a real
> count(*). Whole-account counts now come from SQL. Twelve findings were fixed and each
> fix was reproduced against the local server by its own agent before the merge.
>
> The console was audited by eye against production at 1440 and 390 and against
> the code that feeds it, then rebuilt as a workbench shell. What the audit found,
> and what moved:
>
> | Finding | Before | After |
> |---|---|---|
> | Wayfinding | a one-shot "Jump to" anchor list, gone after the first scroll; section heads 12px mono, smaller than table cells | sticky side rail with seven server-rendered views, counts, `aria-current` decided by the server; a top bar plus view strip under 960px |
> | Clocks | five numbers on four clocks (range, all time, this month, now) with defensive footnotes | one period control per view, scoping every windowed figure; each tile names its window; the plan meter moves to the account card |
> | Sample data | a signed-in user in `?demo=1` saw their REAL plan quota above invented tiles; 7d/90d showed a 30-day chart | account card shows the sample plan under demo; the sample series is cut or tiled to the window (7 / 30 / 90 columns, verified) |
> | Chart | dashed grid, ticks at 960/480, three ISO dates, y labels under bars, legend as prose | solid hairlines, nice ticks (1,000 / 500 / 0) in a left gutter, weekly `Aug 9` labels, one direct peak label, CSS hover readout with every series, day-by-day table twin on the activity view |
> | Leaks | a task at 13 of 5 wore a green "ceiling hit" chip | used above ceiling is `--fail` on the console and the homepage panel; "N past the ceiling" replaces "0 left" |
> | Guardrails | no surface at all; `default_budget_units` shown nowhere; ceilings scattered across three sections | a Limits view: the four rules in `preflight.ts` evaluation order, where each is set, what refuses it, live counts in the window, and the sentence that nothing here edits one |
> | Cost per client | usage vs limit only | customers ranked by lifetime spend with share of all customers' spend, on the overview and the customers view |
> | Refusals | a slashed `40 / 500 / 492` cell and a closed details | a composed sentence per row (`Asked 40 units with the task at 492 of 500.`), agent and task as filter links, `?task=` `?agent=` `?only=leaks` filters in SQL, cards instead of a six-column scroller on a phone |
> | Empty account | zero tiles, a zero leak row, then the onboarding box, then five "nothing yet" sections | the onboarding frame first, then the limits ladder, which is true at zero |
> | Type and labels | 49 font-size literals, seven mono-uppercase label styles | 0 literals in the file (ratchet 135 to 86), one `.lbl`, one `.chip`, headings on the display face |
>
> Verified on a local server against the local Postgres brought up to the full
> migration chain: 12 headless captures (sample, signed-in with real refusals and
> one real leak, empty account, login) at 1440 and 390, all 200, no sideways
> scroll, zero `<script>` tags, clean console; `npm run shots` green; DOM
> measurements at 320 and 414 (wordmark right 125 < account chip left 153, every
> control 44px). tsc, hygiene against the running server, snippets 43 blocks 0
> failures, ratchet down. Still zero JavaScript under `default-src 'none'`.
>
> Two things read against the code before they were written: the limits copy
> against `preflight.ts` (evaluation order, `default_budget_units` from
> `register.ts:440`, `task_ceiling_required` on an unknown task), and the leak
> rule against `tasks.ts` (`exceeded: used > ceiling`) and `events.ts`.


> **STATUS 2026-09-06: all five waves are implemented on `wave-1-rendering-defects`,
> six commits, `d2a9c32` through `e135e34`. Not merged and not deployed.**
>
> Every change was verified against a LOCAL server whose page heights matched
> production exactly on all 18 captures. What moved, measured:
>
> | | before | after |
> |---|---|---|
> | /docs API table on a phone | 420px in a 342px box, cells unreachable | 342px, 0 cells past the viewport |
> | Console chart tallest bar | 55% of a plot labelled 960 | 100%, touches its own label |
> | /pricing mobile row rules | stubs ending at 3 different x | full-width rules only |
> | Title to section head | 1.06x | 1.47x desktop, 1.33x phone |
> | Diptych panel widths | 569 / 408 / 569 | 569 / 569 / 569 |
> | Panel top edge vs left border | both 35, no bevel | 61 vs 35 |
> | Ground to surface step | +7 | +12 |
> | /register column rag | 410px | 1px |
> | Visible primaries on a phone | 2 on six pages | 1 |
> | Chromatic pixels, /blog | 118,477 | 29,175 |
> | Chromatic pixels, /docs | 221,239 | 128,920 |
> | Docs prose measure | 86 characters | 54 to 67 |
>
> Repo checks all green throughout: tsc 0, hygiene, snippets, and the drift
> ratchet, whose font-size baseline this work LOWERED from 137 to 135.
>
> **One prescription was applied, measured, and reverted:** moving the nav's
> active-page bar to the dim end of the brand hue. A 2px rule at that value is
> invisible on this ground, so wayfinding fell back to the text colour alone.
> The reason is in `chrome.ts` and the two tokens it needed were removed rather
> than left inert.
>
> **One was declined and recorded in design.md:** a product panel on /pricing.
> That page's own stamp says the table is the product surface.
>
> **Still open, deliberately:** positioning and copy, which `current-state.md`
> holds for phase 2, and the contact address in `legal.ts`, which is a legal
> document rather than a render. `/about` is the one page whose absolute green
> rose, by 14%, because unifying the CTA label made its two buttons wider.


Written 2026-09-06. Companion to `design.md`, which stays the authority on the system.
This file is the work order that closes the gap between the system and what actually renders.

## How this was produced, so you can trust or discard it

Nine surfaces were captured full-page at 1440x1000 and 390x844 with headless Chromium,
against production. Sixteen premium references were captured the same way: Linear, Stripe,
Vercel, Resend, Clerk, Polar, Railway, Modal, Neon, Warp, Browserbase, Upstash, Langfuse,
Helicone, plus the Stripe and Linear pricing pages. Thirty-eight agents then audited the
screenshots by eye, one per surface and one per comparison axis, and every finding was put
to a second agent whose instructions were to refute it and whose default was REFUTED.

**92 findings were raised. 29 were refuted and killed. 63 survived.** Most of the 29 died
because `design.md` already argues for the thing being criticised. That is the number to
look at first: a third of what an audit wants to tell you about this codebase is already
answered in the system file.

The capture script is `scripts/shots.mjs`. It is the reason this plan exists and it is the
last item in it.

## The diagnosis, in one paragraph

The system is not the problem. `design.md` is better than most design systems that ship
with a Series A, and the audit's own refutation rate proves it. The problem is that
`design.md` ends with a line nobody acted on: *"No page has ever been checked by eye. Every
verified in the log below is grep and arithmetic. That is how a 230px empty panel shipped."*
That is exactly what happened, nine more times. Every surface scored 5 or 6 out of 10, and
not one of them scored low because of a bad decision. They scored low because the decisions
were never looked at after they rendered.

## The single most useful thing the audit found

AgentBill's unequal two-column rows have **no bottom edge**.

The homepage diptychs fill 52%, 58% and 58% of their panel height and leave voids of 134px,
123px and 80px. The obvious reading is "the void is too big". It is the wrong reading.
Stripe's pricing page ships a row that fills **39%** and leaves **115px** of void, which is
proportionally worse than anything on AgentBill, and nobody has ever noticed, because a
full-width hairline closes the row and the two cells sit on two different grounds.

Across fourteen reference slices, **not one** leaves an open-bottomed unequal row on flat
ground. Every one closes the row: by rule, by band, by card, by pinned CTA, or by a split
ground. AgentBill gives the panel an edge and gives the row nothing, so the short column
terminates into identical ground and the eye reads an unfinished column instead of a closed row.

**Do not fill the voids. Close the rows.** This one change addresses the dominant complaint
on `/`, `/register`, `/pricing` and `/about` at once, and it costs one shared utility class.

---

# P0. It is broken on a phone

Not opinions. Bugs, on the viewport where paid clicks land. Ship these before anything else.

| # | Defect | File |
|---|---|---|
| 1 | Every mobile tier row is bisected by a half-width hairline stub, at three different arbitrary x positions. The FREE row carries two, stacked 16px apart. `th.tier` keeps the base rule's border because the `max-width:720px` reset covers `td` only. | `src/routes/upgrade.ts` |
| 2 | The API reference table is 420px inside a 342px container with `overflow-x: clip` on html/body, so roughly half of every parameter description is **permanently unreachable**. Not scrollable. Gone. | `src/ui/docs.ts` |
| 3 | The activity chart's y-axis does not describe its own bars: the top gridline is labelled with the max units day but the units segment is scaled to 55% of plot height, so anyone reading a bar against the axis gets a wrong number. | `src/routes/app.ts` |
| 4 | The hero code sample is mangled by `pre-wrap`: indentation half preserved, half destroyed, in the panel captioned "the whole integration". | `src/routes/home.ts` |
| 5 | `BUILDER` and `50,000` collide in the mobile pricing table. `.tier { width: 18% }` gives 61.6px for a label needing 63px. | `src/routes/home.ts` |
| 6 | The `/preflight` JSON is cut mid-token flush against the frame, in the panel captioned "the entire integration surface". | `src/ui/panels.ts` |
| 7 | The hero label bar amputates `agentbill-sdk` mid-glyph against the panel border. | `src/routes/home.ts` |
| 8 | The FAQ rail chops a link mid-word at the screen edge, no ellipsis, unreachable. | `src/ui/docs.ts` |
| 9 | The scroll-fade mask is applied to the element that also carries the border and radius, so four code panels dissolve their own right frame and corners. | `src/ui/docs.ts` |
| 10 | An inline code chip breaks across a line, rendering one endpoint as two pills. | `src/ui/docs.ts` |

**Also P0, and not a rendering bug:** a personal gmail address is the rendered incident
contact on `/status`. That is the trust surface.

---

# P1. Four token-level deficits

Each is one edit that propagates everywhere. This is the highest ratio of result to risk
in the whole plan.

## 1. The type scale collapses above the hero

Measured: the step from page title to section head is **1.06x** across the entire 780-1111px
laptop band, and 1.08x on mobile. On `/docs` the h1 cap height is *shorter* than the h2 ink
beside it. Every reference clears **1.6x**; the tightest measured were Neon at 1.47x and
Linear at 1.34x, and Modal runs a five-rung scale with a 1.9x section-to-card step.

The hero is fine. Everything below it is one size.

- `theme.ts`: widen `--fs-h1-sub` to `clamp(32px, 5vw, 50px)`, leaving `--fs-h2` alone. The
  vw slopes pull apart (5.0 vs 3.4) and the step becomes a constant ~1.47x at every width.
- `theme.ts`: `--fs-h3` from 19px to 22px. At 19 it is 1.06x the lede, which is why no
  content page adopted it and two pages routed around it in opposite directions.
- `docs.ts`: h3 currently renders at `--fs-micro` (12px) in `--dim`, so the third heading
  level is **smaller and dimmer than the body it introduces** and identical to table
  headers, the breadcrumb and the rail label. Give it the display face at `--fs-h3`.
- `home.ts`: the three diptych heads are `<h2>`, the same 34px as the section that governs
  them. Demote to `<h3>`.

## 2. All three depth mechanisms measure to nothing

- `--edge` at 0.055 computes to exactly `#1e1e1e` over `--surface` and exactly `#232323`
  over `--surface2`. **The lit edge is set to the same value as the border it is supposed
  to sit above.** It is invisible by arithmetic.
- The inset highlight paints on the padding box, and `.panel-h` has an opaque
  `background: var(--surface2)` that covers it. All five panels open with a `.panel-h`, so
  the bevel is +0 on every panel that has one.
- `--bg` at `#0a0a0a` (10) puts `--surface` only 7 levels up. Every dark reference commits
  harder: Polar +8 borderless, Linear +11, Neon +17, Modal's bevel +34, Resend's lit centre +57.

Fix: deepen `--bg` to `#050505`, raise `--edge` so it clears the border, and move the lit
edge out from under the header strip.

## 3. Colour: the brief's premise does not survive measurement

**You asked for premium and implied more colour. The measurement says the opposite.**
Chromatic pixel share: Linear 0.06%, Polar 0.00%, Vercel 0.00%, Clerk 0.06%, Resend 0.32%,
Warp 0.59%. AgentBill's pricing page is **0.84%**. Four references that read unmistakably
premium are *less* colourful than AgentBill already. Linear's and Polar's primary CTAs are
white, not their brand hue.

Adding a second accent would also be a finding `design.md` already answers. So the work is
subtraction, not addition:

- Six declarations set `color: var(--code)` on a **whole block**, so entire code panels
  render lime. `--code` is syntax only, by the system's own rule.
- The API reference parameter column is on `--code`, so `agent_id`, `task_ref`,
  `estimated_units` and the rest run lime down the whole page.
- Blog index headings inherit `a { color: var(--green) }`, so every post title is green.
- Add `--green-bg: #0e2a20` and `--green-line: #1b4a3a` as general-purpose dim steps of the
  brand hue, so green can appear as a ground rather than only as a saturated fill.

## 4. Close the rows

Add one utility to `src/ui/panels.ts`:

```css
.row-close { border-bottom: 1px solid var(--border); }
```

Apply to the four grids that currently end in an unmarked rag: `.dip` on `/`, the register
grid, the pricing includes grid, and the about portrait row. Make the padding symmetric.
See the diagnosis section above for why this beats filling the space.

---

# P2. Conversion craft

`/register` has produced two external signups ever. These are the specific deltas against
fourteen references.

1. **The pricing page spends three filled green buttons on three tiers a stranger cannot
   buy, and gives the free tier the outlined chip.** Linear's pricing page has the same
   four-tier structure and the opposite emphasis. `design.md` already says one primary per
   fold. Swap the ternary in `upgrade.ts:63`.
2. **Seven different labels for one action.** "Get API key", "Get your API key", "Start
   free", "Generate my API key", "Unlock checkout"... Export one constant from `chrome.ts`.
3. **Two identical green CTAs on one phone screen** at the tail of `/about`, ~160px apart,
   which `chrome.ts` own comment forbids for the nav button and never extended to in-page CTAs.
4. **The register form's two `<select>`s render their empty state at full text strength
   while the inputs grey theirs**, so the bottom half of the form reads as already answered.
   Separately: only `email` is `required`, but the two selects are not labelled optional the
   way the name field is, so a visitor reads two mandatory dropdowns that do not exist.
5. **A 440x410px void in the lower right of `/register`**, plus a further 195px band where
   the section's 88px bottom padding and the footer's 88px top margin fire at the same seam.
   Fill it with the content the page already contains and hides: the success state's Next
   steps, as a resting panel that the success state swaps in place.

**One reference move that AgentBill must not copy.** Fourteen of fourteen references put
proof within one screen of the primary action: logo walls, "10,000+ companies", customer
counts. AgentBill has two external signups and zero customers. A logo wall is unavailable
and a fabricated one would violate `voice-dna`'s claims rules outright. The honest
substitute is the commitment step that needs no account: a copyable `pip install
agentbill-sdk` under the hero CTA pair, and a copy control on every code block, which the
label-bar component is already positioned to host.

---

# P3. Page-level

- `.dip.flip` reorders the DOM item but not the grid track, so the middle diptych's panel is
  **161px narrower** than its two siblings. Add the mirrored `grid-template-columns`.
- `/about` uses the docs rail for a four-section, ~450-word page. On mobile it puts 312px of
  navigation furniture above the H1. `docs.ts` already ships `.no-rail`, used by `/status`,
  `/blog` and `/thanks` for exactly this reason. Pass it.
- `/pricing` is named in `design.md` as a Split Studio surface where every claim sits beside
  a panel showing the product doing what the claim describes. It has no panel.
- `/docs` prose runs 86 characters, because `68ch` was read as 68 characters and `ch` is the
  width of a zero. Set `54ch`.
- The `SAMPLE DATA` banner is amber, which gives amber a second job on a page whose own CSS
  comment says amber means "approaching a limit" and nothing else.

---

# P4. The change that prevents the next 63

Everything above exists because rendering was verified by grep and arithmetic, and
`design.md` says so in writing.

`scripts/shots.mjs` captures all nine surfaces at two viewports against any base URL and
reports status, document height, horizontal overflow and console errors. It found zero
console errors and zero overflow, which is real information: the failures here are all
*visual*, and no amount of DOM assertion would have caught one of them.

Make it a gate:

1. Check in `scripts/shots.mjs` and add `npm run shots`.
2. Run it before every deploy that touches a rendered surface. Look at the mobile set. Most
   of P0 is invisible on a 1440px desktop and obvious on a 390px phone.
3. Extend the `scripts/ratchet` idea: fail the build on horizontal overflow or a non-200,
   which is cheap and catches the class of defect that produced items 2 and 8.

The rule this closes is already in `voice-dna.md`: **verify the effect, not the presence.**
A page that returns 200 with no console errors and an unreachable table has passed every
check this repo runs and is still broken.

---

# Sequencing

| Wave | Contents | Why first |
|---|---|---|
| 1 | P0 items 1-10, the gmail address, `npm run shots` checked in | They are bugs, they are on mobile, and the script is what proves they are fixed |
| 2 | P1.1 type scale, P1.4 close the rows | Two edits, largest visible change, near-zero risk |
| 3 | P1.2 depth, P1.3 colour subtraction | Token-level, needs a rendered check after each |
| 4 | P2 conversion | Touches the surface with two signups, so change one thing at a time |
| 5 | P3 page-level | Restructuring, do it last, and re-read every caption that moves. `design.md` already records that moving a section is exactly when a caption starts contradicting its neighbour |

## What this plan does not do

It does not touch positioning or copy. `current-state.md` section 8 records that the
headline moves from the ceiling to the statement, and section 9 puts that in Phase 2. The
homepage still leads with "Your loop won't stop itself", which is the old position. That is
a deliberate hold, not an oversight, and it is out of scope here.

It also does not add a second accent colour, a logo wall, decorative motion, gradients or
scroll reveals. Three of those `design.md` forbids, one the measurement refutes, and one
would be a fabricated claim.
