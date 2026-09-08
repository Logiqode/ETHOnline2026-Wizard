import { randomBytes } from 'node:crypto'
import { z } from 'zod'

// ─── Constants mirrored from contracts/src/CampaignFactory.sol ──────────────
// MIN_OPERATING_DEPOSIT = 0.01 ether; fee split is in basis points (0-10000).
export const MIN_OPERATING_DEPOSIT = 0.01 // demo constant (ETH)
export const MIN_OPERATING_WEI = BigInt(10_000_000_000_000_000) // 0.01 ether, wei
export const MAX_FEE_SPLIT_BPS = 10_000

// ─── Zod schema (mirror the contract's createCampaign boundary) ─────────────
// The workflow/wizard state is JSONB; only the launch-relevant fields are
// validated at the boundary. `feeSplitBps` is Company A's share; Company B
// receives the remainder (matches the contract's _splitDeposit).
export const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  rewardType: z.enum(['monetary', 'digital', 'physical']).default('monetary'),
  mechanics: z.record(z.string(), z.unknown()).default({}),
  terms: z.record(z.string(), z.unknown()).default({}),
  rules: z.record(z.string(), z.unknown()).default({}),
  feeSplitBps: z.number().int().min(0).max(MAX_FEE_SPLIT_BPS).default(5000),
  companyA: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default('0x0000000000000000000000000000000000000000'),
  companyB: z.string().regex(/^0x[a-fA-F0-9]{40}$/).default('0x0000000000000000000000000000000000000000'),
  companyAName: z.string().default(''),
  companyBName: z.string().default(''),
})

export type CampaignInput = z.infer<typeof campaignSchema>

// ─── Launch validation (mirrors CampaignFactory.createCampaign) ─────────────
// Order matters and matches the contract:
//   1. feeSplit bps check      (CampaignFactory__InvalidFeeSplit)
//   2. fee-account zero check  (CampaignFactory__InvalidFeeAccount)
//   3. deposit check           (CampaignFactory__DepositRequired)
// The deposit is the demo constant (0.01 ether, in wei) — real settlement deferred.
export interface LaunchInput {
  feeSplitBps: number
  companyA: string
  companyB: string
  operatingDepositWei?: bigint
}

export function validateLaunch(input: LaunchInput): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(input.feeSplitBps) || input.feeSplitBps < 0 || input.feeSplitBps > MAX_FEE_SPLIT_BPS) {
    return { ok: false, error: `InvalidFeeSplit: ${input.feeSplitBps} (must be 0-${MAX_FEE_SPLIT_BPS} bps)` }
  }
  const a = input.companyA.toLowerCase()
  const b = input.companyB.toLowerCase()
  if (a === '0x0000000000000000000000000000000000000000' || b === '0x0000000000000000000000000000000000000000') {
    return { ok: false, error: 'InvalidFeeAccount: company A and B fee accounts must be non-zero' }
  }
  const depositWei = input.operatingDepositWei ?? MIN_OPERATING_WEI
  if (depositWei !== MIN_OPERATING_WEI) {
    return { ok: false, error: `OperatingDeposit: companies owe exactly ${MIN_OPERATING_DEPOSIT} ETH combined (A ${input.feeSplitBps} bps, B the rest), got ${Number(depositWei) / 1e18}` }
  }
  return { ok: true }
}

// ─── Reward earn calculation (mirrors CampaignEscrow earn semantics) ─────────
// Pure function so the wizard's cap logic is testable backend-side. A user's
// earn on a single purchase is:
//   1. the mechanic: flat (fixed per purchase) or rate% of the purchase
//   2. capped per transaction when perTxCap is set
//   3. capped cumulatively by the remaining per-user budget (per-user cap
//      minus everything already earned)
// Both caps are optional; caps never go negative, and 0 remaining budget means
// the user earns nothing. For discount campaigns the returned value is dollars
// SAVED (the totalSaved counter) — same math, different meaning downstream.
export interface EarnParams {
  purchaseAmount: number
  rateBps: number // 0-10000 (cashbackRate% × 100); ignored when flatValue is set
  flatValue?: number | null // fixed reward per qualifying purchase (flat mechanic)
  perTxCap?: number | null
  perUserCap?: number | null
  alreadyEarned?: number
}

