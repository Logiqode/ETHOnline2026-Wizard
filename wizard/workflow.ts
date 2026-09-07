import {
	cre,
	getNetwork,
	hexToBase64,
	bytesToHex,
	TxStatus,
	text,
	type HTTPPayload,
	type Runtime,
	type TeeRuntime,
} from '@chainlink/cre-sdk'
import { encodeCallMsg } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters, encodeFunctionData, decodeFunctionResult, keccak256, concatHex, toHex, toBytes, getAddress } from 'viem'
import { z } from 'zod'

// ─── Campaign terms (per campaign) ─────────────────────────────
// Each campaign is one entry in the config `campaigns` map, selected by the
// HTTP payload's `campaignId`. A single workflow binary serves N campaigns.

const windowSchema = z.object({
	start: z.number().int().nonnegative(), // unix
	end: z.number().int().nonnegative(),   // unix
	escrow: z.string(),                    // the campaign's deployed CampaignEscrow (Base Sepolia)
})

const cashbackSchema = z.object({
	campaignId: z.number().int().nonnegative(),
	rewardType: z.literal('cashback'),
	minSpend: z.number().nonnegative().default(0),
	rateBps: z.number().int().positive(),    // e.g. 2000 = 20%
	cap: z.number().nonnegative(),           // per-user cap in reward units
	perTxCap: z.number().nonnegative().optional(), // per-transaction cap (points); absent = uncapped
	capPeriod: z.enum(['Lifetime', 'Year', 'Month', 'Week', 'Day']).default('Lifetime'),
	capPeriodCount: z.number().int().positive().default(1),
	capResetBasis: z.enum(['Rolling', 'Calendar']).default('Rolling'),
	capResetWeekday: z.number().int().min(0).max(6).optional(), // Week calendar: 0=Mon..6=Sun
	capResetDay: z.number().int().min(1).max(31).optional(),
	capResetMonth: z.number().int().min(1).max(12).optional(),
	capResetTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('00:00'),
	daysOfWeek: z.number().int().min(0).max(127).default(0), // bitmask 0=Mon..6=Sun; 0 = any day
	start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(),
	escrow: z.string(),
})

const discountSchema = z.object({
	campaignId: z.number().int().nonnegative(),
	rewardType: z.literal('discount'),
	minSpend: z.number().nonnegative().default(0),
	discountType: z.enum(['percent', 'fixed']),
	discountValue: z.number().nonnegative(),
	perTxCap: z.number().nonnegative().optional(), // per-transaction cap (USD); absent = uncapped
	start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(),
	escrow: z.string(),
})

const digitalSchema = z.object({
	campaignId: z.number().int().nonnegative(),
	rewardType: z.literal('digital'),
	minSpend: z.number().nonnegative().default(0),
	digitalName: z.string(),
	totalRedeemCap: z.number().nonnegative(),
	start: z.number().int().nonnegative(),
	end: z.number().int().nonnegative(),
	escrow: z.string(),
})

const campaignSchema = z.discriminatedUnion('rewardType', [cashbackSchema, discountSchema, digitalSchema])
type Campaign = z.infer<typeof campaignSchema>

// ─── Config Schema ──────────────────────────────────────────────
// Deliberately MINIMAL: campaign terms are read ON-CHAIN from the factory at
// request time (the factory is the single stable "workflow master" address),
// so new campaigns work with zero workflow redeploys. Only public plumbing
// lives in config.
export const configSchema = z.object({
	chainName: z.string(),        // e.g. 'ethereum-testnet-sepolia-base-1'
	factoryAddress: z.string(),   // deployed CampaignFactory on the target chain
	workflowOwnerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), // workflow-owner EOA (public; goes into report metadata)
})
export type Config = z.infer<typeof configSchema>

// ─── HTTP-trigger authorized keys ──────────────────────────────
// Addresses allowed to sign JSON-RPC requests that fire the trigger (the DON
// verifies each request's ECDSA signature against this list — the "public
// key" field takes the 20-byte EVM address form, 0x + 40 hex). Demo: the
// platform deployer/relay EOA — its private key lives in the platform .env
// only. Production roadmap: a dedicated relay keypair, one workflow per
// campaign.
const AUTHORIZED_TRIGGER_KEYS = [
	'0x9587BD3e8195D597BF4e82B18724178e52B55c4F',
] as const

