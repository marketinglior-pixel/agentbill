import { randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { sql } from '../db/index.js'
import { loadOffice, safeJson, type Office, type OfficeState } from './office.js'

// Public links to an account's office (2026-09-26, Lior: the owner chooses
// whether agent names and dollar amounts are shown).
//
// A share is a SNAPSHOT, made on the server when the owner asks for it: the
// office as loadOffice() reads it at that moment, with the owner's two choices
// already applied by snapshotOf(). The public page draws the snapshot and
// never reads the account again, so what a stranger sees is exactly what the
// owner chose, frozen, and nothing a later call records can leak onto it.
//
//   names hidden   every agent is "agent 1", "agent 2", ... in the room's order,
//                  the highest paid included; no real name is in the snapshot
//   dollars hidden no salary, no payroll and no amount is in the snapshot, and
//                  usdHidden tells the engine not to print "unpriced" instead
//
// The card image is the one thing the browser supplies: the 1200x630 PNG the
// console drew with the same two choices, for the preview a feed shows. It is
// not trusted: checkCardPng() accepts only a well-formed PNG of exactly that
// size, made of image chunks, with no text chunk or anything else a file could
// carry. It is the owner's own drawing of their own office; the page itself is
// built from the snapshot, never from the image.

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{24}$/
/** Live links an account can hold at once. */
export const SHARES_ACTIVE_MAX = 20
/** Links an account can make in one UTC day, stopped ones included. */
export const SHARES_PER_DAY = 10
export const CARD_W = 1200
export const CARD_H = 630
/** The largest card stored. A canvas card is 100-400 KB; migration 035 holds the same bound. */
export const CARD_MAX_BYTES = 1_048_576

/** 18 random bytes, 24 url-safe characters. */
export const newShareToken = (): string => randomBytes(18).toString('base64url')

export type ShareChoices = { showNames: boolean; showUsd: boolean }
export type ShareAgent = { name: string; sal: number | null; state: OfficeState; working: boolean }
export type ShareSnapshot = {
  sample: false
  public: true
  usdHidden: boolean
  shareText: string
  agents: ShareAgent[]
  summary: {
    month: string
    payroll: number | null
    staff: number
    atDesk: number
    sentHome: number
    top: { name: string; sal: number | null; idx: number } | null
  }
}

const cents = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100)

/** The office as a stranger may see it: the owner's two choices, applied here, once. */
export function snapshotOf(o: Office, { showNames, showUsd }: ShareChoices): ShareSnapshot {
  const nameOf = (i: number, real: string) => (showNames ? real : `agent ${i + 1}`)
  const agents = o.agents.map((a, i) => ({ name: nameOf(i, a.name), sal: showUsd ? cents(a.sal) : null, state: a.state, working: a.working }))
  const topIdx = o.topEarner ? o.agents.findIndex((a) => a.name === o.topEarner!.name) : -1
  const top = o.topEarner && topIdx >= 0
    ? { name: nameOf(topIdx, o.topEarner.name), sal: showUsd ? cents(o.topEarner.sal) : null, idx: topIdx }
    : null
  const summary = { month: o.month, payroll: showUsd ? cents(o.payroll) : null, staff: o.staff, atDesk: o.atDesk, sentHome: o.sentHome, top }
  return { sample: false, public: true, usdHidden: !showUsd, shareText: shareTextOf(summary, showUsd), agents, summary }
}

/** The post a link starts from. Names no agent, and no dollar when dollars are hidden. */
export function shareTextOf(s: ShareSnapshot['summary'], showUsd: boolean): string {
  const n = `${s.staff} ${s.staff === 1 ? 'AI agent' : 'AI agents'}`
  const sent = s.sentHome ? `, ${s.sentHome} sent home by a spend ceiling` : ''
  const pay = showUsd && s.payroll != null
    ? `$${s.payroll.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of payroll across ${n}`
    : `${n} on staff`
  return `My office this month: ${pay}${sent}. Made with AgentBill`
}

export const snapshotJson = (s: ShareSnapshot): string => safeJson(s)

// ---------------------------------------------------------------- the card

/** Chunks a canvas PNG may carry. No text (tEXt, zTXt, iTXt), no eXIf, nothing private. */
const CARD_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP'])
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type CardCheck = { ok: true } | { ok: false; reason: string }

/**
 * A card is accepted only if it is a PNG this check can read end to end: the
 * signature, then chunks each of whose CRC is right, IHDR first and 1200x630
 * at 8 bits per channel, at least one IDAT, IEND last and nothing after it,
 * and no chunk outside CARD_CHUNKS.
 */
