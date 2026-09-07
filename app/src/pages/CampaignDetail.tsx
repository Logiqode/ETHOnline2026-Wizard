import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

const API = 'http://localhost:4000'

interface Campaign {
  id: string
  name: string
  status: 'draft' | 'launched'
  reward_type: 'monetary' | 'digital' | 'physical'
  fee_split_bps: number
  company_a_name: string
  company_b_name: string
  salt: string | null
  escrow_address: string | null
  reward_address: string | null
  operatingDepositWei: string
  mechanics: Record<string, unknown>
  terms: Record<string, unknown>
}

interface EscrowState {
  escrow: string
  reward: string
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
  platformFeeBps: number
  platformFeesAccrued: string
  participants: Participant[]
  participantsPartial: boolean
}

interface Participant {
  address: string
  totalBalance: string // lifetime earned (raw 18-dec)
  unspentBalance: string // currently spendable (raw 18-dec)
  originalBlock: number
  claims: number
  amountSpentUsd: number
  lastClaimBlock: number
}

interface TestPayloadInfo {
  payload: {
    campaignId: number
    userAnchor: string
    merchantId: string
    amountSpent: number
    timestamp: number
    earnedInWindow: number
    items?: string[]
  }
  description: string
}

interface TriggerResult {
  ok?: boolean
  signer?: string
  executionId?: string | null
  note?: string
  error?: string
  gatewayResponse?: unknown
}

const WEI = 1e18
const toUnits = (raw: string): string => (Number(raw) / WEI).toFixed(2)
// ETH amounts this small need significant digits, not fixed decimals — an
// 8.04e-7 ETH claim shows as "0.0000" under toFixed(4). Render as 0.0₆804:
// the subscript is the EXACT count of zeros between the decimal point and
// the first significant digit (0.0₆804 = 0.000000804), mantissa ≤ 3 digits.
const sub = (n: number): string => String(n).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)] ?? d).join('')
const ethSig = (v: number): string => {
  if (v === 0) return '0'
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a >= 0.001) return sign + a.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  const exp = Math.floor(Math.log10(a)) // 8.04e-7 → -7
  let zeros = -exp - 1 // zeros between '.' and first digit
  let mantissa = Math.round(a * 10 ** (-exp) * 100) // 8.04e-7 → 804
  if (mantissa >= 1000) { // 9.999e-7 rounding up → 1.000e-6
    mantissa = Math.round(mantissa / 10)
    zeros -= 1
  }
  return `${sign}0.0${sub(zeros)}${mantissa}`
}
const short = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`
const explorer = (a: string): string => `https://sepolia.basescan.org/address/${a}`

// ─── Deposit log (demo model) ───────────────────────────────────────────────
// The OperatingDeposit is a *recorded* amount (0.01 ETH equivalent, settled
// off-chain) — see README "Gas & the operating deposit".

function formatDateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 10px 6px 0', color: 'var(--text-secondary)', fontWeight: 500, borderBottom: '1px solid #e3e8ee', whiteSpace: 'nowrap' }
const tdStyle: React.CSSProperties = { padding: '8px 10px 8px 0', borderBottom: '1px solid #eef1f4' }

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [onchain, setOnchain] = useState<EscrowState | null>(null)
  const [onchainError, setOnchainError] = useState<string | null>(null)
  const [testPayload, setTestPayload] = useState<TestPayloadInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Manual payload form
  const [manual, setManual] = useState({ userAnchor: '0xAAaA000000000000000000000000000000000001', merchantId: 'burgera', amountSpent: '30' })
  const [sending, setSending] = useState<'none' | 'test' | 'manual'>('none')
  const [result, setResult] = useState<TriggerResult | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}/api/campaigns/${id}`)
      if (!res.ok) throw new Error(res.status === 404 ? 'Campaign not found' : `HTTP ${res.status}`)
      const data = (await res.json()) as Campaign
      setCampaign(data)

      if (data.status === 'launched' && data.escrow_address) {
        const [ocRes, tpRes] = await Promise.all([
          fetch(`${API}/api/campaigns/${id}/onchain`),
          fetch(`${API}/api/campaigns/${id}/test-payload`),
        ])
        if (ocRes.ok) setOnchain(await ocRes.json())
        else {
          const body = (await ocRes.json()) as { error?: string }
          setOnchainError(body.error ?? 'On-chain read failed')
        }
        if (tpRes.ok) setTestPayload(await tpRes.json())
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load campaign')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const send = async (kind: 'test' | 'manual') => {
    if (!id || !campaign) return
    setSending(kind)
    setResult(null)
    try {
      const body =
        kind === 'test' && testPayload
          ? { ...testPayload.payload }
          : {
              campaignId: Number(testPayload?.payload.campaignId ?? id),
              userAnchor: manual.userAnchor,
              merchantId: manual.merchantId,
              amountSpent: Number(manual.amountSpent),
              timestamp: Math.floor(Date.now() / 1000),
              earnedInWindow: 0,
            }
      const res = await fetch(`${API}/api/campaigns/${id}/payload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as TriggerResult
      setResult(data)
      // The claim may have landed — refresh the on-chain panel after a beat.
      if (data.ok) setTimeout(load, 15000)
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : 'Request failed' })
    } finally {
      setSending('none')
    }
  }

  if (loading) return <div className="page"><p>Loading campaign…</p></div>
  if (error || !campaign) {
    return (
      <div className="page">
        <p className="launch-error" role="alert">⚠️ {error ?? 'Campaign not found'}</p>
        <p><Link to="/campaigns">← Back to campaigns</Link></p>
      </div>
    )
  }

  const mechanics = campaign.mechanics as { rewardValues?: Record<string, string | number | boolean> } | undefined
  const rv = mechanics?.rewardValues ?? {}
  const mechanicLabel =
    rv.cashbackType === 'flat'
      ? `Flat $${rv.cashbackFlat} cashback per purchase`
      : rv.cashbackType === 'discount'
        ? `$${rv.cashbackFlat} discount (proof-of-savings)`
        : `${rv.cashbackRate}% cashback in ${rv.cashbackToken ?? 'points'}`

  // Gas meter (demo model): gas is estimated from the REAL per-claim receipts
  // on this escrow (~268k gas, ~0.006 gwei effective on Base Sepolia → ≈
  // 0.0000016 ETH per claim). Rounded to 4 decimals the total reads 0.0000 —
  // Base Sepolia gas is genuinely that cheap. Real per-campaign accounting is
  // the ERC-4337 paymaster roadmap item.
  const CLAIM_GAS = 268_000
  const GWEI = 0.006
  const DEPOSIT_ETH = Number(campaign.operatingDepositWei) / WEI
  const claimsFunded = Math.floor((DEPOSIT_ETH * 1e18) / (CLAIM_GAS * GWEI * 1e9))
  const claimCount = onchain?.participants.reduce((n, p) => n + p.claims, 0) ?? 0
  const gasUsedEth = claimCount * CLAIM_GAS * GWEI * 1e9 / 1e18
  const totalGasUsed = gasUsedEth // total campaign spend (balance drawdown = usage)

  // Operating-fee balances per company (mirror of the factory's _recordDeposit:
  // feeSplitBps% of the deposit is what each company has PAID into the platform
  // reserve — their balance), drawn down by that company's share of usage.
  // Balances are allowed to go NEGATIVE: if one company's share runs dry, the
  // other's deposit keeps the campaign running, and the deficit is a debt the
  // drained company owes back at withdrawal/campaign end (settlement).
  const splitA = campaign.fee_split_bps
  const balanceA = (DEPOSIT_ETH * splitA) / 10_000
  const balanceB = DEPOSIT_ETH - balanceA
  const usageA = gasUsedEth * (splitA / 10_000)
  const usageB = gasUsedEth * (1 - splitA / 10_000)
  const netA = balanceA - usageA // signed; negative = owes the platform
  const netB = balanceB - usageB
  // Who is covering whom: the positive-side company fronts the negative-side
  // company's overage (the platform is made whole either way).
  const coveredByA = netA >= 0 && netB < 0 ? -netB : 0 // A covered part of B's share
  const coveredByB = netB >= 0 && netA < 0 ? -netA : 0 // B covered part of A's share
  // Platform fee accrual in reward units (per-tx platformFeeBps uplift; the
  // demo escrows were seeded with platformFeeBps=0, so this is usually 0).

  return (
    <div className="page">
      <div className="page-header">
        <p style={{ marginBottom: 4 }}>
          <Link to="/campaigns" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>← Campaigns</Link>
        </p>
        <h1 className="page-title">{campaign.name}</h1>
        <p className="page-subtitle">
          <span className={`status status-${campaign.status}`}>{campaign.status}</span>
          {'  '}Campaign #{campaign.id} — {campaign.company_a_name} (POS) × {campaign.company_b_name} (Redeem)
        </p>
      </div>

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-title">Campaign summary</div>
        <div className="card-desc">{mechanicLabel} · fee split {(campaign.fee_split_bps / 100).toFixed(0)}% to {campaign.company_a_name}</div>
        {onchain ? (
          <div>
            <div className="insight-row">
              <span className="insight-label">Mechanic (on-chain)</span>
              <span className="insight-value">
                {onchain.flatEnabled
                  ? `Flat $${onchain.flatValueUsd.toFixed(2)}${onchain.redeemable ? ' cashback' : ' discount (proof-of-savings)'}`
                  : `${(onchain.rateBps / 100).toFixed(1)}% cashback`}
              </span>
            </div>
            <div className="insight-row">
              <span className="insight-label">Min spend</span>
              <span className="insight-value">{onchain.minSpendEnabled ? `$${onchain.minSpendUsd.toFixed(2)}` : 'none'}</span>
            </div>
            <div className="insight-row">
              <span className="insight-label">Per-user cap</span>
              <span className="insight-value">{onchain.capEnabled ? `$${onchain.capUsd.toFixed(2)}` : 'none'}</span>
            </div>
            <div className="insight-row">
              <span className="insight-label">Window</span>
              <span className="insight-value">{formatDateTime(onchain.start)} → {formatDateTime(onchain.end)}</span>
            </div>
            <div className="insight-row">
              <span className="insight-label">Escrow</span>
              <span className="insight-value mono"><a href={explorer(onchain.escrow)} target="_blank" rel="noreferrer">{short(onchain.escrow)}</a></span>
            </div>
            <div className="insight-row">
              <span className="insight-label">Reward (ERC-1155)</span>
              <span className="insight-value mono">
                <a href={explorer(onchain.reward)} target="_blank" rel="noreferrer">{short(onchain.reward)}</a>
                {'  '}tokenId {onchain.rewardTokenId}
              </span>
            </div>
          </div>
        ) : onchainError ? (
          <p className="field-hint">On-chain terms unavailable: {onchainError}</p>
        ) : (
          <p className="field-hint">No on-chain escrow for this campaign.</p>
        )}
      </div>

      {/* ── Participants (live escrow ledger) ───────────────────────────── */}
      {onchain && (
        <div className="card">
          <div className="card-title">Participants</div>
          <div className="card-desc">
            Wallets that earned from this campaign — live from the escrow ledger (first-seen block{' '}
            {Math.min(...onchain.participants.map((p) => p.originalBlock))}).
          </div>
          {onchain.participants.length === 0 ? (
            <p className="field-hint">No claims yet — send a payload below to mint the first reward.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {['Wallet', onchain.redeemable ? 'Lifetime earned' : 'Total saved', onchain.redeemable ? 'Spendable' : null, 'Cap used', 'Claims', 'Spend volume', 'First block']
                      .filter(Boolean)
                      .map((h) => (
                        <th key={h as string} style={thStyle}>{h}</th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {onchain.participants.map((p) => {
                    const total = Number(p.totalBalance) / WEI
                    const unspent = Number(p.unspentBalance) / WEI
                    const capUsed = onchain.capEnabled ? `${Math.min(100, (total / onchain.capUsd) * 100).toFixed(0)}% of $${onchain.capUsd}` : 'no cap'
                    return (
                      <tr key={p.address}>
                        <td style={tdStyle}><span className="mono"><a href={explorer(p.address)} target="_blank" rel="noreferrer">{short(p.address)}</a></span></td>
                        <td style={tdStyle}><span className="mono">{total.toFixed(2)} {rv.cashbackToken ?? 'points'}</span></td>
                        {onchain.redeemable && <td style={tdStyle}><span className="mono">{unspent.toFixed(2)} {rv.cashbackToken ?? 'points'}</span></td>}
                        <td style={tdStyle}>{capUsed}</td>
                        <td style={tdStyle}>{p.claims}</td>
                        <td style={tdStyle}>${p.amountSpentUsd.toFixed(2)}</td>
                        <td style={tdStyle}><span className="mono">{p.originalBlock}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {onchain.participantsPartial && (
            <p className="field-hint" style={{ marginTop: 8 }}>
              Scanned the last ~49k blocks (public-RPC range limit) — claims older than that may be missing.
            </p>
          )}
        </div>
      )}

      {/* ── Operating fees (gas + platform + per-company deposit owed) ──── */}
      {onchain && (
        <div className="card">
          <div className="card-title">Operating fees</div>
          <div className="card-desc">
            {claimCount} claim{claimCount === 1 ? '' : 's'} through the workflow — gas from the real per-claim receipts (~268k gas @ ~0.006 gwei on Base Sepolia; per-campaign metering is the paymaster roadmap item).
          </div>
          <div className="insight-row">
            <span className="insight-label">Workflow gas used</span>
            <span className="insight-value mono">{ethSig(gasUsedEth)} ETH ({claimCount} × ~{CLAIM_GAS.toLocaleString()} gas @ {GWEI} gwei)</span>
          </div>
          <div className="insight-row">
            <span className="insight-label">Chainlink CRE fees</span>
            <span className="insight-value mono">$0.00 <span className="field-hint" style={{ display: 'inline' }}>(free tier for the hackathon demo — not tracked)</span></span>
          </div>
          <div className="insight-row">
            <span className="insight-label">Platform fee accrual</span>
            <span className="insight-value mono">
              {onchain.platformFeeBps > 0
                ? `${toUnits(onchain.platformFeesAccrued)} ${rv.cashbackToken ?? 'points'} (${(onchain.platformFeeBps / 100).toFixed(1)}% per claim)`
                : 'none (platformFeeBps = 0 on this escrow)'}
            </span>
          </div>
          <div className="insight-row">
            <span className="insight-label">Operating-fee balance (paid)</span>
            <span className="insight-value mono">{DEPOSIT_ETH.toFixed(3)} ETH ≈ {claimsFunded.toLocaleString()} claims of headroom</span>
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="field-label">Total usage <span className="field-hint" style={{ display: 'inline' }}>(cumulative gas spent by this campaign, split per company against their operating-fee balance — balances may go negative, see settlement note)</span></div>
            <div className="insight-row">
              <span className="insight-label">{campaign.company_a_name} (POS) — {(splitA / 100).toFixed(0)}% split</span>
              <span className="insight-value mono">
                {ethSig(usageA)} / {ethSig(balanceA)} ETH
                <span className="field-hint" style={{ display: 'inline' }}> · {ethSig(netA)} ETH left</span>
              </span>
            </div>
            <div className="insight-row">
              <span className="insight-label">{campaign.company_b_name} (Redeem) — {((10_000 - splitA) / 100).toFixed(0)}% split</span>
              <span className="insight-value mono">
                {ethSig(usageB)} / {ethSig(balanceB)} ETH
                <span className="field-hint" style={{ display: 'inline' }}> · {ethSig(netB)} ETH left</span>
              </span>
            </div>
            <div style={{ marginTop: 10 }}>
              <div style={{ height: 10, background: '#eef1f4', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(100, (totalGasUsed / Math.max(DEPOSIT_ETH, 1e-12)) * 100)}%`,
                  height: '100%',
                  background: '#6366f1',
                  transition: 'width 300ms',
                }} />
              </div>
              <div className="field-hint" style={{ marginTop: 6 }}>
                {ethSig(totalGasUsed)} spent of {DEPOSIT_ETH.toFixed(3)} ETH operating-fee balance ({Math.min(100, (totalGasUsed / Math.max(DEPOSIT_ETH, 1e-12)) * 100).toFixed(4)}% used)
              </div>
            </div>
            {(coveredByA > 0 || coveredByB > 0) && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: '#fff7e6', border: '1px solid #f5d48f', borderRadius: 6, fontSize: 13 }}>
                {coveredByB > 0
                  ? <><strong>{campaign.company_b_name}</strong> covered {ethSig(coveredByB)} ETH of <strong>{campaign.company_a_name}</strong>'s gas (A's share ran dry). Owed by {campaign.company_a_name} at settlement/campaign end.</>
                  : <><strong>{campaign.company_a_name}</strong> covered {ethSig(coveredByA)} ETH of <strong>{campaign.company_b_name}</strong>'s gas (B's share ran dry). Owed by {campaign.company_b_name} at settlement/campaign end.</>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Payloads ────────────────────────────────────────────────────── */}
      {campaign.status === 'launched' && campaign.escrow_address && (
        <div className="card">
          <div className="card-title">Send a purchase to the confidential workflow</div>
          <div className="card-desc">
            The payload is signed by the platform relay and POSTed to the CRE gateway; eligibility runs inside the TEE
            and only the verdict + mint land on-chain. Claims take ~15–30s to settle.
          </div>

          {testPayload && (
            <div style={{ marginTop: 12, padding: 12, border: '1px solid #e3e8ee', borderRadius: 8 }}>
              <div className="field-label">Hardcoded test payload</div>
              <p className="field-hint" style={{ marginTop: 4 }}>{testPayload.description}</p>
              <pre className="mono" style={{ fontSize: 12, background: '#f7f8f8', padding: 10, borderRadius: 6, overflowX: 'auto' }}>
                {JSON.stringify(testPayload.payload, null, 2)}
              </pre>
              <button className="btn btn-primary" onClick={() => send('test')} disabled={sending !== 'none'}>
                {sending === 'test' ? 'Sending…' : 'Send test payload'}
              </button>
            </div>
          )}

          <div style={{ marginTop: 16, padding: 12, border: '1px solid #e3e8ee', borderRadius: 8 }}>
            <div className="field-label">Manual payload</div>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <div className="field">
                <label className="field-label">Customer wallet</label>
                <input className="input mono" value={manual.userAnchor} onChange={(e) => setManual({ ...manual, userAnchor: e.target.value })} />
              </div>
              <div className="field">
                <label className="field-label">Merchant</label>
                <input className="input" value={manual.merchantId} onChange={(e) => setManual({ ...manual, merchantId: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label className="field-label">Amount (USD)</label>
              <input className="input" type="number" min="0" value={manual.amountSpent} onChange={(e) => setManual({ ...manual, amountSpent: e.target.value })} />
            </div>
            <button className="btn btn-primary" onClick={() => send('manual')} disabled={sending !== 'none'}>
              {sending === 'manual' ? 'Sending…' : 'Submit to confidential workflow'}
            </button>
          </div>

          {result && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: result.ok ? '#e3f2e9' : '#fdeceb' }}>
              {result.ok ? (
                <>
                  <div><strong>ACCEPTED</strong> by the gateway{result.executionId ? ` — execution ${result.executionId.slice(0, 18)}…` : ''}</div>
                  <div className="field-hint" style={{ marginTop: 4 }}>{result.note}</div>
                </>
              ) : (
                <div><strong>Failed:</strong> {result.error}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
