// ─── On-chain escrow state reader (Base Sepolia) ────────────────────────────
// Read-only viem client for the campaign detail page: terms, the participant
// ledger (scanned from Claim events), platform fees accrued, and the
// escrow/reward addresses for a campaign id.
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from 'viem'
import { baseSepolia } from 'viem/chains'

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com'

// CampaignEscrow's public surface we read from the detail page. The forwarder
// address is fixed on Base Sepolia (same one the escrow was initialized with).
const escrowAbi = parseAbi([
  // Param order mirrors the CampaignTerms struct field order exactly
  // (rateBps, start, end, reward, rewardTokenId, rules, platformFeeBps, platformFeeAccount).
  'function terms() view returns (uint256 rateBps, uint64 start, uint64 end, address reward, uint256 rewardTokenId, (bool minSpendEnabled, uint256 minSpend, bool capEnabled, uint256 cap, bool dayOfWeekEnabled, uint8 daysOfWeek, bool flatEnabled, uint256 flatValue, bool redeemable, bool perTxCapEnabled, uint256 perTxCap, uint8 capWindow, uint8 capWindowCount, uint16 capWindowTime, uint8 capWindowDow) rules, uint256 platformFeeBps, address platformFeeAccount)',
  'function campaignLedger(uint256, address) view returns (uint256 totalBalance, uint256 unspentBalance, uint256 originalBlock)',
  'function platformFeesAccrued() view returns (uint256)',
  'function forwarder() view returns (address)',
  'function workflowOwner() view returns (address)',
  'function reportOwner() view returns (address)',
  'function usedNullifiers(bytes32) view returns (bool)',
])

const CLAIM_EVENT = parseAbiItem('event Claim(bytes32 indexed nullifier, address indexed recipient, uint256 points, uint256 amountSpent)')

export const DEMO_USER_ANCHOR = '0xAAaA000000000000000000000000000000000001' as Address

export interface Participant {
  address: Address
  totalBalance: string // lifetime earned (raw 18-dec)
  unspentBalance: string // currently spendable (raw 18-dec; == totalBalance for discount campaigns)
  originalBlock: number // first participation block
  claims: number // Claim events observed for this wallet
  amountSpentUsd: number // total purchase volume across claims (18-dec USD)
  lastClaimBlock: number
}

export interface EscrowState {
  escrow: Address
  reward: Address
  rewardTokenId: string
  rateBps: number
  start: number
  end: number
  minSpendEnabled: boolean
  minSpendUsd: number
  capEnabled: boolean
  capUsd: number
  perTxCapEnabled: boolean
  perTxCapUsd: number
  capWindow: number      // 0 lifetime, 1 day, 2 week, 3 month, 4 year (UTC calendar)
  capWindowCount: number // N intervals
  capWindowTime: number  // seconds past midnight UTC for the reset instant
  capWindowDow: number   // week anchor weekday: 0=Mon..6=Sun
  dayOfWeekEnabled: boolean
  daysOfWeek: number
  flatEnabled: boolean
  flatValueUsd: number
  redeemable: boolean
  platformFeeBps: number
  platformFeeAccount: Address
  platformFeesAccrued: string // raw 18-dec reward units as string
  participants: Participant[]
  // True when the Claim-event scan had to fall back to a narrower window
  // (public RPC range limits) — the list may then miss very old claims.
  participantsPartial: boolean
}

const formatUsd = (raw: bigint): number => Number(raw) / 1e18

