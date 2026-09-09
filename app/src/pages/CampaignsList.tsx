import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

interface Campaign {
  id: string
  name: string
  status: 'draft' | 'pending_deposit' | 'launched' | 'cancelled'
  reward_type: 'monetary' | 'digital' | 'physical'
  fee_split_bps: number
  company_a: string
  company_b: string
  company_a_name: string
  company_b_name: string
  salt: string | null
  escrow_address: string | null
  reward_address: string | null
  operatingDepositWei: string
  createdAt: string
  launchedAt: string | null
  depositDeadline: string | null
}

import { API } from '../lib/api'

export default function CampaignsList() {
  const [live, setLive] = useState<Campaign[]>([])
  const [pending, setPending] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        // Idempotent bootstrap: make sure the three factory-seeded demo
        // campaigns exist in the DB before listing. Cheap when already seeded.
        setSeeding(true)
        await fetch(`${API}/api/campaigns/seed`, { method: 'POST' })
        setSeeding(false)

        const res = await fetch(`${API}/api/campaigns`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { live: Campaign[]; pending: Campaign[] }
        if (!cancelled) {
          setLive(data.live)
          setPending(data.pending)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load campaigns')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setSeeding(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="page">
        <p>Loading campaigns{seeding ? ' (syncing seeded campaigns…)' : '…'}</p>
      </div>
    )
  }
  if (error) return <div className="page"><p className="launch-error" role="alert">⚠️ {error}</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Campaigns</h1>
        <p className="page-subtitle">
          Active campaigns are verified against the live Base Sepolia factory — the factory registry is the source of
          truth. Pending campaigns exist only in the local database until both deposit handshake shares land on-chain.
          Click a campaign for its summary, balances, and test payloads.
        </p>
      </div>

      {/* ── Pending handshake (DB-only: no escrow exists yet) ─────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Pending campaigns</div>
        <div className="card-desc">
          Awaiting the deposit handshake (or cancelled after the deadline) — not yet on-chain, listed from the local
          database only.
        </div>
        {pending.length === 0 ? (
          <p className="field-hint">No pending campaigns.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="campaigns-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Fee split (A)</th>
                  <th>Deposit deadline</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>
                      <Link to={`/campaigns/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {c.name}
                      </Link>
                    </td>
                    <td><span className={`status status-${c.status}`}>{c.status}</span></td>
                    <td className="mono">{(c.fee_split_bps / 100).toFixed(0)}%</td>
                    <td className="mono">
                      {c.depositDeadline
                        ? new Date(c.depositDeadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Active on-chain (factory-registry verified) ───────────────────── */}
      <div className="card">
        <div className="card-title">Active campaigns</div>
        <div className="card-desc">Verified live on Base Sepolia against the factory registry.</div>
        {live.length === 0 ? (
          <p className="field-hint">No live campaigns yet — launch one from the <strong>Campaign Wizard</strong>.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="campaigns-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Reward</th>
                  <th>Fee split (A)</th>
                  <th>Salt</th>
                  <th>Escrow</th>
                </tr>
              </thead>
              <tbody>
                {live.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>
                      <Link to={`/campaigns/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {c.name}
                      </Link>
                    </td>
                    <td>{c.reward_type}</td>
                    <td className="mono">{(c.fee_split_bps / 100).toFixed(0)}%</td>
                    <td className="mono salt-cell">{c.salt ? `${c.salt.slice(0, 10)}…` : '—'}</td>
                    <td className="mono">
                      {c.escrow_address ? (
                        <a
                          href={`https://sepolia.basescan.org/address/${c.escrow_address}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'inherit' }}
                        >
                          {c.escrow_address.slice(0, 10)}…
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
