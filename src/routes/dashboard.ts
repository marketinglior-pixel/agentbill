import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'

export async function dashboardRoute(app: FastifyInstance) {

  // JSON endpoint, useful for external tooling
  app.get('/customers', async (request, reply) => {
    const rows = await sql`
      SELECT
        c.customer_ref   AS customer_id,
        c.limit_units    AS "limit",
        c.used_units     AS used,
        CASE WHEN c.limit_units IS NULL THEN NULL
             ELSE c.limit_units - c.used_units END AS remaining,
        CASE WHEN c.limit_units IS NOT NULL AND c.used_units >= c.limit_units
             THEN true ELSE false END AS is_blocked,
        c.created_at
      FROM customers c
      WHERE c.account_id = ${(request as any).accountId}
      ORDER BY c.created_at DESC
    `
    return reply.send(rows)
  })

  // Visual dashboard, single HTML page
  app.get('/dashboard', async (request, reply) => {
    reply.type('text/html')
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AgentBill Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0d0d0d; color: #e2e8f0; padding: 40px; }
    h1 { font-size: 20px; font-weight: 600; color: #a78bfa; margin-bottom: 4px; }
    .subtitle { font-size: 12px; color: #4b5563; margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 16px; color: #6b7280; font-weight: 500;
         border-bottom: 1px solid #1f2937; text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
    td { padding: 12px 16px; border-bottom: 1px solid #111827; }
    tr:hover td { background: #111827; }
    .bar-wrap { background: #1f2937; border-radius: 4px; height: 6px; width: 120px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 8px; }
    .bar { height: 100%; border-radius: 4px; background: #7c3aed; }
    .bar.danger { background: #dc2626; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge.blocked { background: #450a0a; color: #f87171; }
    .badge.ok { background: #052e16; color: #4ade80; }
    .mono { font-family: inherit; color: #c4b5fd; }
    #refresh { margin-bottom: 24px; display: flex; align-items: center; gap: 12px; }
    button { background: #1f2937; border: 1px solid #374151; color: #e2e8f0; padding: 6px 14px;
             border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; }
    button:hover { background: #374151; }
    .ts { color: #4b5563; font-size: 11px; }
  </style>
</head>
<body>
  <h1>AgentBill</h1>
  <p class="subtitle">Customer budget usage, live view</p>

  <div id="refresh">
    <button onclick="load()">↺ Refresh</button>
    <span class="ts" id="last-update"></span>
  </div>

  <table>
    <thead>
      <tr>
        <th>Customer ID</th>
        <th>Usage</th>
        <th>Used</th>
        <th>Limit</th>
        <th>Remaining</th>
        <th>Status</th>
        <th>Created</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

  <script>
    async function load() {
      const res = await fetch('/customers')
      const data = await res.json()
      const tbody = document.getElementById('rows')
      tbody.innerHTML = data.map(c => {
        const pct = c.limit ? Math.min(100, Math.round(c.used / c.limit * 100)) : 0
        const danger = pct >= 80
        const bar = c.limit
          ? \`<span class="bar-wrap"><span class="bar\${danger ? ' danger' : ''}" style="width:\${pct}%"></span></span>\${pct}%\`
          : '<span style="color:#4b5563">unlimited</span>'
        const badge = c.isBlocked
          ? '<span class="badge blocked">BLOCKED</span>'
          : '<span class="badge ok">OK</span>'
        const created = new Date(c.createdAt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})
        return \`<tr>
          <td class="mono">\${c.customerId}</td>
          <td>\${bar}</td>
          <td>\${c.used}</td>
          <td>\${c.limit ?? '∞'}</td>
          <td>\${c.remaining ?? '∞'}</td>
          <td>\${badge}</td>
          <td class="ts">\${created}</td>
        </tr>\`
      }).join('')
      document.getElementById('last-update').textContent = 'Updated ' + new Date().toLocaleTimeString()
    }
    load()
  </script>
</body>
</html>`)
  })
}
