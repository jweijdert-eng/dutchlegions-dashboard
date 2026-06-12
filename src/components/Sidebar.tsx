import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAuth } from '../auth/AuthContext'
import { useAlerts } from '../context/useAlerts'
import { getWallet, getWalletJournal, getCharacterInfo, getAlliance, clearEsiCache } from '../api/esi'
import SolarSystem from './SolarSystem'
import EveImage from './EveImage'

function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const w = 108, h = 20
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x},${y}`
  }).join(' ')
  const trend = values[values.length - 1] - values[0]
  const color = trend >= 0 ? '#4ade80' : '#f87171'
  return (
    <svg width={w} height={h} style={{ display: 'block', marginTop: '0.2rem', opacity: 0.7 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

const LOCAL = 'http://localhost:8765'

interface SdeStatus {
  loaded: boolean
  count: number
  path: string
  loadError: string | null
  fsdFiles: number
  typeNamesLoaded: boolean
  typeNamesCount: number
  schematicsLoaded: boolean
  version: { installed: number | null; installedReleaseDate: string | null; latest: number | null; latestReleaseDate: string | null; updateAvailable: boolean; checking: boolean }
  download: { active: boolean; step: string; downloaded: number; total: number; extracted: number; error: string | null }
}

function fmtMB(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(0)} MB` }

