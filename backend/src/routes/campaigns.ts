import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db'
import {
  MIN_OPERATING_WEI,
  campaignSchema,
  computeDepositDeadline,
  depositShareWei,
  generateSalt,
  toApi,
  validateLaunch,
  type CampaignRow,
  type DepositRecord,
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

  // ── Reward-type gate (PRODUCTION-LIMITED honesty) ─────────────────────────
  // Only 'monetary' (cashback/discount) has a launch mapping. 'digital' badge
  // campaigns WOULD be supported by the on-chain caps (flat mechanic, value 1,
  // per-tx 1) but the launcher wiring doesn't exist yet — a launch today would
  // silently encode rateBps=0/flat=0 and mint nothing. Refuse loudly instead.
  const launchRewardType = String(row.mechanics?.rewardType ?? (row as { reward_type?: string }).reward_type ?? '')
  if (launchRewardType !== 'monetary') {
    return c.json({ error: `PRODUCTION-LIMITED: reward type "${launchRewardType}" has no launch mapping yet — only Monetary (cashback/discount) campaigns can launch on-chain.` }, 400)
  }

  const salt = generateSalt()

  // ── On-chain createCampaign: real deployment to Base Sepolia ──────────────
  const result = await launchOnChainAndRecord(id, row, salt, deployment)
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json({ ...toApi(result.row), onchainTxHash: result.onchain.txHash, onchainCampaignId: result.onchain.campaignId })
})

// ─── Shared launch core: terms mapping → createCampaignOnChain → DB row ─────
// Used by BOTH launch paths: the wizard's direct /launch (DEMO bypass of the
// deposit handshake) and the two-deposit completion in the handshake flow.
// Returns a discriminated result so route handlers can shape their responses.
async function launchOnChainAndRecord(
  id: number,
  row: CampaignRow,
  salt: string,
  deployment: Awaited<ReturnType<typeof loadDeployment>>,
): Promise<{ error: string; status: 400 | 502 } | { row: CampaignRow; onchain: Awaited<ReturnType<typeof createCampaignOnChain>> }> {
  // ── Reward-type gate (PRODUCTION-LIMITED honesty) ─────────────────────────
  // Only 'monetary' (cashback/discount) has a launch mapping. 'digital' badge
  // campaigns WOULD be supported by the on-chain caps (flat mechanic, value 1,
  // per-tx 1) but the launcher wiring doesn't exist yet — a launch today would
  // silently encode rateBps=0/flat=0 and mint nothing. Refuse loudly instead.
  const launchRewardType = String(row.mechanics?.rewardType ?? (row as { reward_type?: string }).reward_type ?? '')
  if (launchRewardType !== 'monetary') {
    return { error: `PRODUCTION-LIMITED: reward type "${launchRewardType}" has no launch mapping yet — only Monetary (cashback/discount) campaigns can launch on-chain.`, status: 400 }
  }

  // Campaign-wide cap (wizard "Total redeem cap" toggle): earn-side, lifetime,
  // ALL users combined — enforced on-chain via the escrow's campaignTotalEarned.
  // Terms from the wizard's JSONB record; rewardUri points at the (future)
  // metadata endpoint — the reward contract's ERC-1155 base URI template.
  const mechanics = row.mechanics as { rewardType?: string; rewardValues?: Record<string, string | number | boolean> }
  const rv = mechanics?.rewardValues ?? {}
  const rules = row.rules as { ruleStates?: Record<string, string>; ruleValues?: Record<string, string | number> }
  const rs = rules?.ruleStates ?? {}
  const rvals = rules?.ruleValues ?? {}
  const t = row.terms as { start?: string; end?: string; noEndDate?: boolean; totalRedeemCap?: number; redeemCapEnabled?: boolean }
  const redeemCapOn = t?.redeemCapEnabled === true || t?.redeemCapEnabled === undefined // default ON (wizard default)
  const totalRedeemCap = Number(t?.totalRedeemCap ?? 0)

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
        // Campaign-wide cap: the wizard's "Total redeem cap" toggle. Earn-side,
        // lifetime, ALL users combined — enforced in the escrow via
        // campaignTotalEarned. The value is terms.totalRedeemCap (USD).
        campaignCapEnabled: redeemCapOn && totalRedeemCap > 0,
        campaignCapWei: redeemCapOn ? usdToWei(totalRedeemCap) : 0n,
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
    return { error: `On-chain launch failed: ${(err as Error).message}`, status: 502 as const }
  }

  const rows = await sql<CampaignRow[]>`
    UPDATE campaigns SET
      status = 'launched', salt = ${salt}, launched_at = NOW(),
      escrow_address = ${onchain.escrow}, reward_address = ${onchain.reward},
      terms = terms || ${sql.json({ onchainCampaignId: onchain.campaignId })}::jsonb
    WHERE id = ${id}
    RETURNING *
  `
  return { row: rows[0], onchain }
}

