// What the retention job WOULD remove, now, per category. Reads only: it
// runs the report half of src/lib/retention.ts and writes nothing, whatever
// RETENTION_MODE says. This is the number to read before RETENTION_MODE=enforce
// is set anywhere.
//
//   production:  flyctl ssh console -a agentbill -C "node /app/dist/retention-report.js"
//   locally:     DATABASE_URL=... DATABASE_SSL=disable node dist/retention-report.js
//
// It connects the way the server does (src/db/tls.ts: the certificate is
// verified in production).
import { sql } from './db/index.js'
import { RETENTION, retentionCounts } from './lib/retention.js'

const counts = await retentionCounts()
const rows = RETENTION.map((c) => ({ category: c.key, period: `${c.days} days from ${c.from}`, action: c.action, rows_past_period: counts[c.key] }))
console.table(rows)
console.log(JSON.stringify({ report: 'retention', at: new Date().toISOString(), counts }))
await sql.end({ timeout: 5 })
