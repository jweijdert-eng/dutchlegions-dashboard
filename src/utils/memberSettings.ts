import { useEffect, useState } from 'react'

// Persoonlijke (per-browser) member-instellingen. localStorage + een event zodat
// de Sidebar en andere componenten live meeveranderen.
export interface MemberSettings {
  hiddenTabs: string[]      // paths die in de zijbalk verborgen zijn
  notifications: boolean    // desktop-notificatie bij Local-mention
  sound: boolean            // geluidswaarschuwing (intel/local)
}

const KEY = 'eve_member_settings'
const DEFAULTS: MemberSettings = { hiddenTabs: [], notifications: true, sound: true }
const EVENT = 'membersettings'

export function getMemberSettings(): MemberSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      hiddenTabs: Array.isArray(raw.hiddenTabs) ? raw.hiddenTabs : [],
      notifications: raw.notifications !== false,
      sound: raw.sound !== false,
    }
  } catch { return { ...DEFAULTS } }
}

export function setMemberSettings(patch: Partial<MemberSettings>): MemberSettings {
  const next = { ...getMemberSettings(), ...patch }
  localStorage.setItem(KEY, JSON.stringify(next))
  window.dispatchEvent(new Event(EVENT))
  return next
}

export function useMemberSettings(): MemberSettings {
  const [s, setS] = useState<MemberSettings>(getMemberSettings)
  useEffect(() => {
    const h = () => setS(getMemberSettings())
    window.addEventListener(EVENT, h)
    window.addEventListener('storage', h)
    return () => { window.removeEventListener(EVENT, h); window.removeEventListener('storage', h) }
  }, [])
  return s
}