// ─── Deposit handshake (gen-6): initiate / record / expiry ───────────────────
// DEMO SCOPE, honestly stated: there is NO authentication in the backend — any
// caller can initiate or record a deposit for any campaign, and the "Privy
// wallet" is whatever address the client claims. Production would bind wallets
// to authenticated company identities (Privy access tokens verified server-
// side) and email invites with single-use codes. The deposit tx itself IS
// verified on-chain (the recorded tx must have moved exactly the share from
// the claimed wallet to the platform wallet), so the money path is real even
// though identity attribution is not.

const PLATFORM_WALLET = '0x9587BD3e8195D597BF4e82B18724178e52B55c4F' as Address // demo platform gas wallet

/** Cancel a pending_deposit campaign whose deadline has passed (lazy expiry). */
async function expireIfPastDeadline(row: CampaignRow): Promise<CampaignRow> {
  if (
    row.status === 'pending_deposit' &&
    row.deposit_deadline &&
    new Date(row.deposit_deadline).getTime() <= Date.now()
  ) {
    const cancelled = await sql<CampaignRow[]>`
      UPDATE campaigns SET status = 'cancelled'
      WHERE id = ${row.id} AND status = 'pending_deposit'
      RETURNING *
    `
    if (cancelled.length > 0) return cancelled[0]
  }
  return row
}

// POST /api/campaigns/:id/deposits/initiate — draft → pending_deposit.
// Computes each share from fee_split_bps, sets the deadline (campaign start,
// or now+4h when the start is past/missing), and snapshots the company
// wallets the depositing clients must match.
campaigns.post('/:id/deposits/initiate', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400)
  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
  const row = await expireIfPastDeadline(rows[0])
  if (row.status !== 'draft') {
    return c.json({ error: `Campaign is ${row.status}, not draft — initiate only works on drafts` }, 409)
  }
  // Handshake flow: the REAL fee recipients are the depositing wallets, which
  // don't exist yet at initiate time — so zero placeholders pass here. The
  // launch validator still enforces non-zero at createCampaign time (the
  // deposited wallets are written into company_a/company_b as they land).
  const validation = validateLaunch({
    feeSplitBps: row.fee_split_bps,
    companyA: row.company_a,
    companyB: row.company_b,
    operatingDepositWei: BigInt(row.operating_deposit),
  })
  if (!validation.ok && !validation.error.startsWith('InvalidFeeAccount')) {
    return c.json({ error: validation.error }, 400)
  }

  const t = row.terms as { start?: string; noEndDate?: boolean }
  const deadline = computeDepositDeadline(t?.start)
  const updated = await sql<CampaignRow[]>`
    UPDATE campaigns SET status = 'pending_deposit', deposit_deadline = ${deadline}, deposits = '{}'::jsonb
    WHERE id = ${id} RETURNING *
  `
  return c.json({
    ...toApi(updated[0]),
    shares: {
      A: depositShareWei(row.fee_split_bps, 'A').toString(),
      B: depositShareWei(row.fee_split_bps, 'B').toString(),
    },
    platformWallet: PLATFORM_WALLET,
  })
})

