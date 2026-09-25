import { z } from 'zod'
import { isUuid } from './ids.js'

// Pagination for the two list endpoints that had no LIMIT: GET /customers and
// GET /keys. Both returned every row an account had, so an account with a
// hundred thousand customer ids (made on sight by /events) got a response of
// that size on every call.
//
// Keyset, not OFFSET: the cursor is the id of the last row returned, and the
// next page starts strictly after that row's (created_at, id). It is opaque to
// callers. The default page is large (200) so that every account that exists
// today gets exactly the response it got before.

export const PAGE_DEFAULT = 200
export const PAGE_MAX = 500

const Page = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).optional(),
  cursor: z.string().optional(),
})

export type PageArgs = { limit: number; cursor: string | null }

export function readPage(query: unknown): { ok: true; page: PageArgs } | { ok: false; message: string } {
  const p = Page.safeParse(query ?? {})
  if (!p.success) return { ok: false, message: `limit is 1 to ${PAGE_MAX}` }
  const cursor = p.data.cursor ?? null
  if (cursor !== null && !isUuid(cursor)) return { ok: false, message: 'cursor is not one this endpoint returned' }
  return { ok: true, page: { limit: p.data.limit ?? PAGE_DEFAULT, cursor } }
}
