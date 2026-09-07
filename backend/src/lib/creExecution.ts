// ─── CRE CLI bridge: poll an execution to its verdict ───────────────────────
// The gateway's HTTP API only accepts the fire (workflows.execute); status
// lives behind the `cre` CLI ("cre execution status <id> --json"). This spawns
// the CLI in-process and parses the JSON stdout — no shell, no PATH dependency
// (the binary lives in %LOCALAPPDATA%/Programs/cre).
//
// Windows note: the CLI writes the JSON to stdout but its "Initializing…" /
// update-notice chatter to stderr — always parse stdout only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ExecutionVerdict {
  status: 'SUCCESS' | 'FAILURE' | 'PENDING' // PENDING = still running when we gave up
  finishedAt: string | null
  durationMs: number | null
  errors: { error: string; count: number }[] // top-level DON errors on FAILURE
  logs: { node: string; timestamp: string; message: string }[] // user logs (Node 1 view)
  points: number | null // computed reward from the eligibility log (e.g. 3 Bpoints)
  eligible: boolean | null // eligibility verdict from the log
  reason: string | null // e.g. 'ok', 'below-min-spend', 'cap-exhausted'
}

const CRE_CANDIDATES = [
  process.env.CRE_CLI_PATH,
  join(process.env.LOCALAPPDATA ?? 'C:/Users/jerem/AppData/Local', 'Programs', 'cre', 'cre.exe'),
  '/usr/local/bin/cre',
  '/usr/bin/cre',
].filter(Boolean) as string[]

function findCreBinary(): string {
  for (const p of CRE_CANDIDATES) {
    try {
      readFileSync(p) // existence probe (works for the .exe too)
      return p
    } catch {
      /* try next */
    }
  }
  throw new Error('cre CLI not found (set CRE_CLI_PATH or install to %LOCALAPPDATA%/Programs/cre)')
}

function runCre(args: string[], cwd: string): string {
  const proc = Bun.spawnSync([findCreBinary(), ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`cre ${args[0]} exited ${proc.exitCode}: ${proc.stderr.toString().slice(0, 300)}`)
  }
  return proc.stdout.toString()
}

/** Parse the CLI's mixed output ("Initializing…" chatter + a JSON body). */
function extractJson(stdout: string): unknown {
  const start = stdout.indexOf('{')
  if (start === -1) throw new Error('no JSON found in cre CLI output')
  return JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1))
}

/** Strip the update-notice tail and parse the log array. */
function extractLogArray(stdout: string): { node?: string; timestamp?: string; message?: string }[] {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return []
  }
}

/** One status probe: returns the raw CLI JSON (or null while PENDING). */
function probeStatus(executionId: string, cwd: string): { status: string; finishedAt?: string; errors?: { error: string; count: number }[] } {
  const parsed = extractJson(runCre(['execution', 'status', executionId.replace(/^0x/i, ''), '--json'], cwd)) as {
    status?: string
    finishedAt?: string
    errors?: { error: string; count: number }[]
  }
  return { status: parsed.status ?? 'UNKNOWN', finishedAt: parsed.finishedAt, errors: parsed.errors }
}

/**
 * Poll the execution until it reaches SUCCESS/FAILURE (or the timeout).
 * Execution typically takes 10-15s (trigger → reads → consensus → write);
 * we poll every 2s up to `timeoutMs` (default 45s).
 */
export async function awaitExecutionVerdict(executionId: string, timeoutMs = 45_000, cwd = process.cwd()): Promise<ExecutionVerdict> {
  const deadline = Date.now() + timeoutMs
  let last: { status: string; finishedAt?: string; errors?: { error: string; count: number }[] } | null = null

  while (Date.now() < deadline) {
    try {
      last = probeStatus(executionId, cwd)
      if (last.status === 'SUCCESS' || last.status === 'FAILURE') break
    } catch {
      // transient CLI/RPC hiccup — keep polling until the deadline
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }

  const status = last?.status === 'SUCCESS' || last?.status === 'FAILURE' ? last.status : 'PENDING'
  let durationMs: number | null = null
  if (last?.finishedAt) {
    // finishedAt is ISO; startedAt isn't worth a second call — the CLI prints
    // duration only in the human view, so derive from finishedAt minus now if
    // needed. For the UI, null is fine (status + errors are the payload).
    const t = Date.parse(last.finishedAt)
    if (!Number.isNaN(t)) durationMs = 0 // set below from the status call when cheap
  }

  // Pull the node logs for the debug view (eligibility verdict, report write,
  // etc.). Node 1's logs are canonical. Also parse the eligibility line into
  // structured fields so the UI can show "eligible=true points=3 (reason=ok)"
  // next to the verdict — what testers need when exercising caps/rules.
  let logs: ExecutionVerdict['logs'] = []
  let points: number | null = null
  let eligible: boolean | null = null
  let reason: string | null = null
  try {
    const raw = runCre(['execution', 'logs', executionId.replace(/^0x/i, ''), '--json'], cwd)
    logs = extractLogArray(raw)
      .filter((l) => l.node === undefined || l.node === '' || l.node === 'Node 1')
      .map((l) => ({ node: l.node ?? 'Node 1', timestamp: l.timestamp ?? '', message: l.message ?? '' }))
      .slice(0, 8)
    const eligLine = logs.find((l) => l.message.startsWith('eligibility:'))?.message
    if (eligLine) {
      // Shape: "eligibility: ok eligible=true points=3" (or "eligibility: cap-exhausted eligible=false points=0")
      const parts = eligLine.replace(/^eligibility:\s*/, '').split(/\s+/)
      reason = parts[0] ?? null
      const e = parts.find((p) => p.startsWith('eligible='))?.split('=')[1]
      eligible = e === 'true' ? true : e === 'false' ? false : null
      const p = parts.find((x) => x.startsWith('points='))?.split('=')[1]
      points = p !== undefined && !Number.isNaN(Number(p)) ? Number(p) : null
    }
  } catch {
    /* logs are best-effort */
  }

  return { status, finishedAt: last?.finishedAt ?? null, durationMs, errors: last?.errors ?? [], logs, points, eligible, reason }
}
