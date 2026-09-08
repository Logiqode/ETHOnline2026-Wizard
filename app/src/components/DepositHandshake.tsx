// ─── Deposit handshake panel (gen-6, demo scope) ─────────────────────────────
// Two Privy-connected wallets deposit their share of the operating deposit;
// the on-chain createCampaign fires when BOTH land. DEMO honesty: there is no
// backend authentication — "connecting" a wallet here only tells the backend
// which address claims each side; the deposit tx itself is verified on-chain
// (exact amount, exact recipient). See backend routes/campaigns.ts.
import { useEffect, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'

const API = 'http://localhost:4000'

interface HandshakeState {
  shares: { A: string; B: string }
  platformWallet: string
}

const WEI = 1e18
const eth = (wei: string): string => (Number(wei) / WEI).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')

interface Props {
  campaignId: string
  feeSplitBps: number
  companyAName: string
  companyBName: string
  termsStart: unknown
  onChanged: () => void
}

export default function DepositHandshake({ campaignId, feeSplitBps, companyAName, companyBName, termsStart, onChanged }: Props) {
  const { ready, authenticated, user, login, logout } = usePrivy()
  const { wallets } = useWallets()
  const [state, setState] = useState<HandshakeState | null>(null)
  const [busy, setBusy] = useState<'A' | 'B' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // The connected embedded wallet (Privy-created). Prefer the embedded wallet;
  // fall back to the first linked wallet.
  const embedded = wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0]
  const walletAddress: string | null = embedded?.address ?? (user?.wallet?.address as string | undefined) ?? null

  // Determine which side this wallet represents. The campaign row's
  // company_a/company_b hold the wallet captured at record time; before any
  // deposit, the first connect claims A, the second claims B.
  const [claimA, setClaimA] = useState<string | null>(null)
  const [claimB, setClaimB] = useState<string | null>(null)

  const side: 'A' | 'B' | null = walletAddress
    ? claimA?.toLowerCase() === walletAddress.toLowerCase() ? 'A'
      : claimB?.toLowerCase() === walletAddress.toLowerCase() ? 'B'
        : !claimA ? 'A' : !claimB ? 'B' : null
    : null

  const initiate = async (): Promise<HandshakeState> => {
    const res = await fetch(`${API}/api/campaigns/${campaignId}/deposits/initiate`, { method: 'POST' })
    const data = await res.json() as HandshakeState & { error?: string }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    const s: HandshakeState = { shares: data.shares, platformWallet: data.platformWallet }
    setState(s)
    return s
  }

  // Auto-initiate on mount if still a draft (the wizard launched us here).
  useEffect(() => {
    initiate().catch(() => { /* surfaced via error on explicit actions */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId])

  const deposit = async (side: 'A' | 'B') => {
    if (!walletAddress) return
    setBusy(side)
    setError(null)
    try {
      const s = state ?? await initiate()
      const shareWei = BigInt(s.shares[side])
      const wallet = embedded
      if (!wallet) throw new Error('No Privy wallet connected')
      await wallet.switchChain(84532) // Base Sepolia
      // Send via the wallet's EIP-1193 provider (Privy embedded wallets expose
      // a standard provider; no viem account import needed).
      const provider = await wallet.getEthereumProvider()
      const txHash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: walletAddress,
          to: s.platformWallet,
          value: `0x${shareWei.toString(16)}`,
        }],
      })) as string

      const res = await fetch(`${API}/api/campaigns/${campaignId}/deposits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: side, wallet: walletAddress, txHash }),
      })
      const data = await res.json() as { error?: string; onchainTxHash?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (data.onchainTxHash) {
        setDone(`Both deposits confirmed — campaign launched on-chain (createCampaign tx ${data.onchainTxHash.slice(0, 10)}…).`)
      } else {
        setDone(`Deposit ${side} recorded. Awaiting the other company.`)
      }
      // Record the claim so the panel shows who deposited which side.
      if (side === 'A') setClaimA(walletAddress); else setClaimB(walletAddress)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deposit failed')
    } finally {
      setBusy(null)
    }
  }

  const shareA = state ? eth(state.shares.A) : eth((BigInt(10_000_000_000_000_000) * BigInt(feeSplitBps) / 10_000n).toString())
  const shareB = state ? eth(state.shares.B) : eth((BigInt(10_000_000_000_000_000) * BigInt(10_000 - feeSplitBps) / 10_000n).toString())

  if (done) {
    return (
      <div className="card">
        <div className="card-title">Deposit handshake</div>
        <p className="field-hint">{done}</p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card-title">Deposit handshake — pending</div>
      <div className="card-desc">
        Each company connects a Privy wallet and deposits its share of the {((feeSplitBps / 100)).toFixed(0)}/{(100 - feeSplitBps / 100).toFixed(0)} operating split.
        The campaign deploys on-chain once both deposits confirm
        {termsStart ? ` — deadline is the campaign start (${String(termsStart).slice(0, 10)}), or now + 4h if that passed` : ' — deadline is now + 4h'}.
      </div>

      <div className="insight-row">
        <span className="insight-label">{companyAName} (A)</span>
        <span className="insight-value">
          {claimA ? `deposited ${short(claimA)}` : `${shareA} ETH — deposit A`}
          <button
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
            disabled={busy !== null || (side !== null && side !== 'A')}
            onClick={() => {
              if (!ready) return
              if (!authenticated) { login(); return }
              if (side === null) { setError('Both sides are already claimed by other wallets'); return }
              void deposit('A')
            }}
          >
            {busy === 'A' ? 'Depositing…' : authenticated ? (side === 'A' ? `Deposit as ${companyAName}` : 'Wallet claimed other side') : 'Connect wallet (A)'}
          </button>
        </span>
      </div>
      <div className="insight-row">
        <span className="insight-label">{companyBName} (B)</span>
        <span className="insight-value">
          {claimB ? `deposited ${short(claimB)}` : `${shareB} ETH — deposit B`}
          <button
            className="btn btn-primary"
            style={{ marginLeft: 12 }}
            disabled={busy !== null || (side !== null && side !== 'B')}
            onClick={() => {
              if (!ready) return
              if (!authenticated) { login(); return }
              if (side === null) { setError('Both sides are already claimed by other wallets'); return }
              void deposit('B')
            }}
          >
            {busy === 'B' ? 'Depositing…' : authenticated ? (side === 'B' ? `Deposit as ${companyBName}` : 'Wallet claimed other side') : 'Connect wallet (B)'}
          </button>
        </span>
      </div>
      {authenticated && walletAddress && (
        <p className="field-hint">
          Connected: <span className="mono">{short(walletAddress)}</span> (Privy embedded wallet){' '}
          <button className="linklike" onClick={() => void logout()}>disconnect</button>
        </p>
      )}
      {error && <p className="launch-error" role="alert">⚠️ {error}</p>}
      <p className="field-hint" style={{ opacity: 0.7 }}>
        DEMO: deposits are real Base Sepolia transfers verified on-chain by the backend; wallet↔company attribution is
        claimed client-side (no auth in the demo backend). Production binds wallets to authenticated company identities.
      </p>
    </div>
  )
}

// short() local (same shape as the detail page's helper)
function short(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-6)}`
}
