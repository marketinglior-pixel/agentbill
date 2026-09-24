import { ORIGIN, abs, byPath } from './site.js'
import { policy } from '../lib/csp.js'
// The single source of truth for the site's design tokens and page shell.
//
// Before this file existed every route carried its own inline <style> with its
// own hex values: 11 style blocks, 57 unique colours, five h1 sizes and two
// display typefaces across nine files. Nothing enforced consistency, so each
// edit drifted a little further from the last.
//
// The tokens stay inline rather than moving to a served .css file on purpose.
// /app renders a live API key under `default-src 'none'` and only allows
// `style-src 'unsafe-inline'`; serving a stylesheet would mean widening that
// header on the one page where it matters most. Inlining a shared constant
// fixes the divergence, which is the actual defect, without touching CSP.

/**
 * Breakpoints.
 *
 * A CSS custom property cannot be used in a media query, so this is the one
 * place a breakpoint is written and every file interpolates it. There were six
 * ad hoc values across the codebase (960, 900, 820, 720, 640, 400), each picked
 * per file. 900 folds into lg, which is where /docs already collapses.
 *
 * 820 is left alone for now: it is the playground's own content pressure, not
 * a layout breakpoint, and it should be settled by looking at the page rather
 * than by decree.
 */
export const BP = { lg: 960, md: 720, sm: 640, xs: 400 } as const

/**
 * The three brand colours, as values rather than as CSS custom properties.
 *
 * This is not a second representation of a token: TOKENS below interpolates
 * these, so :root is rendered from them and there is still one definition.
 * They exist because three surfaces cannot read a CSS variable at all. A
 * <meta name="theme-color"> takes a colour, not a var(). So does the web app
 * manifest, which is JSON. And the favicon is a standalone SVG document with
 * no :root of the page to inherit from.
 */
export const BRAND = {
  // #0a0a0a put --surface only 7 levels up and the step did not read. Every dark
  // reference either drops the ground or lifts the surface: Neon 0, Resend 0,
  // Polar 9, Linear 8. At 5 the same --surface #111111 reads +12, which is
  // Linear's own ratio. Read literally by the theme-color meta and the manifest.
  bg: '#050505',
  green: '#22d3a0',
  greenInk: '#05130e',
} as const

/**
 * The paper theme's three fixed values, for the same three surfaces that cannot
 * read a CSS variable: the theme-color meta, the manifest and the favicon.
 * `signal` is the refusal, and it is deliberately not a second brand colour:
 * nothing but a refused call may use it.
 */
export const PAPER = {
  bg: '#F2F0E9',
  ink: '#15130F',
  signal: '#C2410C',
} as const

/**
 * The canvas theme's fixed values, for the surfaces that cannot read a CSS
 * variable (the theme-color meta). White ground, near-black ink, and one
 * refusal hue at 5.72 on the ground. Same rule as PAPER: the signal is the
 * refused call and nothing else.
 */
export const CANVAS = {
  bg: '#FFFFFF',
  ink: '#0A0A0A',
  signal: '#B93A0A',
} as const

/**
 * The dark theme's colour, type and spacing tokens. Every route rendered these
 * until 2026-09-23; since then canvas is the default and this block is the
 * revert path (theme: 'dark'), kept whole so the revert is one argument.
 */