function SdeWidget() {
  const [sde, setSde]           = useState<SdeStatus | null>(null)
  const [serverUp, setServerUp] = useState(false)
  const pollRef                 = useRef<ReturnType<typeof setInterval> | null>(null)

  async function pollStatus() {
    try {
      const r = await fetch(`${LOCAL}/sde-status`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { setSde(await r.json()); setServerUp(true) }
    } catch { setServerUp(false) }
  }

  useEffect(() => {
    pollStatus()
    pollRef.current = setInterval(pollStatus, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function startDownload() {
    await fetch(`${LOCAL}/sde-download`, { method: 'POST' }).catch(() => null)
  }

  const dl = sde?.download

  const versionLabel = !serverUp ? null
    : dl?.active ? null
    : sde?.version?.installed ? `Build #${sde.version.installed}`
    : sde?.loaded ? `${sde.fsdFiles} bestanden`
    : null

  const isUpdate = sde?.version?.updateAvailable
  const accentColor = !serverUp ? 'var(--border)' : dl?.active ? 'var(--blue)' : isUpdate ? 'var(--gold)' : sde?.loaded ? 'var(--green)' : 'var(--blue)'

  return (
    <div style={{
      margin: '0.4rem 0.5rem',
      background: 'rgba(0,0,0,0.2)',
      border: `1px solid ${accentColor}33`,
      borderLeft: `3px solid ${accentColor}`,
      borderRadius: 3,
      padding: '0.5rem 0.65rem',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
        <span style={{ fontSize: '0.6rem', color: accentColor, letterSpacing: '0.12em', fontWeight: 700 }}>SDE</span>
        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: accentColor }}>
          {!serverUp ? 'Offline' : dl?.active ? `${dl.extracted > 0 ? dl.extracted + ' bestanden' : dl.step}` : sde?.loaded ? '✓ Geladen' : 'Niet geladen'}
        </span>
      </div>

      {/* Versie + datum */}
      {versionLabel && !dl?.active && (
        <div style={{ marginBottom: '0.35rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: isUpdate ? 'var(--gold)' : 'var(--text)' }}>
              {versionLabel}
            </span>
            {isUpdate && (
              <span style={{ fontSize: '0.58rem', background: 'rgba(240,192,64,0.15)', border: '1px solid rgba(240,192,64,0.4)', color: 'var(--gold)', borderRadius: 2, padding: '0.05rem 0.3rem', fontWeight: 700 }}>
                nieuw
              </span>
            )}
          </div>
          {sde?.version?.installedReleaseDate && (
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>
              {new Date(sde.version.installedReleaseDate).toLocaleString('nl', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
            </div>
          )}
        </div>
      )}

      {/* Download voortgangsbalk */}
      {dl?.active && (
        <div style={{ marginBottom: '0.4rem' }}>
          <div style={{ height: 4, background: 'rgba(0,180,216,0.15)', borderRadius: 2, overflow: 'hidden', marginBottom: '0.25rem' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              background: 'linear-gradient(90deg, var(--blue), #7dd3fc)',
              width: dl.total > 0 ? `${Math.round(dl.downloaded / dl.total * 100)}%` : '60%',
              transition: 'width 0.5s',
            }} />
          </div>
          <div style={{ fontSize: '0.6rem', color: 'var(--blue)', textAlign: 'center', fontWeight: 600 }}>
            {dl.total > 0 ? `${fmtMB(dl.downloaded)} / ${fmtMB(dl.total)}` : dl.step}
          </div>
        </div>
      )}

      {/* Fout */}
      {dl?.error && (
        <div style={{ fontSize: '0.58rem', color: 'var(--red)', marginBottom: '0.3rem', wordBreak: 'break-word', background: 'rgba(224,85,85,0.08)', borderRadius: 2, padding: '0.2rem 0.35rem' }}>
          {dl.error}
        </div>
      )}

      {/* Knop */}
      {!dl?.active && serverUp && (!sde?.loaded || isUpdate) && (
        <button
          onClick={startDownload}
          style={{
            display: 'block', width: '100%', textAlign: 'center', cursor: 'pointer',
            background: isUpdate ? 'rgba(240,192,64,0.12)' : 'rgba(0,180,216,0.1)',
            border: `1px solid ${isUpdate ? 'rgba(240,192,64,0.45)' : 'rgba(0,180,216,0.35)'}`,
            color: isUpdate ? 'var(--gold)' : 'var(--blue)',
            borderRadius: 2, fontSize: '0.65rem', fontWeight: 700, padding: '0.3rem',
          }}
        >
          {isUpdate ? '↻ Bijwerken' : '↓ SDE installeren'}
        </button>
      )}

      {!serverUp && (
        <a
          href="https://developers.eveonline.com/static-data/eve-online-static-data-latest-yaml.zip"
          target="_blank" rel="noreferrer"
          style={{
            display: 'block', textAlign: 'center', textDecoration: 'none',
            background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.25)',
            color: 'var(--blue)', borderRadius: 2, fontSize: '0.65rem', fontWeight: 600, padding: '0.3rem',
          }}
        >↓ Download YAML</a>
      )}
    </div>
  )
}

type NavItem = { label: string; path: string; icon: string; badge: null | 'mail' | 'jobs' | 'alerts' }

const DEFAULT_NAV: NavItem[] = [
  { label: 'Dashboard',   path: '/',           icon: '▣', badge: null },
  { label: 'Overzicht',   path: '/overview',   icon: '⊞', badge: null },
  { label: 'Character',   path: '/character',  icon: '◈', badge: null },
  { label: 'Wallet',      path: '/wallet',     icon: '◑', badge: null },
  { label: 'Market',      path: '/market',     icon: '◊', badge: null },
  { label: 'Kills',       path: '/kills',      icon: '◉', badge: null },
  { label: 'Industry',    path: '/industry',   icon: '◫', badge: 'jobs' },
  { label: 'Mining',      path: '/mining',     icon: '⬟', badge: null },
  { label: 'Planets',     path: '/planets',    icon: '○', badge: null },
  { label: 'Mail',        path: '/mail',       icon: '✉', badge: 'mail' },
  { label: 'Fittings',    path: '/fittings',   icon: '⌬', badge: null },
  { label: 'Skills',      path: '/skills',     icon: '◎', badge: null },
  { label: 'Blueprints',  path: '/blueprints', icon: '⬡', badge: null },
  { label: 'Contracts',   path: '/contracts',  icon: '◧', badge: null },
  { label: 'Local Chat',  path: '/local',      icon: '⌁', badge: null },
  { label: 'Build vs Buy',path: '/buildvsbuy', icon: '⚙', badge: null },
  { label: 'Notities',    path: '/notes',      icon: '✎', badge: null },
]

function loadNav(): NavItem[] {
  try {
    const saved = JSON.parse(localStorage.getItem('nav_order') ?? 'null') as string[] | null
    if (!saved) return DEFAULT_NAV
    const map = Object.fromEntries(DEFAULT_NAV.map(n => [n.path, n]))
    const ordered = saved.map(p => map[p]).filter(Boolean)
    const missing = DEFAULT_NAV.filter(n => !saved.includes(n.path))
    return [...ordered, ...missing]
  } catch { return DEFAULT_NAV }
}

function SortableNavItem({ item, badgeCount }: { item: NavItem; badgeCount: (b: NavItem['badge']) => number | null }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.path })
  const count = badgeCount(item.badge)
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}>
      <NavLink
        to={item.path}
        end={item.path === '/'}
        style={({ isActive }) => ({
          display: 'flex', alignItems: 'center', gap: '0.65rem',
          padding: '0.55rem 1rem', textDecoration: 'none',
          background: isActive ? 'rgba(0,180,216,0.07)' : 'transparent',
          borderLeft: `2px solid ${isActive ? 'var(--blue)' : 'transparent'}`,
          color: isActive ? 'var(--blue)' : 'var(--text-dim)',
          userSelect: 'none',
        })}
      >
        <span
          {...attributes} {...listeners}
          style={{ fontSize: 10, width: 10, color: 'var(--text-dim)', cursor: 'grab', flexShrink: 0, letterSpacing: '-1px' }}
          title="Versleep om volgorde te wijzigen"
        >⠿</span>
        <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
        <span style={{ fontSize: '0.75rem', fontWeight: 400, letterSpacing: '0.03em', flex: 1 }}>{item.label}</span>
        <Badge count={count} />
      </NavLink>
    </div>
  )
}

interface CharData {
  characterId: number
  wallet: number | null
  dailyEarnings: number | null
  sparkline: number[]
  corpId: number | null
  allianceId: number | null
  allianceName: string | null
}

function fmtISK(v: number) {
  const n   = Number(v)
  const abs = Math.abs(n)
  const neg = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}

function fmtDaily(v: number) {
  if (v === 0) return null
  const sign = v > 0 ? '+' : ''
  return `${sign}${fmtISK(v)}`
}

function Badge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span style={{
      marginLeft: 'auto',
      background: 'var(--red)',
      color: '#fff',
      fontSize: '0.55rem',
      fontWeight: 700,
      borderRadius: 8,
      minWidth: 16,
      height: 16,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 4px',
    }}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

interface Token { characterId: number; characterName: string; accessToken: string; expiresAt: number }
interface AlertsState { unreadMail: number; readyJobs: number; locations: Map<number, import('./SolarSystem').default extends never ? never : { system: string; systemId: number | null; shipName: string; shipTypeId: number | null }> }

function AccountDropdown({ tokens, charData, selectedCharId, setSelectedCharId, mainCharId, setMainCharId, removeToken, alerts }: {
  tokens: Token[]
  charData: Map<number, CharData>
  selectedCharId: number | null
  setSelectedCharId: (id: number | null) => void
  mainCharId: number | null
  setMainCharId: (id: number | null) => void
  removeToken: (id: number) => void
  alerts: { unreadMail: number; readyJobs: number; locations: Map<number, { system: string; systemId: number | null; shipName: string; shipTypeId: number | null }> }
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const selected = selectedCharId ? tokens.find(t => t.characterId === selectedCharId) : null
  const data     = selected ? charData.get(selected.characterId) : null
  const loc      = selected ? alerts.locations.get(selected.characterId) : null

  return (
    <div ref={ref} style={{ borderTop: '1px solid var(--border)', position: 'relative' }}>

      {/* Trigger */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.55rem 0.75rem', cursor: 'pointer',
          background: open ? 'rgba(0,180,216,0.05)' : 'transparent',
          borderLeft: `2px solid ${open ? 'var(--blue)' : 'transparent'}`,
        }}
      >
        {selected ? (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <EveImage category="characters" id={selected.characterId} variation="portrait" size={32} px={26} round
              style={{ border: '1px solid var(--blue)', display: 'block' }} />
            {data?.corpId && (
              <EveImage category="corporations" id={data.corpId} variation="logo" size={16} px={14}
                style={{ position: 'absolute', bottom: -2, right: -2, borderRadius: 2, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
            )}
            {data?.allianceId && (
              <EveImage category="alliances" id={data.allianceId} variation="logo" size={16} px={14}
                style={{ position: 'absolute', top: -2, right: -2, borderRadius: 2, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
            )}
          </div>
        ) : (
          <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(0,180,216,0.15)', border: '1px solid rgba(0,180,216,0.3)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--blue)' }}>⊞</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--blue)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            {selected ? selected.characterName : 'Alle accounts'}
            {selected && mainCharId === selected.characterId && (
              <span style={{ color: 'var(--gold)', fontSize: '0.6rem', flexShrink: 0 }}>★</span>
            )}
          </div>
          {selected && data?.wallet != null && (
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{fmtISK(data.wallet)} ISK</div>
          )}
          {selected && data?.allianceName && (
            <div style={{ fontSize: '0.57rem', color: 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.allianceName}</div>
          )}
          {!selected && (
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{tokens.length} accounts</div>
          )}
        </div>
        <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Locatie van geselecteerd account */}
      {selected && loc?.system && loc.system !== '—' && !open && (
        <div style={{ padding: '0 0.75rem 0.4rem 0.75rem', fontSize: '0.57rem', color: 'var(--text)' }}>
          ⬡ <SolarSystem name={loc.system} systemId={loc.systemId ?? undefined} fontSize="0.57rem" />
          {loc.shipName && loc.shipName !== '—' && (
            <span style={{ color: 'var(--gold)', marginLeft: '0.3rem' }}>
              · {loc.shipName}{loc.shipTypeName && loc.shipTypeName !== loc.shipName ? ` (${loc.shipTypeName})` : ''}
            </span>
          )}
        </div>
      )}

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderBottom: 'none', borderRadius: '3px 3px 0 0',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
        }}>
          {/* Alle accounts optie */}
          <div
            onClick={() => { setSelectedCharId(null); setOpen(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.5rem 0.75rem', cursor: 'pointer',
              background: selectedCharId === null ? 'rgba(0,180,216,0.08)' : 'transparent',
              borderLeft: `2px solid ${selectedCharId === null ? 'var(--blue)' : 'transparent'}`,
              borderBottom: '1px solid var(--border)',
            }}
            onMouseEnter={e => { if (selectedCharId !== null) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)' }}
            onMouseLeave={e => { if (selectedCharId !== null) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(0,180,216,0.15)', border: '1px solid rgba(0,180,216,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--blue)', flexShrink: 0 }}>⊞</div>
            <div>
              <div style={{ fontSize: '0.72rem', fontWeight: 600, color: selectedCharId === null ? 'var(--blue)' : 'var(--text)' }}>Alle accounts</div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{tokens.length} accounts</div>
            </div>
          </div>

          {/* Per account */}
          {tokens.map(t => {
            const d   = charData.get(t.characterId)
            const l   = alerts.locations.get(t.characterId)
            const sel = selectedCharId === t.characterId
            return (
              <div key={t.characterId} style={{ borderBottom: '1px solid rgba(28,28,53,0.5)' }}>
                <div
                  onClick={() => { setSelectedCharId(sel ? null : t.characterId); setOpen(false) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.5rem 0.65rem', cursor: 'pointer',
                    background: sel ? 'rgba(0,180,216,0.08)' : 'transparent',
                    borderLeft: `2px solid ${sel ? 'var(--blue)' : 'transparent'}`,
                  }}
                  onMouseEnter={e => { if (!sel) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)' }}
                  onMouseLeave={e => { if (!sel) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                >
                  {/* Portret + corp/alliance icon overlay */}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <EveImage category="characters" id={t.characterId} variation="portrait" size={32} px={26} round
                      style={{ border: `1px solid ${sel ? 'var(--blue)' : 'var(--border)'}`, display: 'block' }} />
                    {d?.corpId && (
                      <EveImage category="corporations" id={d.corpId} variation="logo" size={16} px={14}
                        style={{ position: 'absolute', bottom: -2, right: -2, borderRadius: 2, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
                    )}
                    {d?.allianceId && (
                      <EveImage category="alliances" id={d.allianceId} variation="logo" size={16} px={14}
                        style={{ position: 'absolute', top: -2, right: -2, borderRadius: 2, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: sel ? 'var(--blue)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.characterName}
                    </div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                      {d?.wallet != null ? `${fmtISK(d.wallet)} ISK` : '—'}
                    </div>
                    {d?.allianceName && (
                      <div style={{ fontSize: '0.57rem', color: 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.allianceName}</div>
                    )}
                    {l?.system && l.system !== '—' && (
                      <div style={{ fontSize: '0.57rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        ⬡ {l.system}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flexShrink: 0 }}>
                    <button
                      onClick={e => { e.stopPropagation(); setMainCharId(mainCharId === t.characterId ? null : t.characterId) }}
                      title={mainCharId === t.characterId ? 'Verwijder als hoofdaccount' : 'Stel in als hoofdaccount'}
                      style={{ background: mainCharId === t.characterId ? 'rgba(240,192,64,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${mainCharId === t.characterId ? 'rgba(240,192,64,0.5)' : 'rgba(255,255,255,0.1)'}`, color: mainCharId === t.characterId ? 'var(--gold)' : 'var(--text-dim)', borderRadius: 2, fontSize: '0.65rem', padding: '0.2rem 0.4rem', cursor: 'pointer' }}
                    >★</button>
                    <button
                      onClick={e => { e.stopPropagation(); removeToken(t.characterId); window.location.href = '/' }}
                      title="Uitloggen"
                      style={{ background: 'rgba(224,85,85,0.07)', border: '1px solid rgba(224,85,85,0.2)', color: 'var(--red)', borderRadius: 2, fontSize: '0.65rem', padding: '0.2rem 0.4rem', cursor: 'pointer' }}
                    >⏏</button>
                  </div>
                </div>
              </div>
            )
          })}

          {/* + Account toevoegen */}
          <NavLink
            to="/login"
            onClick={() => setOpen(false)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
              padding: '0.45rem', textDecoration: 'none',
              background: 'rgba(0,180,216,0.05)', color: 'var(--blue)', fontSize: '0.65rem',
            }}
          >+ Account toevoegen</NavLink>
        </div>
      )}
    </div>
  )
}

export default function Sidebar() {
  const { tokens, removeToken, selectedCharId, setSelectedCharId, mainCharId, setMainCharId } = useAuth()
  const alerts = useAlerts()
  const [nav, setNav] = useState<NavItem[]>(loadNav)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setNav(prev => {
      const oldIndex = prev.findIndex(n => n.path === active.id)
      const newIndex = prev.findIndex(n => n.path === over.id)
      const next = arrayMove(prev, oldIndex, newIndex)
      localStorage.setItem('nav_order', JSON.stringify(next.map(n => n.path)))
      return next
    })
  }
  const [charData, setCharData] = useState<Map<number, CharData>>(new Map())

  useEffect(() => {
    if (tokens.length === 0) return
    const today = new Date().toISOString().slice(0, 10)

    tokens.forEach(async t => {
      const [wallet, journal] = await Promise.allSettled([
        getWallet(t.characterId, t.accessToken),
        getWalletJournal(t.characterId, t.accessToken, 3),
      ])

      const walletVal  = wallet.status  === 'fulfilled' ? wallet.value  : null
      const journalVal = journal.status === 'fulfilled' ? journal.value : []

      const dailyEarnings = journalVal
        .filter(e => e.date.startsWith(today) && e.amount > 0)
        .reduce((s, e) => s + e.amount, 0)

      // 7-day wallet sparkline using balance snapshots
      const sparkline: number[] = []
      if (walletVal !== null && journalVal.length > 0) {
        const sorted = [...journalVal].sort((a, b) => b.date.localeCompare(a.date))
        for (let d = 6; d >= 0; d--) {
          const day = new Date()
          day.setDate(day.getDate() - d)
          const dayStr = day.toISOString().slice(0, 10)
          const snap = sorted.find(e => e.date.slice(0, 10) <= dayStr)
          sparkline.push(snap?.balance ?? walletVal)
        }
      }

      const charInfo = await getCharacterInfo(t.characterId).catch(() => null)
      const allianceId = charInfo?.alliance_id ?? null
      const allianceInfo = allianceId ? await getAlliance(allianceId).catch(() => null) : null

      setCharData(prev => new Map(prev).set(t.characterId, {
        characterId: t.characterId,
        wallet: walletVal,
        dailyEarnings,
        sparkline,
        corpId: charInfo?.corporation_id ?? null,
        allianceId,
        allianceName: allianceInfo?.name ?? null,
      }))
    })
  }, [tokens.map(t => t.characterId).join(',')])

  function badgeCount(key: 'mail' | 'jobs' | 'alerts' | null): number {
    if (key === 'mail')   return alerts.unreadMail
    if (key === 'jobs')   return alerts.readyJobs
    if (key === 'alerts') return alerts.unreadMail + alerts.readyJobs
    return 0
  }

  const sharedCorpId = tokens.length > 1
    ? (() => {
      const corpIds = tokens.map(t => charData.get(t.characterId)?.corpId)
      if (corpIds.some(id => id == null)) return null
      const unique = Array.from(new Set(corpIds as number[]))
      return unique.length === 1 ? unique[0] : null
    })()
    : null

  const selectedCorpId = selectedCharId
    ? charData.get(selectedCharId)?.corpId ?? null
    : tokens.length === 1
      ? charData.get(tokens[0].characterId)?.corpId ?? null
      : sharedCorpId

  return (
    <nav style={{
      width: 200,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      height: '100vh',
      position: 'sticky',
      top: 0,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.1rem 1rem', borderBottom: '1px solid var(--border)' }}>
        <NavLink to="/" end style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          {selectedCorpId ? (
            <EveImage
              category="corporations"
              id={selectedCorpId}
              variation="logo"
              size={32}
              px={26}
              style={{ borderRadius: 4, border: '1px solid rgba(0,180,216,0.2)', background: 'var(--surface)', width: 32, height: 32, flexShrink: 0 }}
            />
          ) : (
            <span style={{ color: 'var(--blue)', fontSize: 18 }}>⬡</span>
          )}
          <div>
            <div style={{ color: 'var(--blue)', fontWeight: 700, fontSize: '0.78rem', letterSpacing: '0.18em' }}>EVE</div>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.6rem', letterSpacing: '0.12em' }}>DASHBOARD</div>
          </div>
        </NavLink>
        <button
          onClick={() => { clearEsiCache(); window.location.reload() }}
          title="ESI data herladen"
          style={{
            background: 'rgba(0,180,216,0.07)',
            border: '1px solid rgba(0,180,216,0.2)',
            borderRadius: 3,
            color: 'var(--blue)',
            cursor: 'pointer',
            padding: '0.25rem 0.4rem',
            lineHeight: 1,
            fontSize: '0.85rem',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,180,216,0.18)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,180,216,0.07)' }}
        >↻</button>
      </div>

      {/* Nav */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.4rem 0' }}>
        <div style={{ padding: '0.5rem 1rem 0.25rem', fontSize: '0.6rem', letterSpacing: '0.12em', color: 'var(--text-dim)', userSelect: 'none' }}>
          INDELING
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={nav.map(n => n.path)} strategy={verticalListSortingStrategy}>
            {nav.map(item => (
              <SortableNavItem key={item.path} item={item} badgeCount={badgeCount} />
            ))}
          </SortableContext>
        </DndContext>

        {/* Admin — alleen zichtbaar voor character 1831618559 */}
        {tokens.some(t => t.characterId === 1831618559) && (
          <>
            <div style={{ height: 1, background: 'var(--border)', margin: '0.4rem 1rem' }} />
            <NavLink
              to="/admin"
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
                padding: '0.55rem 1rem',
                textDecoration: 'none',
                background: isActive ? 'rgba(224,85,85,0.07)' : 'transparent',
                borderLeft: `2px solid ${isActive ? 'var(--red)' : 'transparent'}`,
                color: isActive ? 'var(--red)' : 'rgba(224,85,85,0.6)',
              })}
            >
              <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>⚑</span>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.06em', flex: 1 }}>Admin</span>
            </NavLink>
          </>
        )}
      </div>

      {/* Externe links */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '0.5rem 0.5rem 0.35rem' }}>
        {[
          { label: 'Insidious Auth',         url: 'https://auth.insidiousevil.org/',     color: '#e05555' },
          { label: 'Dutch Legions',           url: 'https://dutchlegions.nl/dashboard/', color: '#f0a030' },
          { label: 'Dutch Legions - Logistics', url: 'https://procurer.space/',          color: '#4ade80' },
        ].map(({ label, url, color }) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.3rem 0.55rem', marginBottom: '0.25rem',
              textDecoration: 'none', borderRadius: 2,
              background: `${color}0d`,
              border: `1px solid ${color}44`,
              color: `${color}cc`, fontSize: '0.68rem',
              transition: 'color 0.15s, border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLAnchorElement
              el.style.color = color
              el.style.borderColor = `${color}99`
              el.style.background = `${color}1a`
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLAnchorElement
              el.style.color = `${color}cc`
              el.style.borderColor = `${color}44`
              el.style.background = `${color}0d`
            }}
          >
            <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>↗</span>
            {label}
          </a>
        ))}
      </div>

      <SdeWidget />

      {/* Account dropdown */}
      <AccountDropdown
        tokens={tokens}
        charData={charData}
        selectedCharId={selectedCharId}
        setSelectedCharId={setSelectedCharId}
        mainCharId={mainCharId}
        setMainCharId={setMainCharId}
        removeToken={removeToken}
        alerts={alerts}
      />
    </nav>
  )
}
