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

// The hardcoded POS test-payload SET per seeded campaign (mirror of
// wizard/test-payloads/onchain-*.json) + a human description of what each
// exercises, shown on the campaign detail page. The UI renders them as
// collapsible cards (JSON hidden behind a show/hide toggle). Three payloads
// per campaign: a pass, a below-min-spend rejection, and a cap-edge case.
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

// timestamp 1789000000 ≈ 2026-09-12 (a Saturday? no — epoch math puts it on a
// Friday UTC) — inside every seeded campaign's window. Anchors AND timestamps
// are per-case so no pass payload ever collides with a previous run's
// nullifier (nullifier = f(master, campaignId, anchor, timestamp)).
export const SEED_TEST_PAYLOADS: Record<number, SeedTestPayload[]> = {
  1: [
    {
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
        'PASS — $30 purchase → 10% cashback = 3 Bpoints (above the $10 min spend, 0 already earned against the $100 cap). Mints 3 redeemable points to 0xAAA…0001.',
    },
    {
      payload: {
        campaignId: 1,
        userAnchor: '0xAAaA000000000000000000000000000000000002',
        merchantId: 'burgera',
        amountSpent: 5,
        timestamp: 1789000000,
        earnedInWindow: 0,
        items: ['fries'],
      },
      description:
        'REJECT (below-min-spend) — $5 purchase is under the $10 minimum. The DON verdict will be SUCCESS with eligible=false, points=0, reason=below-min-spend (no on-chain write).',
    },
    {
      payload: {
        campaignId: 1,
        userAnchor: '0xAAaA000000000000000000000000000000000003',
        merchantId: 'burgera',
        amountSpent: 50,
        timestamp: 1789000000,
        earnedInWindow: 0,
        items: ['family-meal'],
      },
      description:
        'CAP CLAMP step 1 — $50 purchase → 5 Bpoints, all against the $100 per-user cap (fresh wallet …0003, earned 0 → uncapped pass). Run this FIRST to build up earnedInWindow=5 on the escrow ledger.',
    },
    {
      payload: {
        campaignId: 1,
        userAnchor: '0xAAaA000000000000000000000000000000000003',
        merchantId: 'burgera',
        amountSpent: 980,
        timestamp: 1789000001,
        earnedInWindow: 5,
        items: ['family-meal'],
      },
      description:
        'CAP CLAMP step 2 — $980 purchase would earn 98 raw, but the wallet now has 5 earned (from step 1) → clamped to 95. Both the enclave and the escrow clamp against the real ledger: the mint is 95, not 98. Run AFTER step 1.',
    },
  ],
  2: [
    {
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
        'PASS — flat mechanic: every qualifying purchase earns exactly $2 regardless of spend (above the $10 min spend). Mints 2 redeemable points.',
    },
    {
      payload: {
        campaignId: 2,
        userAnchor: '0xAAaA000000000000000000000000000000000002',
        merchantId: 'burgera',
        amountSpent: 8,
        timestamp: 1789000000,
        earnedInWindow: 0,
        items: ['drink'],
      },
      description:
        'REJECT (below-min-spend) — $8 purchase is under the $10 minimum; flat $2 never applies below it.',
    },
    {
      payload: {
        campaignId: 2,
        userAnchor: '0xAAaA000000000000000000000000000000000003',
        merchantId: 'burgera',
        amountSpent: 250,
        timestamp: 1789000000,
        earnedInWindow: 0,
        items: ['catering'],
      },
      description:
        'FLAT INVARIANCE — $250 purchase still earns exactly $2 (flat ignores spend size; no cap rule on this campaign so nothing clamps). Tests that the mechanic really is flat.',
    },
  ],
  3: [
    {
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
        'PASS — $30 purchase → $5 discount saved (proof-of-savings: the $5 lands in the totalSaved counter, nothing is minted, nothing redeemable).',
    },
    {
      payload: {
        campaignId: 3,
        userAnchor: '0xAAaA000000000000000000000000000000000002',
        merchantId: 'burgera',
        amountSpent: 4,
        timestamp: 1789000000,
        earnedInWindow: 0,
        items: ['napkin'],
      },
      description:
        'REJECT (below-min-spend) — $4 purchase is under the $10 minimum; no savings recorded.',
    },
    {
      payload: {
        campaignId: 3,
        userAnchor: '0xAAaA000000000000000000000000000000000003',
        merchantId: 'burgera',
        amountSpent: 60,
        timestamp: 1789000000,
        earnedInWindow: 0,
        items: ['groceries'],
      },
      description:
        'ACCUMULATION — second $60 purchase on the same anchor adds another $5 saved (flat per purchase); totalSaved grows 5 → 10 while unspentBalance stays 0 (not redeemable by design).',
    },
  ],
}
