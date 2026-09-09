import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { zId, INT4_MAX } from '../lib/ids.js'

const BudgetQuery = z.object({
  customer_id: zId(),
})

// limit_units is required and nullable, never optional. An absent field would
// have to mean "leave it alone", and a PUT whose body silently means nothing is
// the shape that lets a typo look like a successful write.
const BudgetBody = z.object({
  customer_id: zId(),
  limit_units: z.number().int().min(0).max(INT4_MAX).nullable(),
})

export async function budgetRoute(app: FastifyInstance) {
  app.get('/budget', async (request, reply) => {
    const parsed = BudgetQuery.safeParse(request.query)
    if (!parsed.success) {
      // The old message said "is required" for a parameter that was supplied
      // and rejected on content, which sent the caller looking for the wrong bug.
      return reply.code(422).send({
        error: 'validation_error',
        message: 'Query parameter customer_id is required, 1 to 128 characters, no control characters',
        details: parsed.error.issues,
      })
    }

    const { customer_id: customerRef } = parsed.data
    const accountId = request.accountId

    try {
      const [account] = await sql`
        SELECT default_budget_units FROM accounts WHERE id = ${accountId}
      `
      const defaultBudget: number | null = account?.defaultBudgetUnits ?? null

      // Lazy-create: if customer doesn't exist, create with default budget.
      // This endpoint never returns 404.
      const inserted = await sql`
        INSERT INTO customers (account_id, customer_ref, limit_units)
        VALUES (${accountId}, ${customerRef}, ${defaultBudget})
        ON CONFLICT (account_id, customer_ref) DO NOTHING
        RETURNING *
      `

      const customerCreated = inserted.length > 0
      const customer = customerCreated
        ? inserted[0]
        : (await sql`
            SELECT * FROM customers
            WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
          `)[0]

      const remaining = customer.limitUnits !== null
        ? customer.limitUnits - customer.usedUnits
        : null

      const isBlocked = customer.limitUnits !== null && remaining! <= 0

      return reply.code(200).send({
        customer_id: customerRef,
        customer_created: customerCreated,
        limit: customer.limitUnits,
        used: customer.usedUnits,
        remaining,
        is_blocked: isBlocked,
      })

    } catch (err) {
      request.log.error(err)
      // Never err.message: this route's own catch is why a database sentence
      // still reached the client after server.ts stopped every other one.
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })

  // Set a customer's ceiling. Until this existed the only way to choose one was
  // accounts.default_budget_units, applied once at customer-creation time and
  // hardcoded to 1000 at signup, so a customer's budget was fixed for life and
  // the only fix was a hand-written UPDATE.
  //
  // API only, deliberately: the console stays read-mostly (decision 2026-09-03)
  // and the landing page says we do not ship a dashboard for non-developers.
  // Narrowed 2026-09-10: a JOB's ceiling got a console form (POST /app/tasks,
  // sharing src/lib/task-ceiling.ts with PUT /tasks/:task_ref/ceiling), on the
  // founder's dogfood verdict that setting a budget only from code was the
  // product's whole problem. A customer's ceiling is still this endpoint only.
  app.put('/budget', async (request, reply) => {
    const parsed = BudgetBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: 'Body needs customer_id (1 to 128 characters, no control characters) and limit_units (a non-negative integer, or null for no limit)',
        details: parsed.error.issues,
      })
    }

    const { customer_id: customerRef, limit_units: limitUnits } = parsed.data
    const accountId = request.accountId

    try {
      // Upsert, so a ceiling can be set before that customer has ever made a
      // call. Same lazy-create the rest of the API does, with the limit chosen
      // by the caller instead of inherited from the account default.
      //
      // xmax = 0 is true only for a row this statement inserted; on the DO
      // UPDATE path it carries the locking transaction id. It decides one
      // informational field, never a write.
      const [customer] = await sql`
        INSERT INTO customers (account_id, customer_ref, limit_units)
        VALUES (${accountId}, ${customerRef}, ${limitUnits})
        ON CONFLICT (account_id, customer_ref) DO UPDATE
          SET limit_units = ${limitUnits}, updated_at = now()
        RETURNING customer_ref, limit_units, used_units, reserved_units,
                  (xmax = 0) AS customer_created
      `

      // A ceiling, not a balance: it may legally land under what is already
      // used and reserved. Nothing is rewritten to fit it, and nothing goes
      // negative, because preflight's reserve is a WHERE clause
      // (used + reserved + estimate <= limit) that simply stops matching. The
      // customer is refused with budget_exhausted until reservations settle or
      // expire. remaining is floored at 0 so the caller never reads a negative
      // headroom as a credit.
      const remaining = customer.limitUnits !== null
        ? Math.max(0, customer.limitUnits - customer.usedUnits - customer.reservedUnits)
        : null

      const isBlocked = customer.limitUnits !== null &&
        customer.usedUnits + customer.reservedUnits >= customer.limitUnits

      return reply.code(200).send({
        customer_id: customer.customerRef,
        customer_created: customer.customerCreated,
        limit: customer.limitUnits,
        used: customer.usedUnits,
        reserved: customer.reservedUnits,
        remaining,
        is_blocked: isBlocked,
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