// POST /api/campaigns/:id/deposits — record one company's deposit.
// Body: { company: 'A'|'B', wallet, txHash }. The backend verifies ON-CHAIN
// that txHash transferred exactly the company's share from `wallet` to the
// platform wallet before recording it. When both deposits are recorded, the
// on-chain createCampaign fires immediately (same path as the bypass launch).
const depositBody = z.object({
  company: z.enum(['A', 'B']),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

campaigns.post('/:id/deposits', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = depositBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.flatten() }, 400)
  const { company, wallet, txHash } = parsed.data

  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
  const row = await expireIfPastDeadline(rows[0])
  if (row.status !== 'pending_deposit') {
    return c.json({ error: `Campaign is ${row.status} — deposits only accepted while pending_deposit` }, 409)
  }

  const deposits = (row.deposits ?? {}) as Record<string, DepositRecord>
  if (deposits[company]) {
    return c.json({ error: `Company ${company} already deposited` }, 409)
  }
  const other = company === 'A' ? 'B' : 'A'
  const depositedWallet = deposits[other]?.wallet.toLowerCase()
  if (depositedWallet && depositedWallet === wallet.toLowerCase()) {
    return c.json({ error: 'The same wallet cannot deposit for both companies' }, 400)
  }

  // ── On-chain verification: the tx must be a real transfer of the exact ──
  // share from the claimed wallet to the platform wallet.
  const shareWei = depositShareWei(row.fee_split_bps, company)
  const { createPublicClient, http, parseAbi } = await import('viem')
  const { baseSepolia } = await import('viem/chains')
  const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com') })
  const receipt = await client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null)
  if (!receipt || receipt.status !== 'success') {
    return c.json({ error: 'Deposit tx not found or failed on-chain' }, 400)
  }
  const expectedTo = PLATFORM_WALLET.toLowerCase()
  const expectedFrom = wallet.toLowerCase()
  const value = BigInt(shareWei)
  // Plain ETH transfer check: the tx itself must be from the claimed wallet,
  // to the platform wallet, carrying exactly the share. (An ERC-20 deposit
  // path would use Transfer logs; the demo deposits native ETH.)
  const tx = await client.getTransaction({ hash: txHash as Hex }).catch(() => null)
  const ethOk = !!tx && tx.from.toLowerCase() === expectedFrom && (tx.to?.toLowerCase() ?? '') === expectedTo && tx.value === value
  const ok = ethOk
  if (!ok) {
    return c.json({ error: `Deposit tx does not carry ${Number(shareWei) / 1e18} ETH from ${wallet} to the platform wallet` }, 400)
  }

  const updatedDeposits = { ...deposits, [company]: { wallet, txHash, wei: shareWei.toString(), confirmedAt: new Date().toISOString() } }
  const bothIn = Object.keys(updatedDeposits).length === 2

  if (!bothIn) {
    const updated = await sql<CampaignRow[]>`
      UPDATE campaigns SET deposits = ${sql.json(updatedDeposits as never)}::jsonb
      WHERE id = ${id} RETURNING *
    `
    return c.json({ ...toApi(updated[0]), awaiting: other })
  }

  // Both deposits in → fire the on-chain launch (same createCampaign path as
  // the bypass), with the DEPOSITED WALLETS as the fee recipients — the
  // handshake's whole point: the wallets that funded the campaign are the
  // companies' on-chain fee accounts.
  const updatedRow: CampaignRow = {
    ...row,
    company_a: updatedDeposits.A.wallet,
    company_b: updatedDeposits.B.wallet,
  }
  let deployment: Awaited<ReturnType<typeof loadDeployment>>
  try {
    deployment = await loadDeployment()
  } catch (err) {
    return c.json({ error: `Deployment config unavailable: ${(err as Error).message}` }, 503)
  }
  const salt = generateSalt()
  const launchedRow = await launchOnChainAndRecord(id, updatedRow, salt, deployment)
  if ('error' in launchedRow) return c.json({ error: launchedRow.error }, launchedRow.status)
  return c.json({ ...toApi(launchedRow.row), onchainTxHash: launchedRow.onchain.txHash, onchainCampaignId: launchedRow.onchain.campaignId, deposits: updatedDeposits })
})

// POST /api/campaigns/:id/deposits/cancel — creator cancels a pending campaign
// (DEMO: also the cleanup path if a deposit was recorded with a wrong tx).
campaigns.post('/:id/deposits/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400)
  const rows = await sql<CampaignRow[]>`SELECT * FROM campaigns WHERE id = ${id}`
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
  if (rows[0].status !== 'pending_deposit') {
    return c.json({ error: `Campaign is ${rows[0].status} — only pending_deposit can be cancelled` }, 409)
  }
  const updated = await sql<CampaignRow[]>`
    UPDATE campaigns SET status = 'cancelled' WHERE id = ${id} RETURNING *
  `
  return c.json(toApi(updated[0]))
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
