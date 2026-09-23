// Product panels shared across marketing pages.
//
// One frame (.panel / .panel-h / .panel-f), used by the homepage diptychs and
// by /register, so the site has one card recipe instead of one per page. The
// contents differ per page and live with the page; what lives here is the
// frame and the one panel more than one page shows: the request shape.

/** The panel frame plus the request/response block. Include once per page. */
export const PANEL_CSS = `
    /* The canvas card, 2026-09-23: white, a hairline, --r-inner corners, the
       same object as .cv-card in src/ui/kit.ts, under the name /register and
       /pricing already render. Flat: on this ground an object separates by
       its hairline, not by a light source (--edge and --lift are none). */
    .panel { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
             overflow: hidden; min-width: 0; box-shadow: var(--edge), var(--lift); }
    /* The label bar, in the mono label voice, on the card's own white like
       the frame's bar. The same 12px 18px it always had, so nothing under it
       moves: the key screen's fold gate measures what sits below this strip. */
    .panel-h { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 12px 18px;
               border-bottom: 1px solid var(--card-line); background: var(--card-bg);
               font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-label); text-transform: uppercase;
               color: var(--dim); }
    .panel-h span:last-child { text-transform: none; letter-spacing: 0; font-size: var(--fs-micro); text-align: right; }
    .panel-f { padding: 12px 18px; border-top: 1px solid var(--card-line); background: var(--side-bg);
               font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); line-height: 1.5; }

    @media (max-width: 640px) {
      .panel-h { flex-direction: column; gap: 4px; }
      .panel-h span:last-child { text-align: left; }
    }
`

/**
 * The three key endpoints, once. The console's keys view and the homepage's
 * keys panel both render from here; the sentences mirror src/routes/keys.ts
 * and if they ever disagree, keys.ts is right and this is a bug.
 */
export const KEY_COMMANDS: ReadonlyArray<readonly [endpoint: string, what: string]> = [
  ['POST /keys/generate', 'A new key, with an optional label and expiry in days.'],
  ['POST /keys/rotate', 'A new key now; the old one keeps working for 24 hours, then revokes itself.'],
  ['POST /keys/revoke', 'Revokes the calling key immediately, or another by its prefix.'],
]