export const TOKENS = `
  :root {
    /* Both the meta and the property. The meta tells the UA before CSS parses;
       this is what actually drives native scrollbars, form controls and the
       autofill background, and without it a dark page still gets light ones. */
    color-scheme: dark;
    /* ground */
    --bg: ${BRAND.bg}; --surface: #111111; --surface2: #161616; --surface3: #1a1a1a;
    /* borders. --border is decorative; anything that carries an affordance
       must use --border-strong, which clears the 3:1 of WCAG 1.4.11. */
    --border: #232323; --border-soft: #1e1e1e; --border2: #2c2c2c; --border-strong: #5c645f;
    /* ink. All four clear AA on --bg. */
    --text: #e8ebe9; --muted: #a0a8a3; --dim: #868e88; --white: #ffffff;
    /* signal. --green is the brand and the primary action; --code is syntax
       only; --red and --amber are states that need a human. */
    --green: ${BRAND.green}; --green-ink: ${BRAND.greenInk}; --code: #a8ff78;
    /* The base ink inside a code frame. --code is syntax, and design.md has said
       so all along, but six declarations set it on a whole block, so the docs SQL
       block measured 99% one hue and the register JSON block 90%, against 63%
       achromatic on Modal and 80% on Upstash. A page of solid lime reads as a
       terminal screenshot, not as a document. Slightly green-leaning rather than
       pure grey, so the frame still belongs to this palette. */
    --code-ink: #cfd6d2;
    --red: #ff5757; --amber: #f5b942;
    /* Roles, not hues. --green is the PRIMARY ACTION and --signal is the
       REFUSAL; on the dark theme one value plays both parts, which is exactly
       why the homepage read as a page decorated in mint rather than a page
       that means something by it. The paper theme splits them, and a component
       written against these names renders correctly under either. */
    --signal: ${BRAND.green}; --signal-deep: ${BRAND.green}; --signal-ink: ${BRAND.greenInk};
    /* A plate is the ground for anything the MACHINE produced: a code frame, a
       wire body, a video still. On the dark theme it is one step under the page
       and on paper it is the page's opposite. */
    --plate: #0d0d0d; --plate-ink: #cfd6d2; --plate-dim: #868e88; --plate-signal: ${BRAND.green};
    /* The sticky nav's own ground. It was hardcoded rgba(5,5,5,0.92) inside
       chrome.ts, the one colour on the site that lived outside this file. */
    --nav-bg: rgba(5,5,5,0.92);
    /* Console semantics, shared by every page that shows the console's rows
       (the console itself, the homepage panels). --flow is ordinary traffic,
       --res is units held by a reservation that has not settled, the *-bg /
       *-line pairs are chip grounds and hairlines, --bg-deep is the ground
       under code that sits inside a surface. One copy, here: app.ts and
       home.ts each used to carry their own. */
    --flow: #5d6b75; --flow-ink: #97a6b0; --res: #3a444b; --bg-deep: #0d0d0d;
    --held-bg: #0e2a20; --held-line: #1b4a3a;
    --near-bg: #2b220e; --near-line: #4a3a12; --near-ink: #e0cfa0;
    --fail-bg: #2a1212; --fail-line: #4a1d1d; --fail-ink: #ff8a80;
    /* Type. Three faces, three jobs, no overlap.
       --display carries every heading. It is a narrow industrial grotesque, so
       it reads as infrastructure and, more importantly, it contrasts with the
       mono instead of imitating it: the headings are the human voice and the
       code output is the machine's. Setting headings in mono, which is what
       this site did everywhere, collapses that distinction into costume.
       --mono is for code, data columns, key strings and the wordmark. Nothing
       else. */
    --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif;
    --sans: 'Inter', system-ui, -apple-system, sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

    /* A five-step scale with large intervals. The old set ran
       46 / 26 / 15.5 / 15, so a card title and its body text were half a pixel
       apart and nothing read as a hierarchy. Weight and colour carry the rest. */
    --fs-display: clamp(40px, 5.4vw, 58px);
    --fs-h2: clamp(24px, 3.4vw, 34px);
    /* Clamped, not fixed. At a flat 22px the mobile ladder read 32 / 24 / 22,
       so h2 to h3 was 1.09x: the same flattening this scale exists to prevent,
       one rung down. The clamp gives 24 / 19 on a phone (1.26x) and 34 / 22 on
       a laptop (1.55x). */
    --fs-h3: clamp(19px, 2.2vw, 22px);
    --fs-lede: 18px;
    --fs-body: 16px;
    --fs-small: 13.5px;
    --fs-micro: 12px;

    /* The two rungs below --fs-micro. About sixty of the hardcoded sizes in
       this codebase live down here, and they were twelve distinct values
       between 10 and 15.5px, half a pixel apart in places, which is the same
       "nothing reads as a hierarchy" defect the scale above was created to fix,
       one rung lower. The real vocabulary is two things: a tracked uppercase
       label, and a chip. */
    --fs-label: 11.5px;
    --fs-chip: 11px;
    /* One rung under --fs-chip, for a tick label beside a figure's axis. It is
       not a general small size: nothing that has to be READ may use it. */
    --fs-tick: 9.5px;

    /* The two h1 sizes that already existed implicitly. --fs-h1-sub was typed
       identically into docs.ts and upgrade.ts, and register.ts had a third
       value two pixels away that nobody chose. --fs-h1-app is the workbench
       heading on /app and /admin, which should not inherit a marketing clamp. */
    --fs-h1-sub: clamp(32px, 5vw, 50px);
    --fs-h1-app: 28px;
    /* The figure in a workbench tile: the one number a view leads with. One rung
       above the app heading so a count outranks its own title, one rung below
       --fs-h2 so it never competes with a marketing headline. */
    --fs-figure: 34px;

    /* Spacing. Deliberately not a geometric scale: this codebase uses 28
       distinct values, and a 4px base would force rounding 7, 9, 11, 22 and 26
       and move pixels on every page. These name what is already load bearing.
       New CSS uses them; an existing odd value stays until its block is
       rewritten for another reason. Never a find-and-replace pass. */
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px;
    --s6: 32px; --s7: 48px; --s8: 64px; --s9: 88px;
    --gutter: 24px;   /* the inline padding of every .wrap and .container */
    --gap: 56px;      /* the column gap of the hero and the diptychs */

    /* Radius. design.md already states the 12/8 rule; as tokens a violation
       becomes a named bug instead of an opinion. Known offenders, all
       scheduled: .pg at 3px, .pg-btn and .pg-status at 2px, docs .code at 6px,
       and every radius in admin.ts. */
    --r-frame: 12px;    /* panels, cards, tables, anything that holds content */
    --r-control: 8px;   /* buttons, inputs, selects */
    --r-chip: 4px;      /* chips, tags, badges */
    --r-pill: 999px;    /* progress tracks */

    /* Depth. A dark surface one shade off the ground reads flat and cheap; the
       thing that makes it read as a raised object is a single lit pixel along
       its top edge, the way real light falls on a bevel. --edge is that pixel
       and --lift is the shadow under it. Use them together on anything that is
       supposed to sit ON the page rather than be cut out of it. */
    /* 0.055 computed to 30.1 over --surface, which is exactly --border-soft,
       and 34.8 over --surface2, which is exactly --border. The highlight was
       set to the border's own value, so a panel's top edge and its left edge
       measured identically at 35 and the bevel did not exist. 0.17 lands at
       57.5 and 61.6, which is +23 and +27 over the border, between Linear's
       measured +17 and Modal's +34. */
    --edge: inset 0 1px 0 rgba(255,255,255,0.17);
    /* The 0 8px 24px rgba(0,0,0,0.28) half moved the ground from 10 to 8 over
       three pixels and then paid for a blur on six call sites. A shadow has
       about ten levels of headroom on a near-black ground; a border has 245,
       which is why Linear and Modal say which way the light falls with the
       frame instead. See .panel's border-top-color. */
    --lift: 0 1px 2px rgba(0,0,0,0.5);

    /* The one gradient. Achromatic, and for media that is looked at rather
       than used: the share card, the film, a slide. Never on a product page and
       never behind text. Colour on this site is subtraction: 0.84% chromatic
       pixels against 0.00 to 0.06% on the references, measured 2026-09-06. */
    --grad-vignette: radial-gradient(120% 80% at 50% 0%, #0b0f0d 0%, var(--bg) 60%);
    /* The canvas role names (see TOKENS_CANVAS), at this theme's own values,
       so a page opted back into dark never meets an undefined property. */
    --r-card: 12px; --r-card-sm: 12px; --r-inner: 12px; --r-field: 8px; --r-row: 8px; --r-inline: 4px;
    --fs-stat: 34px; --fs-code: 13px; --btn-hover: ${BRAND.green};
  }`

