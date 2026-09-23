import postgres from 'postgres'
import { int8Type } from './int8.js'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required')
}

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  // Local verification runs against a plain container with no TLS. Production
  // is unchanged: without the flag this stays 'require'.
  ssl: process.env.DATABASE_SSL === 'disable' ? false : 'require',
  transform: postgres.camel,
  // int8 as an exact number, or a loud error; never a string. Must ship
  // before migration 016 moves the unit columns to BIGINT. See ./int8.ts.
  types: { int8: int8Type },
})
