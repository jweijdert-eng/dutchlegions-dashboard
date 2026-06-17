import { useEffect, useState } from 'react'

// Persoonlijke (per-browser) member-instellingen. localStorage + een event zodat
// de Sidebar en andere componenten live meeveranderen.
export interface MemberSettings {
  hiddenTabs: string[]      // paths die in de zijbalk verborgen zijn
  notifications: boolean    // desktop-notificatie bij Local-mention
  sound: boolean            // geluidswaarschuwing (intel/local)
  localWidget: boolean      // Local Chat-widget op het dashboard tonen
  accent: string            // persoonlijke accentkleur (#rrggbb), leeg = site-accent
  translate: boolean        // Local-berichten vertalen
  translateLang: 'en' | 'nl' // doeltaal voor de vertaling
}

const KEY = 'eve_member_settings'
const DEFAULTS: MemberSettings = { hiddenTabs: [], notifications: true, sound: true, localWidget: true, accent: '', translate: false, translateLang: 'en' }
const EVENT = 'membersettings'

export function getMemberSettings(): MemberSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      hiddenTabs: Array.isArray(raw.hiddenTabs) ? raw.hiddenTabs : [],
      notifications: raw.notifications !== false,
      sound: raw.sound !== false,
      localWidget: raw.localWidget !== false,
      accent: /^#[0-9a-fA-F]{6}$/.test(raw.accent) ? raw.accent : '',
      translate: raw.translate === true,
      translateLang: raw.translateLang === 'nl' ? 'nl' : 'en',
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
