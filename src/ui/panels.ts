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
 */
export function requestPanel(): string {
  return `<div class="panel">
        <div class="panel-h"><span>POST /preflight</span><span>the entire integration surface</span></div>
        <div class="req"><span class="k">request</span>
{ "agent_id": "researcher",
  "task_ref": "job-142",
  "task_ceiling": 500,
  "estimated_units": 12 }

<span class="k">approved</span>
{ "approved": <span class="t">true</span>,
  "task_ref": "job-142",
  "task_remaining_units": 488 }

<span class="k">blocked</span>
{ "approved": <span class="f">false</span>,
  "reason": "task_ceiling_exceeded",
  "task_ref": "job-142",
  "task_remaining_units": 8 }</div>
        <div class="panel-f">Your code calls this, then calls your provider. Nothing of ours sits between the two.</div>
      </div>`
}
