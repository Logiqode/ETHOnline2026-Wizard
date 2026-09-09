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
  { value: 'digital', label: 'Digital Merchandise', hint: 'PRODUCTION-LIMITED: badge minting (1 per purchase) is not wired in the launch path yet — the on-chain caps support it, the launcher does not.' },
  { value: 'physical', label: 'Physical Merchandise', hint: 'PRODUCTION-LIMITED: off-chain fulfillment has no on-chain enforcement.' },
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
      { key: 'capPeriod', label: 'Reset period', type: 'select', options: ['Lifetime', 'Year', 'Month', 'Week', 'Day', 'Hour', 'Minute', 'Second'], disabledOptions: ['Hour', 'Minute', 'Second'], disabledHint: 'PRODUCTION-LIMITED: sub-day reset windows have no on-chain window math yet (windowStart anchors to day boundaries). Launches map them to a lifetime cap.' },
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
    description: 'After spending a total of n amount in the campaign, receive X (a badge, an event ticket, a lottery entry — reward shape is the campaign\'s choice).',
    guide: 'Milestone reward based on cumulative spend across the campaign, not per-transaction.',
    state: 'production-limited',
    fields: [
      { key: 'period', label: 'Period (days)', type: 'number', placeholder: '30' },
      { key: 'threshold', label: 'Total spend (n)', type: 'number', placeholder: '200' },
      { key: 'reward', label: 'Receives (X)', type: 'text', placeholder: 'badge / ticket / lottery entry' },
    ],
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
    id: 'referred-by-friend',
    name: 'Referred by a friend',
    description: 'Join via a referral link/code from an existing customer.',
    guide: 'The customer\'s first purchase counts only if they arrived through a referral — pairs with "Refer a friend" (referee-side of the same loop; attribution model TBD).',
    state: 'production-limited',
    fields: [{ key: 'referralSource', label: 'Requires referral', type: 'select', options: ['Any referral', 'Specific campaign referral'] }],
  },
  {
    id: 'prior-campaign',
    name: 'Participated in campaign n',
    description: 'Customer must have participated in campaign n before.',
    guide: 'Cross-campaign eligibility: rewards only for wallets with a claim history on a prior campaign.',
    state: 'production-limited',
    fields: [{ key: 'campaignRef', label: 'Prior campaign', type: 'text', placeholder: 'campaign id or name' }],
  },
  {
    id: 'payment-method',
    name: 'Payment method',
    description: 'Customer must have paid using an eligible payment method.',
    guide: 'Restrict the reward to specific payment rails (e.g. Globex card, mobile wallet).',
    state: 'production-limited',
    fields: [{ key: 'methods', label: 'Eligible methods', type: 'text', placeholder: 'Globex card, QR wallet' }],
  },
  // 'reward-shapes' removed — redundant: reward shape is chosen in the dedicated
  // Reward section (Reward type + cashback/discount mechanics blocks).
  {
    id: 'birth-month',
    name: 'Birth date',
    description: 'e.g. customer birth month is July.',
    guide: 'Reward based on a customer attribute (birth month).',
    state: 'production-limited',
    fields: [{ key: 'month', label: 'Month', type: 'select', options: ['January','February','March','April','May','June','July','August','September','October','November','December'] }],
  },
  // Last rule addition — "Before Tax" computes the reward on the pre-tax amount
  // (e.g. 10% cashback on $110 incl. 10% tax = $10.00, not $11.00). Needs the
  // POS payload to carry a tax breakdown the demo doesn't collect.
  {
    id: 'before-tax',
    name: 'Before Tax',
    description: 'Compute the reward on the pre-tax amount, not the total paid.',
    guide: 'The POS payload would need a tax breakdown (subtotal vs tax) so the reward is calculated on the subtotal only.',
    state: 'production-limited',
    fields: [{ key: 'taxMode', label: 'Tax handling', type: 'select', options: ['Pre-tax subtotal', 'Pre-tax + tip'] }],
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