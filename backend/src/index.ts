// Local dev entry (Bun). The Vercel serverless entry is api/index.ts, which
// imports the shared Hono app from src/app.ts — routes stay in lockstep.
import { app, initSchema } from './app.js'

await initSchema()

const PORT = Number(process.env.PORT ?? 4000)
Bun.serve({ fetch: app.fetch, port: PORT })
console.log(`wizard backend listening on http://localhost:${PORT}`)