/**
 * The paper theme, for marketing surfaces only. `/` rendered it from
 * 2026-09-16 to 2026-09-23; nothing routes to it now.
 *
 * It redefines the SAME token names as TOKENS above rather than adding a second
 * vocabulary, which is what lets `/` change identity without touching
 * chrome.ts, tiers.ts or panels.ts. The console keeps the dark theme: `--held`
 * green is load-bearing semantics in /app, and nothing here reaches it.
 *
 * Contrast was measured on every pair before this shipped, compositing
 * translucent grounds and walking text RANGES rather than node fills. Six pairs
 * failed AA on the first pass; the values below are the corrected ones. Ratios
 * are in the comments so the next edit has to beat a number, not a taste.
 */
export const TOKENS_PAPER = `
  :root {
    color-scheme: light;
    /* ground */
    --bg: ${PAPER.bg}; --surface: ${PAPER.bg}; --surface2: #E9E5DA; --surface3: #E0DACE;
    --bg-deep: #E9E5DA;
    /* borders */
    --border: #D3CDBF; --border-soft: #E0DACE; --border2: ${PAPER.ink}; --border-strong: ${PAPER.ink};
    /* ink. 16.3 / 6.3 / 5.0 on the paper ground; --dim was #8C8578 at 3.21 and
       failed on all 39 of its labels. */
    --text: ${PAPER.ink}; --muted: #5C574C; --dim: #6B665A; --white: ${PAPER.ink};
    /* The primary action is ink on paper. --green keeps its NAME because it is
       the same role every shared component already binds to; renaming it is a
       12-file refactor and belongs in its own pass, not smuggled into a
       redesign. */
    --green: ${PAPER.ink}; --green-ink: ${PAPER.bg};
    /* The refusal. One hue cannot clear AA on paper, on its own tint and on a
       near-black plate, so it is three values: 4.54 on paper, 5.89 on the 8%
       tint, 6.67 on the plate. */
    --signal: ${PAPER.signal}; --signal-deep: #9A3009; --signal-ink: ${PAPER.bg};
    --plate: #14120E; --plate-ink: #D8D3C8; --plate-dim: #8A8478; --plate-signal: #F97316;
    --nav-bg: rgba(242,240,233,0.92);
    --code: #F97316; --code-ink: #D8D3C8;
    --red: #B91C1C; --amber: #92400E;
    /* Console semantics are not used on paper surfaces, but a shared partial
       could reach for one, so they resolve to something legible rather than to
       nothing. */
    --flow: #8A8478; --flow-ink: #5C574C; --res: #D3CDBF;
    --held-bg: #F5E6DC; --held-line: ${PAPER.signal};
    --near-bg: #F6EBD6; --near-line: #92400E; --near-ink: #6B4A0B;
    --fail-bg: #F7E2E2; --fail-line: #B91C1C; --fail-ink: #7F1D1D;
    /* Two faces, not three. The display face and the body face are one family:
       an industrial grotesque set tight for headings and loose for prose. The
       mono is a drafting mono, so a code frame reads as a technical document
       rather than as a terminal screenshot. */
    --display: 'Instrument Sans', 'Helvetica Neue', Arial, sans-serif;
    --sans: 'Instrument Sans', system-ui, -apple-system, sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    --fs-display: clamp(40px, 5.2vw, 60px);
    --fs-h2: clamp(26px, 3.4vw, 42px);
    --fs-h3: clamp(19px, 2.2vw, 22px);
    --fs-lede: 18px; --fs-body: 16px; --fs-small: 13.5px; --fs-micro: 12px;
    --fs-label: 11px; --fs-chip: 10.5px; --fs-tick: 9.5px;
    --fs-h1-sub: clamp(32px, 5vw, 50px); --fs-h1-app: 28px; --fs-figure: 34px;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px;
    --s6: 32px; --s7: 48px; --s8: 64px; --s9: 88px;
    --gutter: 24px; --gap: 56px;
    /* Nothing is rounded. A hard edge is the whole difference between a spec
       sheet and a dashboard, and it is one line rather than a rule per element. */
    --r-frame: 0px; --r-control: 0px; --r-chip: 0px; --r-pill: 0px;
    /* No bevel and no lift. On paper an object is separated by a rule, not by a
       fake light source; --edge and --lift exist only so a shared component
       that names them does not emit an empty box-shadow. */
    --edge: none; --lift: none;
    --grad-vignette: none;
    /* The canvas role names, square here, for the same reason as on dark. */
    --r-card: 0px; --r-card-sm: 0px; --r-inner: 0px; --r-field: 0px; --r-row: 0px; --r-inline: 0px;
    --fs-stat: 34px; --fs-code: 13px; --btn-hover: ${PAPER.ink};
  }`

