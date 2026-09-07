// ─── On-chain escrow state reader (Base Sepolia) ────────────────────────────
// Read-only viem client for the campaign detail page: terms, per-user ledger,
// platform fees accrued, and the escrow/reward addresses for a campaign id.
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { baseSepolia } from 'viem/chains'

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com'

// CampaignEscrow's public surface we read from the detail page. The forwarder
// address is fixed on Base Sepolia (same one the escrow was initialized with).
const escrowAbi = parseAbi([
  // Param order mirrors the CampaignTerms struct field order exactly
  // (rateBps, start, end, reward, rewardTokenId, rules, platformFeeBps, platformFeeAccount).
  'function terms() view returns (uint256 rateBps, uint64 start, uint64 end, address reward, uint256 rewardTokenId, (bool minSpendEnabled, uint256 minSpend, bool capEnabled, uint256 cap, bool dayOfWeekEnabled, uint8 daysOfWeek, bool flatEnabled, uint256 flatValue, bool redeemable) rules, uint256 platformFeeBps, address platformFeeAccount)',
  'function campaignLedger(uint256, address) view returns (uint256 totalBalance, uint256 unspentBalance, uint256 originalBlock)',
  'function platformFeesAccrued() view returns (uint256)',
  'function forwarder() view returns (address)',
  'function workflowOwner() view returns (address)',
  'function reportOwner() view returns (address)',
  'function usedNullifiers(bytes32) view returns (bool)',
])

export const DEMO_USER_ANCHOR = '0xAAaA000000000000000000000000000000000001' as Address

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
  flatEnabled: boolean
  flatValueUsd: number
  redeemable: boolean
  platformFeesAccrued: string // raw 18-dec reward units as string
  demoUser: {
    totalBalance: string // lifetime earned (raw 18-dec)
    unspentBalance: string // currently spendable (raw 18-dec)
    originalBlock: number
  }
}

const formatUsd = (raw: bigint): number => Number(raw) / 1e18

export async function loadEscrowState(escrow: Address): Promise<EscrowState> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) })

  // terms() first (escrow must exist for the page to be useful). viem returns
  // public struct getters as POSITIONAL tuples in struct-field order:
  // [rateBps, start, end, reward, rewardTokenId, rules, platformFeeBps, platformFeeAccount]
  const terms = await client.readContract({ address: escrow, abi: escrowAbi, functionName: 'terms' })
  const [rateBps, start, end, reward, rewardTokenId, rules] = terms as readonly [
    bigint, bigint, bigint, Address, bigint,
    { minSpendEnabled: boolean; minSpend: bigint; capEnabled: boolean; cap: bigint; dayOfWeekEnabled: boolean; daysOfWeek: number; flatEnabled: boolean; flatValue: bigint; redeemable: boolean },
    bigint, Address,
  ]

  const [feesAccrued, demoLedger] = await Promise.all([
    client.readContract({ address: escrow, abi: escrowAbi, functionName: 'platformFeesAccrued' }),
    client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: 'campaignLedger',
      args: [rewardTokenId, DEMO_USER_ANCHOR],
    }),
  ])

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
    flatEnabled: rules.flatEnabled,
    flatValueUsd: formatUsd(rules.flatValue),
    redeemable: rules.redeemable,
    platformFeesAccrued: feesAccrued.toString(),
    demoUser: {
      totalBalance: demoLedger[0].toString(),
      unspentBalance: demoLedger[1].toString(),
      originalBlock: Number(demoLedger[2]),
    },
  }
}
