// Auth-ordering probe: CORRECT authorized key, deliberately WRONG digest.
// If the gateway answers "signature mismatch" (auth reached), the earlier
// "Workflow not found" is a tenant-scoping issue, not a bad ID.
import { privateKeyToAccount } from 'viem/accounts'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const b64url = (i: string) => Buffer.from(i).toString('base64url')
const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
let pk = envText.split('\n').find((l) => l.startsWith('CRE_ETH_PRIVATE_KEY='))!.split('=').slice(1).join('=').trim()
if (!pk.startsWith('0x')) pk = `0x${pk}`
const account = privateKeyToAccount(pk as `0x${string}`)

const bodyObj = {
  jsonrpc: '2.0',
  id: 'probe-auth2',
  method: 'workflows.execute',
  params: { input: {}, workflow: { workflowID: '00bf398105e7f12a5ce218898b16a2a9681cecb214b82f3c3287c48f838e12c1' } },
}
const header = b64url(JSON.stringify({ alg: 'ETH', typ: 'JWT' }))
const digest = '0x' + createHash('sha256').update('wrong-bytes', 'utf8').digest('hex') // WRONG on purpose
const now = Math.floor(Date.now() / 1000)
const payload = b64url(JSON.stringify({ digest, iss: account.address, iat: now, exp: now + 240, jti: randomUUID() }))
const msg = `${header}.${payload}`
const sig = await account.signMessage({ message: msg })
const token = `${msg}.${b64url(Buffer.from(sig.slice(2), 'hex'))}`

const res = await fetch('https://01.enterprise-gateway.zone-a.cre.chain.link/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(bodyObj),
})
console.log('HTTP', res.status, await res.text())
