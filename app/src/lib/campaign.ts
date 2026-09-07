// Campaign configuration model.
//
// The wizard is a building-block assembly across four sections:
//   Campaign Description (name + participating brands)
//   Campaign Terms      (window, total redeem cap)
//   Campaign Rules      (toggleable eligibility gates)
//   Campaign Rewards    (reward type + cashback/discount blocks)

export type RuleState = 'enabled' | 'disabled' | 'production-limited'
export type BrandRole = 'pos' | 'reward'
export type RewardType = 'monetary' | 'digital' | 'physical'

export const BRAND_ROLES: { value: BrandRole; label: string; short: string }[] = [
  { value: 'pos', label: 'POS / Issuing (earn at)', short: 'POS' },
  { value: 'reward', label: 'Reward minter / Redemption', short: 'Reward' },
]

export const BRANDS = ['Acme Coffee', 'Globex Books', 'Initech Foods', 'Hooli Fitness', 'Umbrella Goods'] as const

export interface BrandParticipant {
  name: string
  role: BrandRole
}

// ─── Reward asset types (NOT NULL selector) ────────────────────
// 'monetary' covers cashback (points) and discount; 'digital' is an NFT-like
// ERC-1155 badge/item; 'physical' is off-chain fulfillment.
export const REWARD_TYPES: { value: RewardType; label: string; hint: string }[] = [
  { value: 'monetary', label: 'Monetary', hint: 'Cashback points or a discount.' },
  { value: 'digital', label: 'Digital Merchandise', hint: 'NFT-like ERC-1155 badge/item.' },
  { value: 'physical', label: 'Physical Merchandise', hint: 'Off-chain fulfillment.' },
]

// ─── Reward mechanics blocks ───────────────────────────────────
export interface RewardBlock {
  id: string
  name: string
  description: string
  guide: string
  state: 'enabled' | 'disabled'
  fields: RuleField[]
}

export interface RuleField {
  key: string
  label: string
  hint?: string
  type: 'number' | 'text' | 'datetime' | 'select' | 'multi' | 'time' | 'toggle'
  options?: string[]
  /** Option values the user cannot pick (rendered greyed out + disabled). */
  disabledOptions?: string[]
  /** Tooltip for disabled options. */
  disabledHint?: string
  placeholder?: string
  min?: number
  max?: number
}

// Cashback: rate (%) + optional per-user cap + token/point name.
// Discount: a value off. These two are mutually exclusive (user can't have both).
export const REWARD_BLOCKS: RewardBlock[] = [
  {
    id: 'cashback',
    name: 'Cashback',
    description: 'Return a % of the purchase as points, or a fixed amount per purchase.',
    guide: 'Cashback mechanic (percent or flat), an optional per-transaction cap, and the point/token name.',
    state: 'enabled',
    fields: [
      { key: 'cashbackType', label: 'Type', type: 'select', options: ['Percentage (%)', 'Flat/Fixed'], hint: 'Percentage: points = rate% of the purchase. Flat/Fixed: every qualifying purchase earns the same fixed amount.' },
      { key: 'cashbackRate', label: 'Cashback (%)', type: 'number', placeholder: '10', min: 0, max: 100 },
      { key: 'cashbackFlat', label: 'Cashback (fixed)', type: 'number', placeholder: '2', min: 0, hint: 'Only for Flat/Fixed — the fixed amount earned per qualifying purchase.' },
      { key: 'cashbackPerTxCapEnabled', label: 'Per transaction cap', type: 'toggle', hint: 'Cap the points earned on a single purchase.' },
      { key: 'cashbackToken', label: 'Point / token name', type: 'text', placeholder: 'Bpoints' },
      { key: 'cashbackPerTxCap', label: 'Per transaction cap', type: 'number', placeholder: '50', min: 0 },
    ],
  },
  {
    id: 'discount',
    name: 'Discount',
    description: 'Discount the price by a fixed amount or % — tracked as proof-of-savings.',
    guide: 'A flat or % discount. Savings accumulate in the user\'s totalSaved counter — nothing is redeemable at a POS.',
    state: 'disabled',
    fields: [
      { key: 'discountValue', label: 'Discount', type: 'number', placeholder: '5', min: 0 },
      { key: 'discountPerTxCapEnabled', label: 'Per transaction cap', type: 'toggle', hint: 'Cap the discount amount on a single purchase.' },
      { key: 'discountType', label: 'Type', type: 'select', options: ['Percentage (%)', 'Flat/Fixed'] },
      { key: 'discountPerTxCap', label: 'Per transaction cap', type: 'number', placeholder: '20', min: 0 },
    ],
  },
]

