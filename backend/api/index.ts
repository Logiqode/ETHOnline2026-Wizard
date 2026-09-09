// Vercel serverless entry — wraps the same Hono app the local Bun server uses.
// Every route (except the Bun.serve bootstrap in src/index.ts, which is not
// imported here) lives in src/app.ts so local dev and serverless stay in lockstep.
import { handle } from 'hono/vercel'
import { app } from '../src/app'

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const OPTIONS = handle(app)
export const maxDuration = 60 // launch path does 2 on-chain txs + receipt waits
