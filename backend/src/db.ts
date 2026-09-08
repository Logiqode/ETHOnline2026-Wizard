import postgres from 'postgres'

// Connection is built from DATABASE_URL. Compose sets it for the backend container;
// local dev uses .env (see .env.example). Port 5433 = the compose mapping, so the
// Dockerized Postgres never collides with a host-local Postgres on 5432.
const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://wizard:***@localhost:5433/wizard'

export const sql = postgres(connectionString, {
  max: 5, // small pool — hackathon backend
  onnotice: () => {}, // swallow NOTICEs from migrations/init
})

// ─── Deposit-handshake schema (gen-6, idempotent) ────────────────────────────
// The docker-compose init script creates the base table; these statements bring
// any existing database up to the gen-6 shape (new statuses + deposit columns)
// without manual psql steps. Runs at module load — before any route queries.
let schemaReady: Promise<void> | null = null
export function ensureDepositSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await sql`ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check`
    await sql`ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check CHECK (status = ANY (ARRAY['draft'::text, 'pending_deposit'::text, 'launched'::text, 'cancelled'::text]))`
    await sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deposit_deadline timestamptz`
    await sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deposits jsonb NOT NULL DEFAULT '{}'::jsonb`
  })()
  return schemaReady
}
