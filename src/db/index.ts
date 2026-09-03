import postgres from 'postgres'

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
})
