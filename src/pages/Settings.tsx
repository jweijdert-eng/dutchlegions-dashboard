import { useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { DEFAULT_NAV } from '../components/Sidebar'
import { useMemberSettings, setMemberSettings } from '../utils/memberSettings'

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

// Tabs die je niet kunt verbergen.
const FIXED = new Set(['/'])
// Local Chat is geen vaste nav-item maar wél toggle-baar.
const TOGGLEABLE = [...DEFAULT_NAV.filter(n => !FIXED.has(n.path)), { label: 'Local Chat', path: '/local', icon: '⌁', badge: null as null }]

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
  const [chatStatus, setChatStatus] = useState<'unknown' | 'linked' | 'none'>('unknown')
  const [busy, setBusy] = useState(false)

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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0' }}>
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Geluidswaarschuwing (intel)</div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Pieptoon bij een nieuwe threat in de Intel-feed.</div>
            </div>
            <Toggle on={settings.sound} onChange={v => setMemberSettings({ sound: v })} />
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

      </div>
    </Layout>
  )
}