export function checkCardPng(buf: Buffer): CardCheck {
  if (buf.length > CARD_MAX_BYTES) return { ok: false, reason: 'too_large' }
  if (buf.length < PNG_SIG.length + 12 + 13 || !buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, reason: 'not_png' }
  let at = 8
  let seen = 0
  let idat = 0
  while (at < buf.length) {
    if (at + 12 > buf.length) return { ok: false, reason: 'truncated' }
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (len > buf.length - at - 12) return { ok: false, reason: 'truncated' }
    const body = buf.subarray(at + 4, at + 8 + len)
    if (crc32(body) !== buf.readUInt32BE(at + 8 + len)) return { ok: false, reason: 'bad_crc' }
    if (!CARD_CHUNKS.has(type)) return { ok: false, reason: `chunk_${/^[A-Za-z]{4}$/.test(type) ? type : 'invalid'}` }
    if (seen === 0) {
      if (type !== 'IHDR' || len !== 13) return { ok: false, reason: 'no_ihdr' }
      const w = buf.readUInt32BE(at + 8), h = buf.readUInt32BE(at + 12), depth = buf[at + 16], color = buf[at + 17]
      if (w !== CARD_W || h !== CARD_H) return { ok: false, reason: 'wrong_size' }
      if (depth !== 8 || (color !== 2 && color !== 6)) return { ok: false, reason: 'wrong_format' }
    } else if (type === 'IHDR') return { ok: false, reason: 'two_ihdr' }
    if (type === 'IDAT') idat++
    seen++
    at += 12 + len
    if (type === 'IEND') return at === buf.length && idat > 0 && len === 0 ? { ok: true } : { ok: false, reason: 'bad_end' }
  }
  return { ok: false, reason: 'no_iend' }
}

/** The form's card field: a PNG data URL, or empty when the page had no JavaScript. */
export function cardFromField(v: unknown): Buffer | null | 'invalid' {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return 'invalid'
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v)
  if (!m) return 'invalid'
  const buf = Buffer.from(m[1], 'base64')
  return checkCardPng(buf).ok ? buf : 'invalid'
}

// ---------------------------------------------------------------- storage

export type MadeShare = { ok: true; token: string } | { ok: false; reason: 'empty' | 'active_limit' | 'day_limit' }

/**
 * Makes a link. The limits are counted and the row written under one
 * per-account lock, so two submits at once cannot both take the last slot.
 */
export async function createShare(accountId: string, choices: ShareChoices, card: Buffer | null): Promise<MadeShare> {
  const office = await loadOffice(accountId)
  if (office.staff === 0) return { ok: false, reason: 'empty' }
  const snap = snapshotOf(office, choices)
  const token = newShareToken()
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'office_shares:' + accountId}))`
    const [n] = await tx`
      SELECT count(*) FILTER (WHERE stopped_at IS NULL)::int AS active,
             count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS today
      FROM office_shares WHERE account_id = ${accountId}`
    if (n.active >= SHARES_ACTIVE_MAX) return { ok: false as const, reason: 'active_limit' as const }
    if (n.today >= SHARES_PER_DAY) return { ok: false as const, reason: 'day_limit' as const }
    // ::text::jsonb, the house rule (src/routes/events.ts): a bare parameter
    // bound to jsonb is stored as a JSON string, not an object.
    await tx`
      INSERT INTO office_shares (token, account_id, month, show_names, show_usd, snapshot, card_png)
      VALUES (${token}, ${accountId}, ${office.month}, ${choices.showNames}, ${choices.showUsd}, ${JSON.stringify(snap)}::text::jsonb, ${card})`
    return { ok: true as const, token }
  })
}

export type PublicShare = { token: string; month: string; showNames: boolean; showUsd: boolean; snapshot: ShareSnapshot; hasCard: boolean; createdAt: Date }

/** A live link's page data, or null for a token that is malformed, unknown or stopped: one answer for all three. */
export async function loadShare(token: string): Promise<PublicShare | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null
  const [r] = await sql`
    SELECT token, month, show_names, show_usd, snapshot, card_png IS NOT NULL AS has_card, created_at
    FROM office_shares WHERE token = ${token} AND stopped_at IS NULL`
  if (!r) return null
  const snapshot = r.snapshot as ShareSnapshot
  return { token: r.token, month: r.month, showNames: r.showNames, showUsd: r.showUsd, snapshot, hasCard: r.hasCard, createdAt: new Date(r.createdAt) }
}

/** A live link's card, or null. */
export async function loadShareCard(token: string): Promise<Buffer | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null
  const [r] = await sql`SELECT card_png FROM office_shares WHERE token = ${token} AND stopped_at IS NULL AND card_png IS NOT NULL`
  return r ? Buffer.from(r.cardPng as Uint8Array) : null
}

export type OwnShare = { id: string; token: string; month: string; showNames: boolean; showUsd: boolean; hasCard: boolean; createdAt: Date }

/** The account's live links, newest first. */
export async function listShares(accountId: string): Promise<OwnShare[]> {
  const rows = await sql`
    SELECT id, token, month, show_names, show_usd, card_png IS NOT NULL AS has_card, created_at
    FROM office_shares WHERE account_id = ${accountId} AND stopped_at IS NULL
    ORDER BY created_at DESC LIMIT ${SHARES_ACTIVE_MAX}`
  return rows.map((r) => ({ id: r.id, token: r.token, month: r.month, showNames: r.showNames, showUsd: r.showUsd, hasCard: r.hasCard, createdAt: new Date(r.createdAt) }))
}

/**
 * Stops one of the account's own links, and deletes what it published: the
 * card and the snapshot go at once. The row itself stays, empty, only so the
 * day's count of links made (SHARES_PER_DAY) still counts it. False when the
 * link is not theirs, or already stopped.
 */
export async function stopShare(accountId: string, id: string): Promise<boolean> {
  const hit = await sql`
    UPDATE office_shares SET stopped_at = now(), card_png = NULL, snapshot = '{}'::jsonb
    WHERE id = ${id} AND account_id = ${accountId} AND stopped_at IS NULL RETURNING id`
  return hit.length > 0
}
