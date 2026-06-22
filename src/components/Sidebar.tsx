import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAuth } from '../auth/AuthContext'
import { useLayoutMode } from '../context/LayoutModeContext'

import { useAlerts } from '../context/useAlerts'
import { useSiteSettings } from '../hooks/useSiteSettings'
import { useSiteConfig } from '../hooks/useSiteConfig'
import { useMemberSettings } from '../utils/memberSettings'
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


type NavItem = { label: string; path: string; icon: string; badge: null | 'mail' | 'jobs' | 'alerts'; wip?: boolean }

// Kleurpalet voor door admin beheerde links (cyclisch toegekend).
const LINK_COLORS = ['#00b4d8', '#f0a030', '#4ade80', '#a78bfa', '#f472b6', '#e05555']

// Standaard externe links (als de admin er nog geen heeft ingesteld in siteconfig).
const DEFAULT_LINKS = [
  { label: 'Insidious Auth',            url: 'https://auth.insidiousevil.org/',    color: '#e05555' },
  { label: 'Dutch Legions',             url: 'https://dutchlegions.nl/dashboard/', color: '#f0a030' },
  { label: 'Dutch Legions - Logistics', url: 'https://procurer.space/',            color: '#4ade80' },
]
// Een menu-key is geldig als het een bekende pagina is of een externe (http) link.
const isExternal = (k: string) => /^https?:\/\//.test(k)
const keepKey = (k: string) => !!ITEM_BY_PATH[k] || isExternal(k)

// Registry van alle navigeerbare pagina's (los van hoe ze in de menu-boom staan)
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',    path: '/',           icon: '🛸', badge: null },
  { label: 'Character',    path: '/character',  icon: '🧑‍🚀', badge: null },
  { label: 'Skills',       path: '/skills',     icon: '🧠', badge: null },
  { label: 'Mail',         path: '/mail',       icon: '📨', badge: 'mail' },
  { label: 'Assets',       path: '/assets',     icon: '🗃️', badge: null },
  { label: 'Notities',     path: '/notes',      icon: '🗒️', badge: null },
  { label: 'Finance',      path: '/wallet',     icon: '🏦', badge: null },
  { label: 'Market',       path: '/market',     icon: '🛒', badge: null },
  { label: 'Contracts',    path: '/contracts',  icon: '🤝', badge: null },
  { label: 'Hauling',      path: '/hauling',    icon: '🛻', badge: null },
  { label: 'Killboard',    path: '/kills',      icon: '☠️', badge: null },
  { label: 'Wars',         path: '/wars',       icon: '🗡️', badge: null },
  { label: 'Fleet',        path: '/fleet',      icon: '🛰️', badge: null },
  { label: 'Ratting',      path: '/ratting',    icon: '🪙', badge: null },
  { label: 'Industry',     path: '/industry',   icon: '🔩', badge: 'jobs' },
  { label: 'Mining',       path: '/mining',     icon: '⚒️', badge: null },
  { label: 'Planets',      path: '/planets',    icon: '🌑', badge: null },
  { label: 'PI-planner',   path: '/pi-planner', icon: '🌐', badge: null },
  { label: 'Fittings',     path: '/fittings',   icon: '🛠️', badge: null },
  { label: 'Blueprints',   path: '/blueprints', icon: '📐', badge: null },
  { label: 'Build vs Buy', path: '/buildvsbuy', icon: '⚖️', badge: null },
  { label: 'Bouwproject',  path: '/build',      icon: '🔨', badge: null },
  { label: 'Industrie-kosten', path: '/industry-cost', icon: '🧾', badge: null, wip: true },
  { label: 'Recruitment',  path: '/recruit-funnel', icon: '📋', badge: null, wip: true },
  { label: 'Courier-calc', path: '/courier-calc', icon: '📬', badge: null, wip: true },
  { label: 'Boosters',     path: '/boosters', icon: '💉', badge: null, wip: true },
  { label: 'Trading P&L',  path: '/trading-pnl', icon: '💹', badge: null, wip: true },
  { label: 'Kills v/d maand', path: '/kill-of-week', icon: '🥇', badge: null, wip: true },
  { label: 'Leaderboard',  path: '/leaderboard', icon: '🏅', badge: null, wip: true },
]
const ITEM_BY_PATH: Record<string, NavItem> = Object.fromEntries(NAV_ITEMS.map(i => [i.path, i]))

// Menu-boom: een geordende lijst van losse items of uitklapbare groepen.
export type LayoutEntry =
  | { kind: 'item'; path: string }
  | { kind: 'group'; id: string; label: string; icon: string; children: string[]; adminOnly?: boolean }

