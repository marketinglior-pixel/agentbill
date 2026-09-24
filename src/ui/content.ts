import { BP } from './theme.js'
// The canvas treatment for the BODY of a content page: /docs, the guides under
// it, the blog, /faq and /about. Added 2026-09-23, the day Lior asked for every
// screen in the design language he approved on the homepage.
//
// The docs shell (src/ui/docs.ts) already draws the frame of these pages: the
// nav, the breadcrumb, the rail, the headings, the prose measure, the light
// code card. What it could not know is what sits inside each body, and three
// things there still spoke the old language:
//
//   the machine's answer (a printed run, a response body) sat on the same
//     light card as the code that produced it, so the one line each page
//     exists to show, the refusal, looked like one more line of your code;
//   parameter tables were bare rules on the page, where the homepage only
//     ever shows a table inside a card;
//   lists of places to go next were a column of underlined sentences, where
//     the homepage makes a choice a white row in a warm-grey panel.
//
// Every value is a token from theme.ts or ROLES, and every component is the
// kit's where the kit has one (the plate is .cv-code). Nothing here is a new
// colour, a new radius or a font-size literal; the ratchet counts both.
//
// Branch-local on purpose: it is included by the five route files above and by
// nothing the foundation owns. It is a candidate to fold into DOCS_CSS once the
// canvas branches merge.

export const CONTENT_CSS = `
  /* ---- The machine's answer, on the plate. The kit's .cv-code, at the code
     size of the light card beside it so the two read as one column. Printed
     output wraps rather than scrolls: nobody copies it, and a refusal cut at
     the frame's edge is the one line on the page that must be read whole.
     .out-ok and .out-no keep the out- prefix the snippet harvester drops, so
     a block of output is never parsed as a sample. */
  .container .cv-code { margin: var(--s4) 0; font-size: var(--fs-code); }
  .container .cv-code.ct-out { white-space: pre-wrap; overflow-wrap: anywhere; }
  .cv-code .out-ok { color: var(--plate-ink); }
  .cv-code .out-no, .cv-code .no { color: var(--plate-signal); }
  .cv-code .comment { color: var(--plate-dim); }

  /* ---- A code word written as a bare code element (the posts write them that
     way) takes the shell's inline chip: the ink on the chip ground. Without a
     class it fell to the browser's own monospace, a second mono face on a page
     set in Geist Mono. */
  .container code:not([class]) { font-family: var(--mono); background: var(--surface3); padding: 2px 6px;
                                 border-radius: var(--r-inline); font-size: .875em; color: var(--text); }

  /* ---- A table is a card: white, the card hairline, --r-inner corners, the
     mono column labels on the card's own white, a row hairline between rows
     and none under the last. The shell keeps its phone layout (each row
     stacked); the card and its insets follow it there. */
  .container table { border: 1px solid var(--card-line); border-radius: var(--r-inner); border-collapse: separate;
                     border-spacing: 0; overflow: hidden; background: var(--card-bg); margin: var(--s5) 0; }
  .container th { padding: 12px 16px; border-bottom: 1px solid var(--card-line); }
  .container td { padding: 12px 16px; }
  .container tr:last-child td { border-bottom: 0; }

  /* ---- Where to go next: white rows in a warm-grey panel, an arrow at the
     end of each, the choice as the homepage draws one. .also is the related
     list every guide and post ends on; .ct-links is the same object inside a
     page (the docs' Guides section). */
  .also, .ct-links { display: grid; gap: var(--s2); background: var(--panel-bg); border: 0;
                     border-radius: var(--r-card); padding: var(--s5); }
  .also { margin-top: var(--s8); }
  .ct-links { margin: var(--s4) 0 0; }
  .also p { margin: 0 0 var(--s1); }
  .also a, .ct-links a { display: flex; align-items: center; justify-content: space-between; gap: var(--s4);
                         min-height: var(--h-lg); padding: 10px 16px; margin: 0; background: var(--card-bg);
                         border: 1px solid var(--card-line); border-radius: var(--r-field); color: var(--text);
                         font-size: var(--fs-body); font-weight: 500; line-height: 1.4; text-decoration: none;
                         transition: border-color .15s; }
  .also a::after, .ct-links a::after { content: "\\2192"; flex: none; color: var(--dim); font-weight: 400; }
  .also a:hover, .ct-links a:hover { text-decoration: none; border-color: var(--border-strong); }

  @media (max-width: ${BP.sm}px) {
    /* The plate follows the light card's phone size, so the two stay one column. */
    .container .cv-code { font-size: var(--fs-micro); padding: 16px; }
    .container tr { padding: 12px 16px; }
    .container tr:last-child { border-bottom: 0; }
    .container td { padding: 0; }
  }
  @media (max-width: ${BP.md}px) {
    .also, .ct-links { padding: var(--s3); border-radius: var(--r-card-sm); }
    .also p { padding: var(--s1) var(--s1) 0; }
  }
`