export function calculateRewardEarn(p: EarnParams): number {
  const earn = p.flatValue != null && p.flatValue > 0
    ? p.flatValue
    : (p.purchaseAmount * p.rateBps) / 10_000
  let capped = earn
  if (p.perTxCap != null) capped = Math.min(capped, p.perTxCap)
  if (p.perUserCap != null) {
    const remaining = Math.max(0, p.perUserCap - (p.alreadyEarned ?? 0))
    capped = Math.min(capped, remaining)
  }
  return Math.max(0, capped)
}

// ─── Salt generation ────────────────────────────────────────────────────────
// The smart contract uses a CREATE2 salt for deterministic escrow addresses.
// Backend generates a 32-byte random salt at launch (same shape the contract
// accepts); the on-chain createCampaign wiring is still pending deployment, so
// the salt is stored now and consumed when that wiring lands.
export function generateSalt(): string {
  return '0x' + randomBytes(32).toString('hex')
}

// ─── Row → API shape (JSONB comes back as an object) ────────────────────────
export interface CampaignRow {
  id: number
  name: string
  status: 'draft' | 'pending_deposit' | 'launched' | 'cancelled'
  reward_type: 'monetary' | 'digital' | 'physical'
  mechanics: Record<string, unknown>
  terms: Record<string, unknown>
  rules: Record<string, unknown>
  fee_split_bps: number
  company_a: string
  company_b: string
  company_a_name: string
  company_b_name: string
  operating_deposit: bigint | string | number
  salt: string | null
  escrow_address: string | null
  reward_address: string | null
  created_at: Date
  launched_at: Date | null
  deposit_deadline: Date | null
  deposits: Record<string, DepositRecord>
}

// One recorded deposit: the Privy wallet that sent it, the tx that carried it,
// and when the backend confirmed it on-chain. The JSONB key is 'A' or 'B'.
export interface DepositRecord {
  wallet: string
  txHash: string
  wei: string
  confirmedAt: string
}

export interface CampaignApi extends Omit<CampaignRow, 'operating_deposit' | 'created_at' | 'launched_at' | 'deposit_deadline' | 'deposits'> {
  operatingDepositWei: string
  createdAt: string
  launchedAt: string | null
  depositDeadline: string | null
  deposits: Record<string, DepositRecord>
}

export function toApi(row: CampaignRow): CampaignApi {
  const { operating_deposit, created_at, launched_at, deposit_deadline, deposits, ...rest } = row
  return {
    ...rest,
    operatingDepositWei: operating_deposit.toString(),
    createdAt: created_at.toISOString(),
    launchedAt: launched_at ? launched_at.toISOString() : null,
    depositDeadline: deposit_deadline ? deposit_deadline.toISOString() : null,
    deposits: deposits ?? {},
  }
}

// ─── Deposit shares & deadline (pure helpers — unit-tested) ─────────────────
// Each company deposits its own share of MIN_OPERATING_DEPOSIT: A deposits
// feeSplitBps% of the total, B the complement (mirrors the factory's
// _recordDeposit split — A 4000 bps of 0.01 ETH → A sends 0.004, B 0.006).
export function depositShareWei(feeSplitBps: number, company: 'A' | 'B', totalWei?: bigint): bigint {
  const total = totalWei ?? MIN_OPERATING_WEI
  const shareBps = company === 'A' ? feeSplitBps : MAX_FEE_SPLIT_BPS - feeSplitBps
  return (total * BigInt(shareBps)) / BigInt(MAX_FEE_SPLIT_BPS)
}

// Deposit deadline = the campaign's start date; if the start is already in the
// past (or missing), the deadline is now + 4 hours. Backend-enforced only —
// on-chain nothing blocks a late recording (honest demo boundary, README'd).
export const DEPOSIT_DEADLINE_GRACE_MS = 4 * 60 * 60 * 1000

export function computeDepositDeadline(startIso: unknown, nowMs?: number): string {
  const now = nowMs ?? Date.now()
  const startMs = typeof startIso === 'string' ? new Date(startIso).getTime() : NaN
  if (Number.isFinite(startMs) && startMs > now) {
    return new Date(startMs).toISOString()
  }
  return new Date(now + DEPOSIT_DEADLINE_GRACE_MS).toISOString()
}