/**
 * The canvas theme. Added 2026-09-23 for `/`, and the same evening made the
 * DEFAULT for every page, the console included, on Lior's instruction ("design
 * all the screens, including the console, in the same design and the same
 * design language"). head() renders this block unless a page passes a theme.
 *
 * Craft reference: x.ai/bot, read for the white canvas, near-black type, pale
 * warm-gray panels, large soft-cornered frames and pill actions; nothing of its
 * product, palette or claims. Dark (TOKENS) and paper stay defined, and nothing
 * routes to them: a page can still pass theme 'dark' or 'paper', which is the
 * revert path, and both carry the role names below at their own values.
 *
 * This reverses the earlier rule that the console keeps the dark theme because
 * its --held green is semantics. The semantics survive, re-cast: on this ground
 * the one accent is the refusal (--signal), and an approved call is not a
 * colour. design.md, "The canvas system", has the rules.
 *
 * Same token NAMES as TOKENS and TOKENS_PAPER, so the shared partials follow
 * without an edit. The role names at the end (radii by role, --fs-stat,
 * --fs-code, heading weights, the primary's hover) are read by src/ui/kit.ts,
 * chrome.ts and docs.ts; ROLES below aliases the component roles onto these.
 *
 * Contrast, WCAG 2.x, measured on the three grounds this page uses (white /
 * --surface2 / --surface3): --text 19.8 / 18.3 / 17.1, --muted 6.21 / 5.75 /
 * 5.35, --dim 5.11 / 4.73 (never on --surface3, where it is 4.40), --signal
 * 5.72 / 5.29 / 4.93 and 5.22 on its own tint (--fail-bg), --border-strong
 * 3.33 / 3.08 for every border that marks a control. On the plate: --plate-ink
 * 15.1, --plate-dim 5.63, --plate-signal 6.74. The reference's own body gray,
 * #7D8187, measures 3.92 on white and is not used.
 */
