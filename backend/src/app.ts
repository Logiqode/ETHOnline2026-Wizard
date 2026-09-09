import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ensureDepositSchema, sql } from './db'
import { campaigns } from './routes/campaigns'

// Bring the DB up to the gen-6 shape (deposit-handshake statuses + columns)
// before serving — idempotent, safe on a fresh or already-migrated database.
export function initSchema(): Promise<void> {
  return ensureDepositSchema()
}

export const app = new Hono()

// CORS: `CORS_ORIGIN` is a comma-separated allowlist. Defaults to the Vite dev
// origin; in production set it to the deployed app URL(s). Vercel preview URLs
// vary per deployment — add a preview pattern's origin explicitly if needed.
const CORS_ORIGINS = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
app.use('*', cors({
  origin: (origin) => (CORS_ORIGINS.includes(origin) ? origin : undefined),
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
}))

app.get('/health', async (c) => {
  try {
    await sql`SELECT 1`
    return c.json({ ok: true, db: 'up' })
  } catch {
    return c.json({ ok: false, db: 'down' }, 503)
  }
})

app.route('/api/campaigns', campaigns)

app.notFound((c) => c.json({ error: 'Not found' }, 404))

// Hono error handler — async handler rejections land here.
app.onError((err, c) => {
  console.error('backend error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})