// ─── HTTP Request Payload ───────────────────────────────────────
// The HTTP body selects a campaign and carries the POS purchase. `earnedInWindow`
// is the caller-computed amount the user already earned in the current reset window
// (0 when the window just rolled over) — the workflow clamps the cap against it.
const requestSchema = z.object({
	campaignId: z.number().int().nonnegative(),
	userAnchor: z.string(),              // Privy embedded wallet address (identity anchor)
	merchantId: z.string(),
	amountSpent: z.number().nonnegative(),
	timestamp: z.number().int().nonnegative(),
	earnedInWindow: z.number().nonnegative().default(0),
	// Window the caller computed earnedInWindow in (unix ts). When it differs
	// from the window containing `timestamp`, the reset has rolled over and
	// the workflow treats earnedInWindow as 0 (fresh headroom). Advisory only —
	// the escrow's earnedInCapWindow ledger is the settlement law.
	earnedInWindowStart: z.number().int().nonnegative().optional(),
	items: z.array(z.string()).optional(),
})
export type Request = z.infer<typeof requestSchema>

// ─── Eligibility (deterministic, runs inside enclave) ─────────
// The evaluator consumes on-chain terms (flat shape from readCampaignOnChain).
type EvalCampaign = OnChainCampaign

export function evaluate(request: Request, campaign: EvalCampaign): { eligible: boolean; points: number; reason: string } {
	// 1. Date window
	if (request.timestamp < campaign.start) {
		return { eligible: false, points: 0, reason: 'before-campaign-start' }
	}
	if (request.timestamp > campaign.end) {
		return { eligible: false, points: 0, reason: 'after-campaign-end' }
	}
	// 2. Minimum spend
	if (request.amountSpent < campaign.minSpend) {
		return { eligible: false, points: 0, reason: 'below-min-spend' }
	}

	// 3. Reward mechanic. The demo escrow encodes ONE mechanic — percent
	// cashback (rateBps of the purchase) — in CampaignTerms.rateBps.
	// 3a. Day-of-week gate (bitmask 0=Mon..6=Sun). UTC weekday from timestamp.
	if (campaign.dayOfWeekEnabled && campaign.daysOfWeek !== 0) {
		const dayIndex = ((Math.floor(request.timestamp / 86400) + 3) % 7) // 0=Mon..6=Sun (epoch was Thu)
		if (((campaign.daysOfWeek >> dayIndex) & 1) !== 1) {
			return { eligible: false, points: 0, reason: 'not-allowed-day' }
		}
	}
	// 3b. Reward mechanic: percent (rateBps% of spend) or flat (fixed value per
	// purchase). For discount campaigns (rewardType 'discount') the computed
	// value is dollars SAVED — it accumulates in the user's totalSaved counter
	// on-chain, never in a spendable balance. Tightest wins — mirrors backend
	// calculateRewardEarn and CampaignRulesLib.computePoints. capEnabled=false
	// means no cap: `cap` is 0 on-chain and the clamp must be skipped, not
	// applied as 0.
	const raw = campaign.mechanic === 'flat' ? campaign.flatValue : (campaign.rateBps / 10_000) * request.amountSpent
	let points = raw
	// Per-tx cap first (independent of ledger state), then the WINDOW cap —
	// mirrors CampaignRulesLib.computePoints + the escrow's window ledger so
	// the DON report matches the escrow's on-chain re-verification exactly.
	// earnedInWindow is the caller's advisory view of the CURRENT window
	// (payload may predate a reset); the escrow's earnedInCapWindow ledger is
	// the settlement law — onReport recomputes with its own window math.
	if (campaign.perTxCapEnabled && points > campaign.perTxCap) points = campaign.perTxCap
	if (campaign.capEnabled) {
		let earnedInWindow = request.earnedInWindow ?? 0
		if (campaign.capWindow > 0) {
			const wStart = windowStart(campaign.capWindow, campaign.capWindowCount, campaign.capWindowTime, campaign.capWindowDow, request.timestamp)
			// A payload earnedInWindow computed in an EARLIER window is stale —
			// the reset grants fresh headroom (matches the escrow, which returns
			// windowEarned only when the proof's windowStart == current one).
			if (request.earnedInWindowStart !== undefined && request.earnedInWindowStart !== wStart) {
				earnedInWindow = 0
			}
		}
		const remaining = campaign.cap - earnedInWindow
		points = Math.min(points, Math.max(remaining, 0))
	}
	if (points <= 0) {
		return { eligible: false, points: 0, reason: 'cap-exhausted' }
	}
	return { eligible: true, points, reason: 'ok' }
}

