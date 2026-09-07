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
  platformFeesAccrued: string
  demoUser: { totalBalance: string; unspentBalance: string; originalBlock: number }
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
const short = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`
const explorer = (a: string): string => `https://sepolia.basescan.org/address/${a}`

// ─── Deposit log (demo model) ───────────────────────────────────────────────
// The OperatingDeposit is a *recorded* amount (0.01 ETH equivalent, settled
// off-chain) — see README "Gas & the operating deposit". The demo log renders
// it as a single platform-paid entry plus the gas the claims consumed.
interface DepositEntry {
  label: string
  amount: string
  note: string
}

function formatDateTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

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

  // Gas meter (demo model): each claim costs ≈ 190k gas on this escrow; the
  // operating deposit covers an estimated budget of claims. This is presentational —
  // real per-campaign gas accounting is the ERC-4337 paymaster roadmap item.
  const CLAIM_GAS = 190_000
  const DEPOSIT_ETH = Number(campaign.operatingDepositWei) / WEI
  const claimsFunded = Math.floor((DEPOSIT_ETH * 1e18) / (CLAIM_GAS * 0.05e9)) // @ 0.05 gwei
  const claimsUsed = testPayload ? 1 : 0 // placeholder — wired to the ledger count below
  void claimsUsed

  const deposits: DepositEntry[] = [
    {
      label: 'Initial Deposit',
      amount: `$25.00`,
      note: 'Paid by the platform wallet for demo purposes (operating deposit, settled off-chain).',
    },
  ]
  if (onchain && onchain.demoUser.totalBalance !== '0') {
    deposits.push({
      label: 'Claim settlement (demo user)',
      amount: `${toUnits(onchain.demoUser.totalBalance)} ${rv.cashbackToken ?? 'points'}`,
      note: 'DON-verified claim settled on-chain — minted to 0xAAA…0001.',
    })
  }

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

      {/* ── Balances + gas meter ────────────────────────────────────────── */}
      {onchain && (
        <div className="card">
          <div className="card-title">Balances & gas</div>
          <div className="card-desc">
            Demo user 0xAAA…0001 — live from the escrow ledger (block {onchain.demoUser.originalBlock}).
          </div>
          <div className="insight-row">
            <span className="insight-label">Lifetime earned</span>
            <span className="insight-value mono">{toUnits(onchain.demoUser.totalBalance)} {rv.cashbackToken ?? 'points'}</span>
          </div>
          <div className="insight-row">
            <span className="insight-label">{onchain.redeemable ? 'Available (spendable)' : 'Total saved (proof-of-savings)'}</span>
            <span className="insight-value mono">
              {toUnits(onchain.redeemable ? onchain.demoUser.unspentBalance : onchain.demoUser.totalBalance)} {rv.cashbackToken ?? 'points'}
            </span>
          </div>
          <div className="insight-row">
            <span className="insight-label">Platform fees accrued</span>
            <span className="insight-value mono">{toUnits(onchain.platformFeesAccrued)} {rv.cashbackToken ?? 'points'}</span>
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="field-label">Gas meter <span className="field-hint" style={{ display: 'inline' }}>(demo estimate @ 0.05 gwei · ~190k gas/claim)</span></div>
            <div style={{ height: 10, background: '#eef1f4', borderRadius: 5, overflow: 'hidden', marginTop: 6 }}>
              <div style={{ width: `${Math.min(100, (1 / Math.max(claimsFunded, 1)) * 100)}%`, height: '100%', background: '#6366f1' }} />
            </div>
            <div className="field-hint" style={{ marginTop: 6 }}>
              {DEPOSIT_ETH.toFixed(3)} ETH deposit funds ≈ {claimsFunded.toLocaleString()} claims · deposits are custody, not revenue (see README).
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="field-label">Deposit log</div>
            {deposits.map((d, i) => (
              <div key={i} className="insight-row">
                <span className="insight-label">{d.label} — <strong>{d.amount}</strong></span>
                <span className="field-hint" style={{ display: 'inline' }}>{d.note}</span>
              </div>
            ))}
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
