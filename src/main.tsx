import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getMemberSettings } from './utils/memberSettings'
import { applyAccent } from './hooks/useSiteConfig'

// Accentkleur meteen toepassen (uit member-instelling of gecachte site-accent)
// vóór de eerste render — voorkomt de blauw→kleur-flash bij refreshen.
const initialAccent = getMemberSettings().accent || localStorage.getItem('eve_site_accent') || ''
if (initialAccent) applyAccent(initialAccent)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