// Convert a reward amount to wei (1e18) as a bigint.
function pointsToWei(points: number): bigint {
	const scaled = Math.round(points * 1e18)
	return BigInt(scaled.toLocaleString('en-US', { useGrouping: false }))
}

// ─── On-chain reads (enclave → factory/escrow, via EVM capability) ──────────
// The factory is the "workflow master": campaign terms are read at request
// time, so campaigns created after the workflow was deployed work immediately.

const FACTORY_ABI = [
	{
		name: 'campaigns',
		type: 'function',
		stateMutability: 'view',
		inputs: [{ name: '', type: 'uint256' }],
		outputs: [
			{ name: 'escrow', type: 'address' },
			{ name: 'reward', type: 'address' },
			{ name: 'rewardTokenId', type: 'uint256' },
			{ name: 'start', type: 'uint64' },
			{ name: 'end', type: 'uint64' },
		],
	},
] as const

const ESCROW_TERMS_ABI = [
	{
		name: 'terms',
		type: 'function',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'rateBps', type: 'uint256' },
			{ name: 'start', type: 'uint64' },
			{ name: 'end', type: 'uint64' },
			{ name: 'reward', type: 'address' },
			{ name: 'rewardTokenId', type: 'uint256' },
			{
				name: 'rules',
				type: 'tuple',
				components: [
					{ name: 'minSpendEnabled', type: 'bool' },
					{ name: 'minSpend', type: 'uint256' },
					{ name: 'capEnabled', type: 'bool' },
					{ name: 'cap', type: 'uint256' },
					{ name: 'dayOfWeekEnabled', type: 'bool' },
					{ name: 'daysOfWeek', type: 'uint8' },
					{ name: 'flatEnabled', type: 'bool' },
					{ name: 'flatValue', type: 'uint256' },
					{ name: 'redeemable', type: 'bool' },
					{ name: 'perTxCapEnabled', type: 'bool' },
					{ name: 'perTxCap', type: 'uint256' },
					{ name: 'capWindow', type: 'uint8' },
					{ name: 'capWindowCount', type: 'uint8' },
					{ name: 'capWindowTime', type: 'uint16' },
					{ name: 'capWindowDow', type: 'uint8' },
					],
			},
			{ name: 'platformFeeBps', type: 'uint256' },
			{ name: 'platformFeeAccount', type: 'address' },
		],
	},
] as const

interface OnChainCampaign {
	escrow: string
	rewardType: 'cashback' | 'discount' // redeemable=false → discount proof-of-savings
	mechanic: 'percent' | 'flat'
	flatValue: number // reward units per qualifying purchase (flat mechanic)
	rateBps: number
	start: number
	end: number
	minSpend: number // USD
	cap: number // reward units
	minSpendEnabled: boolean
	capEnabled: boolean
	dayOfWeekEnabled: boolean
	daysOfWeek: number
	perTxCapEnabled: boolean
	perTxCap: number // reward units per single transaction
	capWindow: number // 0 lifetime, 1 day, 2 week, 3 month, 4 year (UTC calendar)
	capWindowCount: number // N intervals (every 2 weeks → 2)
	capWindowTime: number // seconds past midnight UTC for the reset instant
	capWindowDow: number // week anchor weekday: 0=Mon..6=Sun
}

