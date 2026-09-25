import postgres from 'postgres'
import { int8Type } from './int8.js'
import { dbSsl } from './tls.js'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required')
}

// Prepared statements, on unless DATABASE_PREPARE=false. The switch exists for
// one step of a deploy: an ALTER ... TYPE (migration 016 is the first) while
// this process is serving.
//
// postgres.js prepares every statement once per connection and keeps it. After
// an ALTER changes a column's type under it, the kept statement fails:
// Postgres answers 0A000 "cached plan must not change result type", which
// postgres.js retries outside a transaction but cannot inside sql.begin (the
// transaction is already aborted), and in a review rehearsal of 016 under
// load it also handed the int8 parser UUIDs and IPs and left requests that
// never answered at all. Restarting the process afterwards does not bring
// those requests back. With prepared statements off, every statement is
// parsed and described fresh, so a query that runs after the ALTER commits
// sees the new types, and nothing cached can go stale. It costs one round
// trip more per parameterised query, which is why it is a window and not the
// default. The order is in the header of migration 016, and
// scripts/preflight/alter-under-load.sh rehearses it.
const prepare = process.env.DATABASE_PREPARE !== 'false'
if (!prepare) {
  console.log('[db] prepared statements OFF (DATABASE_PREPARE=false): the ALTER ... TYPE window is open. Unset it once the migration is verified.')
}

// Throws, and so stops the boot, on an insecure mode in production without the
// explicit override. See ./tls.ts for the modes and the measurement.
const tls = dbSsl()
if (tls.notice) console.error(tls.notice)

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  // verify in production (chain and host name checked), require elsewhere,
  // disable for a local container. ./tls.ts.
  ssl: tls.ssl,
  transform: postgres.camel,
  prepare,
  // int8 as an exact number, or a loud error; never a string. Must ship
  // before migration 016 moves the unit columns to BIGINT. See ./int8.ts.
  types: { int8: int8Type },
})
