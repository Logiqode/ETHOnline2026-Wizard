// Name-based selector probe: does the gateway resolve workflows by
// (workflowOwner, workflowName, workflowTag) instead of workflowID?
// JWT construction mirrors trigger.ts (SDK-aligned) exactly.
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex, parseSignature } from 'viem'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const b64urlFromB64 = (b64: string): string =>
  b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

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

async function createRequestJwt(account: ReturnType<typeof privateKeyToAccount>, bodyObj: Record<string, unknown>): Promise<string> {
  const header = b64urlFromB64(Buffer.from(JSON.stringify({ alg: 'ETH', typ: 'JWT' }), 'utf8').toString('base64'))
  const digest = sha256Hex(sortedJson(bodyObj))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64urlFromB64(
    Buffer.from(
      JSON.stringify({ digest, iss: account.address, iat: now, exp: now + 300, jti: randomUUID() }),
      'utf8',
    ).toString('base64'),
  )
  const message = `${header}.${payload}`
  const sig = await account.signMessage({ message })
  const { r, s, v, yParity } = parseSignature(sig)
  const recoveryId = v !== undefined ? (v >= 27n ? v - 27n : v) : yParity
  if (recoveryId === undefined) throw new Error('no recovery id')
  const rBuf = Buffer.from(r.slice(2).padStart(64, '0'), 'hex')
  const sBuf = Buffer.from(s.slice(2).padStart(64, '0'), 'hex')
  const signatureBytes = Buffer.concat([rBuf, sBuf, Buffer.from([Number(recoveryId)])])
  return `${message}.${b64urlFromB64(signatureBytes.toString('base64'))}`
}

let pk = process.env.CRE_ETH_PRIVATE_KEY
if (!pk) {
  const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  pk = envText.split('\n').find((l) => l.startsWith('CRE_ETH_PRIVATE_KEY='))!.split('=').slice(1).join('=').trim()
}
if (!pk!.startsWith('0x')) pk = `0x${pk}`
const account = privateKeyToAccount(pk as Hex)

const OWNER_ID = '8996097709d886abd468511bfb5a7279110e15d8' // workflow list ownerAddress (32-hex, no 0x)
const OWNER_EVM = account.address.toLowerCase() // lowercase 0x9587bd3e... (gateway rejects checksummed)

const candidates: Array<{ label: string; workflow: Record<string, string> }> = [
  ...['staging', 'default', 'latest'].map((tag) => ({
    label: `evmOwner+name+tag:${tag}`,
    workflow: { workflowOwner: OWNER_EVM, workflowName: 'wizard-staging', workflowTag: tag },
  })),
  ...['staging', 'default', 'latest'].map((tag) => ({
    label: `ownerId+name+tag:${tag}`,
    workflow: { workflowOwner: OWNER_ID, workflowName: 'wizard-staging', workflowTag: tag },
  })),
]

const gateway = 'https://01.enterprise-gateway.zone-a.cre.chain.link/'
for (const c of candidates) {
  const bodyObj = {
    jsonrpc: '2.0',
    id: `probe-${randomUUID()}`,
    method: 'workflows.execute',
    params: { input: { campaignId: 1 }, workflow: c.workflow },
  }
  const token = await createRequestJwt(account, bodyObj)
  try {
    const res = await fetch(gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(bodyObj),
    })
    const text = await res.text()
    console.log(`[${c.label}] HTTP ${res.status}: ${text.slice(0, 220)}`)
  } catch (e) {
    console.log(`[${c.label}] fetch error:`, (e as Error).message)
  }
}
