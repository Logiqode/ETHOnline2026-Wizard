import { NavLink } from 'react-router-dom'
import logoUrl from '../assets/wizard-hat-logo.png'

const PAGES = [
  { to: '/', label: 'Campaign Wizard', end: true },
  { to: '/campaigns', label: 'Campaigns' },
]

export default function Navbar() {
  return (
    <nav className="topbar">
      <div className="brand">
        <img className="brand-mark" src={logoUrl} alt="Wizard logo" />
        Wizard
      </div>
      <div className="nav-links">
        {PAGES.map((p) => (
          <NavLink
            key={p.to}
            to={p.to}
            end={p.end}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            {p.label}
          </NavLink>
        ))}
      </div>
      <div className="nav-spacer" />
      <span className="nav-badge">Base Sepolia</span>
    </nav>
  )
}
