// ─── CRE HTTP-trigger relay client ──────────────────────────────────────────
// The platform backend's signed-relay: merchants authenticate to the platform
// with API keys (no-web3-for-partners); THIS script (or the backend route that
// wraps it) signs the workflow execution request with the relay key and POSTs
// it to the CRE gateway. The signing address must be in the workflow's
// `authorizedKeys`.
//
// Spec: https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/triggering-deployed-workflows
// Reference impl: https://github.com/smartcontractkit/cre-sdk-typescript/tree/main/packages/cre-http-trigger
//   (this script mirrors create-jwt.ts + trigger-workflow.ts exactly —
//   including the yParity signature normalization — so any spec ambiguity
//   resolves to "identical to the official SDK client")
//
// Usage:
//   bun run trigger.ts ./payload.json                    # WORKFLOW_ID from env
//   bun run trigger.ts ./payload.json --workflow-id <64hex>
//
// Env (root .env): CRE_ETH_PRIVATE_KEY (relay/authorized key), WORKFLOW_ID.
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { type Hex, parseSignature } from 'viem'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

// ── helpers (mirrors SDK utils.ts) ──────────────────────────────────────────
const b64urlFromB64 = (b64: string): string =>
  b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

/** Canonical JSON: keys sorted ascending lexicographically at EVERY level.
 *  Byte-identical to the SDK's `json-stable-stringify` for our payload shapes
 *  (verified against the real request body). */
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

// ── JWT (mirrors SDK create-jwt.ts) ─────────────────────────────────────────
async function createRequestJwt(account: PrivateKeyAccount, bodyObj: Record<string, unknown>): Promise<{ token: string; body: string }> {
  const header = b64urlFromB64(Buffer.from(JSON.stringify({ alg: 'ETH', typ: 'JWT' }), 'utf8').toString('base64'))

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

  // Signature encoding per the spec / SDK: r (32B) || s (32B) || recoveryId (1B, yParity 0/1).
  const { r, s, v, yParity } = parseSignature(sig)
  const recoveryId = v !== undefined ? (v >= 27n ? v - 27n : v) : yParity
  if (recoveryId === undefined) throw new Error('Unable to extract recovery ID from signature')
  const rBuf = Buffer.from(r.slice(2).padStart(64, '0'), 'hex')
  const sBuf = Buffer.from(s.slice(2).padStart(64, '0'), 'hex')
  const signatureBytes = Buffer.concat([rBuf, sBuf, Buffer.from([Number(recoveryId)])])
  const encodedSignature = b64urlFromB64(signatureBytes.toString('base64'))

  return { token: `${message}.${encodedSignature}`, body: JSON.stringify(bodyObj) }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const payloadPath = args.find((a) => !a.startsWith('--'))
  const wfFlag = args.indexOf('--workflow-id')
  const workflowId = wfFlag >= 0 ? args[wfFlag + 1] : process.env.WORKFLOW_ID
  if (!payloadPath || !workflowId) {
    console.error('usage: bun run trigger.ts <payload.json> [--workflow-id <64hex>]')
    console.error('env: CRE_ETH_PRIVATE_KEY, WORKFLOW_ID (or pass --workflow-id)')
    process.exit(1)
  }

  // Private key: env first, else read the repo-root .env (backend cwd fallback).
  let pk = process.env.CRE_ETH_PRIVATE_KEY
  if (!pk) {
    const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    pk = envText.split('\n').find((l) => l.startsWith('CRE_ETH_PRIVATE_KEY='))?.split('=').slice(1).join('=').trim()
  }
  if (!pk) throw new Error('CRE_ETH_PRIVATE_KEY missing')
  if (!pk.startsWith('0x')) pk = `0x${pk}`
  const account = privateKeyToAccount(pk as Hex)

  // The payload IS params.input (the enclave's requestSchema parses it).
  const input = JSON.parse(readFileSync(payloadPath, 'utf8'))
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
  console.log('signed by:', account.address)

  // Private-registry gateway (per workflow.yaml `deployment-registry: "private"`).
  const gateway = process.env.CRE_GATEWAY_URL || 'https://01.enterprise-gateway.zone-a.cre.chain.link/'
  const res = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  })
  const text = await res.text()
  console.log(`HTTP ${res.status}`)
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
  if (res.status !== 200) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
