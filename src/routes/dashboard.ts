import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'

// /customers, the JSON balance list. The HTML page that used to live here
// was unreachable for its whole life: /dashboard was registered but never
// added to the auth allowlist, so every browser GET got a 401 before the
// page ran, and its own fetch('/customers') sent no Authorization header
// either. /app renders this data now, server-side, against a real session.
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
}
