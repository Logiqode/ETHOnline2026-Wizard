import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db'
import {
  MIN_OPERATING_WEI,
  campaignSchema,
  generateSalt,
  toApi,
  validateLaunch,
  type CampaignRow,
} from '../lib/launch'
import { createCampaignOnChain, loadDeployment, readRootEnvVar, usdToWei } from '../lib/onchain'
import { loadEscrowState } from '../lib/escrowState'
import { SEED_CAMPAIGNS, SEED_COMPANY_A, SEED_COMPANY_B, SEED_TEST_PAYLOADS } from '../lib/seedCampaigns'
import { triggerWorkflow, loadRelayKey } from '../lib/relay'
import { awaitExecutionVerdict } from '../lib/creExecution'
import { getAddress } from 'viem'
import type { Address, Hex } from 'viem'

export const campaigns = new Hono()

// postgres.js sql.json() expects its JSONValue union; our records are `unknown`-typed.
// Cast through a narrow helper so the DB still gets properly-encoded JSON.
const asJson = (v: Record<string, unknown>) => sql.json(v as never)

// POST /api/campaigns — create a draft campaign
campaigns.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = campaignSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten() }, 400)
  }
  const v = parsed.data
  const rows = await sql<CampaignRow[]>`
    INSERT INTO campaigns (
      name, reward_type, mechanics, terms, rules,
      fee_split_bps, company_a, company_b, company_a_name, company_b_name,
      operating_deposit, status
    ) VALUES (
      ${v.name}, ${v.rewardType}, ${asJson(v.mechanics)}, ${asJson(v.terms)}, ${asJson(v.rules)},
      ${v.feeSplitBps}, ${v.companyA}, ${v.companyB}, ${v.companyAName}, ${v.companyBName},
      ${MIN_OPERATING_WEI.toString()}, 'draft'
    )
    RETURNING *
  `
  return c.json(toApi(rows[0]), 201)
})

