// Product panels shared across marketing pages.
//
// One frame (.panel / .panel-h / .panel-f), used by the homepage diptychs and
// by /register, so the site has one card recipe instead of one per page. The
// contents differ per page and live with the page; what lives here is the
// frame and the one panel more than one page shows: the request shape.

/** The panel frame plus the request/response block. Include once per page. */
export const PANEL_CSS = `
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
             overflow: hidden; min-width: 0; box-shadow: var(--edge), var(--lift); }
    .panel-h { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 12px 18px;
               border-bottom: 1px solid var(--border); background: var(--surface2);
               font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
               color: var(--dim); }
    .panel-h span:last-child { text-transform: none; letter-spacing: 0; font-size: 12px; text-align: right; }
    .panel-f { padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface2);
               font-family: var(--mono); font-size: 12px; color: var(--dim); line-height: 1.5; }

    .req { padding: 18px 20px; font-family: var(--mono); font-size: 13px; line-height: 1.7; color: var(--code);
           white-space: pre; overflow-x: auto; }
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
{ "agent_id": "researcher", "task_ref": "job-142",
  "task_ceiling": 500, "estimated_units": 12 }

<span class="k">approved</span>
{ "approved": <span class="t">true</span>, "task_ref": "job-142",
  "task_remaining_units": 488 }

<span class="k">blocked</span>
{ "approved": <span class="f">false</span>, "reason": "task_ceiling_exceeded",
  "task_ref": "job-142", "task_remaining_units": 8 }</div>
        <div class="panel-f">Your code calls this, then calls your provider. Nothing of ours sits between the two.</div>
      </div>`
}
