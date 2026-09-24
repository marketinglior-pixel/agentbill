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
// TLS as the app does it: required unless DATABASE_SSL=disable.
import postgres from 'postgres'
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RETRYABLE = new Set(['55P03', '40P01'])

const connect = (url) => postgres(url, {
  max: 1,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : 'require',
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
    const sql = connect(url)
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
      const sql = connect(process.env.DATABASE_URL)
      const rows = await sql.unsafe(check)
      for (const row of rows) console.log(JSON.stringify(row))
      await sql.end({ timeout: 5 })
    }
  } catch (err) {
    console.error(`apply-migration: ${err?.code ?? ''} ${err?.message ?? err}`.trim())
    process.exit(1)
  }
}
