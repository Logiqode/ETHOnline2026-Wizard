// Final evidence matrix for the "Workflow not found" gateway issue.
// Fires the confirmed-ACTIVE workflow ID at both documented gateways,
// with/without trailing slash, with/without 0x prefix.
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
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`)
  return `{${entries.join(',')}}`
}

const sha256Hex = (s: string): string => '0x' + createHash('sha256').update(s, 'utf8').digest('hex')

async function createRequestJwt(account: ReturnType<typeof privateKeyToAccount>, bodyObj: Record<string, unknown>): Promise<string> {
  const header = b64urlFromB64(Buffer.from(JSON.stringify({ alg: 'ETH', typ: 'JWT' }), 'utf8').toString('base64'))
  const digest = sha256Hex(sortedJson(bodyObj))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64urlFromB64(Buffer.from(JSON.stringify({ digest, iss: account.address, iat: now, exp: now + 300, jti: randomUUID() }), 'utf8').toString('base64'))
  const message = `${header}.${payload}`
  const sig = await account.signMessage({ message })
  const { r, s, v, yParity } = parseSignature(sig)
  const recoveryId = v !== undefined ? (v >= 27n ? v - 27n : v) : yParity
  const rBuf = Buffer.from(r.slice(2).padStart(64, '0'), 'hex')
  const sBuf = Buffer.from(s.slice(2).padStart(64, '0'), 'hex')
  return `${message}.${b64urlFromB64(Buffer.concat([rBuf, sBuf, Buffer.from([Number(recoveryId)])]).toString('base64'))}`
}

let pk = process.env.CRE_ETH_PRIVATE_KEY
if (!pk) {
  const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  pk = envText.split('\n').find((l) => l.startsWith('CRE_ETH_PRIVATE_KEY='))!.split('=').slice(1).join('=').trim()
}
if (!pk!.startsWith('0x')) pk = `0x${pk}`
const account = privateKeyToAccount(pk as Hex)

const ID = '00bf398105e7f12a5ce218898b16a2a9681cecb214b82f3c3287c48f838e12c1'

const cases: Array<{ label: string; url: string; wfId: string }> = [
  { label: 'enterprise (trailing /), plain ID', url: 'https://01.enterprise-gateway.zone-a.cre.chain.link/', wfId: ID },
  { label: 'enterprise (no trailing /), plain ID', url: 'https://01.enterprise-gateway.zone-a.cre.chain.link', wfId: ID },
  { label: 'enterprise, 0x-prefixed ID', url: 'https://01.enterprise-gateway.zone-a.cre.chain.link/', wfId: `0x${ID}` },
  { label: 'PUBLIC gateway, plain ID', url: 'https://01.gateway.zone-a.cre.chain.link', wfId: ID },
]

for (const c of cases) {
  const bodyObj = { jsonrpc: '2.0', id: `probe-${randomUUID()}`, method: 'workflows.execute', params: { input: { campaignId: 1 }, workflow: { workflowID: c.wfId } } }
  const token = await createRequestJwt(account, bodyObj)
  try {
    const res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(bodyObj) })
    const text = await res.text()
    const msg = (() => { try { return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text } catch { return text } })()
    console.log(`[${c.label}] HTTP ${res.status}: ${msg.slice(0, 160)}`)
  } catch (e) { console.log(`[${c.label}] fetch error: ${(e as Error).message}`) }
}
