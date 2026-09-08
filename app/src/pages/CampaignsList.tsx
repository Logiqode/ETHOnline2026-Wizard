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

const API = 'http://localhost:4000'

export default function CampaignsList() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
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
        const data = (await res.json()) as Campaign[]
        // Live campaigns (launched with an escrow) plus campaigns awaiting
        // deposits — the handshake is part of the lifecycle, show it.
        const visible = data.filter((c) =>
          (c.status === 'launched' && c.escrow_address) || c.status === 'pending_deposit' || c.status === 'cancelled',
        )
        if (!cancelled) setCampaigns(visible)
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
          Campaigns live on Base Sepolia — the factory-seeded demos plus anything launched from the wizard. Click a
          campaign for its summary, balances, and test payloads.
        </p>
      </div>

      {campaigns.length === 0 ? (
        <div className="card">
          <p className="card-desc">No live campaigns yet — launch one from the <strong>Campaign Wizard</strong>.</p>
        </div>
      ) : (
        <div className="card">
          <table className="campaigns-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Status</th>
                <th>Reward</th>
                <th>Fee split (A)</th>
                <th>Salt</th>
                <th>Escrow</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td>
                    <Link to={`/campaigns/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {c.name}
                    </Link>
                  </td>
                  <td><span className={`status status-${c.status}`}>{c.status}</span></td>
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
  )
}