// GET /api/campaigns — list campaigns
// Only campaigns the LIVE factory knows about are listed: a DB row counts as
// live if it carries an onchainCampaignId whose factory entry matches the
// row's escrow, or (wizard-launched rows) whose escrow was created by this
// factory. Anything else (stale rows from superseded factory generations) is
// hidden — the DB is bookkeeping, the factory registry is the source of truth.
campaigns.get('/', async (c) => {
  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns ORDER BY id DESC`

  // Resolve the live factory registry once: id -> escrow address.
  let registry: Map<number, string> | null = null
  try {
    const deployment = await loadDeployment()
    const { createPublicClient, http, parseAbi } = await import('viem')
    const { baseSepolia } = await import('viem/chains')
    const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com') })
    const abi = parseAbi(['function campaigns(uint256) view returns (address escrow, address reward, uint256 rewardTokenId, uint64 start, uint64 end)', 'function nextCampaignId() view returns (uint256)'])
    const nextId = Number(await client.readContract({ address: deployment.factory, abi, functionName: 'nextCampaignId' }))
    registry = new Map()
    for (let i = 1; i < nextId; i++) {
      const entry = await client.readContract({ address: deployment.factory, abi, functionName: 'campaigns', args: [BigInt(i)] })
      registry.set(i, (entry[0] as Address).toLowerCase())
    }
  } catch {
    // Factory/RPC unavailable — fall through with null registry and list DB rows as-is.
  }

  const live = rows.filter((row) => {
    if (!row.escrow_address) return false // drafts without deployment
    if (!registry) return true // fallback: keep DB as-is when the factory can't be read
    const onchainId = (row.terms as { onchainCampaignId?: number } | null)?.onchainCampaignId
    if (onchainId) return registry.get(onchainId) === row.escrow_address.toLowerCase()
    // Wizard-launched: no onchainCampaignId recorded — treat as live only if
    // the escrow appears somewhere in the factory registry.
    const escrowLower = row.escrow_address.toLowerCase()
    return [...registry.values()].includes(escrowLower)
  })
  return c.json(live.map(toApi))
})

// GET /api/campaigns/:id
campaigns.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) {
    return c.json({ error: 'Not found' }, 404)
  }
  return c.json(toApi(rows[0]))
})

// PUT /api/campaigns/:id — update a draft
campaigns.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = campaignSchema.partial().safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten() }, 400)
  }
  const v = parsed.data
  const existing = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (existing.length === 0) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (existing[0].status === 'launched') {
    return c.json({ error: 'Cannot update a launched campaign' }, 409)
  }
  const merged = {
    name: v.name ?? existing[0].name,
    rewardType: v.rewardType ?? existing[0].reward_type,
    mechanics: v.mechanics ?? existing[0].mechanics,
    terms: v.terms ?? existing[0].terms,
    rules: v.rules ?? existing[0].rules,
    feeSplitBps: v.feeSplitBps ?? existing[0].fee_split_bps,
    companyA: v.companyA ?? existing[0].company_a,
    companyB: v.companyB ?? existing[0].company_b,
    companyAName: v.companyAName ?? existing[0].company_a_name,
    companyBName: v.companyBName ?? existing[0].company_b_name,
  }
  const rows = await sql<CampaignRow[]>`
    UPDATE campaigns SET
      name = ${merged.name},
      reward_type = ${merged.rewardType},
      mechanics = ${asJson(merged.mechanics)},
      terms = ${asJson(merged.terms)},
      rules = ${asJson(merged.rules)},
      fee_split_bps = ${merged.feeSplitBps},
      company_a = ${merged.companyA},
      company_b = ${merged.companyB},
      company_a_name = ${merged.companyAName},
      company_b_name = ${merged.companyBName}
    WHERE id = ${id}
    RETURNING *
  `
  return c.json(toApi(rows[0]))
})

// POST /api/campaigns/:id/launch — validate + salt + mark launched
campaigns.post('/:id/launch', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  const existing = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (existing.length === 0) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (existing[0].status === 'launched') {
    return c.json({ error: 'Already launched' }, 409)
  }

  const row = existing[0]
  let deployment: Awaited<ReturnType<typeof loadDeployment>>
  try {
    deployment = await loadDeployment()
  } catch (err) {
    return c.json({ error: `Deployment config unavailable: ${(err as Error).message}` }, 503)
  }
  const validation = validateLaunch({
    feeSplitBps: row.fee_split_bps,
    companyA: row.company_a,
    companyB: row.company_b,
    operatingDepositWei: BigInt(row.operating_deposit),
  })
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400)
  }

  const salt = generateSalt()

  // ── On-chain createCampaign: real deployment to Base Sepolia ──────────────
  // Terms from the wizard's JSONB record; rewardUri points at the (future)
  // metadata endpoint — the reward contract's ERC-1155 base URI template.
  const mechanics = row.mechanics as { rewardType?: string; rewardValues?: Record<string, string | number | boolean> }
  const rv = mechanics?.rewardValues ?? {}
  const rules = row.rules as { ruleStates?: Record<string, string>; ruleValues?: Record<string, string | number> }
  const rs = rules?.ruleStates ?? {}
  const rvals = rules?.ruleValues ?? {}
  const t = row.terms as { start?: string; end?: string; noEndDate?: boolean }

  const startUnix = t?.start ? Math.floor(new Date(t.start).getTime() / 1000) : 0
  // "No end date" maps to a far-future end (the wizard uses 7026-12-31 for this).
  const endUnix = t?.noEndDate || !t?.end
    ? 4102444800 // 2100-01-01
    : Math.floor(new Date(t.end).getTime() / 1000)
  const minSpendEnabled = rs['min-spend'] === 'enabled'
  const capEnabled = rs['reward-cap'] === 'enabled'
  const dowEnabled = rs['day-of-week'] === 'enabled'
  const daysMask = dowEnabled ? 127 : 0 // every day allowed when the rule is on with no selection

  // ── Reward mechanic mapping (mirrors CampaignRulesLib.computePoints) ──────
  // 'monetary' = cashback: percent (rateBps% of spend) or flat (fixed per
  // purchase). 'discount' = proof-of-savings: redeemable=false, the computed
  // value is dollars saved — it lands in the user's totalSaved counter only.
  const cashbackType = String(rv.cashbackType ?? 'percent')
  const flatEnabled = mechanics?.rewardType === 'monetary' && cashbackType === 'flat'
  const rateBps = flatEnabled ? 0 : Math.round(Number(rv.cashbackRate ?? 0) * 100)
  const flatValueWei = flatEnabled ? usdToWei(Number(rv.cashbackFlat ?? 0)) : 0n
  const redeemable = mechanics?.rewardType !== 'discount'
  // Per-transaction cap (now on-chain in Rules). For percent cashback the UI
  // value is in reward units ($); for percent discounts it's a % of spend —
  // same semantics the wizard displays. Off when the toggle is off.
  const cashbackPerTxCapOn = redeemable && rv.cashbackPerTxCapEnabled === true
  const discountPerTxCapOn = !redeemable && rv.discountPerTxCapEnabled === true
  const perTxCapEnabled = cashbackPerTxCapOn || discountPerTxCapOn
  const perTxCapWei = perTxCapEnabled
    ? usdToWei(Number((cashbackPerTxCapOn ? rv.cashbackPerTxCap : rv.discountPerTxCap) ?? 0))
    : 0n

  // ── Cap-reset window mapping (gen-5: enforced on-chain, CampaignRulesLib) ─
  // capWindow: 0 lifetime, 1 day, 2 week, 3 month, 4 year. Rolling basis has
  // NO on-chain window math (calendar math only) — the wizard greys it out as
  // PRODUCTION-LIMITED, and the launch mapping maps it to lifetime honestly.
  const capPeriod = String(rvals.capPeriod ?? 'Lifetime')
  const capCount = Math.max(1, Math.min(255, Number(rvals.capPeriodCount ?? 1)))
  const calendarBasis = String(rvals.capResetBasis ?? 'Rolling') === 'Calendar'
  const windowKind = capEnabled && capPeriod !== 'Lifetime' && calendarBasis
    ? ({ Day: 1, Week: 2, Month: 3, Year: 4 } as Record<string, number>)[capPeriod] ?? 0
    : 0
  // Reset time "HH:MM" (wizard form) → seconds past midnight UTC.
  const hm = String(rvals.capResetTime ?? '00:00').match(/^(\d{1,2}):(\d{2})$/)
  const capWindowTime = windowKind > 0 && hm
    ? Math.min(86399, Number(hm[1]) * 3600 + Number(hm[2]) * 60)
    : 0
  // Week anchor weekday: wizard stores 'Monday'.. name; 0=Mon..6=Sun.
  const dowNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  const capWindowDow = windowKind === 2
    ? Math.max(0, Math.min(6, dowNames.indexOf(String(rvals.capResetWeekday ?? 'Monday'))))
    : 0

  let onchain
  try {
    onchain = await createCampaignOnChain({
      terms: {
        rateBps,
        startUnix,
        endUnix,
        minSpendEnabled,
        minSpendWei: usdToWei(Number(rvals.minSpend ?? 0)),
        capEnabled,
        capWei: usdToWei(Number(rvals.cap ?? 0)),
        dayOfWeekEnabled: dowEnabled,
        daysOfWeekBitmask: daysMask,
        flatEnabled,
        flatValueWei,
        redeemable,
        perTxCapEnabled,
        perTxCapWei,
        capWindow: windowKind,
        capWindowCount: windowKind > 0 ? capCount : 0,
        capWindowTime,
        capWindowDow,
      },
      // The DON stamps the CRE *registry* owner (workflow deployer EOA) into
      // report metadata; the escrow's reportOwner must match or onReport
      // reverts (silently — forwarder logs success=00, nothing mints). Factory
      // default is workflowOwner, which differs → pass it explicitly.
      // Bun auto-loads only backend/.env, so also fall back to the ROOT .env
      // (same pattern as the CRE_ETH_PRIVATE_KEY fallback in onchain.ts) —
      // 2026-09-08: a launch with only deployment.deployer in scope shipped
      // reportOwner=0x9587… and every claim minted nothing.
      reportOwner: (process.env.WORKFLOW_OWNER_ADDRESS || (await readRootEnvVar('WORKFLOW_OWNER_ADDRESS')) || deployment.deployer) as Address,
      workflowOwner: (process.env.WORKFLOW_OWNER_ADDRESS || (await readRootEnvVar('WORKFLOW_OWNER_ADDRESS')) || deployment.deployer) as Address,
      rewardUri: process.env.REWARD_URI || 'https://wizard.example/api/metadata/{id}.json',
      salt: salt as Hex,
      companyA: row.company_a as Address,
      companyB: row.company_b as Address,
      feeSplitBps: row.fee_split_bps,
    })
  } catch (err) {
    return c.json({ error: `On-chain launch failed: ${(err as Error).message}` }, 502)
  }

  const rows = await sql<CampaignRow[]>`
    UPDATE campaigns SET
      status = 'launched', salt = ${salt}, launched_at = NOW(),
      escrow_address = ${onchain.escrow}, reward_address = ${onchain.reward},
      terms = terms || ${sql.json({ onchainCampaignId: onchain.campaignId })}::jsonb
    WHERE id = ${id}
    RETURNING *
  `
  return c.json({ ...toApi(rows[0]), onchainTxHash: onchain.txHash, onchainCampaignId: onchain.campaignId })
})
// ─── POST /api/campaigns/seed ────────────────────────────────────────────────
// Idempotent bootstrap: insert DB records for the three factory-seeded demo
// campaigns (they were deployed by SeedCampaigns.s.sol, not the wizard, so the
// DB had no record). Escrow/reward addresses are read LIVE from the factory by
// on-chain campaign id; the salt/terms constants mirror the seed script.
// Manual wizard launches keep working alongside these.
const seedBody = z.object({
  workflowId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
})

campaigns.post('/seed', async (c) => {
  let body: unknown = {}
  try {
    body = await c.req.json()
  } catch {
    /* empty body allowed */
  }
  const parsed = seedBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten() }, 400)
  }

  let deployment: Awaited<ReturnType<typeof loadDeployment>>
  try {
    deployment = await loadDeployment()
  } catch (err) {
    return c.json({ error: `Deployment config unavailable: ${(err as Error).message}` }, 503)
  }

  const { createPublicClient, http, parseAbi } = await import('viem')
  const { baseSepolia } = await import('viem/chains')
  const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com') })
  const factoryAbi = parseAbi(['function campaigns(uint256) view returns (address escrow, address reward, uint256 rewardTokenId, uint64 start, uint64 end)'])

  const seeded: number[] = []
  for (const spec of SEED_CAMPAIGNS) {
    // Already in the DB (by seed salt OR seeded name) -> skip. Two guards
    // because the UI fires /seed on every page load and mounts can race.
    const existing = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE salt = ${spec.salt} OR name = ${spec.name}`
    if (existing.length > 0) continue

    // Read the live escrow/reward from the factory for this campaign id.
    let escrow: Address | null = null
    let reward: Address | null = null
    try {
      const entry = await client.readContract({
        address: deployment.factory,
        abi: factoryAbi,
        functionName: 'campaigns',
        args: [BigInt(spec.campaignId)],
      })
      escrow = entry[0]
      reward = entry[1]
    } catch {
      // Factory read failed - still insert the record so the UI can show it;
      // addresses stay null and the detail page will surface the RPC error.
    }

    await sql`
      INSERT INTO campaigns (
        name, status, reward_type, mechanics, terms, rules,
        fee_split_bps, company_a, company_b, company_a_name, company_b_name,
        operating_deposit, salt, escrow_address, reward_address, launched_at
      ) VALUES (
        ${spec.name}, 'launched', 'monetary',
        ${asJson(spec.mechanics)}, ${asJson({ ...spec.terms, onchainCampaignId: spec.campaignId })}, ${asJson(spec.rules)},
        2500, ${SEED_COMPANY_A}, ${SEED_COMPANY_B}, 'Acme Coffee', 'Globex Books',
        ${MIN_OPERATING_WEI.toString()}, ${spec.salt}, ${escrow}, ${reward}, NOW()
      )
    `
    seeded.push(spec.campaignId)
  }

  return c.json({ seeded, alreadyPresent: SEED_CAMPAIGNS.length - seeded.length })
})

