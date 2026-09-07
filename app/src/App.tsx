import { Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import CampaignWizard from './pages/CampaignWizard'
import CampaignsList from './pages/CampaignsList'
import CampaignDetail from './pages/CampaignDetail'

export default function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<CampaignWizard />} />
        <Route path="/campaigns" element={<CampaignsList />} />
        <Route path="/campaigns/:id" element={<CampaignDetail />} />
      </Routes>
    </>
  )
}
