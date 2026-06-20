import { useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { NAV_ITEMS } from '../components/Sidebar'
import { useMemberSettings, setMemberSettings } from '../utils/memberSettings'
import { applyAccent, useSiteConfig } from '../hooks/useSiteConfig'
import { useAuth } from '../auth/AuthContext'
import AccountsPanel from '../components/AccountsPanel'

const ACCENTS = [
  '#00b4d8', '#22d3ee', '#14b8a6', '#3ecf6e', '#84cc16', '#f0c040',
  '#f97316', '#e05555', '#f472b6', '#ec4899', '#a78bfa', '#6366f1',
]

// Eenvoudige toggle-switch.
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} role="switch" aria-checked={on}
      style={{ width: 40, height: 22, borderRadius: 11, border: '1px solid var(--border)', cursor: 'pointer', flexShrink: 0,
        background: on ? 'var(--green)' : 'var(--surface2)', position: 'relative', transition: 'background 0.15s' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
    </button>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem 1.1rem', marginBottom: '0.9rem' }
const cardTitle: React.CSSProperties = { fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.2rem' }
const cardSub: React.CSSProperties = { fontSize: '0.66rem', color: 'var(--text-dim)', marginBottom: '0.8rem' }
const smallBtn: React.CSSProperties = { background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.7rem', fontWeight: 600, padding: '0.3rem 0.7rem', cursor: 'pointer' }

// Tabs die je niet kunt verbergen.
const FIXED = new Set(['/'])
// Local Chat is geen vaste nav-item maar wél toggle-baar.
const TOGGLEABLE = [...NAV_ITEMS.filter(n => !FIXED.has(n.path)), { label: 'Local Chat', path: '/local', icon: '⌁', badge: null as null }]

const SUPPORTED = typeof window !== 'undefined' && 'showDirectoryPicker' in window

// ── Chatlogs-map koppelen voor zowel Local Chat als de Intel-kaart ──
// (die gebruiken aparte IndexedDB-stores; we schrijven de handle naar beide.)
function idbPut(dbName: string, version: number, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.open(dbName, version)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store) }
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction(store, 'readwrite')
        tx.objectStore(store).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      } catch { resolve() }
    }
    req.onerror = () => resolve()
  })
}
function idbHas(dbName: string, version: number, store: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = indexedDB.open(dbName, version)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store) }
    req.onsuccess = () => {
      try {
        const r = req.result.transaction(store, 'readonly').objectStore(store).get(key)
        r.onsuccess = () => resolve(!!r.result)
        r.onerror = () => resolve(false)
      } catch { resolve(false) }
    }
    req.onerror = () => resolve(false)
  })
}

