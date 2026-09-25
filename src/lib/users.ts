import { sql } from '../db/index.js'
import type { VerifiedIdentity } from './oauth.js'

// People, their identities, and the one account each of them owns.
//
// The rule this file exists to keep: an identity is NEVER attached to an
// existing account because an email matches. accounts.email was never
// verified (anyone could register anyone's address at /register and hold the
// key), so "this Google address equals that account's address" is not
// evidence that the Google user owns the account, and linking on it would hand
// a pre-registered account, and everything the victim later does in it, to
// whoever registered it. An account created before sign-in existed is linked
// in exactly one way: its key holder, signed into the console with the key,
// presses "Connect Google" or "Connect GitHub" (linkIdentity below).
//
// Between USERS, a verified address does join identities: a person who signed
// up with an email link and later presses "Continue with Google" for the same
// address is one person with one account. Both sides of that match were
// verified (we mailed the address, or Google/GitHub vouched for it), which is
// the whole difference from the legacy accounts, and users.email is UNIQUE so
// there is never more than one candidate.

export interface SignedIn {
  userId: string
  epoch: number
  accountId: string
  email: string
  /** A new account was created by this sign-in. */
  created: boolean
}

export type LinkRefusal =
  | 'identity_in_use'      // this Google/GitHub identity already signs in to a different account
  | 'provider_taken'       // this account's owner already has a different identity at this provider
  | 'email_in_use'         // the provider's verified address already belongs to another person here

export async function signIn(id: VerifiedIdentity): Promise<{ ok: true; s: SignedIn } | { ok: false; reason: LinkRefusal }> {
  return sql.begin(async (tx) => {
    let user: { id: string; sessionEpoch: number; email: string } | undefined
    const [known] = await tx`
      SELECT u.id, u.session_epoch, u.email FROM user_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ${id.provider} AND i.provider_user_id = ${id.providerUserId}
    `
    if (known) {
      user = known as unknown as typeof user
      await tx`UPDATE user_identities SET last_used_at = now() WHERE provider = ${id.provider} AND provider_user_id = ${id.providerUserId}`
    } else {
      // A verified address that already belongs to a person joins that person.
      await tx`INSERT INTO users (email, email_verified_at) VALUES (${id.email}, now()) ON CONFLICT (email) DO NOTHING`
      const [u] = await tx`SELECT id, session_epoch, email FROM users WHERE email = ${id.email} FOR UPDATE`
      user = u as unknown as typeof user
      const inserted = await tx`
        INSERT INTO user_identities (user_id, provider, provider_user_id, email)
        VALUES (${user!.id}, ${id.provider}, ${id.providerUserId}, ${id.email})
        ON CONFLICT DO NOTHING RETURNING id
      `
      if (!inserted.length) {
        // Either a concurrent sign-in with this identity won the insert (then
        // it is this user's), or this person already has a DIFFERENT identity
        // at this provider (a second Google account with the same address).
        const [who] = await tx`SELECT user_id FROM user_identities WHERE provider = ${id.provider} AND provider_user_id = ${id.providerUserId}`
        if (!who || who.userId !== user!.id) return { ok: false as const, reason: 'provider_taken' as const }
      }
    }
    const u = user!
    // One account per person. The row lock serialises two first sign-ins of
    // the same person, so they cannot create two accounts.
    await tx`SELECT id FROM users WHERE id = ${u.id} FOR UPDATE`
    const [owned] = await tx`SELECT id FROM accounts WHERE owner_user_id = ${u.id}`
    if (owned) {
      return { ok: true as const, s: { userId: u.id, epoch: Number(u.sessionEpoch), accountId: owned.id as string, email: u.email, created: false } }
    }
    // A new account. accounts.email is UNIQUE, and a legacy account may already
    // hold this address (unverified, possibly registered by somebody else).
    // That account is not this person's to open, so this one is created beside
    // it with no accounts.email; the senders that mail an account (the quota
    // and new-network alerts) read the owner's verified address when it is
    // NULL. Nothing in the reply says which of the two happened.
    //
    // default_budget_units NULL for the reason register.ts gives: it is copied
    // onto every customer and never resets, so a number here is a silent
    // lifetime cap.
    let [acct] = await tx`
      INSERT INTO accounts (email, name, plan, default_budget_units, owner_user_id)
      VALUES (${u.email}, NULL, 'free', NULL, ${u.id})
      ON CONFLICT DO NOTHING RETURNING id
    `
    if (!acct) {
      ;[acct] = await tx`
        INSERT INTO accounts (email, name, plan, default_budget_units, owner_user_id)
        VALUES (NULL, NULL, 'free', NULL, ${u.id}) RETURNING id
      `
    }
    return { ok: true as const, s: { userId: u.id, epoch: Number(u.sessionEpoch), accountId: acct.id as string, email: u.email, created: true } }
  })
}