const DEFAULT_LAYOUT: LayoutEntry[] = [
  { kind: 'item', path: '/' },
  { kind: 'group', id: 'grp-character', label: 'Character', icon: '◈', children: ['/character', '/skills', '/mail', '/assets', '/notes'] },
  { kind: 'group', id: 'grp-finance',   label: 'Finance',   icon: '◑', children: ['/wallet', '/market', '/contracts', '/hauling'] },
  { kind: 'group', id: 'grp-industry',  label: 'Industrie', icon: '◫', children: ['/industry', '/mining', '/planets', '/fittings', '/blueprints', '/buildvsbuy', '/build'] },
  { kind: 'group', id: 'grp-pvp',       label: 'PvP',       icon: '⚔', children: ['/kills', '/fleet', '/ratting'] },
]

const NAV_LS_KEY = 'nav_layout_v1'
// Onbekende paden eruit + nieuwe pagina's die nog nergens staan onderaan toevoegen
function cleanLayout(layout: LayoutEntry[]): LayoutEntry[] {
  const present = new Set<string>()
  const clean: LayoutEntry[] = []
  for (const e of layout) {
    if (e.kind === 'group') {
      const children = (e.children ?? []).filter(keepKey)
      children.forEach(p => present.add(p))
      clean.push({ ...e, children })
    } else if (e.kind === 'item' && keepKey(e.path)) {
      present.add(e.path); clean.push(e)
    }
  }
  // Nieuwe pagina's die nog nergens staan: gewone items bovenaan; WIP-items in de
  // 'Ontwikkeling'-groep (bestaande hergebruikt, anders nieuw + admin-only).
  const missingTop: string[] = []
  const missingWip: string[] = []
  for (const i of NAV_ITEMS) if (!present.has(i.path)) (i.wip ? missingWip : missingTop).push(i.path)
  for (const p of missingTop) clean.push({ kind: 'item', path: p })
  if (missingWip.length) {
    const gi = clean.findIndex(e => e.kind === 'group' && /^ontwikkeling$/i.test(e.label))
    const g = gi >= 0 ? clean[gi] : null
    if (g && g.kind === 'group') clean[gi] = { ...g, children: [...g.children, ...missingWip] }
    else clean.push({ kind: 'group', id: 'grp-ontwikkeling', label: 'Ontwikkeling', icon: '🚧', children: missingWip, adminOnly: true })
  }
  return clean
}
export function loadLayout(): LayoutEntry[] {
  let layout: LayoutEntry[] = DEFAULT_LAYOUT
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_LS_KEY) ?? 'null')
    if (Array.isArray(saved) && saved.length) layout = saved
  } catch { /* default */ }
  return cleanLayout(layout)
}
export function saveLayout(l: LayoutEntry[]) { try { localStorage.setItem(NAV_LS_KEY, JSON.stringify(l)) } catch { /* ignore */ } }

const ADMIN_CHAR_ID = 1831618559

// Voegt de actuele externe links in de layout: verdwenen links eruit, ontbrekende in
// een groep met de naam 'Links' (bestaande hergebruikt, anders nieuw). Puur (geen state).
function mergeLinks(layout: LayoutEntry[], urls: string[]): LayoutEntry[] {
  const urlSet = new Set(urls)
  let next: LayoutEntry[] = layout
    .map(e => e.kind === 'group' ? { ...e, children: e.children.filter(c => !isExternal(c) || urlSet.has(c)) } : e)
    .filter(e => e.kind !== 'item' || !isExternal(e.path) || urlSet.has(e.path))
  const present = new Set<string>()
  for (const e of next) { if (e.kind === 'group') e.children.forEach(c => present.add(c)); else present.add(e.path) }
  const missing = urls.filter(u => !present.has(u))
  if (missing.length) {
    let idx = next.findIndex(e => e.kind === 'group' && /^links$/i.test(e.label))
    if (idx === -1) { next = [...next, { kind: 'group', id: 'grp-links', label: 'Links', icon: '🔗', children: [] }]; idx = next.length - 1 }
    next = next.map((e, i) => i === idx && e.kind === 'group' ? { ...e, children: [...e.children, ...missing] } : e)
  }
  return next
}

