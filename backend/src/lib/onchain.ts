// ─── On-chain campaign deployment (Base Sepolia) ────────────────────────────
// Wires the backend's launch flow to CampaignFactory.createCampaign(): builds
// CampaignTerms from the wizard's draft record, sends the create tx, and reads
// back the deterministic escrow/reward addresses. Deployment addresses come
// from contracts/deployments/base-sepolia.json (written by the forge script).
import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog, getEventSelector, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com'

export const factoryAbi = parseAbi([
  'function createCampaign((uint256 rateBps, uint64 start, uint64 end, address reward, uint256 rewardTokenId, (bool minSpendEnabled, uint256 minSpend, bool capEnabled, uint256 cap, bool dayOfWeekEnabled, uint8 daysOfWeek, bool flatEnabled, uint256 flatValue, bool redeemable) rules, uint256 platformFeeBps, address platformFeeAccount) terms, address workflowOwner, address reportOwner, string rewardUri, bytes32 salt, address companyA, address companyB, uint256 feeSplitBps) returns (uint256 campaignId)',
  'function campaigns(uint256) view returns (address escrow, address reward, uint256 rewardTokenId, uint64 start, uint64 end)',
  'function nextCampaignId() view returns (uint256)',
  'function MIN_OPERATING_DEPOSIT() view returns (uint256)',
  'event CampaignCreated(uint256 indexed campaignId, address indexed escrow, address indexed reward)',
])

export interface DeployedAddresses {
  factory: Address
  escrowImplementation: Address
  deployer: Address
  chainId: number
}

export async function loadDeployment(): Promise<DeployedAddresses> {
  // Resolved from this module's location (backend/src/lib) up to the repo root;
  // the JSON lives in contracts/deployments/.
  const path = join(import.meta.dir, '..', '..', '..', 'contracts', 'deployments', 'base-sepolia.json')
  const raw = JSON.parse(await readFile(path, 'utf8'))
  return {
    factory: raw.factory as Address,
    escrowImplementation: raw.escrowImplementation as Address,
    deployer: raw.deployer as Address,
    chainId: raw.chainId,
  }
}

export interface TermsInput {
  rateBps: number
  startUnix: number
  endUnix: number
  minSpendEnabled: boolean
  minSpendWei: bigint
  capEnabled: boolean
  capWei: bigint
  dayOfWeekEnabled: boolean
  daysOfWeekBitmask: number
  flatEnabled: boolean   // reward mechanic: false = percent (rateBps), true = flat (flatValue per purchase)
  flatValueWei: bigint   // flat cashback per qualifying purchase (18-decimals reward units)
  redeemable: boolean    // false = discount proof-of-savings (totalSaved counter only, nothing spendable)
}

export interface CreateCampaignArgs {
  terms: TermsInput
  workflowOwner: Address
  /** CRE *registry* owner the forwarder stamps into report metadata (workflow deployer EOA); zero = use workflowOwner. */
  reportOwner?: Address
  rewardUri: string
  salt: Hex
  companyA: Address
  companyB: Address
  feeSplitBps: number
}

export interface CreateCampaignResult {
  txHash: Hex
  campaignId: number
  escrow: Address
  reward: Address
}

// 18-decimal USD helper for min-spend/cap values (contract expects 18-dec fixed).
export const usdToWei = (dollars: number): bigint => BigInt(Math.round(dollars * 1e18))

export async function createCampaignOnChain(args: CreateCampaignArgs): Promise<CreateCampaignResult> {
  const deployment = await loadDeployment()
  // CRE_ETH_PRIVATE_KEY lives in the repo-root .env (shared with the CRE
  // workflow); bun auto-loads only backend/.env, so fall back to reading it.
  let privateKey = process.env.CRE_ETH_PRIVATE_KEY
  if (!privateKey) {
    const rootEnv = join(import.meta.dir, '..', '..', '..', '.env')
    const text = await readFile(rootEnv, 'utf8').catch(() => '')
    privateKey = text.split('\n').find((l) => l.startsWith('CRE_ETH_PRIVATE_KEY='))?.split('=').slice(1).join('=').trim()
  }
  if (!privateKey) throw new Error('CRE_ETH_PRIVATE_KEY missing (process env or root .env) — cannot send createCampaign tx')
  // Normalize: accept 64-hex with or without the 0x prefix.
  if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`

  const account = privateKeyToAccount(privateKey as Hex)
  const deployer = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) })
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) })

  const t = args.terms
  const terms = {
    rateBps: BigInt(t.rateBps),
    start: BigInt(t.startUnix),
    end: BigInt(t.endUnix),
    reward: '0x0000000000000000000000000000000000000000' as Address, // factory fills
    rewardTokenId: 0n, // factory fills (campaignId * REWARD_TOKEN_RANGE)
    rules: {
      minSpendEnabled: t.minSpendEnabled,
      minSpend: t.minSpendWei,
      capEnabled: t.capEnabled,
      cap: t.capWei,
      dayOfWeekEnabled: t.dayOfWeekEnabled,
      daysOfWeek: t.daysOfWeekBitmask,
      flatEnabled: t.flatEnabled,
      flatValue: t.flatValueWei,
      redeemable: t.redeemable,
    },
    platformFeeBps: 0n,
    platformFeeAccount: '0x0000000000000000000000000000000000000000' as Address,
  }

  const txHash = await deployer.writeContract({
    account,
    address: deployment.factory,
    abi: factoryAbi,
    functionName: 'createCampaign',
    args: [terms, args.workflowOwner, args.reportOwner ?? '0x0000000000000000000000000000000000000000', args.rewardUri, args.salt, args.companyA, args.companyB, BigInt(args.feeSplitBps)],
  })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error(`createCampaign tx reverted: ${txHash}`)

  // The CampaignCreated event carries the deterministic addresses.
  // Topics: [0]=sig, [1]=campaignId, [2]=escrow, [3]=reward (all indexed).
  const evDef = factoryAbi.find((a) => a.type === 'event' && (a as { name: string }).name === 'CampaignCreated')
  const expectedTopic = getEventSelector(evDef as never)
  const campaignLog = receipt.logs.find((l) =>
    l.address.toLowerCase() === deployment.factory.toLowerCase() &&
    l.topics[0]?.toLowerCase() === expectedTopic.toLowerCase(),
  )
  if (!evDef || !campaignLog || campaignLog.topics.length < 4) {
    throw new Error(`CampaignCreated event not found in receipt ${txHash}`)
  }
  const decoded = decodeEventLog({ abi: [evDef], data: campaignLog.data, topics: campaignLog.topics }) as { eventName: string; args: { campaignId: bigint; escrow: Address; reward: Address } }
  if (decoded.eventName !== 'CampaignCreated') throw new Error(`Unexpected event in receipt ${txHash}`)

  return {
    txHash,
    campaignId: Number(decoded.args.campaignId),
    escrow: decoded.args.escrow,
    reward: decoded.args.reward,
  }
}