export const TOKENS_CANVAS = `
  :root {
    color-scheme: light;
    /* ground: white page, warm-gray panels one and two steps down */
    --bg: ${CANVAS.bg}; --surface: ${CANVAS.bg}; --surface2: #F7F6F3; --surface3: #EFEEEA;
    --bg-deep: #F7F6F3;
    /* borders: hairlines are quiet; anything that marks a control clears 3:1 */
    --border: #E6E4DF; --border-soft: #EFEEEA; --border2: #D4D1CA; --border-strong: #8A8D93;
    /* ink */
    --text: ${CANVAS.ink}; --muted: #5E6167; --dim: #6B6E74; --white: ${CANVAS.ink};
    /* The primary action is ink on white. --green keeps its NAME for the same
       reason it does on paper: it is the role every shared component binds to. */
    --green: ${CANVAS.ink}; --green-ink: ${CANVAS.bg};
    /* The refusal, and nothing else. */
    --signal: ${CANVAS.signal}; --signal-deep: #9A3412; --signal-ink: ${CANVAS.bg};
    --plate: #111110; --plate-ink: #E8E6E1; --plate-dim: #8F8C85; --plate-signal: #F97316;
    --nav-bg: rgba(255,255,255,0.9);
    /* Code on this page sits on white (the install pills, the samples); the dark
       plates read --plate-* directly. */
    --code: #9A3412; --code-ink: ${CANVAS.ink};
    --red: ${CANVAS.signal}; --amber: #92400E;
    /* Console semantics, kept legible for any shared partial. Held and flow are
       neutral here: an approved call is not a colour on this page. */
    --flow: #8A8D93; --flow-ink: #5E6167; --res: #D4D1CA;
    --held-bg: #EFEEEA; --held-line: #D4D1CA;
    --near-bg: #F6EBD6; --near-line: #92400E; --near-ink: #6B4A0B;
    --fail-bg: #FBF3EE; --fail-line: ${CANVAS.signal}; --fail-ink: #9A3412;
    /* One family in two cuts. */
    --display: 'Geist', 'Helvetica Neue', Arial, sans-serif;
    --sans: 'Geist', system-ui, -apple-system, sans-serif;
    --mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    --fs-display: clamp(36px, 4.6vw, 64px);
    --fs-h2: clamp(30px, 3.2vw, 40px);
    --fs-h3: clamp(19px, 2vw, 22px);
    --fs-lede: 18px; --fs-body: 16px; --fs-small: 14px; --fs-micro: 12px;
    --fs-label: 12px; --fs-chip: 11px; --fs-tick: 10px;
    --fs-h1-sub: clamp(32px, 5vw, 50px); --fs-h1-app: 28px; --fs-figure: 34px;
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px;
    --s6: 32px; --s7: 48px; --s8: 64px; --s9: 88px;
    --gutter: 24px; --gap: 56px;
    /* Soft corners: frames at 24, controls and chips as pills. */
    --r-frame: 24px; --r-control: 999px; --r-chip: 999px; --r-pill: 999px;
    /* Flat. Objects separate by ground and hairline, not by a light source. */
    --edge: none; --lift: none;
    --grad-vignette: none;
    /* Radii by role. --r-card the outer panel (--r-card-sm on a phone),
       --r-inner the white card inside it and a code frame, --r-field an
       input or a plate inside a card, --r-row a tinted row or a rail link,
       --r-inline code set inside a sentence. */
    --r-card: 24px; --r-card-sm: 20px; --r-inner: 16px; --r-field: 12px; --r-row: 10px; --r-inline: 6px;
    /* The figure in a frame (492 / 500 units), and code in a frame. */
    --fs-stat: clamp(34px, 4vw, 44px);
    --fs-code: 13px;
    /* Geist at 500 for every heading, the register the homepage set. BASE
       reads these; the other themes fall back to BASE's own weights. */
    --fw-h1: 500; --fw-h2: 500; --fw-h3: 500;
    /* The primary's hover: the ink lifted one step. */
    --btn-hover: #2A2A28;
  }`

/**
 * Component roles, on top of whichever theme rendered. Added 2026-09-23 with
 * src/ui/kit.ts, so a table, a chip, a callout, a field, the rail, an empty
 * state and a code frame each have one name per role instead of a surface
 * token picked per page. They alias the theme's own tokens, so this block
 * carries no colour of its own and renders correctly under every theme.
 * Change a role here and every screen that uses the kit follows.
 */