const rowStyle = (isActive: boolean, collapsed: boolean, nested: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: '0.65rem',
  padding: collapsed ? '0.55rem 0' : nested ? '0.4rem 1rem 0.4rem 0.9rem' : '0.55rem 1rem',
  justifyContent: collapsed ? 'center' : 'flex-start',
  position: 'relative', textDecoration: 'none',
  background: isActive ? 'rgba(0,180,216,0.07)' : 'transparent',
  borderLeft: `2px solid ${isActive ? 'var(--blue)' : 'transparent'}`,
  color: isActive ? 'var(--blue)' : nested ? 'var(--text-dim)' : 'var(--text)',
  userSelect: 'none',
  fontSize: nested ? '0.72rem' : '0.75rem',
  marginLeft: nested ? -1 : undefined,
})

// Eén navigeerbaar item (zowel top-level als genest in een groep)
function LeafRow({ item, badgeCount, collapsed, nested, label }: { item: NavItem; badgeCount: (b: NavItem['badge']) => number; collapsed?: boolean; nested?: boolean; label?: string }) {
  const count = badgeCount(item.badge)
  const name = label ?? item.label
  return (
    <NavLink to={item.path} end={item.path === '/'} title={collapsed ? name : undefined}
      style={({ isActive }) => rowStyle(isActive, !!collapsed, !!nested)}>
      <span style={{ fontSize: nested ? 12 : 13, width: 16, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
      {!collapsed && <span style={nested
        ? { fontWeight: 400, letterSpacing: '0.03em', flex: 1 }
        : { fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1 }}>{name}</span>}
      {!collapsed && <Badge count={count} />}
      {collapsed && count > 0 && <span style={{ position: 'absolute', top: 5, right: 9, width: 7, height: 7, borderRadius: '50%', background: 'var(--red)' }} />}
    </NavLink>
  )
}

// Externe link-regel (opent in nieuw tabblad)
function LinkRow({ url, label, color, collapsed, nested }: { url: string; label: string; color: string; collapsed?: boolean; nested?: boolean }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" title={collapsed ? label : undefined}
      style={{ ...rowStyle(false, !!collapsed, !!nested) }}>
      <span style={{ fontSize: nested ? 9 : 10, width: 16, textAlign: 'center', flexShrink: 0, color }}>●</span>
      {!collapsed && <span style={{ fontWeight: 400, letterSpacing: '0.03em', flex: 1 }}>{label}</span>}
      {!collapsed && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>↗</span>}
    </a>
  )
}

// Uitklapbare groep (hoofd-item met genest lijstje); kinderen worden via renderChild gerenderd
function GroupRow({ group, badgeCount, collapsed, open, onToggle, renderChild, adminOnly }: { group: Extract<LayoutEntry, { kind: 'group' }>; badgeCount: (b: NavItem['badge']) => number; collapsed?: boolean; open: boolean; onToggle: () => void; renderChild: (key: string) => React.ReactNode; adminOnly?: boolean }) {
  const location = useLocation()
  const childActive = group.children.includes(location.pathname)
  const totalBadge = group.children.reduce((s, p) => s + badgeCount(ITEM_BY_PATH[p]?.badge ?? null), 0)
  const expanded = open   // de in-/uitklap-keuze is leidend, ook als je op een subpagina staat
  return (
    <div>
      <div onClick={onToggle} title={collapsed ? group.label : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.65rem', cursor: 'pointer',
          padding: collapsed ? '0.55rem 0' : '0.55rem 1rem', justifyContent: collapsed ? 'center' : 'flex-start',
          color: childActive ? 'var(--blue)' : 'var(--text)', userSelect: 'none',
          borderLeft: `2px solid ${childActive && !expanded ? 'var(--blue)' : 'transparent'}`,
        }}>
        <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>{group.icon}</span>
        {!collapsed && <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', flex: 1, textTransform: 'uppercase' }}>{group.label}{adminOnly ? <span title="Alleen zichtbaar voor admin" style={{ marginLeft: 5, opacity: 0.8 }}>🔒</span> : ''}</span>}
        {!collapsed && totalBadge > 0 && !expanded && <Badge count={totalBadge} />}
        {!collapsed && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{expanded ? '▾' : '▸'}</span>}
      </div>
      {!collapsed && expanded && (
        <div style={{ marginLeft: '1.1rem', borderLeft: '1px solid var(--border)', paddingTop: 1, paddingBottom: 2 }}>
          {group.children.map(p => renderChild(p))}
        </div>
      )}
    </div>
  )
}

// ── Menu-editor: groepen maken/hernoemen/verwijderen, items verplaatsen & ordenen ──
const eBtn: React.CSSProperties = { fontSize: '0.62rem', background: 'rgba(255,255,255,0.07)', color: 'var(--text)', border: '1px solid var(--text-dim)', borderRadius: 4, padding: '2px 7px', cursor: 'pointer' }
const eArrow: React.CSSProperties = { fontSize: '0.55rem', lineHeight: 1, background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '0 1px' }
const eInput: React.CSSProperties = { background: 'rgba(0,0,0,0.3)', color: '#fff', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 4px', fontSize: '0.7rem' }
const eSelect: React.CSSProperties = { fontSize: '0.6rem', background: 'rgba(0,0,0,0.35)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 3, maxWidth: 90 }

function NavEditor({ layout, onChange, onReset, labelOf, onRenameItem, onPublish, saved, iconFor, known }: { layout: LayoutEntry[]; onChange: (l: LayoutEntry[]) => void; onReset: () => void; labelOf: (p: string) => string; onRenameItem: (p: string, v: string) => void; onPublish: () => void; saved: 'idle' | 'saving' | 'done'; iconFor: (k: string) => string; known: (k: string) => boolean }) {
  const groups = layout.filter((e): e is Extract<LayoutEntry, { kind: 'group' }> => e.kind === 'group')
  const moveTop = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= layout.length) return; const n = [...layout];[n[i], n[j]] = [n[j], n[i]]; onChange(n) }
  const addGroup = () => onChange([...layout, { kind: 'group', id: 'grp-' + Date.now().toString(36), label: 'Nieuwe groep', icon: '▦', children: [] }])
  const renameGroup = (id: string, label: string) => onChange(layout.map(e => e.kind === 'group' && e.id === id ? { ...e, label } : e))
  const setIcon = (id: string, icon: string) => onChange(layout.map(e => e.kind === 'group' && e.id === id ? { ...e, icon: icon || '▦' } : e))
  const setAdminOnly = (id: string, v: boolean) => onChange(layout.map(e => e.kind === 'group' && e.id === id ? { ...e, adminOnly: v } : e))
  const deleteGroup = (id: string) => { const n: LayoutEntry[] = []; for (const e of layout) { if (e.kind === 'group' && e.id === id) e.children.forEach(p => n.push({ kind: 'item', path: p })); else n.push(e) } onChange(n) }
  const moveChild = (gid: string, idx: number, dir: -1 | 1) => onChange(layout.map(e => {
    if (e.kind !== 'group' || e.id !== gid) return e
    const j = idx + dir; if (j < 0 || j >= e.children.length) return e
    const ch = [...e.children];[ch[idx], ch[j]] = [ch[j], ch[idx]]; return { ...e, children: ch }
  }))
  const moveItem = (path: string, target: string) => {
    let n: LayoutEntry[] = layout.map(e => e.kind === 'group' ? { ...e, children: e.children.filter(p => p !== path) } : e).filter(e => !(e.kind === 'item' && e.path === path))
    if (target === '__top') n = [...n, { kind: 'item', path }]
    else n = n.map(e => e.kind === 'group' && e.id === target ? { ...e, children: [...e.children, path] } : e)
    onChange(n)
  }
  const groupSelect = (path: string, current: string) => (
    <select value={current} onChange={e => moveItem(path, e.target.value)} title="Naar groep verplaatsen" style={eSelect}>
      <option value="__top">— los —</option>
      {groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
    </select>
  )

  return (
    <div style={{ padding: '2px 6px 8px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={addGroup} style={eBtn}>＋ Groep</button>
        <button onClick={onReset} style={eBtn} title="Terug naar de standaard-indeling">↺ Standaard</button>
      </div>
      <button onClick={onPublish} disabled={saved === 'saving'}
        style={{ ...eBtn, width: '100%', marginBottom: 8, padding: '5px', background: saved === 'done' ? 'rgba(62,207,110,0.2)' : 'rgba(0,180,216,0.15)', borderColor: saved === 'done' ? '#3ecf6e' : 'var(--blue)', color: saved === 'done' ? '#3ecf6e' : 'var(--blue)', fontWeight: 700 }}
        title="Sla deze indeling op zodat alle members 'm zien">
        {saved === 'saving' ? '⏳ opslaan…' : saved === 'done' ? '✓ opgeslagen voor iedereen' : '💾 Opslaan voor iedereen'}
      </button>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.4 }}>
        Wijzigingen zie je meteen zelf; klik <strong>Opslaan voor iedereen</strong> om ze voor alle members te publiceren.
      </div>
      {layout.map((e, i) => e.kind === 'group' ? (
        <div key={e.id} style={{ border: '1px solid var(--border)', borderRadius: 5, marginBottom: 6, padding: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ display: 'flex', flexDirection: 'column' }}><button onClick={() => moveTop(i, -1)} style={eArrow}>▲</button><button onClick={() => moveTop(i, 1)} style={eArrow}>▼</button></span>
            <input value={e.icon} onChange={ev => setIcon(e.id, ev.target.value.slice(0, 2))} style={{ ...eInput, width: 26, textAlign: 'center' }} title="Icoon" />
            <input value={e.label} onChange={ev => renameGroup(e.id, ev.target.value)} style={{ ...eInput, flex: 1, minWidth: 0, fontWeight: 700 }} />
            <button onClick={() => setAdminOnly(e.id, !e.adminOnly)}
              title={e.adminOnly ? 'Alleen zichtbaar voor admin — klik om voor iedereen te tonen' : 'Voor iedereen zichtbaar — klik om alleen-admin te maken'}
              style={{ fontSize: '0.78rem', lineHeight: 1, cursor: 'pointer', flexShrink: 0, border: 'none', borderRadius: 4, padding: '2px 3px',
                background: e.adminOnly ? 'rgba(240,160,48,0.3)' : 'transparent', opacity: e.adminOnly ? 1 : 0.4 }}>🔒</button>
            <button onClick={() => deleteGroup(e.id)} title="Groep opheffen (items worden los)" style={{ ...eArrow, color: 'var(--red)', fontSize: '0.7rem' }}>✕</button>
          </div>
          <div style={{ marginLeft: 6, marginTop: 3 }}>
            {e.children.length === 0 && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', padding: '2px 4px' }}>leeg — verplaats items hierheen</div>}
            {e.children.map((p, ci) => known(p) && (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 2px', fontSize: '0.7rem' }}>
                <span style={{ display: 'flex', flexDirection: 'column' }}><button onClick={() => moveChild(e.id, ci, -1)} style={eArrow}>▲</button><button onClick={() => moveChild(e.id, ci, 1)} style={eArrow}>▼</button></span>
                <span style={{ width: 14, textAlign: 'center' }}>{iconFor(p)}</span>
                <input value={labelOf(p)} onChange={ev => onRenameItem(p, ev.target.value)} style={{ ...eInput, flex: 1, minWidth: 0 }} title="Naam aanpassen" />
                {groupSelect(p, e.id)}
              </div>
            ))}
          </div>
        </div>
      ) : known(e.path) ? (
        <div key={e.path} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px', marginBottom: 2, fontSize: '0.7rem' }}>
          <span style={{ display: 'flex', flexDirection: 'column' }}><button onClick={() => moveTop(i, -1)} style={eArrow}>▲</button><button onClick={() => moveTop(i, 1)} style={eArrow}>▼</button></span>
          <span style={{ width: 14, textAlign: 'center' }}>{iconFor(e.path)}</span>
          <input value={labelOf(e.path)} onChange={ev => onRenameItem(e.path, ev.target.value)} style={{ ...eInput, flex: 1, minWidth: 0 }} title="Naam aanpassen" />
          {groupSelect(e.path, '__top')}
        </div>
      ) : null)}
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
          <EveImage category="characters" id={selected.characterId} variation="portrait" size={32} px={26} round
            style={{ border: '1px solid var(--blue)', display: 'block', flexShrink: 0 }} />
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
          {selected && (data?.corpId || data?.allianceId) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.12rem' }}>
              {data?.corpId && <EveImage category="corporations" id={data.corpId} variation="logo" size={32} px={13} style={{ borderRadius: 2, flexShrink: 0 }} />}
              {data?.allianceId && <EveImage category="alliances" id={data.allianceId} variation="logo" size={32} px={13} style={{ borderRadius: 2, flexShrink: 0 }} />}
              {data?.allianceName && <span style={{ fontSize: '0.57rem', color: 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.allianceName}</span>}
            </div>
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
                  <EveImage category="characters" id={t.characterId} variation="portrait" size={32} px={26} round
                    style={{ border: `1px solid ${sel ? 'var(--blue)' : 'var(--border)'}`, display: 'block', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: sel ? 'var(--blue)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.characterName}
                    </div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                      {d?.wallet != null ? `${fmtISK(d.wallet)} ISK` : '—'}
                    </div>
                    {(d?.corpId || d?.allianceId) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.08rem' }}>
                        {d?.corpId && <EveImage category="corporations" id={d.corpId} variation="logo" size={32} px={13} style={{ borderRadius: 2, flexShrink: 0 }} />}
                        {d?.allianceId && <EveImage category="alliances" id={d.allianceId} variation="logo" size={32} px={13} style={{ borderRadius: 2, flexShrink: 0 }} />}
                        {d?.allianceName && <span style={{ fontSize: '0.57rem', color: 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.allianceName}</span>}
                      </div>
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

export default function Sidebar({ mobile = false, open = false, onClose }: { mobile?: boolean; open?: boolean; onClose?: () => void } = {}) {
  const { tokens, removeToken, selectedCharId, setSelectedCharId, mainCharId, setMainCharId } = useAuth()
  const { previewMode } = useLayoutMode()
  const alerts = useAlerts()
  const settings = useSiteSettings()
  const siteConfig = useSiteConfig()   // accentkleur (auto toegepast) + handige links
  const localChatOn = settings.local_chat !== false // default zichtbaar tenzij admin het uitzet
  const isAdminChar = tokens.some(t => t.characterId === 1831618559)
  const member = useMemberSettings()
  const [layout, setLayout] = useState<LayoutEntry[]>(loadLayout)
  const applyLayout = (l: LayoutEntry[]) => { setLayout(l); saveLayout(l) }
  const resetNav = () => { try { localStorage.removeItem('nav_layout_v1'); localStorage.removeItem('nav_labels') } catch { /* ignore */ }; setLabels({}); setLayout(loadLayout()) }
  const [navEdit, setNavEdit] = useState(false)
  // Eigen labels per pagina (overschrijft de standaardnaam)
  const [labels, setLabels] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem('nav_labels') ?? '{}') || {} } catch { return {} } })
  // Externe links (admin-config of standaard) — ook plaatsbaar als menu-items, gekoppeld op URL
  const links = siteConfig.links.length ? siteConfig.links.map((l, i) => ({ label: l.label, url: l.url, color: LINK_COLORS[i % LINK_COLORS.length] })) : DEFAULT_LINKS
  const linkByUrl = new Map(links.map(l => [l.url, l] as const))
  const isInternal = (k: string) => !!ITEM_BY_PATH[k]
  const knownKey = (k: string) => isInternal(k) || linkByUrl.has(k)
  const iconFor = (k: string) => isInternal(k) ? ITEM_BY_PATH[k].icon : '🔗'
  const labelOf = (key: string) => { const o = labels[key]; if (o && o.trim()) return o; return isInternal(key) ? ITEM_BY_PATH[key].label : (linkByUrl.get(key)?.label ?? key) }
  const renameItem = (path: string, value: string) => setLabels(prev => {
    const next = { ...prev, [path]: value.slice(0, 24) }
    try { localStorage.setItem('nav_labels', JSON.stringify(next)) } catch { /* ignore */ }
    return next
  })

  // Gedeelde menu-indeling van de server laden (geldt voor iedereen; overschrijft de lokale cache)
  useEffect(() => {
    fetch('/api/navconfig.php').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return
      if (Array.isArray(d.layout) && d.layout.length) { const l = cleanLayout(d.layout); setLayout(l); saveLayout(l) }
      if (d.labels && typeof d.labels === 'object' && !Array.isArray(d.labels)) { setLabels(d.labels); try { localStorage.setItem('nav_labels', JSON.stringify(d.labels)) } catch { /* ignore */ } }
    }).catch(() => { /* offline: lokale cache */ })
  }, [])
  // De getoonde indeling = opgeslagen layout mét de actuele links erin (afgeleid → geen race)
  const displayLayout = mergeLinks(layout, links.map(l => l.url))

  // Eén menu-key renderen: interne pagina (LeafRow) of externe link (LinkRow)
  const renderEntry = (key: string, nested: boolean, collapsed = false) => {
    if (isInternal(key)) return <LeafRow key={key} item={ITEM_BY_PATH[key]} badgeCount={badgeCount} nested={nested} collapsed={collapsed} label={labelOf(key)} />
    const l = linkByUrl.get(key); if (!l) return null
    return <LinkRow key={key} url={l.url} label={labelOf(key)} color={l.color} nested={nested} collapsed={collapsed} />
  }

  // Admin publiceert de huidige indeling naar iedereen
  const [navSaved, setNavSaved] = useState<'idle' | 'saving' | 'done'>('idle')
  const publishNav = async () => {
    setNavSaved('saving')
    try {
      const r = await fetch('/api/navconfig.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: ADMIN_CHAR_ID, layout, labels }) })
      setNavSaved(r.ok ? 'done' : 'idle')
      if (r.ok) setTimeout(() => setNavSaved('idle'), 2000)
    } catch { setNavSaved('idle') }
  }
  const isHidden = (p: string) => member.hiddenTabs.includes(p)
  // welke groepen staan open (persistent per browser)
  // Groepen staan standaard OPEN; we onthouden welke je dichtklapt (zo zijn nieuwe groepen meteen zichtbaar).
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { const s = JSON.parse(localStorage.getItem('nav_closed_groups') ?? 'null'); if (Array.isArray(s)) return new Set(s) } catch { /* default */ }
    return new Set()
  })
  const toggleGroup = (id: string) => setClosedGroups(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id)
    try { localStorage.setItem('nav_closed_groups', JSON.stringify([...n])) } catch { /* ignore */ }
    return n
  })

  // Inklapbaar op desktop (op mobiel is het altijd een volledige drawer)
  const [collapsedRaw, setCollapsedRaw] = useState(() => localStorage.getItem('sidebar_collapsed') === '1')
  const collapsed = !mobile && collapsedRaw
  function toggleCollapsed() {
    setCollapsedRaw(c => { localStorage.setItem('sidebar_collapsed', c ? '0' : '1'); return !c })
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
      width: mobile ? 230 : collapsed ? 58 : 200,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      height: '100vh',
      transition: mobile ? 'transform 0.25s ease' : 'width 0.18s ease',
      ...(mobile
        ? {
            position: 'fixed' as const, top: 0, left: 0, bottom: 0, zIndex: 200,
            transform: open ? 'translateX(0)' : 'translateX(-100%)',
            boxShadow: open ? '4px 0 24px rgba(0,0,0,0.5)' : 'none',
          }
        : { position: 'sticky' as const, top: 0 }),
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', padding: mobile ? '0.7rem 1rem' : collapsed ? '1.1rem 0' : '1.1rem 1rem', borderBottom: '1px solid var(--border)' }}>
        {!collapsed && (
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
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {!collapsed && (
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
          )}
          {mobile && (
            <button
              onClick={onClose}
              aria-label="Menu sluiten"
              style={{
                background: 'rgba(224,85,85,0.07)',
                border: '1px solid rgba(224,85,85,0.2)',
                borderRadius: 3,
                color: 'var(--red)',
                cursor: 'pointer',
                padding: '0.25rem 0.5rem',
                lineHeight: 1,
                fontSize: '0.95rem',
              }}
            >✕</button>
          )}
          {!mobile && (
            <button
              onClick={toggleCollapsed}
              title={collapsed ? 'Menu uitklappen' : 'Menu inklappen'}
              aria-label={collapsed ? 'Menu uitklappen' : 'Menu inklappen'}
              style={{
                background: 'rgba(0,180,216,0.07)',
                border: '1px solid rgba(0,180,216,0.2)',
                borderRadius: 3,
                color: 'var(--blue)',
                cursor: 'pointer',
                padding: '0.25rem 0.45rem',
                lineHeight: 1,
                fontSize: '0.8rem',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,180,216,0.18)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,180,216,0.07)' }}
            >{collapsed ? '»' : '«'}</button>
          )}
        </div>
      </div>

      {/* Nav */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '0.4rem 0' }}>
        {!collapsed && isAdminChar && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 0.6rem 2px' }}>
            <button onClick={() => setNavEdit(v => !v)} title="Menu indelen voor iedereen — groepen maken en items verplaatsen"
              style={{ fontSize: '0.6rem', background: 'none', border: 'none', cursor: 'pointer', color: navEdit ? 'var(--blue)' : 'var(--text-dim)' }}>
              {navEdit ? '✓ klaar' : '✎ menu'}
            </button>
          </div>
        )}
        {navEdit && !collapsed && isAdminChar
          ? <NavEditor layout={displayLayout} onChange={applyLayout} onReset={resetNav} labelOf={labelOf} onRenameItem={renameItem} onPublish={publishNav} saved={navSaved} iconFor={iconFor} known={knownKey} />
          : collapsed
          // Ingeklapt: platte icoon-rail (alle zichtbare items op volgorde van de boom)
          ? displayLayout.flatMap(e => e.kind === 'group' ? (e.adminOnly && !isAdminChar ? [] : e.children) : [e.path])
              .filter(p => knownKey(p) && !isHidden(p))
              .map(p => renderEntry(p, false, true))
          // Uitgeklapt: losse items + uitklapbare groepen
          : displayLayout.map(e => {
              if (e.kind === 'item') return knownKey(e.path) && !isHidden(e.path) ? renderEntry(e.path, false) : null
              if (e.adminOnly && !isAdminChar) return null   // alleen-admin groep: verberg voor members
              const visibleChildren = e.children.filter(p => knownKey(p) && !isHidden(p))
              if (visibleChildren.length === 0) return null
              return <GroupRow key={e.id} group={{ ...e, children: visibleChildren }} badgeCount={badgeCount} open={!closedGroups.has(e.id)} onToggle={() => toggleGroup(e.id)} renderChild={k => renderEntry(k, true)} adminOnly={e.adminOnly} />
            })}

        {/* Local Chat — zichtbaar voor members als de admin het aan heeft staan (default aan) */}
        {localChatOn && !member.hiddenTabs.includes('/local') && (
          <NavLink
            to="/local"
            title={collapsed ? 'Local Chat' : undefined}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: '0.65rem',
              padding: collapsed ? '0.55rem 0' : '0.55rem 1rem',
              justifyContent: collapsed ? 'center' : 'flex-start',
              textDecoration: 'none',
              background: isActive ? 'rgba(0,180,216,0.07)' : 'transparent',
              borderLeft: `2px solid ${isActive ? 'var(--blue)' : 'transparent'}`,
              color: isActive ? 'var(--blue)' : 'var(--text)',
            })}
          >
            <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>⌁</span>
            {!collapsed && <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1 }}>Local Chat</span>}
          </NavLink>
        )}

        {/* Instellingen — altijd zichtbaar voor members */}
        <NavLink
          to="/settings"
          title={collapsed ? 'Instellingen' : undefined}
          style={({ isActive }) => ({
            display: 'flex', alignItems: 'center', gap: '0.65rem',
            padding: collapsed ? '0.55rem 0' : '0.55rem 1rem',
            justifyContent: collapsed ? 'center' : 'flex-start',
            textDecoration: 'none',
            background: isActive ? 'rgba(0,180,216,0.07)' : 'transparent',
            borderLeft: `2px solid ${isActive ? 'var(--blue)' : 'transparent'}`,
            color: isActive ? 'var(--blue)' : 'var(--text)',
          })}
        >
          <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>⚙</span>
          {!collapsed && <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1 }}>Instellingen</span>}
        </NavLink>

        {/* Admin — alleen het admin-character, niet in preview */}
        {isAdminChar && !previewMode && (
          <>
            <div style={{ height: 1, background: 'var(--border)', margin: collapsed ? '0.4rem 0.5rem' : '0.4rem 1rem' }} />
            <NavLink
              to="/admin"
              title={collapsed ? 'Admin' : undefined}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '0.65rem',
                padding: collapsed ? '0.55rem 0' : '0.55rem 1rem',
                justifyContent: collapsed ? 'center' : 'flex-start',
                textDecoration: 'none',
                background: isActive ? 'rgba(224,85,85,0.07)' : 'transparent',
                borderLeft: `2px solid ${isActive ? 'var(--red)' : 'transparent'}`,
                color: isActive ? 'var(--red)' : 'rgba(224,85,85,0.6)',
              })}
            >
              <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>⚑</span>
              {!collapsed && <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.06em', flex: 1 }}>Admin</span>}
            </NavLink>
          </>
        )}
      </div>

      {/* De externe corp-links zitten nu in de menu-boom hierboven (groep 'Links'). */}

      {/* Accountbeheer + character-switcher staan nu op de Instellingen-pagina. */}
      <NavLink
        to="/settings"
        title={collapsed ? 'Accounts & instellingen' : undefined}
        style={({ isActive }) => ({
          display: 'flex', alignItems: 'center', gap: '0.6rem', borderTop: '1px solid var(--border)',
          padding: collapsed ? '0.6rem 0' : '0.6rem 0.85rem', justifyContent: collapsed ? 'center' : 'flex-start',
          textDecoration: 'none', color: isActive ? 'var(--blue)' : 'var(--text-dim)',
          background: isActive ? 'rgba(0,180,216,0.05)' : 'transparent',
        })}
      >
        {selectedCharId
          ? <EveImage category="characters" id={selectedCharId} variation="portrait" size={32} px={26} round style={{ border: '1px solid var(--blue)', display: 'block', flexShrink: 0 }} />
          : <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(0,180,216,0.15)', border: '1px solid rgba(0,180,216,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--blue)', flexShrink: 0 }}>⊞</div>}
        {!collapsed && <span style={{ fontSize: '0.72rem', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedCharId ? (tokens.find(t => t.characterId === selectedCharId)?.characterName ?? 'Account') : `Accounts (${tokens.length})`}
        </span>}
      </NavLink>
    </nav>
  )
}