// TS mirror of CampaignRulesLib.windowStart — MUST match the contract exactly,
// because the escrow's onReport re-verifies points against its own window math
// and any divergence reverts the report. Returns the unix timestamp of the
// start of the cap-reset window containing `ts` (0 = lifetime, never resets).
export function windowStart(
	capWindow: number,
	capWindowCount: number,
	timeOfDay: number,
	anchorDow: number,
	ts: number,
): number {
	const n = capWindowCount > 0 ? capWindowCount : 1
	const off = timeOfDay >= 86400 ? 0 : timeOfDay
	if (capWindow === 1) {
		// N-day epoch-aligned blocks shifted by `off`.
		if (ts < off) return 0
		return (Math.floor((ts - off) / 86400 / n) * n) * 86400 + off
	}
	if (capWindow === 2) {
		// Week blocks anchored at weekday (4 + anchorDow mod 7) days from the
		// epoch (1970-01-01 = Thursday) + `off` seconds. Floor to N-week blocks.
		const base = 4 * 86400 + (anchorDow % 7) * 86400 + off
		if (ts < base) return 0
		return Math.floor((ts - base) / (7 * 86400) / n) * n * 7 * 86400 + base
	}
	if (capWindow === 3 || capWindow === 4) {
		// Calendar month/year blocks (UTC), shifted by `off`.
		if (ts < off) return 0
		const d = new Date((ts - off) * 1000)
		let months = d.getUTCFullYear() * 12 + d.getUTCMonth() // months since year 0
		months = Math.floor(months / n) * n
		if (capWindow === 3) {
			const y = Math.floor(months / 12)
			const m = months % 12
			return Date.UTC(y, m, 1) / 1000 + off
		}
		const y = Math.floor(months / 12)
		return Date.UTC(y, 0, 1) / 1000 + off
	}
	return 0 // lifetime
}

function getEvmClient(chainName: string) {
	const net = getNetwork({ chainFamily: 'evm', chainSelectorName: chainName, isTestnet: true })
	if (!net) throw new Error(`Network not found for chain name: ${chainName}`)
	return new cre.capabilities.EVMClient(net.chainSelector.selector)
}

// EVM capability calls (reads + writes) route through the DON runtime — the
// enclave runtime cannot reach the chain directly. A TeeRuntime escalates to
// its DON counterpart via usingTheDons().
function donRuntimeOf(runtime: Runtime<Config> | TeeRuntime<Config>): Runtime<Config> {
	if ('usingTheDons' in runtime) return runtime.usingTheDons()
	return runtime as Runtime<Config>
}

// Decode an ABI-encoded single value returned by callContract (protobuf bytes → hex).
function decodeCall<T>(abi: readonly unknown[], functionName: string, data: Uint8Array | undefined): T {
	if (!data || data.length === 0) throw new Error(`empty callContract reply for ${functionName}`)
	const params = { abi: abi as never, functionName, data: bytesToHex(data) }
	return decodeFunctionResult(params as never) as T
}

// Read the campaign's terms from the factory + escrow on Base Sepolia.
function readCampaignOnChain(runtime: Runtime<Config>, evmClient: ReturnType<typeof getEvmClient>, campaignId: number): OnChainCampaign {
	const cfg = runtime.config
	const callData = encodeFunctionData({ abi: FACTORY_ABI, functionName: 'campaigns', args: [BigInt(campaignId)] })
	const reply = evmClient
		.callContract(donRuntimeOf(runtime), {
			call: encodeCallMsg({ from: '0x0000000000000000000000000000000000000000', to: cfg.factoryAddress as `0x${string}`, data: callData }),
		})
		.result()
	const info = decodeCall<readonly [string, string, bigint, bigint, bigint]>(FACTORY_ABI, 'campaigns', reply.data)
	const [escrowAddr] = info
	if (escrowAddr === '0x0000000000000000000000000000000000000000') {
		throw new Error(`Unknown campaignId: ${campaignId}`)
	}

	const termsData = encodeFunctionData({ abi: ESCROW_TERMS_ABI, functionName: 'terms', args: [] })
	const termsReply = evmClient
		.callContract(donRuntimeOf(runtime), {
			call: encodeCallMsg({ from: '0x0000000000000000000000000000000000000000', to: escrowAddr as `0x${string}`, data: termsData }),
		})
		.result()
	// viem quirk: top-level outputs decode as a plain array, but a NESTED named
	// tuple (rules) decodes as a named object — so normalize the shape instead
	// of assuming one (a wrong assumption throws "value is not iterable").
	type TermsTuple = readonly [bigint, bigint, bigint, string, bigint, unknown, bigint, string]
	const terms = decodeCall<TermsTuple>(ESCROW_TERMS_ABI, 'terms', termsReply.data)
	const [rateBps, tStart, tEnd, , , rawRules] = terms
	type RulesShape = {
		minSpendEnabled: boolean
		minSpend: bigint
		capEnabled: boolean
		cap: bigint
		dayOfWeekEnabled: boolean
		daysOfWeek: number
		flatEnabled: boolean
		flatValue: bigint
		redeemable: boolean
		perTxCapEnabled: boolean
		perTxCap: bigint
		capWindow: number
		capWindowCount: number
		capWindowTime: number
		capWindowDow: number
	}
	const rules: RulesShape = Array.isArray(rawRules)
		? {
				minSpendEnabled: rawRules[0] as boolean,
				minSpend: rawRules[1] as bigint,
				capEnabled: rawRules[2] as boolean,
				cap: rawRules[3] as bigint,
				dayOfWeekEnabled: rawRules[4] as boolean,
				daysOfWeek: rawRules[5] as number,
				flatEnabled: rawRules[6] as boolean,
				flatValue: rawRules[7] as bigint,
				redeemable: rawRules[8] as boolean,
				perTxCapEnabled: rawRules[9] as boolean,
				perTxCap: rawRules[10] as bigint,
				capWindow: rawRules[11] as number,
				capWindowCount: rawRules[12] as number,
				capWindowTime: rawRules[13] as number,
				capWindowDow: rawRules[14] as number,
			}
		: (rawRules as RulesShape)
	const { minSpendEnabled: minSpendOn, minSpend: minSpendWei, capEnabled: capOn, cap: capWei, dayOfWeekEnabled: dowOn, daysOfWeek: dowMask } = rules

	// 18-decimal USD/reward values → plain numbers for evaluation.
	const usd = (wei: bigint) => Number(wei) / 1e18
	return {
		escrow: escrowAddr,
		rewardType: rules.redeemable ? 'cashback' : 'discount',
		mechanic: rules.flatEnabled ? 'flat' : 'percent',
		flatValue: rules.flatEnabled ? usd(rules.flatValue) : 0,
		rateBps: Number(rateBps),
		start: Number(tStart),
		end: Number(tEnd),
		minSpend: minSpendOn ? usd(minSpendWei) : 0,
		cap: capOn ? usd(capWei) : 0,
		minSpendEnabled: minSpendOn,
		capEnabled: capOn,
		dayOfWeekEnabled: dowOn,
		daysOfWeek: dowMask,
		perTxCapEnabled: rules.perTxCapEnabled,
		perTxCap: rules.perTxCapEnabled ? usd(rules.perTxCap) : 0,
		capWindow: rules.capWindow,
		capWindowCount: rules.capWindowCount,
		capWindowTime: rules.capWindowTime,
		capWindowDow: rules.capWindowDow,
	}
}