export async function loadEscrowState(escrow: Address): Promise<EscrowState> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) })

  // terms() first (escrow must exist for the page to be useful). viem returns
  // public struct getters as POSITIONAL tuples in struct-field order:
  // [rateBps, start, end, reward, rewardTokenId, rules, platformFeeBps, platformFeeAccount]
  const terms = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'terms' })
  const [rateBps, start, end, reward, rewardTokenId, rules, platformFeeBps, platformFeeAccount] = terms as readonly [
    bigint, bigint, bigint, Address, bigint,
    { minSpendEnabled: boolean; minSpend: bigint; capEnabled: boolean; cap: bigint; dayOfWeekEnabled: boolean; daysOfWeek: number; flatEnabled: boolean; flatValue: bigint; redeemable: boolean; perTxCapEnabled: boolean; perTxCap: bigint; capWindow: number; capWindowCount: number; capWindowTime: number; capWindowDow: number },
    bigint, Address,
  ]

  const feesAccrued = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'platformFeesAccrued' })

  // ── Participants: scan Claim events since the campaign window opened ──────
  // Claims can only land inside [terms.start, terms.end], so deriving the scan
  // start from the window start keeps the query small. Public Base Sepolia
  // RPCs cap eth_getLogs ranges (publicnode: 50k blocks ≈ 28h) — clamp to
  // that; if the clamp hides claims we flag the list as partial. For demo
  // campaigns seeded days ago the clamp covers everything that happened.
  const head = await client.getBlockNumber()
  const MAX_RANGE = 49_000n // just under the publicnode 50k limit
  const estFrom = head - BigInt(Math.ceil((Math.floor(Date.now() / 1000) - Number(start)) / 2) + 1000)
  const fromBlock = estFrom > 0n ? (estFrom < head - MAX_RANGE ? head - MAX_RANGE : estFrom) : (head > MAX_RANGE ? head - MAX_RANGE : 0n)
  const participantsPartial = fromBlock > estFrom || estFrom < 0n
  const claimLogs = await client.getLogs({ address: escrow, event: CLAIM_EVENT, fromBlock, toBlock: 'latest' })

  // Unique recipients in first-seen order; the ledger read is the source of
  // truth for balances (each claim has a unique per-purchase nullifier, so
  // the event sums always agree with the ledger — the ledger is still
  // authoritative).
  const seen = new Map<Address, { claims: number; amountSpentUsd: bigint; lastClaimBlock: number }>()
  for (const log of claimLogs) {
    const recipient = log.args.recipient as Address | undefined
    if (!recipient) continue
    const agg = seen.get(recipient) ?? { claims: 0, amountSpentUsd: 0n, lastClaimBlock: 0 }
    agg.claims += 1
    agg.amountSpentUsd += (log.args.amountSpent as bigint) ?? 0n
    agg.lastClaimBlock = Number(log.blockNumber)
    seen.set(recipient, agg)
  }

  const participants: Participant[] = await Promise.all(
    [...seen.entries()].map(async ([address, agg]) => {
      const ledger = await client.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: 'campaignLedger',
        args: [rewardTokenId, address],
      })
      const [totalBalance, unspentBalance, originalBlock] = ledger as readonly [bigint, bigint, bigint]
      return {
        address,
        totalBalance: totalBalance.toString(),
        unspentBalance: unspentBalance.toString(),
        originalBlock: Number(originalBlock),
        claims: agg.claims,
        amountSpentUsd: formatUsd(agg.amountSpentUsd),
        lastClaimBlock: agg.lastClaimBlock,
      }
    }),
  )
  // Biggest earners first — the demo usually has 1-5 rows, newest activity is
  // still visible via the lastClaimBlock column.
  participants.sort((a, b) => Number(b.totalBalance) - Number(a.totalBalance) || a.address.localeCompare(b.address))

  return {
    escrow,
    reward,
    rewardTokenId: rewardTokenId.toString(),
    rateBps: Number(rateBps),
    start: Number(start),
    end: Number(end),
    minSpendEnabled: rules.minSpendEnabled,
    minSpendUsd: formatUsd(rules.minSpend),
    capEnabled: rules.capEnabled,
    capUsd: formatUsd(rules.cap),
    perTxCapEnabled: rules.perTxCapEnabled,
    perTxCapUsd: formatUsd(rules.perTxCap),
    capWindow: rules.capWindow,
    capWindowCount: rules.capWindowCount,
    capWindowTime: rules.capWindowTime,
    capWindowDow: rules.capWindowDow,
    dayOfWeekEnabled: rules.dayOfWeekEnabled,
    daysOfWeek: rules.daysOfWeek,
    flatEnabled: rules.flatEnabled,
    flatValueUsd: formatUsd(rules.flatValue),
    redeemable: rules.redeemable,
    platformFeeBps: Number(platformFeeBps),
    platformFeeAccount: platformFeeAccount,
    platformFeesAccrued: feesAccrued.toString(),
    participants,
    participantsPartial,
  }
}
