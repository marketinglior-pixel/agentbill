#!/usr/bin/env node
// Apply one migration file, retrying while it cannot get its locks.
//
//   DATABASE_URL=... node apply-migration.mjs <file.sql> [--attempts N] [--check "<SELECT ...>"]
//
// Written for the production step in migration 016, and for any migration
// that locks tables the app is using: production's machine has node and the
// postgres package but no psql, so a file is applied from inside it with
// this (copied in with `flyctl ssh sftp shell`, deleted after). The same
// function is what scripts/preflight/alter-under-load.mjs runs, so the
// rehearsal exercises the runner the deploy uses.
//
// The file runs as one simple-protocol query on a fresh connection, so its
// own BEGIN / COMMIT decide what is atomic. A lock the file could not get in
// its lock_timeout (55P03), or a deadlock it lost (40P01), rolls the whole
// file back: the connection is closed, nothing was changed, and it is tried
// again after a short pause. Any other error stops at once and is printed.
// --check runs a read afterwards and prints its rows, so the result is
// verified by what the database says, not by the absence of an error.
//
// On the production machine, run it from /app (cd /app first, or copy it to
// /app/scripts/db/), so it finds /app/dist/db/tls.js and /app/node_modules:
//   cd /app && DATABASE_URL=... node /tmp/apply-migration.mjs /tmp/0NN_x.sql --check "..."
// It verifies the Supabase certificate by default; there is nothing to set.
//
// TLS, since 2026-09-25 (security batch C): the certificate is VERIFIED, the
// way the server has verified it since batch A (S10). Until then this said
// "as the app does it" and meant ssl 'require', which in postgres.js is
// rejectUnauthorized: false: encrypted, with any certificate accepted. That
// is the connection that carries a production migration and its credentials.
//
// The rule is the server's own: dbSsl() from src/db/tls.ts (compiled to
// dist/db/tls.js), in its verify mode, which checks the chain and the host
// name against the embedded Supabase Root 2021 CA plus Node's public roots,
// and DATABASE_SSL_CA_FILE for a database that is not Supabase. One copy of
// the root, so the runner and the server cannot trust different things.
// dist/ is found beside this file (scripts/db -> ../../dist, the repo and the
// production image's /app alike) or under the working directory; if it is in
// neither place the runner refuses to connect, rather than connect unverified.
//
// The one opt-out: DATABASE_SSL=disable, for a database on this machine. It
// is refused for any host but localhost, 127.0.0.1 and ::1 (or a Unix
// socket), and it says so on stderr every time it is used. There is no
// "encrypted but unverified" mode here: DATABASE_SSL=require is refused.
import postgres from 'postgres'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RETRYABLE = new Set(['55P03', '40P01'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', ''])

/** The host a connection string names, as postgres.js will dial it. */
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

async function serverTls() {
  const candidates = [new URL('../../dist/db/tls.js', import.meta.url), pathToFileURL(resolve(process.cwd(), 'dist/db/tls.js'))]
  const found = candidates.find((u) => existsSync(u))
  if (!found) {
    throw new Error('cannot find dist/db/tls.js (the server\'s TLS rule and the Supabase root). Run `npm run build` first, or run this from the app directory. Refusing to connect without verifying the certificate.')
  }
  return import(found.href)
}

/**
 * The `ssl` option for this connection, or a thrown refusal. Exported for the
 * harness ([migration tls] gates), which checks every branch of it.
 */
export async function tlsFor(url, env = process.env, warn = (m) => console.error(m)) {
  const mode = (env.DATABASE_SSL ?? '').trim().toLowerCase()
  const host = hostOf(url)
  if (host === null) throw new Error('DATABASE_URL is not a URL this runner can read the host of.')
  if (mode === 'disable') {
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(`DATABASE_SSL=disable is for a database on this machine only (localhost, 127.0.0.1, ::1). ${host} is not one. Refusing to connect without TLS.`)
    }
    warn(`[apply-migration] WARNING: DATABASE_SSL=disable. Connecting to ${host || 'a local socket'} WITHOUT TLS. For a local database only.`)
    return false
  }
  if (mode !== '' && mode !== 'verify') {
    throw new Error(`DATABASE_SSL=${mode} is not accepted here: this runner verifies the database certificate (unset or verify), or, for a database on this machine only, DATABASE_SSL=disable.`)
  }
  const { dbSsl } = await serverTls()
  return dbSsl({ ...env, DATABASE_SSL: 'verify' }).ssl
}

const connect = async (url) => postgres(url, {
  max: 1,
  ssl: await tlsFor(url),
  prepare: false,
  onnotice: () => {},
})

// Only a .sql file that exists as a regular file is read: the argument is the
// operator's, but a typo should fail here, not run something else.
export function migrationText(file) {
  const path = resolve(String(file))
  if (!path.endsWith('.sql') || !statSync(path).isFile()) {
    throw new Error(`not a .sql migration file: ${path}`)
  }
  return { path, name: basename(path), text: readFileSync(path, 'utf8') }
}

export async function applyMigration(url, file, { attempts = 40, pauseMs = 250, log = console.log } = {}) {
  const { name, text } = migrationText(file)
  for (let i = 1; ; i++) {
    const sql = await connect(url)
    try {
      await sql.unsafe(text)
      await sql.end({ timeout: 5 })
      log(`applied ${name} on attempt ${i}`)
      return { attempts: i }
    } catch (err) {
      // Closing the connection is what ends a transaction the error aborted.
      await sql.end({ timeout: 1 }).catch(() => {})
      if (!RETRYABLE.has(err?.code) || i >= attempts) {
        log(`${name}: ${err?.code ?? ''} ${err?.message ?? err} (attempt ${i}, not retried)`)
        throw err
      }
      log(`${name}: attempt ${i} ${err.code} ${err.message}; rolled back, nothing changed, retrying`)
      await new Promise((r) => setTimeout(r, pauseMs + Math.floor(Math.random() * pauseMs)))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const file = args.find((a, i) => !a.startsWith('--') && !['--attempts', '--check'].includes(args[i - 1]))
  const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  if (!process.env.DATABASE_URL || !file) {
    console.error('usage: DATABASE_URL=... node apply-migration.mjs <file.sql> [--attempts N] [--check "<SELECT ...>"]')
    process.exit(2)
  }
  try {
    await applyMigration(process.env.DATABASE_URL, file, { attempts: Number(flag('--attempts') ?? 40) })
    const check = flag('--check')
    if (check) {
      const sql = await connect(process.env.DATABASE_URL)
      const rows = await sql.unsafe(check)
      for (const row of rows) console.log(JSON.stringify(row))
      await sql.end({ timeout: 5 })
    }
  } catch (err) {
    console.error(`apply-migration: ${err?.code ?? ''} ${err?.message ?? err}`.trim())
    process.exit(1)
  }
}
