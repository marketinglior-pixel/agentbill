// The secrets that sign sessions, checked before the server listens.
//
// APP_SESSION_SECRET signs the console cookie (src/routes/app.ts) and
// ADMIN_SECRET signs the admin session and, when APP_SESSION_SECRET is unset,
// is what the console secret is derived from. Nothing checked their length, so
// a four-character secret would have been an HMAC key anyone could brute-force
// offline from one cookie. In production each one that is set must be at least
// 32 bytes, or the process exits here with a sentence saying which.
//
// Unset is not refused: an unset APP_SESSION_SECRET falls back to the derived
// secret, and an unset ADMIN_SECRET means /admin and the console login answer
// "unavailable". Both are the behaviour this server already had.

export const MIN_SECRET_BYTES = 32

export function secretProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return []
  const out: string[] = []
  for (const name of ['APP_SESSION_SECRET', 'ADMIN_SECRET', 'WEBHOOK_SIGNING_KEY'] as const) {
    const v = env[name]
    if (v !== undefined && v !== '' && Buffer.byteLength(v, 'utf8') < MIN_SECRET_BYTES) {
      out.push(`${name} is ${Buffer.byteLength(v, 'utf8')} bytes; production needs at least ${MIN_SECRET_BYTES}`)
    }
  }
  return out
}

export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const problems = secretProblems(env)
  if (problems.length === 0) return
  console.error(`[boot] refusing to start: ${problems.join('; ')}. Generate one with: openssl rand -hex 32`)
  process.exit(1)
}