// ─── Nullifier (master-salt derivation, enclave-only) ───────────
// campaignSecret = HMAC-SHA256(master, campaignId); nullifier = keccak256(campaignSecret || userAnchor || timestamp).
// The payload timestamp (POS purchase time) is the per-receipt freshness
// element: the same wallet can claim once per purchase, while re-submitting
// the SAME purchase (same timestamp) derives the same nullifier and is
// rejected by the escrow's usedNullifiers check. One Vault secret covers
// every campaign; the secret never leaves the enclave.
// Uses @noble/hashes (pure JS) — node:crypto is not available in CRE WASM workflows.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

function deriveNullifier(master: string, campaignId: number, userAnchor: string, timestamp: number): `0x${string}` {
	const campaignSecret = hmac(sha256, toBytes(master), toBytes(String(campaignId)))
	const digest = keccak256(concatHex([toHex(campaignSecret), toHex(userAnchor as `0x${string}`), toHex(toBytes(String(timestamp)))]))
	return digest
}
export { deriveNullifier }

// ─── HTTP Trigger Handler (runs inside the enclave) ────────────
export const onHTTPTrigger = (runtime: TeeRuntime<Config>, payload: HTTPPayload): string => {
	const config = runtime.config

	if (!payload.input || payload.input.length === 0) {
		throw new Error('HTTP trigger payload is required')
	}

	// Load the master nullifier secret inside the enclave (Vault DON) — never log it.
	const master = runtime.getSecret({ id: 'CAMPAIGN_NULLIFIER_MASTER' }).result().value

	// Parse the request body (decode the bytes input).
	const request = requestSchema.parse(JSON.parse(Buffer.from(payload.input).toString('utf8')))
	// viem enforces EIP-55 checksums downstream (encodeAbiParameters parses the
	// recipient address and rejects non-checksummed input — "Address must match
	// its checksum counterpart", Count: 10 = every DON node). Callers may send
	// any casing, so normalize once here. Note: the nullifier is derived from
	// the address BYTES (toHex is case-insensitive), so normalization never
	// changes an already-recorded nullifier.
	const userAnchor = getAddress(request.userAnchor)
	runtime.log(
		`payload: campaign=${request.campaignId} user=${userAnchor} merchant=${request.merchantId}` +
			` amount=${request.amountSpent} ts=${request.timestamp} earnedInWindow=${request.earnedInWindow}`,
	)

	// Read this campaign's terms ON-CHAIN from the factory (workflow master).
	const evmClient = getEvmClient(config.chainName)
	const campaign = readCampaignOnChain(donRuntimeOf(runtime), evmClient, request.campaignId)
	runtime.log(`on-chain terms: escrow=${campaign.escrow} rateBps=${campaign.rateBps} window=[${campaign.start},${campaign.end}] minSpend=${campaign.minSpend} cap=${campaign.cap}`)

	// Evaluate eligibility inside the enclave.
	const verdict = evaluate(request, campaign)
	runtime.log(`eligibility: ${verdict.reason} eligible=${verdict.eligible} points=${verdict.points}`)

	// Nullifier derived from the Vault master secret (enclave-only). Timestamp
	// = per-purchase freshness element (same wallet + same purchase ts =
	// same nullifier → replay rejected; different purchase → new claim).
	const nullifier = deriveNullifier(master, request.campaignId, request.userAnchor, request.timestamp)

	if (!verdict.eligible) {
		runtime.log(`ineligible (${verdict.reason}) — no on-chain write`)
		return `REJECT points=0 reason=${verdict.reason}`
	}

	// The report payload is ONLY the ABI-encoded report body — the CRE Forwarder
	// wraps it with its own metadata (workflowId(32) || workflowName(10) ||
	// workflowOwner(20), abi.encodePacked) and calls escrow.onReport(metadata, report).
	// Verified against the ReceiverTemplate ("encoded using abi.encodePacked by the
	// Forwarder") and the ai-audit-firewall reference (payload = encodeAbiParameters
	// of the fields, no onReport calldata wrapping). Wrapping onReport(...) calldata
	// here makes the escrow see a 356-byte "report" that fails its length check.
	// report = abi.encode(nullifier, recipient, amountSpentWei, eligible, pointsWei).
	const reportPayload = encodeAbiParameters(
		parseAbiParameters('bytes32 nullifier, address recipient, uint256 amountSpentWei, bool eligible, uint256 pointsWei'),
		[nullifier, userAnchor, pointsToWei(request.amountSpent), true, pointsToWei(verdict.points)],
	)

	// Cross back to the DON for consensus (DON signs the report), then write it.
	const donRuntime = runtime.usingTheDons()
	const reportResponse = donRuntime
		.report({
			encodedPayload: hexToBase64(reportPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// Write the DON-signed report via the EVM capability — routed through the
	// DON runtime (outside the TEE), forwarder → escrow.onReport.
	const writeResult = evmClient
		.writeReport(donRuntime, {
			receiver: campaign.escrow as `0x${string}`,
			report: reportResponse,
		})
		.result()

	runtime.log(`report written to escrow ${campaign.escrow} (txStatus=${writeResult.txStatus})`)
	if (writeResult.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`on-chain write failed: ${writeResult.errorMessage || writeResult.txStatus}`)
	}

	return `APPROVE points=${verdict.points} reason=${verdict.reason}`
}

// ─── Workflow identity (report metadata) ───────────────────────
// The CRE Forwarder itself builds the report metadata:
//   metadata = abi.encodePacked(workflowId(32) || workflowName(10) || workflowOwner(20))
// using the registry-issued workflow ID and owner — nothing to pin here. The
// escrow's onReport validates metadata.workflowOwner === terms.workflowOwner
// (the forwarder-supplied owner is the EOA that deployed this workflow).

// ─── Workflow Init (HTTP trigger) ──────────────────────────────
// Trigger auth: every incoming HTTP request must carry an ECDSA signature from
// an authorized key (the platform relay). Merchants never touch keys — they
// authenticate to the platform backend with API keys; the backend signs the
// workflow request with the deployer key (demo; see README security notes).
export function initWorkflow(config: Config) {
	const httpTrigger = new cre.capabilities.HTTPCapability()

	return [
		cre.handlerInTee(
			httpTrigger.trigger({
				authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: AUTHORIZED_TRIGGER_KEYS[0] }],
			}),
			onHTTPTrigger,
			[{ tee: 'nitro', regions: ['us-west-2'] }],
		),
	]
}