// ─── Campaign Rules (toggleable eligibility gates) ─────────────
// `disabled` rules are toggleable; `production-limited` rules are a static
// yellow showcase (deferred, not in v1 build) — never clickable.
export interface CampaignRule {
  id: string
  name: string
  description: string
  guide: string
  state: RuleState
  fields: RuleField[]
}

export const CAMPAIGN_RULES: CampaignRule[] = [
  {
    id: 'min-spend',
    name: 'Minimum spend',
    description: 'Reward only when the purchase total is at least X.',
    guide: 'The minimum USD amount a purchase must reach to qualify.',
    state: 'enabled',
    fields: [{ key: 'minSpend', label: 'Min spend (USD)', type: 'number', placeholder: '10', min: 0 }],
  },
  {
    id: 'reward-cap',
    name: 'Reward cap / user',
    description: 'Lifetime or periodic reward cap per user.',
    guide: 'Caps cumulative rewards per customer. Pick a reset period — Lifetime, or every N days/weeks/months/years.',
    state: 'enabled',
    fields: [
      { key: 'cap', label: 'Reward cap / user', type: 'number', placeholder: '100', min: 0 },
      { key: 'capPeriod', label: 'Reset period', type: 'select', options: ['Lifetime', 'Year', 'Month', 'Week', 'Day'] },
      { key: 'capPeriodCount', label: 'Every', type: 'number', placeholder: '1', min: 1 },
      { key: 'capResetBasis', label: 'Reset basis', type: 'select', options: ['Calendar', 'Rolling'], disabledOptions: ['Rolling'], disabledHint: 'PRODUCTION-LIMITED: rolling windows re-anchor per user and have no on-chain enforcement yet. Launches map Rolling to a lifetime cap.', hint: 'Calendar: fixed UTC boundaries — fully enforced on-chain.' },
      { key: 'capResetWeekday', label: 'Reset on', type: 'select', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], hint: 'Only for Calendar + Week — the weekday boundary (e.g. every 3 weeks on Wednesday).' },
      { key: 'capResetDay', label: 'Reset on day', type: 'number', placeholder: '1', min: 1, max: 31, hint: 'Day of month (1-31). On-chain this anchors to the 1st of the month/year; custom day-of-month is PRODUCTION-LIMITED.' },
      { key: 'capResetMonth', label: 'Reset month', type: 'select', options: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], hint: 'Only for Calendar + Year. On-chain year windows anchor to Jan 1; custom month is PRODUCTION-LIMITED.' },
      { key: 'capResetTime', label: 'Reset time', type: 'time', hint: 'Only for Calendar basis — the UTC time of the boundary (e.g. 04:30).' },
    ],
  },
  {
    id: 'day-of-week',
    name: 'Day of week',
    description: 'Reward only on selected days.',
    guide: 'Pick one or more days (or none for any day).',
    state: 'enabled',
    fields: [
      { key: 'day', label: 'Days', type: 'multi', options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] },
    ],
  },
  {
    id: 'member-tier',
    name: 'Member tier',
    description: 'e.g. Tier 2 / Gold and above.',
    guide: 'Only members above a tier earn rewards.',
    state: 'production-limited',
    fields: [{ key: 'tier', label: 'Tier', type: 'select', options: ['Tier 1', 'Tier 2', 'Tier 3', 'Gold', 'Platinum'] }],
  },
  {
    id: 'cumulative-spend',
    name: 'Cumulative spend period',
    description: 'Aggregate spending over a time window.',
    guide: 'Reward is based on cumulative spend, not per-transaction.',
    state: 'production-limited',
    fields: [{ key: 'period', label: 'Period (days)', type: 'number', placeholder: '30' }],
  },
  {
    id: 'max-visits',
    name: 'Max visits per period',
    description: 'Limit of 1 transaction per day in-window.',
    guide: 'Restricts how often a customer can earn in a period.',
    state: 'production-limited',
    fields: [{ key: 'max', label: 'Max transactions', type: 'number', placeholder: '1' }],
  },
  {
    id: 'pay-with-purchase',
    name: 'Pay-with-Purchase',
    description: 'Spend X to qualify, then pay Z to get Y.',
    guide: 'A second payment unlocks the reward after qualifying.',
    state: 'production-limited',
    fields: [
      { key: 'qualify', label: 'Qualify spend (X)', type: 'number' },
      { key: 'unlock', label: 'Unlock pay (Z)', type: 'number' },
    ],
  },
  {
    id: 'product',
    name: 'Buy specific product',
    description: 'Eligible on a named product / combination.',
    guide: 'Only listed products trigger the reward.',
    state: 'production-limited',
    fields: [{ key: 'products', label: 'Products', type: 'text', placeholder: 'latte, pastry' }],
  },
  {
    id: 'is-member',
    name: 'Is member',
    description: 'Must be a registered member.',
    guide: 'Requires a membership before rewarding.',
    state: 'production-limited',
    fields: [{ key: 'membership', label: 'Membership', type: 'select', options: ['Any', 'Specific'] }],
  },
  {
    id: 'refer-friend',
    name: 'Refer a friend',
    description: 'Reward tied to a successful referral.',
    guide: 'Reward when a referred friend completes a purchase.',
    state: 'production-limited',
    fields: [{ key: 'referralCount', label: 'Referrals', type: 'number', placeholder: '1' }],
  },
  {
    id: 'reward-shapes',
    name: 'Reward shapes',
    description: 'Cashback / badge / redeemable badge / flat discount.',
    guide: 'How the reward is delivered (points vs NFT badge).',
    state: 'production-limited',
    fields: [{ key: 'shape', label: 'Shape', type: 'select', options: ['Cashback', 'Badge', 'Redeemable badge', 'Flat discount'] }],
  },
  {
    id: 'birth-month',
    name: 'Birth date',
    description: 'e.g. customer birth month is July.',
    guide: 'Reward based on a customer attribute (birth month).',
    state: 'production-limited',
    fields: [{ key: 'month', label: 'Month', type: 'select', options: ['January','February','March','April','May','June','July','August','September','October','November','December'] }],
  },
]

