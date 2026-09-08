import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ensureDepositSchema, sql } from './db'
import { campaigns } from './routes/campaigns'

// Bring the DB up to the gen-6 shape (deposit-handshake statuses + columns)
// before serving — idempotent, safe on a fresh or already-migrated database.
await ensureDepositSchema()

const app = new Hono()

// CORS for the Vite dev server. `CORS_ORIGIN` defaults to the canonical dev
// origin (5173) but can be set to another port (e.g. 5190) when Vite serves
// there. In production the app and backend share an origin, so this is dev-only.
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173'
app.use('*', cors({ origin: CORS_ORIGIN, allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'] }))

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

const PORT = Number(process.env.PORT ?? 4000)
Bun.serve({ fetch: app.fetch, port: PORT })
console.log(`wizard backend listening on http://localhost:${PORT}`)