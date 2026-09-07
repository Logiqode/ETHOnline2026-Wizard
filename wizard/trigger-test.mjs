// Standalone repro of the relay signing to compare digests
import { privateKeyToAccount } from 'viem/accounts'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseSignature } from 'viem'

const env = readFileSync('../.env','utf8')
const pk = env.split('\n').find(l=>l.startsWith('CRE_ETH_PRIVATE_KEY=')).split('=').slice(1).join('=').trim()
const wf = env.split('\n').find(l=>l.startsWith('WORKFLOW_ID=')).split('=').slice(1).join('=').trim()
const account = privateKeyToAccount(pk.startsWith('0x')?pk:'0x'+pk)

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
const sorted = v => v===null||typeof v!=='object' ? JSON.stringify(v)
  : Array.isArray(v) ? '['+v.map(sorted).join(',')+']'
  : '{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+sorted(x)).join(',')+'}'

const input = { campaignId: 1, userAnchor: '0xAAaA000000000000000000000000000000000004', merchantId: 'burgera', amountSpent: 20, timestamp: 1789000000, earnedInWindow: 0, items: ['burger'] }
const bodyObj = { jsonrpc: '2.0', id: 'req-'+randomUUID(), method: 'workflows.execute', params: { input, workflow: { workflowID: wf } } }
const body = JSON.stringify(bodyObj)
console.log('BODY:', body)
const canon = sorted(bodyObj)
console.log('CANON:', canon)
const digest = '0x'+createHash('sha256').update(canon,'utf8').digest('hex')
const now = Math.floor(Date.now()/1000)
const payload = b64u(JSON.stringify({digest, iss: account.address, iat: now, exp: now+300, jti: randomUUID()}))
const header = b64u(JSON.stringify({alg:'ETH',typ:'JWT'}))
const msg = header+'.'+payload
const sig = await account.signMessage({message: msg})
const { r, s, v, yParity } = parseSignature(sig)
const rec = v!==undefined ? (v>=27n?v-27n:v) : yParity
const sigBytes = Buffer.concat([Buffer.from(r.slice(2),'hex'), Buffer.from(s.slice(2),'hex'), Buffer.from([Number(rec)])])
const token = msg+'.'+b64u(sigBytes)
const res = await fetch('https://01.gateway.zone-a.cre.chain.link', {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body})
const text = await res.text()
console.log('HTTP', res.status)
console.log(text.slice(0,400))
const m = text.match(/workflow_execution_id":"(0x[0-9a-f]+)/)
if (m) console.log('EXECID='+m[1])