/**
 * Add a verified identity to one account, on the explicit request of somebody
 * already signed into that account (with its key, or as its owner). The only
 * way a legacy account ever gets an owner.
 */
export async function linkIdentity(accountId: string, id: VerifiedIdentity):
    Promise<{ ok: true; s: SignedIn } | { ok: false; reason: LinkRefusal }> {
  return sql.begin(async (tx) => {
    const [acct] = await tx`SELECT id, owner_user_id FROM accounts WHERE id = ${accountId} FOR UPDATE`
    if (!acct) return { ok: false as const, reason: 'identity_in_use' as const }
    const [holder] = await tx`
      SELECT i.user_id, a.id AS account_id FROM user_identities i LEFT JOIN accounts a ON a.owner_user_id = i.user_id
      WHERE i.provider = ${id.provider} AND i.provider_user_id = ${id.providerUserId}
    `
    let ownerId = acct.ownerUserId as string | null
    if (holder) {
      // Already this account's: nothing to add. Anyone else's: refused, and the
      // other account is not named.
      if (ownerId && holder.userId === ownerId) {
        const [u] = await tx`SELECT id, session_epoch, email FROM users WHERE id = ${ownerId}`
        return { ok: true as const, s: { userId: u.id as string, epoch: Number(u.sessionEpoch), accountId, email: u.email as string, created: false } }
      }
      return { ok: false as const, reason: 'identity_in_use' as const }
    }
    if (!ownerId) {
      const [taken] = await tx`SELECT id FROM users WHERE email = ${id.email}`
      if (taken) return { ok: false as const, reason: 'email_in_use' as const }
      const [u] = await tx`INSERT INTO users (email, email_verified_at) VALUES (${id.email}, now()) RETURNING id`
      ownerId = u.id as string
      await tx`UPDATE accounts SET owner_user_id = ${ownerId} WHERE id = ${accountId}`
    }
    const added = await tx`
      INSERT INTO user_identities (user_id, provider, provider_user_id, email)
      VALUES (${ownerId}, ${id.provider}, ${id.providerUserId}, ${id.email})
      ON CONFLICT DO NOTHING RETURNING id
    `
    if (!added.length) return { ok: false as const, reason: 'provider_taken' as const }
    const [u] = await tx`SELECT id, session_epoch, email FROM users WHERE id = ${ownerId}`
    return { ok: true as const, s: { userId: u.id as string, epoch: Number(u.sessionEpoch), accountId, email: u.email as string, created: false } }
  })
}

/** Logout: every session this person holds, on every device, ends now. */
export async function endSessions(userId: string, epoch: number): Promise<void> {
  await sql`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ${userId} AND session_epoch = ${epoch}`
}

/** The providers linked to the person who owns `accountId`. */
export async function linkedProviders(accountId: string): Promise<string[]> {
  const rows = await sql`
    SELECT i.provider FROM accounts a JOIN user_identities i ON i.user_id = a.owner_user_id
    WHERE a.id = ${accountId} ORDER BY i.provider
  `
  return rows.map((r) => r.provider as string)
}