// ─── GET /api/campaigns/:id/onchain - live escrow state for the detail page ──
campaigns.get('/:id/onchain', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) {
    return c.json({ error: 'Not found' }, 404)
  }
  const row = rows[0]
  if (row.status !== 'launched' || !row.escrow_address) {
    return c.json({ error: 'Campaign has no on-chain escrow' }, 404)
  }
  try {
    const state = await loadEscrowState(row.escrow_address as Address)
    return c.json(state)
  } catch (err) {
    return c.json({ error: `On-chain read failed: ${(err as Error).message}` }, 502)
  }
})

// ─── GET /api/campaigns/:id/test-payload - the hardcoded demo payload set ────
// Returns { payloads: SeedTestPayload[] } — an array of curated cases (pass /
// reject / edge). Seeded campaigns get their set by on-chain campaign id;
// wizard-launched campaigns get a generic set built from their terms.
campaigns.get('/:id/test-payload', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
  const row = rows[0]
  const terms = row.terms as { onchainCampaignId?: number }
  const onchainId = terms?.onchainCampaignId

  // Seeded campaigns: their curated three-case set.
  if (onchainId && SEED_TEST_PAYLOADS[onchainId]) {
    return c.json({ payloads: SEED_TEST_PAYLOADS[onchainId] })
  }

  // Wizard-launched: generic set shaped by the campaign's own min spend.
  const rules = row.rules as { minSpend?: number } | null
  const minSpend = Number(rules?.minSpend ?? 10)
  const anchor = '0xAAaA000000000000000000000000000000000001'
  return c.json({
    payloads: [
      {
        payload: {
          campaignId: onchainId ?? id,
          userAnchor: anchor,
          merchantId: 'wizard-ui',
          amountSpent: Math.max(minSpend + 20, 30),
          timestamp: Math.floor(Date.now() / 1000),
          earnedInWindow: 0,
          items: ['demo-purchase'],
        },
        description: `PASS — purchase above the $${minSpend} min spend; reward computed from the campaign's on-chain terms.`,
      },
      {
        payload: {
          campaignId: onchainId ?? id,
          userAnchor: '0xAAaA000000000000000000000000000000000002',
          merchantId: 'wizard-ui',
          amountSpent: Math.max(minSpend - 5, 1),
          timestamp: Math.floor(Date.now() / 1000),
          earnedInWindow: 0,
          items: ['demo-purchase'],
        },
        description: `REJECT (below-min-spend) — under the $${minSpend} minimum; eligible=false, no on-chain write.`,
      },
    ],
  })
})

