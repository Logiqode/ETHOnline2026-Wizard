// ─── CRE HTTP-trigger relay (shared core) ───────────────────────────────────
// Extracted from scripts/trigger.ts so the backend's HTTP route and the CLI
// script share one JWT-creation implementation. Byte-identical to the official
// SDK client (create-jwt.ts + trigger-workflow.ts), including the yParity
// signature normalization.
//
// Spec: https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/triggering-deployed-workflows
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { type Hex, parseSignature } from 'viem'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const b64urlFromB64 = (b64: string): string =>
  b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

/** Canonical JSON: keys sorted ascending lexicographically at EVERY level.
 *  Byte-identical to the SDK's `json-stable-stringify` for our payload shapes. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`)
  return `{${entries.join(',')}}`
}

const sha256Hex = (s: string): string =>
  '0x' + createHash('sha256').update(s, 'utf8').digest('hex')

async function createRequestJwt(
  account: PrivateKeyAccount,
  bodyObj: Record<string, unknown>,
): Promise<{ token: string; body: string }> {
  const header = b64urlFromB64(
    Buffer.from(JSON.stringify({ alg: 'ETH', typ: 'JWT' }), 'utf8').toString('base64'),
  )

  // digest = sha256 of the request body with keys sorted at every nesting level
  const digest = sha256Hex(sortedJson(bodyObj))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64urlFromB64(
    Buffer.from(
      JSON.stringify({
        digest,
        iss: account.address,
        iat: now,
        exp: now + 300, // 5 minutes (SDK value)
        jti: randomUUID(),
      }),
      'utf8',
    ).toString('base64'),
  )

  const message = `${header}.${payload}`
  // viem's signMessage applies the Ethereum Signed Message prefix + keccak256.
  const sig = await account.signMessage({ message })

  // Signature encoding per the spec / SDK: r (32B) || s (32B) || recoveryId (1B).
  const { r, s, v, yParity } = parseSignature(sig)
  const recoveryId = v !== undefined ? (v >= 27n ? v - 27n : v) : yParity
  if (recoveryId === undefined) throw new Error('Unable to extract recovery ID from signature')
  const rBuf = Buffer.from(r.slice(2).padStart(64, '0'), 'hex')
  const sBuf = Buffer.from(s.slice(2).padStart(64, '0'), 'hex')
  const signatureBytes = Buffer.concat([rBuf, sBuf, Buffer.from([Number(recoveryId)])])
  const encodedSignature = b64urlFromB64(signatureBytes.toString('base64'))

  return { token: `${message}.${encodedSignature}`, body: JSON.stringify(bodyObj) }
}

/** The relay's authorized key: env first, else the repo-root .env (backend cwd fallback). */
export function loadRelayKey(): Hex {
  let pk = process.env.CRE_ETH_PRIVATE_KEY
  if (!pk) {
    const rootEnv = new URL('../../../.env', import.meta.url)
    const envText = readFileSync(rootEnv, 'utf8')
    pk = envText
      .split('\n')
      .find((l) => l.startsWith('CRE_ETH_PRIVATE_KEY='))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
  }
  if (!pk) throw new Error('CRE_ETH_PRIVATE_KEY missing (process env or root .env)')
  if (!pk.startsWith('0x')) pk = `0x${pk}`
  return pk as Hex
}

/** The private-registry gateway for the zone-a DON family. */
export function loadGatewayUrl(): string {
  return process.env.CRE_GATEWAY_URL || 'https://01.gateway.zone-a.cre.chain.link'
}

export interface TriggerResult {
  signer: string
  httpStatus: number
  response: unknown // parsed JSON when possible, raw text otherwise
  executionId: string | null // gateway's execution handle when the fire was accepted
}

/** Sign + POST a workflow execution request to the CRE gateway. */
export async function triggerWorkflow(input: unknown, workflowId: string): Promise<TriggerResult> {
  const account = privateKeyToAccount(loadRelayKey())
  const bodyObj = {
    jsonrpc: '2.0',
    id: `req-${randomUUID()}`,
    method: 'workflows.execute',
    params: {
      input,
      workflow: { workflowID: workflowId },
    },
  }

  const { token, body } = await createRequestJwt(account, bodyObj)
  const res = await fetch(loadGatewayUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  })
  const text = await res.text()
  let response: unknown = text
  try {
    response = JSON.parse(text)
  } catch {
    /* keep raw text */
  }

  // The gateway returns the handle in result.workflow_execution_id on ACCEPTED.
  let executionId: string | null = null
  if (response && typeof response === 'object' && 'result' in response) {
    const result = (response as { result?: { workflow_execution_id?: string } }).result
    if (result && typeof result.workflow_execution_id === 'string') executionId = result.workflow_execution_id
  }

  return { signer: account.address, httpStatus: res.status, response, executionId }
}