export const ROLES = `
  :root {
    /* Heights: the Figma Button component, L 44 and M 40. S 32 is a button
       that sits inside another control (the copy pill) and nothing else. */
    --h-lg: 44px; --h-md: 40px; --h-sm: 32px;
    /* The mono label voice. */
    --track-label: .08em; --track-chip: .06em;
    /* Panel in panel: outer panel, inner card, the card's hairline, and the
       grey right column inside a split card. */
    --panel-bg: var(--surface2); --card-bg: var(--surface); --card-line: var(--border); --side-bg: var(--surface2);
    /* Tables: column-label ink, row hairline, hover, and the refused row. */
    --th-ink: var(--dim); --row-line: var(--border); --row-hover: var(--surface2);
    --row-no-bg: var(--fail-bg); --row-no-ink: var(--signal);
    /* Chips: neutral decision, the tag's outline, and the refusal. */
    --chip-bg: var(--surface3); --chip-ink: var(--text); --chip-line: var(--border2);
    --chip-no-bg: var(--fail-bg); --chip-no-ink: var(--signal); --chip-no-line: var(--signal);
    /* Callouts. */
    --callout-bg: var(--surface2); --callout-line: var(--border);
    /* Fields: ground, a 3:1 border, focus ink, placeholder. */
    --field-bg: var(--surface); --field-line: var(--border-strong); --field-focus: var(--text); --field-ph: var(--dim);
    /* The rail: the console's sidebar and the docs' "On this page". */
    --rail-w: 240px; --rail-bg: var(--surface2); --rail-ink: var(--muted); --rail-hover-bg: var(--surface3);
    --rail-on-bg: var(--surface); --rail-on-ink: var(--text);
    /* Empty state: the dashed frame. */
    --empty-line: var(--border2); --empty-bg: var(--surface);
    /* Code: the machine's answer is on --plate (--plate-ink / -dim / -signal);
       your code is on --snip-bg, grey on the page and white inside a panel. */
    --snip-bg: var(--surface2);
    /* The meter: track, fill, and the ceiling's tick. */
    --meter-track: var(--surface3); --meter-fill: var(--text); --meter-tick: var(--signal);
  }
  /* The phone gutter, for every page: 16px a side under --md. It was the
     homepage's own rule; every other page kept 24 on a 390px screen. */
  @media (max-width: ${BP.md}px) { :root { --gutter: 16px; } }`

/** Reset plus the element defaults every page shares. */
export const BASE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  html, body { overflow-x: clip; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans);
         font-size: var(--fs-body); line-height: 1.65; -webkit-font-smoothing: antialiased; }
  h1, h2, h3, h4 { font-family: var(--display); text-wrap: balance; }
  h1 { font-size: var(--fs-display); font-weight: var(--fw-h1, 800); letter-spacing: -0.03em; line-height: 1.04; }
  h2 { font-size: var(--fs-h2); font-weight: var(--fw-h2, 700); letter-spacing: -0.022em; line-height: 1.12; }
  h3 { font-size: var(--fs-h3); font-weight: var(--fw-h3, 600); letter-spacing: -0.01em; line-height: 1.3; }
  a { color: var(--green); }
  .mono { font-family: var(--mono); }
  :focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    * { transition: none !important; animation: none !important; }
  }`

// Three families, nine weights, one render-blocking request.
//
// It was twelve. Archivo 500 and 600 and Inter 800 were requested on every page
// load and used by nothing: measured by walking every rendered element on nine
// surfaces (/, /docs, /pricing, /register, /terms, a guide, a post, the 404 and
// /app?demo=1) and collecting the computed family and weight. Archivo resolves
// only to 700 and 800, Inter to 400/500/600/700, JetBrains to 400/500/700.
//
// If a future rule sets a weight on a --display element that is not 700 or 800,
// the browser will synthesise it and it will look subtly wrong rather than
// break. Add the weight here rather than letting it synthesise.
const FONTS_DARK = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />`

// The paper theme's two families, and only the weights it renders: Instrument
// Sans at 400/500/700 and IBM Plex Mono at 400/500. Counted the same way the
// dark set was, by walking every rendered element and collecting the computed
// family and weight, so a weight added later has to be added here too rather
// than being synthesised.
const FONTS_PAPER = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />`

// The canvas theme's families. Both are variable fonts on Google Fonts, so one
// range per family covers every weight the shared CSS asks for (BASE headings
// at 600 to 800, .btn at 700, the mono wordmark at 700) without synthesis. The
// CSP already allows fonts.googleapis.com and fonts.gstatic.com; a self-hosted
// copy would be blocked by font-src and fall back silently.
const FONTS_CANVAS = `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..800&family=Geist+Mono:wght@400..700&display=swap" rel="stylesheet" />`

/** Which token block the page renders against. */
export type ThemeName = 'dark' | 'paper' | 'canvas'

/**
 * One row per theme. Record<ThemeName, ...> makes tsc refuse a theme that has
 * no fonts or no meta colour, which is how a third theme would otherwise fall
 * back to the dark settings through a ternary without anyone noticing.
 */
