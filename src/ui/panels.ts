// Product panels shared across marketing pages.
//
// One frame (.panel / .panel-h / .panel-f), used by the homepage diptychs and
// by /register, so the site has one card recipe instead of one per page. The
// contents differ per page and live with the page; what lives here is the
// frame and the one panel more than one page shows: the request shape.

/** The panel frame plus the request/response block. Include once per page. */
export const PANEL_CSS = `
    /* border-top-color is the light direction. A shadow has about ten levels of
       headroom on a near-black ground; the frame has 245, which is the mechanism
       Linear and Modal actually use. The inset --edge stays here for a panel that
       opens without a header strip, and .panel-h carries its own below. */
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
             border-top-color: var(--border2);
             overflow: hidden; min-width: 0; box-shadow: var(--edge), var(--lift); }
    /* The lit edge belongs on whatever is actually the top of the object. An
       inset shadow on .panel paints on .panel's padding box, and this strip's
       opaque background covered it, so the site's signature depth device
       rendered on none of the five marketing panels. */
    .panel-h { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 12px 18px;
               border-bottom: 1px solid var(--border); background: var(--surface2);
               box-shadow: var(--edge);
               font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
               color: var(--dim); }
    .panel-h span:last-child { text-transform: none; letter-spacing: 0; font-size: 12px; text-align: right; }
    .panel-f { padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface2);
               font-family: var(--mono); font-size: 12px; color: var(--dim); line-height: 1.5; }

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