// Hardcoded end-date sentinel when "No end date" is selected (current year + 5000).
export const NO_END_DATE_SENTINEL = `${new Date().getFullYear() + 5000}-12-31T23:59`

// Common IANA timezones for the campaign window, with UTC offsets shown in the
// label. Ordered by offset so UTC sits in the middle. The backend later converts
// these to UTC for smart-contract creation.
export const TIMEZONES = [
  { label: 'America/Los_Angeles (PT, UTC-8)', value: 'America/Los_Angeles' },
  { label: 'America/Denver (MT, UTC-7)', value: 'America/Denver' },
  { label: 'America/Chicago (CT, UTC-6)', value: 'America/Chicago' },
  { label: 'America/New_York (ET, UTC-5)', value: 'America/New_York' },
  { label: 'UTC (UTC+0)', value: 'UTC' },
  { label: 'Europe/London (UTC+0)', value: 'Europe/London' },
  { label: 'Europe/Berlin (CET, UTC+1)', value: 'Europe/Berlin' },
  { label: 'Europe/Paris (UTC+1)', value: 'Europe/Paris' },
  { label: 'Asia/Shanghai (CST, UTC+8)', value: 'Asia/Shanghai' },
  { label: 'Asia/Singapore (SGT, UTC+8)', value: 'Asia/Singapore' },
  { label: 'Asia/Tokyo (JST, UTC+9)', value: 'Asia/Tokyo' },
  { label: 'Asia/Seoul (KST, UTC+9)', value: 'Asia/Seoul' },
  { label: 'Australia/Sydney (AEST, UTC+10)', value: 'Australia/Sydney' },
] as const

export type Timezone = (typeof TIMEZONES)[number]['value']

// Short abbreviation for a timezone (e.g. 'UTC', 'CET', 'JST') derived from its
// label, for compact display beside time fields.
export function timezoneAbbr(tz: Timezone): string {
  const entry = TIMEZONES.find((t) => t.value === tz)
  if (!entry) return tz
  const m = entry.label.match(/\(([A-Z+]+)[,)]/)
  return m ? m[1] : tz
}