const THEMES: Record<ThemeName, { tokens: string; fonts: string; scheme: 'dark' | 'light'; color: string }> = {
  dark: { tokens: TOKENS, fonts: FONTS_DARK, scheme: 'dark', color: BRAND.bg },
  paper: { tokens: TOKENS_PAPER, fonts: FONTS_PAPER, scheme: 'light', color: PAPER.bg },
  canvas: { tokens: TOKENS_CANVAS, fonts: FONTS_CANVAS, scheme: 'light', color: CANVAS.bg },
}

type HeadOpts = {
  /** Full <title>, including the " · AgentBill" suffix. */
  title: string
  /**
   * The token block. Defaults to 'canvas' since 2026-09-23, for every page and
   * the console (Lior's instruction that day). 'dark' and 'paper' stay
   * selectable as the revert path and nothing passes them.
   */
  theme?: ThemeName
  description?: string
  /**
   * The page's path in the registry. Canonical, the share card and the robots
   * directive are all derived from it, so a page that passes `path` cannot end
   * up with a canonical that disagrees with its sitemap entry.
   */
  path?: string
  /** Escape hatch for a page not in the registry. `path` wins if both are set. */
  canonical?: string
  /** Extra CSS for this page, appended after TOKENS and BASE. */
  css?: string
  /** Genuinely page-specific tags. Not og, not canonical, not icons. */
  extraHead?: string
  /**
   * Document language and direction. Defaults to the site's English LTR.
   * A Hebrew page passes { lang: 'he', dir: 'rtl' }; nothing else in the system
   * needs to know, because every layout rule in this codebase already uses
   * logical properties (padding-inline, margin-inline, border-inline-start),
   * which is what makes an RTL flip survive without a second stylesheet.
   */
  lang?: string
  dir?: 'ltr' | 'rtl'
  /** Overrides for the share card. Title and description default to the page's. */
  og?: { type?: string; title?: string; description?: string }
  /** JSON-LD for this page. The sitewide Organization and WebSite are automatic. */
  jsonLd?: unknown | unknown[]
  /**
   * @id of the entity this page is primarily about, e.g. the #software node or
   * this page's own #techarticle. Emitted as WebPage.mainEntity, which is the
   * one field that tells a reader which of the several nodes on the page is the
   * subject rather than the furniture.
   */
  mainEntity?: string
  /**
   * True when the caller ALSO emits a BreadcrumbList carrying this page's
   * #breadcrumb @id. Passed rather than derived from the registry: /pricing has
   * crumbs in PAGES and deliberately draws none, so a registry-derived link
   * would point at a node that is not in the document. Only docsShell, which
   * actually emits one, sets it.
   */
  breadcrumb?: boolean
  /** Emit robots noindex. Derived from the registry when `path` is given. */
  noindex?: boolean
  /**
   * Hashes of the inline scripts this page emits. Passing them turns the CSP
   * on for the page; omitting them leaves the page without one, which is the
   * safe default for anything not yet wired. Pass [] for a page with no script
   * at all and it gets script-src 'none'.
   */
  scriptHashes?: readonly string[]
  /** Extra origins for a configured pixel (script, img, connect). Normally empty. */
  scriptOrigins?: readonly string[] | { script?: readonly string[]; img?: readonly string[]; connect?: readonly string[] }
}

/**
 * JSON-LD is injected into a <script> element, so a description containing
 * "</script>" would close the block and drop the rest of the page's markup into
 * the document as text. Escaping "<" is the whole fix and it must never be
 * removed for tidiness.
 */
const ld = (o: unknown): string => JSON.stringify(o).replace(/</g, '\\u003c')

/** Emitted on every indexable page. The publisher of everything else. */
function sitewideLd(): unknown[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${ORIGIN}/#organization`,
      name: 'AgentBill',
      url: ORIGIN,
      logo: { '@type': 'ImageObject', url: `${ORIGIN}/apple-touch-icon.png`, width: 180, height: 180 },
      sameAs: [
        'https://github.com/marketinglior-pixel/agentbill',
        'https://pypi.org/project/agentbill-sdk/',
        'https://pypi.org/project/agentbill-mcp/',
        'https://www.npmjs.com/package/agentbill',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${ORIGIN}/#website`,
      url: ORIGIN,
      name: 'AgentBill',
      inLanguage: 'en-US',
      publisher: { '@id': `${ORIGIN}/#organization` },
    },
  ]
}