export default function Settings() {
  const settings = useMemberSettings()
  const site = useSiteConfig()
  const { tokens } = useAuth()
  const isAdmin = tokens.some(t => t.characterId === 1831618559)
  const [chatStatus, setChatStatus] = useState<'unknown' | 'linked' | 'none'>('unknown')
  const [busy, setBusy] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(true)

  // Notificatie-permissie + test
  const [perm, setPerm] = useState<NotificationPermission>(typeof Notification !== 'undefined' ? Notification.permission : 'denied')
  const requestPerm = () => { if ('Notification' in window) Notification.requestPermission().then(setPerm) }
  const testNotif = () => { if (Notification.permission === 'granted') new Notification('EVE Dashboard', { body: 'Notificaties werken! 🎉', icon: '/favicon.ico' }) }

  // Instellingen exporteren/importeren (per-browser → meenemen naar ander apparaat)
  const [importText, setImportText] = useState('')
  const [ioMsg, setIoMsg] = useState('')
  const flash = (m: string) => { setIoMsg(m); setTimeout(() => setIoMsg(''), 2500) }
  const exportSettings = () => {
    const code = 'EVE1:' + btoa(unescape(encodeURIComponent(JSON.stringify(settings))))
    navigator.clipboard?.writeText(code).then(() => flash('✓ gekopieerd naar klembord')).catch(() => flash('✗ kopiëren mislukt'))
  }
  const importSettings = () => {
    try {
      const obj = JSON.parse(decodeURIComponent(escape(atob(importText.trim().replace(/^EVE1:/, '')))))
      setMemberSettings(obj)
      applyAccent(obj.accent || site.accent || '')
      setImportText(''); flash('✓ instellingen geïmporteerd')
    } catch { flash('✗ ongeldige code') }
  }

  // Accentkleur live toepassen (persoonlijk wint van site; leeg = site-accent).
  function pickAccent(hex: string) {
    setMemberSettings({ accent: hex })
    applyAccent(hex || site.accent || '')
  }

  useEffect(() => {
    if (!SUPPORTED) { setChatStatus('none'); return }
    Promise.all([
      idbHas('eve-dashboard', 1, 'fs-handles', 'chatlogs-dir'),
      idbHas('eve-intel', 2, 'dir', 'chatlogs'),
    ]).then(([a, b]) => setChatStatus(a || b ? 'linked' : 'none'))
  }, [])

  async function linkChatlogs() {
    if (!SUPPORTED) return
    setBusy(true)
    try {
      const dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ id: 'eve-chatlogs', mode: 'read', startIn: 'documents' })
      // Toestemming is verleend door de keuze; bewaar de handle voor beide features.
      await idbPut('eve-dashboard', 1, 'fs-handles', 'chatlogs-dir', dir)
      await idbPut('eve-intel', 2, 'dir', 'chatlogs', dir)
      setChatStatus('linked')
    } catch { /* geannuleerd */ }
    finally { setBusy(false) }
  }

  const toggleTab = (path: string, visible: boolean) => {
    const hidden = new Set(settings.hiddenTabs)
    if (visible) hidden.delete(path); else hidden.add(path)
    setMemberSettings({ hiddenTabs: [...hidden] })
  }

  return (
    <Layout header={<PageHeader title="Instellingen" sub="Jouw persoonlijke voorkeuren (per browser)" />}>
      <div style={{ maxWidth: 620 }}>

        {/* Accounts (inklapbaar) */}
        <div style={card}>
          <div onClick={() => setAccountsOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
            <div style={{ ...cardTitle, marginBottom: 0 }}>👤 Accounts</div>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{accountsOpen ? '▲' : '▼'}</span>
          </div>
          {accountsOpen && (
            <>
              <div style={{ ...cardSub, marginTop: '0.5rem' }}>Je ingelogde characters. Klik om te kiezen wiens data je ziet (of "Alle accounts"). ★ = hoofdaccount, ⏏ = uitloggen.</div>
              <AccountsPanel />
            </>
          )}
        </div>

        {/* Chatlogs-map */}
        <div style={card}>
          <div style={cardTitle}>📂 Chatlogs-map</div>
          <div style={cardSub}>Koppel je <code>…\EVE\logs\Chatlogs\</code>-map één keer — wordt gebruikt voor <strong>Local Chat</strong> én de <strong>Intel-kaart</strong>. Alleen Chrome/Edge.</div>
          {!SUPPORTED ? (
            <div style={{ fontSize: '0.7rem', color: 'var(--red)' }}>Deze browser ondersteunt het koppelen van een map niet (gebruik Chrome of Edge).</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
              <button onClick={linkChatlogs} disabled={busy}
                style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.74rem', fontWeight: 600, padding: '0.4rem 0.9rem', cursor: busy ? 'wait' : 'pointer' }}>
                {chatStatus === 'linked' ? 'Andere map kiezen' : 'Chatlogs-map koppelen'}
              </button>
              <span style={{ fontSize: '0.68rem', color: chatStatus === 'linked' ? 'var(--green)' : 'var(--text-dim)' }}>
                {chatStatus === 'linked' ? '✓ Gekoppeld' : chatStatus === 'none' ? 'Nog niet gekoppeld' : '…'}
              </span>
            </div>
          )}
          {chatStatus === 'linked' && (
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
              Tip: na koppelen open je Local Chat of de Fleet-kaart één keer; de browser vraagt dan kort om toegang te bevestigen.
            </div>
          )}
        </div>

        {/* Notificaties & geluid */}
        <div style={card}>
          <div style={cardTitle}>🔔 Notificaties & geluid</div>
          <div style={cardSub}>Waarschuwingen bij activiteit.</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid rgba(28,28,53,0.5)' }}>
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Desktop-notificatie bij Local-mention</div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Melding als iemand jouw naam noemt in Local.</div>
            </div>
            <Toggle on={settings.notifications} onChange={v => {
              if (v && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission()
              setMemberSettings({ notifications: v })
            }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid rgba(28,28,53,0.5)' }}>
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Industry-job klaar</div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Desktop-melding als een job klaar is om op te halen.</div>
            </div>
            <Toggle on={settings.notifJobs} onChange={v => setMemberSettings({ notifJobs: v })} />
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid rgba(28,28,53,0.5)' }}>
              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Recruiter-chat</div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Melding bij een nieuw bericht in de recruiter-chat.</div>
              </div>
              <Toggle on={settings.notifRecruiter} onChange={v => setMemberSettings({ notifRecruiter: v })} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0' }}>
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Geluidswaarschuwing (intel)</div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Pieptoon bij een nieuwe threat in de Intel-feed.</div>
            </div>
            <Toggle on={settings.sound} onChange={v => setMemberSettings({ sound: v })} />
          </div>
          {/* Browser-permissie */}
          <div style={{ marginTop: '0.5rem', paddingTop: '0.6rem', borderTop: '1px solid rgba(28,28,53,0.5)', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem' }}>
              Browser-toestemming:{' '}
              <strong style={{ color: perm === 'granted' ? 'var(--green)' : perm === 'denied' ? 'var(--red)' : 'var(--gold)' }}>
                {perm === 'granted' ? 'toegestaan' : perm === 'denied' ? 'geblokkeerd' : 'nog niet gevraagd'}
              </strong>
            </span>
            {perm === 'default' && <button onClick={requestPerm} style={smallBtn}>Toestaan</button>}
            {perm === 'granted' && <button onClick={testNotif} style={smallBtn}>Test melding</button>}
            {perm === 'denied' && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>Zet meldingen aan via het 🔒 in de adresbalk.</span>}
          </div>
        </div>

        {/* Accentkleur */}
        <div style={card}>
          <div style={cardTitle}>🎨 Accentkleur</div>
          <div style={cardSub}>Jouw persoonlijke accentkleur (overschrijft de site-kleur, alleen voor jou). Leeg = site-standaard.</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
            {ACCENTS.map(hex => {
              const active = settings.accent.toLowerCase() === hex
              return (
                <button key={hex} onClick={() => pickAccent(hex)} title={hex}
                  style={{ width: 26, height: 26, borderRadius: '50%', background: hex, cursor: 'pointer',
                    border: active ? '2px solid #fff' : '2px solid transparent', boxShadow: active ? `0 0 0 2px ${hex}` : 'none' }} />
              )
            })}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', marginLeft: '0.3rem' }} title="Eigen kleur">
              <input type="color" value={settings.accent || site.accent || '#00b4d8'} onChange={e => pickAccent(e.target.value)}
                style={{ width: 26, height: 26, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' }} />
            </label>
            {settings.accent && (
              <button onClick={() => pickAccent('')}
                style={{ marginLeft: '0.3rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.66rem', padding: '0.25rem 0.55rem', cursor: 'pointer' }}>
                Site-standaard
              </button>
            )}
          </div>
        </div>

        {/* Dashboard-widgets */}
        <div style={card}>
          <div style={cardTitle}>▦ Dashboard</div>
          <div style={cardSub}>Onderdelen op je dashboard.</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0' }}>
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Local Chat-widget</div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>De Local Chat-widget op het dashboard tonen.</div>
            </div>
            <Toggle on={settings.localWidget} onChange={v => setMemberSettings({ localWidget: v })} />
          </div>
        </div>

        {/* Tabs aan/uit */}
        <div style={card}>
          <div style={cardTitle}>☰ Tabbladen</div>
          <div style={cardSub}>Zet uit welke tabs je niet in de zijbalk wilt. (Dashboard blijft altijd staan.)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '0.3rem 1rem' }}>
            {TOGGLEABLE.map(t => {
              const visible = !settings.hiddenTabs.includes(t.path)
              return (
                <div key={t.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0' }}>
                  <span style={{ fontSize: '0.74rem', color: visible ? 'var(--text)' : 'var(--text-dim)' }}>
                    <span style={{ display: 'inline-block', width: 18, opacity: 0.7 }}>{t.icon}</span>{t.label}
                  </span>
                  <Toggle on={visible} onChange={v => toggleTab(t.path, v)} />
                </div>
              )
            })}
          </div>
        </div>

        {/* Instellingen meenemen (export/import) */}
        <div style={card}>
          <div style={cardTitle}>🔄 Instellingen meenemen</div>
          <div style={cardSub}>Je voorkeuren staan per browser. Kopieer ze als code en plak op een ander apparaat of in een andere browser.</div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.6rem' }}>
            <button onClick={exportSettings} style={smallBtn}>📋 Kopieer mijn instellingen</button>
            {ioMsg && <span style={{ fontSize: '0.66rem', color: ioMsg.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>{ioMsg}</span>}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input value={importText} onChange={e => setImportText(e.target.value)} placeholder="Plak hier een instellingen-code…"
              style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 3, color: '#fff', fontSize: '0.7rem', padding: '0.4rem 0.55rem' }} />
            <button onClick={importSettings} disabled={!importText.trim()} style={{ ...smallBtn, opacity: importText.trim() ? 1 : 0.5 }}>Importeer</button>
          </div>
        </div>

      </div>
    </Layout>
  )
}
