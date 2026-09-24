import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { usageByEventType } from '../lib/usage.js'

const UsageQuery = z.object({
  // The one split there is. Required, so a request says what it groups by and
  // a second dimension can arrive later without changing what this one means.
  by: z.enum(['event_type']),
  // The console's longest window. Counted in calendar days, today included.
  days: z.coerce.number().int().positive().max(90).default(30),
  limit: z.coerce.number().int().positive().max(200).default(50),
})

// What the units went to: the account's recorded units over a window, split
// by the event_type each record carried. Bearer-authenticated like every other
// API route (no publicRoute here), and listed in server.ts API_PREFIXES so the
// canonical-host redirect never strips the Authorization header off it.
export async function usageRoute(app: FastifyInstance) {
  app.get('/usage', async (request, reply) => {
    const parse = UsageQuery.safeParse(request.query ?? {})
    if (!parse.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: 'by=event_type is required. days is 1 to 90 (default 30), limit is 1 to 200 (default 50).',
        details: parse.error.issues,
      })
    }
    const { by, days, limit } = parse.data
    const u = await usageByEventType(request.accountId, days, limit)

    return reply.send({
      by,
      days,
      since: u.since,
      total_units: u.totalUnits,
      total_events: u.totalEvents,
      group_count: u.groupCount,
      groups: u.groups.map((g) => ({
        event_type: g.eventType,
        units: g.units,
        events: g.events,
        // A fraction of total_units, to four places. total_units covers every
        // group in the window, including any past the limit.
        share: u.totalUnits > 0 ? Math.round((g.units / u.totalUnits) * 10_000) / 10_000 : 0,
      })),
    })
  })
}