/**
 * One node per indexable page, joining the URL to the entity it is about.
 *
 * Without it, Organization, WebSite, SoftwareApplication, BreadcrumbList and
 * the article nodes are five islands on one page with nothing saying which of
 * them the page is FOR. That is the question an answer engine is actually
 * asking, and mainEntity is the field that answers it.
 *
 * It lives in head() rather than in each route because a route that forgets it
 * leaves its own article node dangling, and the failure is invisible.
 */
function webPageLd(
  href: string,
  path: string | undefined,
  title: string,
  description: string | undefined,
  lang: string,
  mainEntity: string | undefined,
  breadcrumb: boolean | undefined,
): unknown {
  const meta = path ? byPath.get(path) : undefined
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${href}#webpage`,
    url: href,
    name: title,
    ...(description ? { description } : {}),
    inLanguage: lang === 'he' ? 'he-IL' : 'en-US',
    isPartOf: { '@id': `${ORIGIN}/#website` },
    ...(meta?.updated ? { dateModified: meta.updated } : {}),
    primaryImageOfPage: { '@type': 'ImageObject', url: `${ORIGIN}/og.png`, width: 1200, height: 630 },
    ...(mainEntity ? { mainEntity: { '@id': mainEntity } } : {}),
    ...(breadcrumb ? { breadcrumb: { '@id': `${href}#breadcrumb` } } : {}),
  }
}

/** Doctype through <body>. Every HTML route opens with this. */
/**
 * Emitted by every page. Until this existed the site had no favicon at all and
 * /favicon.ico answered 401, so a tab showed the browser's default globe.
 *
 * color-scheme is here rather than in TOKENS because it also has to reach
 * /admin, which does not go through the token block, and because without it a
 * dark page still gets light native scrollbars, form controls and autofill.
 */
const icons = (theme: ThemeName) => `  <meta name="color-scheme" content="${THEMES[theme].scheme}" />
  <meta name="theme-color" content="${THEMES[theme].color}" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="32x32" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />`

export function head({ title, description, path, canonical, css = '', extraHead = '', og, jsonLd, mainEntity, breadcrumb, noindex, scriptHashes, scriptOrigins = {}, lang = 'en', dir, theme = 'canvas' }: HeadOpts): string {
  const { tokens, fonts } = THEMES[theme]
  const meta = path ? byPath.get(path) : undefined
  const hidden = noindex ?? (meta ? !meta.index : false)
  // A canonical on a noindex page is two contradictory signals about one URL.
  const href = hidden ? undefined : (path ? abs(path) : canonical)
  // One card for every page, for now. head() used to point non-default sections
  // at /og/<section>.png, and those routes were never built, so every share of
  // /docs, /pricing, /register and /blog carried a broken image for a day. The
  // registry keeps the per-section `og` field so cards can exist later; until a
  // route serves them, nothing may reference them.
  const card = `${ORIGIN}/og.png`
  const ogTitle = og?.title ?? title
  const ogDesc = og?.description ?? description ?? ''
  const blocks = hidden ? [] : [
    ...sitewideLd(),
    ...(href ? [webPageLd(href, path, title, description, lang, mainEntity, breadcrumb)] : []),
    ...(jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []),
  ]
  // Delivered as a meta rather than a header so it lives beside the head it
  // describes, and because the one directive a meta cannot carry,
  // frame-ancestors, is already covered by X-Frame-Options: DENY in
  // middleware/headers.ts. It is emitted FIRST so it governs every resource
  // reference below it.
  const csp = scriptHashes
    ? `  <meta http-equiv="Content-Security-Policy" content="${policy(scriptHashes, scriptOrigins)}" />\n`
    : ''

  return `<!DOCTYPE html>
<html lang="${lang}"${dir ? ` dir="${dir}"` : ''}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
${csp}${icons(theme)}
  <title>${title}</title>${description ? `
  <meta name="description" content="${description}" />` : ''}${href ? `
  <link rel="canonical" href="${href}" />` : ''}${hidden ? `
  <meta name="robots" content="noindex" />` : ''}
  <meta property="og:type" content="${og?.type ?? 'website'}" />
  <meta property="og:site_name" content="AgentBill" />
  <meta property="og:locale" content="en_US" />${href ? `
  <meta property="og:url" content="${href}" />` : ''}
  <meta property="og:title" content="${ogTitle}" />${ogDesc ? `
  <meta property="og:description" content="${ogDesc}" />` : ''}
  <meta property="og:image" content="${card}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${ogTitle}" />${ogDesc ? `
  <meta name="twitter:description" content="${ogDesc}" />` : ''}
  <meta name="twitter:image" content="${card}" />
${fonts}
  <style>${tokens}${ROLES}${BASE}${css}
  </style>${blocks.map((b) => `\n  <script type="application/ld+json">${ld(b)}</script>`).join('')}${extraHead ? `\n${extraHead}` : ''}
</head>`
}
