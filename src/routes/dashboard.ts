import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { readPage } from '../lib/page.js'
import { LIST_PRICE_LABEL } from '../lib/prices.js'

// /customers, the JSON balance list. The HTML page that used to live here
// was unreachable for its whole life: /dashboard was registered but never
// added to the auth allowlist, so every browser GET got a 401 before the
// page ran, and its own fetch('/customers') sent no Authorization header
// either. /app renders this data now, server-side, against a real session.
export async function dashboardRoute(app: FastifyInstance) {

  // JSON endpoint, useful for external tooling.
  //
  // Paged since 2026-09-25 (src/lib/page.ts): at most `limit` rows (default
  // 200, max 500), newest first as before. The body is still the bare array
  // every existing caller reads; the next page is named in the headers,
  // X-Next-Cursor and a Link rel="next", and both are absent on the last page.
  app.get('/customers', async (request, reply) => {
    const accountId = request.accountId
    const r = readPage(request.query)
    if (!r.ok) return reply.code(422).send({ error: 'validation_error', message: r.message })
    const { limit, cursor } = r.page
    const rows = await sql`
      SELECT
        c.id             AS row_id,
        c.customer_ref   AS customer_id,
        c.limit_units    AS "limit",
        c.used_units     AS used,
        CASE WHEN c.limit_units IS NULL THEN NULL
             ELSE c.limit_units - c.used_units END AS remaining,
        CASE WHEN c.limit_units IS NOT NULL AND c.used_units >= c.limit_units
             THEN true ELSE false END AS is_blocked,
        c.created_at,
        e.usd::text      AS usd,
        coalesce(e.priced, 0) AS priced
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT sum(list_price_usd) AS usd, count(list_price_usd) AS priced
        FROM events WHERE customer_id = c.id AND list_price_usd IS NOT NULL
      ) e ON true
      WHERE c.account_id = ${accountId}
        ${cursor ? sql`AND (c.created_at, c.id) < (SELECT created_at, id FROM customers WHERE id = ${cursor} AND account_id = ${accountId})` : sql``}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${limit + 1}
    `
    const more = rows.length > limit
    const page = rows.slice(0, limit)
    if (more) {
      const next = page[page.length - 1]!.rowId as string
      reply.header('X-Next-Cursor', next)
      reply.header('Link', `</customers?limit=${limit}&cursor=${next}>; rel="next"`)
    }
    // The keys follow the camelCase this route has always answered in.
    // limit, used and remaining are the customer's balance in the numbers the
    // code reported, units and tokens, and never a dollar job's micro-dollars
    // (2026-09-25, see preflight.ts). A customer with priced calls also gets
    // what they cost at public list price, over the priced calls only, as
    // separate fields; a customer with none gets exactly the object it always
    // did, key for key. There is no dollar limit on a customer: a dollar job
    // is bounded by its own ceiling, so "remaining" stays a unit figure.
    return reply.send(page.map(({ rowId: _drop, usd, priced, ...rest }) => Number(priced) > 0
      ? { ...rest, listPriceUsdEstimate: Number(usd), pricedCalls: Number(priced), listPriceLabel: LIST_PRICE_LABEL }
      : rest))
  })
}
