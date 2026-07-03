import { useEffect, useState } from 'react'

// Site-brede instellingen uit /api/settings.php (beheerd op de Admin-pagina).
// Module-gecachet zodat meerdere componenten één fetch delen.
export interface SiteSettings {
  maintenance_mode?: boolean
  require_corp?: boolean
  require_alliance?: boolean
  local_chat?: boolean
  auth_epoch?: string   // wijzigt zodra de admin een geforceerde re-login triggert
}

let _cache: SiteSettings | null = null
let _inflight: Promise<SiteSettings> | null = null

export function fetchSiteSettings(force = false): Promise<SiteSettings> {
  if (_cache && !force) return Promise.resolve(_cache)
  if (!_inflight || force) {
    _inflight = fetch('/api/settings.php')
      .then(r => (r.ok ? r.json() : {}))
      .then((d: SiteSettings) => { _cache = d ?? {}; return _cache })
      .catch(() => { _cache = {}; return _cache })
  }
  return _inflight
}

export function useSiteSettings(): SiteSettings {
  const [settings, setSettings] = useState<SiteSettings>(_cache ?? {})
  useEffect(() => {
    let alive = true
    fetchSiteSettings().then(s => { if (alive) setSettings(s) })
    return () => { alive = false }
  }, [])
  return settings
}
