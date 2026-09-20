// The one definition of what a campaign source may look like.
//
// Two places have to agree on it: the page, which reads ?src= out of its own
// URL, tags its own links to /register with it and puts it on every beacon;
// and this handler, which decides whether to store what arrives. Two copies of
// one rule is one chance for a value the page sends and the server drops,
// which reads back as "that directory sent nobody". The page's copy is inline
// in ui/pulse-client.ts and a gate asserts the two patterns are the same.
//
// Deliberately narrow. This value is written by us, into links we publish, so
// it never has to accommodate anything a visitor might type. Lowercase ASCII,
// digits, hyphen and underscore, opening on an alphanumeric, 24 characters.
// Anything else is not sanitised into shape: it is refused and recorded as no
// source at all, because a mangled label silently merged with a real one is
// worse than an absent one.
export const SOURCE_MAX = 24
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/

/** The value to store, or null. Never throws; callers are on hot paths. */
export function cleanSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  return SOURCE_RE.test(s) ? s : null
}
