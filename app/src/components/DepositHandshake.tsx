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
  // Deposits already recorded server-side (wallet per side) — refreshed from
  // the campaign record so a page reload (or a second browser) sees who has
  // deposited; never trust local state alone for the "already deposited" UI.
  const [deposited, setDeposited] = useState<{ A?: string; B?: string }>({})
  const [busy, setBusy] = useState<'A' | 'B' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // The panel's wallet: prefer the Privy embedded wallet; else an external the
  // user explicitly linked at login (user.wallet). NEVER a silently-connected
  // injected wallet — MetaMask re-exposes accounts to a previously-approved
  // origin on every load even after Privy's storage is cleared, so wallets[0]
  // can be a phantom connection that pins the wrong side.
  const privyWallet = wallets.find((w) => w.walletClientType === 'privy')
  const linkedExternal = authenticated && user?.wallet?.address
    ? wallets.find((w) => w.address?.toLowerCase() === String(user.wallet!.address).toLowerCase())
    : undefined
  const embedded = privyWallet ?? linkedExternal
  const walletAddress: string | null = authenticated
    ? (embedded?.address ?? (user?.wallet?.address as string | undefined) ?? null)
    : null

  // Which side does THIS wallet represent? The side the user *chose* (pinned
  // by clicking A's or B's connect/deposit button) wins; without a pin, an
  // unclaimed wallet takes the first open side. Deposited wallets are always
  // pinned to their side regardless of local state.
  const [pinned, setPinned] = useState<'A' | 'B' | null>(null)
  const side: 'A' | 'B' | null = walletAddress
    ? deposited.A?.toLowerCase() === walletAddress.toLowerCase() ? 'A'
      : deposited.B?.toLowerCase() === walletAddress.toLowerCase() ? 'B'
        : pinned ?? (!deposited.A ? 'A' : !deposited.B ? 'B' : null)
    : null

  const initiate = async (): Promise<HandshakeState> => {
    const res = await fetch(`${API}/api/campaigns/${campaignId}/deposits/initiate`, { method: 'POST' })
    const data = await res.json() as HandshakeState & { deposits?: { A?: { wallet: string }; B?: { wallet: string } }; error?: string }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    const s: HandshakeState = { shares: data.shares, platformWallet: data.platformWallet }
    setState(s)
    // The initiate response is the full campaign row: harvest any deposits
    // already recorded (e.g. this page was reloaded after A paid).
    if (data.deposits) {
      setDeposited({
        ...(data.deposits.A ? { A: data.deposits.A.wallet } : {}),
        ...(data.deposits.B ? { B: data.deposits.B.wallet } : {}),
      })
    }
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
      if (!res.ok) {
        // The backend reads its RPC immediately; a just-broadcast tx may not be
        // indexed yet ("not found or failed"). Wait, then retry — two rounds
        // (~10s total) before surfacing the error to the user. Only retry on
        // the not-found class of error; real rejections (wrong amount, wrong
        // wallet) surface immediately.
        const retryable = /not found|failed on-chain|does not carry/i.test(data.error ?? '')
        if (!retryable) throw new Error(data.error ?? `HTTP ${res.status}`)
        let lastErr = data.error ?? `HTTP ${res.status}`
        for (const delayMs of [5000, 5000]) {
          setDone(`Deposit ${side} sent (${txHash.slice(0, 10)}…) — waiting for it to index…`)
          await new Promise((r) => setTimeout(r, delayMs))
          const retry = await fetch(`${API}/api/campaigns/${campaignId}/deposits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ company: side, wallet: walletAddress, txHash }),
          })
          const rdata = await retry.json() as { error?: string; onchainTxHash?: string }
          if (retry.ok) {
            if (rdata.onchainTxHash) {
              setDone(`Both deposits confirmed — campaign launched on-chain (createCampaign tx ${rdata.onchainTxHash.slice(0, 10)}…).`)
            } else {
              setDone(`Deposit ${side} recorded. Awaiting the other company.`)
            }
            setDeposited((d) => ({ ...d, [side]: walletAddress }))
            onChanged()
            return
          }
          lastErr = rdata.error ?? `HTTP ${retry.status}`
          // A specific rejection (not "not found") — stop waiting, surface it.
          if (!/not found|failed on-chain|does not carry/i.test(lastErr)) throw new Error(lastErr)
        }
        throw new Error(`${lastErr} — if this was recent, give it a moment and refresh; the backend will accept it on the next attempt.`)
      }
      if (data.onchainTxHash) {
        setDone(`Both deposits confirmed — campaign launched on-chain (createCampaign tx ${data.onchainTxHash.slice(0, 10)}…).`)
      } else {
        setDone(`Deposit ${side} recorded. Awaiting the other company.`)
      }
      // Pin this wallet's claim in local state too (the initiate refresh will
      // confirm it from the DB on next load).
      setDeposited((d) => ({ ...d, [side]: walletAddress }))
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
        <strong> Sides are fixed by role, not by the order brands were entered:</strong> (A) is always the POS-side
        company, (B) is always the Reward/redeem-side company — whichever position each brand had in the wizard.
        The Reward company's deposit wallet is the one that signs redeems after launch.
      </div>

      <div className="insight-row">
        <span className="insight-label">{companyAName} (A) — POS side</span>
        <span className="insight-value">
          {deposited.A ? `deposited ${short(deposited.A)}` : `${shareA} ETH — deposit A`}
          {deposited.A ? null : (
            <button
              className="btn btn-primary"
              style={{ marginLeft: 12 }}
              disabled={busy !== null || (side !== null && side !== 'A')}
              onClick={() => {
                if (!ready) return
                setPinned('A')
                if (!authenticated) { login(); return }
                if (side === null) { setError('Both sides are already claimed by other wallets'); return }
                void deposit('A')
              }}
            >
              {busy === 'A' ? 'Depositing…' : authenticated ? (side === 'A' ? `Deposit as ${companyAName}` : 'Wallet claimed other side') : 'Connect wallet (A)'}
            </button>
          )}
        </span>
      </div>
      <div className="insight-row">
        <span className="insight-label">{companyBName} (B) — Reward/redeem side</span>
        <span className="insight-value">
          {deposited.B ? `deposited ${short(deposited.B)}` : `${shareB} ETH — deposit B`}
          {deposited.B ? null : (
            <button
              className="btn btn-primary"
              style={{ marginLeft: 12 }}
              disabled={busy !== null || (side !== null && side !== 'B')}
              onClick={() => {
                if (!ready) return
                setPinned('B')
                if (!authenticated) { login(); return }
                if (side === null) { setError('Both sides are already claimed by other wallets'); return }
                void deposit('B')
              }}
            >
              {busy === 'B' ? 'Depositing…' : authenticated ? (side === 'B' ? `Deposit as ${companyBName}` : 'Wallet claimed other side') : 'Connect wallet (B)'}
            </button>
          )}
        </span>
      </div>
      {authenticated && walletAddress && (
        <p className="field-hint">
          Connected: <button
            className="linklike mono"
            title="Click to copy the full address"
            onClick={() => {
              void navigator.clipboard.writeText(walletAddress)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'copied!' : short(walletAddress)}
          </button>{' '}
          (Privy embedded wallet){' '}
          <button className="linklike" onClick={() => { void logout(); setDeposited({}); setError(null); setDone(null) }}>disconnect / switch identity</button>
          <span style={{ opacity: 0.7 }}> — clears this browser's Privy session so a different company email can log in</span>
        </p>
      )}
      {error && <p className="launch-error" role="alert">⚠️ {error}</p>}
      <p className="field-hint" style={{ opacity: 0.7 }}>
        DEBUG:{' '}
        <button
          className="linklike"
          title="Nukes every Privy storage key in this browser (localStorage, sessionStorage, cookies) and reloads — use when the Privy session is stuck and logout() didn't clear it"
          onClick={() => {
            for (const store of [window.localStorage, window.sessionStorage]) {
              for (const key of Object.keys(store)) {
                if (/privy|privy-io/i.test(key)) store.removeItem(key)
              }
            }
            for (const cookie of document.cookie.split(';')) {
              const name = cookie.split('=')[0]?.trim()
              if (name && /privy/i.test(name)) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
            }
            window.location.reload()
          }}
        >
          force-clear Privy session
        </button>{' '}
        — removes all Privy tokens/storage for this browser and reloads the page (debug only; a fresh login will provision a new embedded wallet).
      </p>
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
