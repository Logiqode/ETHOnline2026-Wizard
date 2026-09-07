// ─── CRE HTTP-trigger relay client (CLI) ────────────────────────────────────
// The platform backend's signed-relay: merchants authenticate to the platform
// with API keys (no-web3-for-partners); THIS script (or the backend route that
// wraps it) signs the workflow execution request with the relay key and POSTs
// it to the CRE gateway. The signing address must be in the workflow's
// `authorizedKeys`.
//
// The JWT/signature implementation lives in src/lib/relay.ts (shared with the
// POST /api/campaigns/:id/payload route) and mirrors the official SDK client
// exactly (create-jwt.ts + trigger-workflow.ts, incl. yParity normalization).
//
// Spec: https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/triggering-deployed-workflows
//
// Usage:
//   bun run trigger.ts ./payload.json                    # WORKFLOW_ID from env
//   bun run trigger.ts ./payload.json --workflow-id <64hex>
//
// Env (root .env): CRE_ETH_PRIVATE_KEY (relay/authorized key), WORKFLOW_ID.
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { loadRelayKey, triggerWorkflow } from '../src/lib/relay'

async function main() {
  const args = process.argv.slice(2)
  const payloadPath = args.find((a) => !a.startsWith('--'))
  const wfFlag = args.indexOf('--workflow-id')
  let workflowId = wfFlag >= 0 ? args[wfFlag + 1] : process.env.WORKFLOW_ID
  if (!payloadPath || !workflowId) {
    console.error('usage: bun run trigger.ts <payload.json> [--workflow-id <64hex>]')
    console.error('env: CRE_ETH_PRIVATE_KEY, WORKFLOW_ID (or pass --workflow-id)')
    process.exit(1)
  }

  const account = privateKeyToAccount(loadRelayKey())
  console.log('signed by:', account.address)

  // The payload IS params.input (the enclave's requestSchema parses it).
  const input = JSON.parse(readFileSync(payloadPath, 'utf8'))

  const result = await triggerWorkflow(input, workflowId)
  console.log(`HTTP ${result.httpStatus}`)
  if (result.response && typeof result.response === 'object') {
    console.log(JSON.stringify(result.response, null, 2))
  } else {
    console.log(result.response)
  }
  if (result.httpStatus !== 200) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