// ─── POST /api/campaigns/:id/payload - fire the CRE workflow via the relay ───
// Wraps the signed-relay client (the same JWT path as backend/scripts/trigger.ts)
// so the browser can submit a POS payload without holding keys.
const payloadBody = z.object({
  campaignId: z.number().int().nonnegative(),
  userAnchor: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  merchantId: z.string().min(1),
  amountSpent: z.number().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  earnedInWindow: z.number().nonnegative().default(0),
  items: z.array(z.string()).optional(),
  workflowId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
})

campaigns.post('/:id/payload', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = payloadBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten() }, 400)
  }

  // Resolve the workflow id: request override -> root .env WORKFLOW_ID.
  let workflowId = parsed.data.workflowId ?? null
  if (!workflowId) {
    const { readFileSync } = await import('node:fs')
    try {
      const envText = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      workflowId = envText.split('\n').find((l) => l.startsWith('WORKFLOW_ID='))?.split('=').slice(1).join('=').trim() ?? null
    } catch {
      /* no root .env */
    }
  }
  if (!workflowId) {
    return c.json({ error: 'No workflow id: pass workflowId in the body or set WORKFLOW_ID in root .env' }, 400)
  }

  const { campaignId: dbCampaignId, userAnchor, merchantId, amountSpent, timestamp, earnedInWindow, items } = parsed.data

  // The workflow reads campaign terms from the FACTORY, whose sequential ids
  // differ from the wizard's Postgres ids (a wizard-launched row id 16 can be
  // factory campaign 4). Forward the on-chain id stored at launch time
  // (terms.onchainCampaignId); plain DB id as fallback.
  const prow = (await sql<{ terms: { onchainCampaignId?: number } }[]>`
    SELECT terms FROM campaigns WHERE id = ${id}
  `)[0]
  const campaignId = prow?.terms?.onchainCampaignId ?? dbCampaignId

  const input: Record<string, unknown> = {
    campaignId,
    userAnchor,
    merchantId,
    amountSpent,
    timestamp,
    earnedInWindow,
    ...(items ? { items } : {}),
  }

  try {
    const result = await triggerWorkflow(input, workflowId)
    if (result.httpStatus !== 200) {
      return c.json({ error: 'Gateway rejected the trigger', gatewayStatus: result.httpStatus, response: result.response }, 502)
    }

    // Optional verdict await: `?await=1` polls the CRE CLI until the execution
    // finishes (~10-15s typical) and returns the DON's verdict + user logs so
    // the UI can show instant feedback instead of "check back in 15s".
    const wantsVerdict = c.req.query('await') === '1'
    if (wantsVerdict && result.executionId) {
      const verdict = await awaitExecutionVerdict(result.executionId)
      return c.json({
        ok: true,
        signer: result.signer,
        executionId: result.executionId,
        gatewayResponse: result.response,
        verdict,
        note: verdict.status === 'SUCCESS'
          ? 'SUCCESS — the DON approved and wrote the report; the escrow claim/mint is on-chain (refresh to see the ledger).'
          : verdict.status === 'FAILURE'
            ? 'FAILURE — the DON rejected the execution; see verdict.errors / verdict.logs.'
            : 'Still running when the await window closed — check `cre execution status` shortly.',
      })
    }

    return c.json({
      ok: true,
      signer: result.signer,
      executionId: result.executionId,
      gatewayResponse: result.response,
      note: result.executionId
        ? 'ACCEPTED - the DON executes in ~10-30s; the on-chain claim (forwarder ReportProcessed + escrow Claim/mint) lands right after.'
        : 'Gateway responded 200 without an execution id - check the response body.',
    })
  } catch (err) {
    return c.json({ error: `Relay failed: ${(err as Error).message}` }, 502)
  }
})

