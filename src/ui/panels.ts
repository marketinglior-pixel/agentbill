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

    .req { padding: 18px 20px; font-family: var(--mono); font-size: 13px; line-height: 1.7; color: var(--code-ink);
           white-space: pre; overflow-x: auto; }
    /* Padding on a scroller collapses at the scroll origin, so a long line ran
       flush into the 1px border with no gutter and read as escaped content
       rather than as something you can scroll. One key per line keeps every
       line inside a 390px panel; this keeps the gutter if a line ever grows. */
    .req::after { content: ''; display: inline-block; width: 20px; }
    .req .k { color: var(--dim); text-transform: uppercase; letter-spacing: .14em; font-size: 11px; }
    .req .t { color: var(--green); }
    .req .f { color: var(--red); font-weight: 700; }

    @media (max-width: 640px) {
      .panel-h { flex-direction: column; gap: 4px; }
      .panel-h span:last-child { text-align: left; }
    }
`

/**
 * The whole request path, as a shape. Field names and the two response
 * bodies mirror the task-budget branch of src/routes/preflight.ts; if they
 * ever disagree, preflight.ts is right and this is a bug.
 *
 * The request deliberately does NOT carry task_ceiling, and putting it back
 * would undo a shipped decision rather than fix an omission.
 *
 * It is a real optional field: preflight.ts opens a new task_ref with it, and
 * /docs documents that in four places, which is where it belongs. But it is
 * applied only while the job does not exist yet, and since the onboarding
 * ticket of 2026-09-10 the ceiling is set before the code runs. On /register
 * this panel sits about 400px from step 3 of that path, which says in so many
 * words that the call sends the job's name and nothing about the budget. A
 * request block showing the opposite is the retired order printed as code
 * next to the prose that replaced it, and a reader believes the code.
 *
 * So the request is the shape after the job has a ceiling: name the job, say
 * what this one call is worth, and let the answer carry the ceiling in force.
 * Both response bodies keep task_ceiling because the server really sends it
 * (preflight.ts:272 and :405), and 500 - 12 = 488 only reads if the panel says
 * where the 500 came from, which is what the footer is now for.
 */
export function requestPanel(): string {
  return `<div class="panel">
        <div class="panel-h"><span>POST /preflight</span><span>the entire integration surface</span></div>
        <div class="req"><span class="k">request</span>
{ "agent_id": "researcher",
  "task_ref": "job-142",
  "estimated_units": 12 }

<span class="k">approved</span>
{ "approved": <span class="t">true</span>,
  "task_ref": "job-142",
  "task_ceiling": 500,
  "task_remaining_units": 488 }

<span class="k">refused</span>
{ "approved": <span class="f">false</span>,
  "reason": "task_ceiling_exceeded",
  "task_ref": "job-142",
  "task_ceiling": 500,
  "task_remaining_units": 8 }</div>
        <div class="panel-f">The ceiling is already on the job, so this call says nothing about the budget. Your code calls this, then calls your provider. Nothing of ours sits between the two.</div>
      </div>`
}

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
