// ─── Seeded demo campaigns (factory bootstrap) ──────────────────────────────
// The three demo campaigns deployed directly by contracts/script/SeedCampaigns.s.sol
// (they never went through the wizard, so the DB had no record of them). These
// constants MIRROR the seed script — same salts, terms, and fee split — so the
// DB records describe the real on-chain escrows. The escrow/reward addresses
// are read live from the factory at seed time, not hardcoded.
import { type Address, type Hex } from 'viem'

export const SEED_COMPANY_A = '0x00000000000000000000000000000000000A11cE' as Address
export const SEED_COMPANY_B = '0x0000000000000000000000000000000000000B0b' as Address

export interface SeedCampaignSpec {
  campaignId: number
  name: string
  salt: Hex
  mechanics: Record<string, unknown>
  terms: Record<string, unknown>
  rules: Record<string, unknown>
}

// feeSplitBps: 2500 (25% to A) — matches the seed script's createCampaign arg.
export const SEED_CAMPAIGNS: SeedCampaignSpec[] = [
  {
    campaignId: 1,
    name: 'Acme ◆ Globex Summer (seeded)',
    salt: '0xba75b1af7059eec00415caeb51e58f98deb8d3dadcac4f443679d810e070318d',
    mechanics: {
      rewardType: 'monetary',
      rewardValues: { cashbackType: 'percent', cashbackRate: 10, cashbackToken: 'Bpoints' },
    },
    terms: { seeded: true, mechanic: 'percent-cashback' },
    rules: {
      ruleStates: { 'min-spend': 'enabled', 'reward-cap': 'enabled', 'day-of-week': 'enabled' },
      ruleValues: { minSpend: 10, cap: 100 },
    },
  },
  {
    campaignId: 2,
    name: 'Flat $2 Cashback (seeded)',
    salt: '0xcce77fdb3a4ccd4ee71ebf30844a2e663aeaa72e7de0dd0496c5c0635ac42916',
    mechanics: {
      rewardType: 'monetary',
      rewardValues: { cashbackType: 'flat', cashbackFlat: 2, cashbackToken: 'Bpoints' },
    },
    terms: { seeded: true, mechanic: 'flat-cashback' },
    rules: {
      ruleStates: { 'min-spend': 'enabled', 'reward-cap': 'disabled', 'day-of-week': 'enabled' },
      ruleValues: { minSpend: 10 },
    },
  },
  {
    campaignId: 3,
    name: '$5 Discount — Proof of Savings (seeded)',
    salt: '0x3f79fd7bd9b76bd72c98f58621dcd9e8dcdf820aa10dbf24e7936ed63d995b50',
    mechanics: {
      rewardType: 'monetary',
      rewardValues: { cashbackType: 'discount', cashbackFlat: 5 },
    },
    terms: { seeded: true, mechanic: 'discount' },
    rules: {
      ruleStates: { 'min-spend': 'enabled', 'reward-cap': 'disabled', 'day-of-week': 'enabled' },
      ruleValues: { minSpend: 10 },
    },
  },
]

// The hardcoded POS test payload per seeded campaign (mirror of
// wizard/test-payloads/onchain-*-pass.json) + a human description of what it
// exercises, shown on the campaign detail page.
export interface SeedTestPayload {
  payload: {
    campaignId: number
    userAnchor: string
    merchantId: string
    amountSpent: number
    timestamp: number
    earnedInWindow: number
    items: string[]
  }
  description: string
}

// timestamp 1789000000 ≈ 2026-09-12 — inside every seeded campaign's window.
export const SEED_TEST_PAYLOADS: Record<number, SeedTestPayload> = {
  1: {
    payload: {
      campaignId: 1,
      userAnchor: '0xAAaA000000000000000000000000000000000001',
      merchantId: 'burgera',
      amountSpent: 30,
      timestamp: 1789000000,
      earnedInWindow: 0,
      items: ['burger'],
    },
    description:
      '$30 purchase → 10% cashback = 3 Bpoints (above the $10 min spend, first claim so 0 already earned against the $100 cap). Mints 3 redeemable points to 0xAAA…0001.',
  },
  2: {
    payload: {
      campaignId: 2,
      userAnchor: '0xAAaA000000000000000000000000000000000001',
      merchantId: 'burgera',
      amountSpent: 30,
      timestamp: 1789000000,
      earnedInWindow: 0,
      items: ['burger'],
    },
    description:
      '$30 purchase → flat $2 cashback (flat mechanic: every qualifying purchase earns exactly $2 regardless of spend, above the $10 min spend). Mints 2 redeemable points.',
  },
  3: {
    payload: {
      campaignId: 3,
      userAnchor: '0xAAaA000000000000000000000000000000000001',
      merchantId: 'burgera',
      amountSpent: 30,
      timestamp: 1789000000,
      earnedInWindow: 0,
      items: ['burger'],
    },
    description:
      '$30 purchase → $5 discount saved (proof-of-savings: the $5 lands in the totalSaved counter, nothing is minted and nothing is redeemable — the ledger records proof of savings only).',
  },
}