// ─── POST /api/campaigns/:id/redeem - spend a user's points (Company B path) ─
// The backend relay signs with the workflowOwner EOA, which the escrow (gen-3
// impl) authorizes as a redeemer alongside explicitly-granted merchant wallets.
// Burns `amount` reward tokens from the user's spendable balance; the ledger's
// totalBalance preserves lineage. Cashback campaigns only — discount escrows
// keep unspentBalance at 0 by design, so any redeem reverts InsufficientBalance.
const redeemBody = z.object({
  user: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.number().positive(),
})

campaigns.post('/:id/redeem', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid id' }, 400)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = redeemBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten() }, 400)
  }

  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
  const row = rows[0]
  if (row.status !== 'launched' || !row.escrow_address) {
    return c.json({ error: 'Campaign has no on-chain escrow' }, 404)
  }

  try {
    const { createWalletClient, createPublicClient, http, parseAbi } = await import('viem')
    const { baseSepolia } = await import('viem/chains')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { loadEscrowState, DEMO_USER_ANCHOR } = await import('../lib/escrowState')

    const escrow = row.escrow_address as Address
    const state = await loadEscrowState(escrow)
    if (!state.redeemable) {
      return c.json({ error: 'Not redeemable — this is a discount (proof-of-savings) campaign; nothing is spendable.' }, 400)
    }

    const user = getAddress(parsed.data.user) as Address // normalize EIP-55 casing (relay-side)
    const amountWei = BigInt(Math.round(parsed.data.amount * 1e18))

    const account = privateKeyToAccount(loadRelayKey())
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com') })
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com') })

    const abi = parseAbi(['function redeemFor(address user, uint256 amount)'])
    const hash = await wallet.writeContract({
      address: escrow,
      abi,
      functionName: 'redeemFor',
      args: [user, amountWei],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`redeem tx reverted: ${hash}`)

    // Read back the remaining spendable balance.
    const after = await loadEscrowState(escrow)
    const p = after.participants.find((x) => x.address.toLowerCase() === user.toLowerCase())
    const remaining = p ? (Number(p.unspentBalance) / 1e18).toFixed(2) : null

    return c.json({
      ok: true,
      txHash: hash,
      user: user,
      amount: parsed.data.amount.toFixed(2),
      remaining,
      note: `Redeemed ${parsed.data.amount.toFixed(2)} ${row.reward_type === 'monetary' ? 'points' : 'units'} — burned from the user's spendable balance (lifetime ledger unchanged).`,
    })
  } catch (err) {
    const msg = (err as Error).message
    // Surface the common reverts readably.
    if (msg.includes('OnlyRedeemer')) return c.json({ error: 'The relay wallet is not an authorized redeemer on this escrow (pre-gen-3 deployment?)' }, 400)
    if (msg.includes('InsufficientBalance')) return c.json({ error: 'Insufficient spendable balance for that user/amount' }, 400)
    if (msg.includes('CampaignNotLive') || msg.includes('CampaignEnded')) return c.json({ error: 'Campaign is not live (outside its window)' }, 400)
    return c.json({ error: `Redeem failed: ${msg}` }, 502)
  }
})
