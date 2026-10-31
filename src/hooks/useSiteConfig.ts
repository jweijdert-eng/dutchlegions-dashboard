import { useEffect, useState } from 'react'
import type { IntelChannel } from '../utils/intelChannels'
import { getMemberSettings } from '../utils/memberSettings'

// Publieke site-config uit /api/siteconfig.php: accentkleur + handige links.
// Beheerd op de Admin-pagina. Module-gecachet zodat componenten één fetch delen.

export interface CorpLink { label: string; url: string }
export interface SiteConfig { accent: string; links: CorpLink[]; intelChannels: IntelChannel[] }

const EMPTY: SiteConfig = { accent: '', links: [], intelChannels: [] }
let _cache: SiteConfig | null = null
let _inflight: Promise<SiteConfig> | null = null

// Past de accentkleur toe op de --blue CSS-variabele (site-breed).
export function applyAccent(accent: string) {
  const root = document.documentElement
  if (accent) root.style.setProperty('--blue', accent)
  else root.style.removeProperty('--blue')
}

export function fetchSiteConfig(force = false): Promise<SiteConfig> {
  if (_cache && !force) return Promise.resolve(_cache)
  if (!_inflight || force) {
    _inflight = fetch('/api/siteconfig.php')
      .then(r => (r.ok ? r.json() : EMPTY))
      .then((d: SiteConfig) => {
        _cache = {
          accent: d?.accent ?? '',
          links: Array.isArray(d?.links) ? d.links : [],
          intelChannels: Array.isArray(d?.intelChannels)
            ? d.intelChannels.filter(c => c && typeof c.prefix === 'string' && c.prefix.trim())
            : [],
        }
        // Persoonlijke accentkleur (member-instelling) wint van de site-accent.
        applyAccent(getMemberSettings().accent || _cache.accent)
        try { localStorage.setItem('eve_site_accent', _cache.accent) } catch { /* ignore */ }
        return _cache
      })
      .catch(() => { _cache = EMPTY; return _cache })
  }
  return _inflight
}

export function useSiteConfig(): SiteConfig {
  const [cfg, setCfg] = useState<SiteConfig>(_cache ?? EMPTY)
  useEffect(() => {
    let alive = true
    fetchSiteConfig().then(c => { if (alive) setCfg(c) })
    return () => { alive = false }
  }, [])
  return cfg
}
