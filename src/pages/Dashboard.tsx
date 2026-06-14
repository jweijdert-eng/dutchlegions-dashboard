import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useAlerts } from '../context/useAlerts'
import { useLayoutMode } from '../context/LayoutModeContext'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, rectSortingStrategy, horizontalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  getWallet, getWalletJournal, getSkillQueue, getIndustryJobs, getMarketOrders,
  getKillmailDetail, getCharacterInfo, getCorporation, getAlliance, resolveNames,
  getCalendar, getCalendarEventDetail,
  type WalletJournalEntry, type SkillQueueEntry, type IndustryJob,
  type MarketOrder, type CorporationInfo, type AllianceInfo,
  type CalendarEventDetail,
} from '../api/esi'
import { getKills, getLosses, type ZkillEntry } from '../api/zkillboard'
import Layout, { PageHeader } from '../components/Layout'
import WalletChart from '../components/WalletChart'
import RattingWidget from '../components/RattingWidget'
import KillsTable, { type KillEntry } from '../components/KillsTable'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'
import LocalChatWidget from '../components/LocalChatWidget'

const GAP = '0.75rem'

function fmtISK(v: number) {
  const abs = Math.abs(v), s = v < 0 ? '−' : ''
  if (abs >= 1e9) return `${s}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${s}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${s}${(abs / 1e3).toFixed(0)}K`
  return `${s}${abs.toFixed(0)}`
}

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Klaar'
  const d = Math.floor(ms / 86400000)
  const h = Math.floor((ms % 86400000) / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (d > 0) return `${d}d ${h}u`
  if (h > 0) return `${h}u ${m}m`
  return `${m}m`
}

function dayEarnings(journal: WalletJournalEntry[], daysAgo: number): number {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const key = d.toISOString().slice(0, 10)
  return journal.filter(e => e.date.startsWith(key) && e.amount > 0).reduce((s, e) => s + e.amount, 0)
}

const REF_ICONS: Record<string, string> = {
  market_transaction: '◊', contract_price: '◧', industry_job_tax: '◫',
  bounty_prizes: '◉', agent_mission_reward: '◎', manufacturing: '◫',
  player_trading: '◊', contract_reward: '◧', skill_purchase: '◎',
}

// ─── Widget IDs & order ───────────────────────────────────────────────────────

const WIDGET_IDS = ['skill-queue', 'industry-jobs', 'market-orders', 'recent-tx', 'net-worth', 'kill-stats', 'income', 'upcoming'] as const
type WidgetId = typeof WIDGET_IDS[number]
const LS_KEY = 'dashboard-widget-order'

function loadOrder(): WidgetId[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as string[]
    const valid = saved.filter((id): id is WidgetId => (WIDGET_IDS as readonly string[]).includes(id))
    const missing = WIDGET_IDS.filter(id => !valid.includes(id))
    return [...valid, ...missing]
  } catch {
    return [...WIDGET_IDS]
  }
}

function saveOrder(order: WidgetId[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(order))
}

const LS_KEY_CHARS = 'dashboard-char-order'

function loadCharOrder(tokenIds: number[]): number[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY_CHARS) ?? '[]') as number[]
    const valid   = saved.filter(id => tokenIds.includes(id))
    const missing = tokenIds.filter(id => !valid.includes(id))
    return [...valid, ...missing]
  } catch {
    return tokenIds
  }
}

function saveCharOrder(order: number[]) {
  localStorage.setItem(LS_KEY_CHARS, JSON.stringify(order))
}

// ─── Widgets ──────────────────────────────────────────────────────────────────

function Section({ title, link, children, dragHandle }: { title: string; link?: string; children: React.ReactNode; dragHandle?: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.55rem 0.875rem', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {dragHandle}
          <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.15em' }}>{title}</span>
        </div>
        {link && (
          <button onClick={() => navigate(link)} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '0.6rem', cursor: 'pointer', padding: 0 }}>
            Meer →
          </button>
        )}
      </div>
      <div style={{ flex: 1, padding: '0.625rem 0.875rem', overflowY: 'auto' }}>{children}</div>
    </div>
  )
}

function SortableWidget({ id, editMode, children }: { id: WidgetId; editMode: boolean; children: (dragHandle: React.ReactNode) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  }
  const handle = editMode ? (
    <span
      {...attributes}
      {...listeners}
      style={{ cursor: 'grab', color: 'var(--text-dim)', fontSize: '0.75rem', lineHeight: 1, userSelect: 'none', touchAction: 'none' }}
      title="Verslepen"
    >⠿</span>
  ) : null
  return (
    <div ref={setNodeRef} style={{ ...style, height: '100%' }}>
      {children(handle)}
    </div>
  )
}

function SortableCharCard({ id, editMode, children }: { id: number; editMode: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(id) })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: 'relative',
  }
  return (
    <div ref={setNodeRef} style={style}>
      {editMode && (
        <span
          {...attributes}
          {...listeners}
          style={{ position: 'absolute', top: 6, right: 8, cursor: 'grab', color: 'var(--text-dim)', fontSize: '0.75rem', lineHeight: 1, userSelect: 'none', touchAction: 'none', zIndex: 1 }}
          title="Verslepen"
        >⠿</span>
      )}
      {children}
    </div>
  )
}

function SkillQueueWidget({ queue, nameMap, loading }: { queue: SkillQueueEntry[]; nameMap: Map<number, string>; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  if (queue.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen skills in training</div>

  const now = Date.now()
  const active = queue.find(s => s.start_date && s.finish_date && new Date(s.start_date).getTime() <= now && new Date(s.finish_date).getTime() > now)
  const last   = queue[queue.length - 1]
  const queueEnds = last?.finish_date

  const pct = active?.start_date && active?.finish_date
    ? Math.min(100, ((now - new Date(active.start_date).getTime()) / (new Date(active.finish_date).getTime() - new Date(active.start_date).getTime())) * 100)
    : 0

  return (
    <div>
      {active ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.3rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>
              {nameMap.get(active.skill_id) ?? `Skill ${active.skill_id}`}
              <span style={{ fontSize: '0.65rem', color: 'var(--blue)', marginLeft: '0.35rem' }}>Lvl {active.finished_level}</span>
            </span>
            <span style={{ fontSize: '0.68rem', color: 'var(--gold)', fontWeight: 600 }}>
              {active.finish_date ? timeLeft(active.finish_date) : '—'}
            </span>
          </div>
          <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: '0.45rem' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--blue)', borderRadius: 2, transition: 'width 1s' }} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>Geen actieve training</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.62rem', color: 'var(--text-dim)' }}>
        <span>{queue.length} skill{queue.length !== 1 ? 's' : ''} in queue</span>
        {queueEnds && <span>Queue leeg: {timeLeft(queueEnds)}</span>}
      </div>
    </div>
  )
}

function IndustryWidget({ jobs, nameMap, loading }: { jobs: IndustryJob[]; nameMap: Map<number, string>; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  if (jobs.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen actieve jobs</div>

  const ready  = jobs.filter(j => j.status === 'ready')
  const active = jobs.filter(j => j.status === 'active')
    .sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime())
    .slice(0, 4)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {ready.length > 0 && (
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--gold)', marginBottom: '0.15rem' }}>
          ⬡ {ready.length} job{ready.length !== 1 ? 's' : ''} klaar om op te halen
        </div>
      )}
      {active.map(j => {
        const name = j.product_type_id ? (nameMap.get(j.product_type_id) ?? `Type ${j.product_type_id}`) : 'Onbekend'
        const ms   = new Date(j.end_date).getTime() - Date.now()
        const pct  = Math.min(100, ((Date.now() - new Date(j.start_date).getTime()) / (new Date(j.end_date).getTime() - new Date(j.start_date).getTime())) * 100)
        return (
          <div key={j.job_id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.1rem' }}>
              <span style={{ fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>{name} ×{j.runs}</span>
              <span style={{ fontSize: '0.65rem', color: ms < 3600000 ? 'var(--gold)' : 'var(--text-dim)', flexShrink: 0 }}>{timeLeft(j.end_date)}</span>
            </div>
            <div style={{ height: 2, background: 'var(--border)', borderRadius: 1, marginBottom: '0.2rem' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--blue)', borderRadius: 1 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function OrdersWidget({ orders, loading }: { orders: MarketOrder[]; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  if (orders.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen actieve orders</div>

  const sell = orders.filter(o => !o.is_buy_order)
  const buy  = orders.filter(o => o.is_buy_order)
  const sellISK   = sell.reduce((s, o) => s + o.price * o.volume_remain, 0)
  const escrow    = orders.reduce((s, o) => s + (o.escrow ?? 0), 0)
  const expiring  = orders.filter(o => {
    const exp = new Date(o.issued); exp.setDate(exp.getDate() + o.duration)
    return exp.getTime() - Date.now() < 86400000
  }).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {[
        { label: 'Sell orders',  value: `${sell.length}  ·  ${fmtISK(sellISK)} ISK`, color: 'var(--green)' },
        { label: 'Buy orders',   value: String(buy.length),                           color: 'var(--blue)'  },
        { label: 'Escrow',       value: `${fmtISK(escrow)} ISK`,                     color: 'var(--gold)'  },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{label}</span>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color }}>{value}</span>
        </div>
      ))}
      {expiring > 0 && (
        <div style={{ fontSize: '0.65rem', color: 'var(--red)', marginTop: '0.1rem' }}>
          ⚠ {expiring} order{expiring !== 1 ? 's' : ''} verloopt binnen 24u
        </div>
      )}
    </div>
  )
}

function RecentTxWidget({ journal, loading }: { journal: WalletJournalEntry[]; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  const entries = journal.slice(0, 6)
  if (entries.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen transacties</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
      {entries.map(e => {
        const icon = REF_ICONS[e.ref_type] ?? '·'
        const d = new Date(e.date)
        const ago = Date.now() - d.getTime()
        const time = ago < 3600000 ? `${Math.floor(ago / 60000)}m` : ago < 86400000 ? `${Math.floor(ago / 3600000)}u` : `${Math.floor(ago / 86400000)}d`
        return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', width: 14, textAlign: 'center' }}>{icon}</span>
            <span style={{ flex: 1, fontSize: '0.65rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.description || e.ref_type.replace(/_/g, ' ')}
            </span>
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: e.amount >= 0 ? 'var(--green)' : 'var(--red)', flexShrink: 0 }}>
              {e.amount >= 0 ? '+' : '−'}{fmtISK(Math.abs(e.amount))}
            </span>
            <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', flexShrink: 0, minWidth: 22, textAlign: 'right' }}>{time}</span>
          </div>
        )
      })}
    </div>
  )
}

const INCOME_CATS: Record<string, string> = {
  market_transaction: 'Market', market_escrow_refund: 'Market', transaction_tax: 'Market',
  bounty_prizes: 'Ratting', bounty_prize: 'Ratting', ess_escrow_transfer: 'Ratting', security_funds_redistribution: 'Ratting',
  contract_price: 'Contracten', contract_reward: 'Contracten', contract_deposit_refund: 'Contracten',
  industry_job_tax: 'Industry', manufacturing: 'Industry',
  mining_income: 'Mining',
  agent_mission_reward: 'Missions', agent_mission_time_bonus_reward: 'Missions',
}
const INCOME_COLORS: Record<string, string> = {
  Market: 'var(--green)', Ratting: 'var(--red)', Contracten: 'var(--blue)',
  Industry: '#a78bfa', Mining: '#f0c040', Missions: '#f97316',
}

function NetWorthWidget({ wallet, orders, loading }: { wallet: number; orders: MarketOrder[]; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  const sellValue = orders.filter(o => !o.is_buy_order).reduce((s, o) => s + o.price * o.volume_remain, 0)
  const escrow    = orders.reduce((s, o) => s + (o.escrow ?? 0), 0)
  const total     = wallet + sellValue + escrow
  return (
    <div>
      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--gold)', marginBottom: '0.45rem' }}>{fmtISK(total)} ISK</div>
      {[
        { label: 'Wallet',       value: wallet,    color: 'var(--gold)'  },
        { label: 'Sell orders',  value: sellValue, color: 'var(--green)' },
        { label: 'Escrow',       value: escrow,    color: 'var(--blue)'  },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.18rem' }}>
          <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>{label}</span>
          <span style={{ fontSize: '0.68rem', fontWeight: 600, color }}>{fmtISK(value)} ISK</span>
        </div>
      ))}
    </div>
  )
}

function KillStatsWidget({ entries, loading }: { entries: KillEntry[]; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  if (entries.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen kills/losses gevonden</div>
  const kills      = entries.filter(e => e.type === 'kill')
  const losses     = entries.filter(e => e.type === 'loss')
  const destroyed  = kills.reduce((s, k) => s + k.isk, 0)
  const lost       = losses.reduce((s, k) => s + k.isk, 0)
  const total      = destroyed + lost
  const efficiency = total > 0 ? (destroyed / total) * 100 : 0
  const effColor   = efficiency >= 60 ? 'var(--green)' : efficiency >= 40 ? 'var(--gold)' : 'var(--red)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>ISK efficiëntie</span>
        <span style={{ fontSize: '1rem', fontWeight: 700, color: effColor }}>{efficiency.toFixed(0)}%</span>
      </div>
      <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginBottom: '0.45rem', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${efficiency}%`, background: effColor, borderRadius: 2 }} />
      </div>
      {[
        { label: `${kills.length} kills`,  value: destroyed, color: 'var(--green)' },
        { label: `${losses.length} losses`, value: lost,     color: 'var(--red)'   },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.18rem' }}>
          <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>{label}</span>
          <span style={{ fontSize: '0.68rem', fontWeight: 600, color }}>{fmtISK(value)} ISK</span>
        </div>
      ))}
    </div>
  )
}

function IncomeWidget({ journal, loading }: { journal: WalletJournalEntry[]; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  const income = journal.filter(e => e.amount > 0)
  if (income.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen inkomsten in journaal</div>

  const cats: Record<string, number> = {}
  for (const e of income) {
    const cat = INCOME_CATS[e.ref_type] ?? 'Overig'
    cats[cat] = (cats[cat] ?? 0) + e.amount
  }
  const total   = Object.values(cats).reduce((s, v) => s + v, 0)
  const sorted  = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {sorted.map(([cat, val]) => {
        const pct   = total > 0 ? (val / total) * 100 : 0
        const color = INCOME_COLORS[cat] ?? 'var(--text-dim)'
        return (
          <div key={cat}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.1rem' }}>
              <span style={{ fontSize: '0.66rem', color }}>{cat}</span>
              <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>{pct.toFixed(0)}% · {fmtISK(val)}</span>
            </div>
            <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, opacity: 0.75 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function UpcomingWidget({ queue, jobs, nameMap, jobNames, loading }: {
  queue: SkillQueueEntry[]; jobs: IndustryJob[];
  nameMap: Map<number, string>; jobNames: Map<number, string>; loading: boolean
}) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  const now = Date.now()

  const events: Array<{ time: Date; label: string; sub: string; color: string }> = []

  // Skills
  for (const s of queue) {
    if (!s.finish_date) continue
    const t = new Date(s.finish_date)
    if (t.getTime() > now) {
      events.push({ time: t, label: nameMap.get(s.skill_id) ?? `Skill ${s.skill_id}`, sub: `Lvl ${s.finished_level}`, color: 'var(--blue)' })
    }
  }

  // Jobs
  for (const j of jobs.filter(j => j.status === 'active')) {
    const t = new Date(j.end_date)
    if (t.getTime() > now) {
      const name = j.product_type_id ? (jobNames.get(j.product_type_id) ?? `Type ${j.product_type_id}`) : 'Job'
      events.push({ time: t, label: name, sub: `×${j.runs} klaar`, color: '#a78bfa' })
    }
  }

  const sorted = events.sort((a, b) => a.time.getTime() - b.time.getTime()).slice(0, 6)
  if (sorted.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Niets aankomend</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
      {sorted.map((e, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: e.color, flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: '0.68rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', flexShrink: 0 }}>{timeLeft(e.time.toISOString())}</span>
        </div>
      ))}
    </div>
  )
}

const OWNER_COLOR: Record<string, string> = {
  eve_server:  '#3ecf6e',
  corporation: '#f0c040',
  alliance:    '#00b4d8',
  character:   '#a78bfa',
  faction:     '#f97316',
}
const OWNER_LABEL: Record<string, string> = {
  eve_server:  'EVE',
  corporation: 'Corp',
  alliance:    'Alliance',
  character:   'Persoonlijk',
  faction:     'Factie',
}
const RSVP_COLOR: Record<string, string> = {
  accepted:      '#3ecf6e',
  declined:      '#e05555',
  tentative:     '#f0c040',
  not_responded: 'var(--border)',
}
const RSVP_LABEL: Record<string, string> = {
  accepted:      'Ja',
  declined:      'Nee',
  tentative:     '?',
  not_responded: '—',
}

function CalendarWidget({ events, loading }: { events: CalendarEventDetail[]; loading: boolean }) {
  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Laden...</div>
  if (events.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen aankomende events</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
      {events.map(ev => {
        const eventDate = new Date(ev.date)
        const now       = Date.now()
        const diff      = eventDate.getTime() - now
        const isPast    = diff < 0
        const ownerColor = OWNER_COLOR[ev.owner_type] ?? 'var(--text-dim)'
        const rsvp      = ev.response as string

        let timeStr: string
        if (isPast) {
          timeStr = 'Bezig'
        } else {
          const d = Math.floor(diff / 86400000)
          const h = Math.floor((diff % 86400000) / 3600000)
          const m = Math.floor((diff % 3600000) / 60000)
          if (d > 0) timeStr = `${d}d ${h}u`
          else if (h > 0) timeStr = `${h}u ${m}m`
          else timeStr = `${m}m`
        }

        return (
          <div key={ev.event_id} style={{
            display: 'flex', alignItems: 'flex-start', gap: '0.55rem',
            padding: '0.4rem 0.5rem',
            background: ev.importance === 1 ? 'rgba(240,192,64,0.06)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${ev.importance === 1 ? 'rgba(240,192,64,0.25)' : 'var(--border)'}`,
            borderLeft: `3px solid ${ownerColor}`,
            borderRadius: 2,
          }}>
            {/* RSVP badge */}
            <div style={{
              flexShrink: 0, width: 20, height: 20, borderRadius: 3,
              background: `${RSVP_COLOR[rsvp] ?? 'var(--border)'}22`,
              border: `1px solid ${RSVP_COLOR[rsvp] ?? 'var(--border)'}66`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.58rem', fontWeight: 700,
              color: RSVP_COLOR[rsvp] ?? 'var(--border)',
            }}>
              {RSVP_LABEL[rsvp] ?? '—'}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.1rem' }}>
                {ev.importance === 1 && <span style={{ color: '#f0c040', fontSize: '0.6rem' }}>★</span>}
                <span style={{ fontSize: '0.7rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {ev.title}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.58rem', color: ownerColor, fontWeight: 700 }}>
                  {OWNER_LABEL[ev.owner_type] ?? ev.owner_type}
                </span>
                {ev.owner_name && ev.owner_type !== 'eve_server' && (
                  <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ev.owner_name}
                  </span>
                )}
              </div>
            </div>

            <div style={{ flexShrink: 0, textAlign: 'right' }}>
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color: isPast ? '#f97316' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                {isPast ? 'Nu' : timeStr}
              </div>
              <div style={{ fontSize: '0.57rem', color: 'var(--text-dim)', marginTop: '0.05rem' }}>
                {eventDate.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface TokenData {
  charId:  number
  wallet:  number
  journal: WalletJournalEntry[]
  queue:   SkillQueueEntry[]
  jobs:    IndustryJob[]
  orders:  MarketOrder[]
}

export default function Dashboard() {
  const { activeTokens, tokens: allTokens, mainCharId } = useAuth()
  const alerts  = useAlerts()
  const navigate = useNavigate()
  const tick    = useAutoRefresh()
  const fetchId = useRef(0)

  const { editMode, setEditMode, previewMode } = useLayoutMode()
  const [widgetOrder, setWidgetOrder] = useState<WidgetId[]>(loadOrder)
  const [charOrder, setCharOrder]     = useState<number[]>([])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setWidgetOrder(prev => {
      const from = prev.indexOf(active.id as WidgetId)
      const to   = prev.indexOf(over.id as WidgetId)
      if (from === -1 || to === -1) return prev
      const next = [...prev]
      next.splice(to, 0, next.splice(from, 1)[0])
      saveOrder(next)
      return next
    })
  }, [])

  const handleCharDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setCharOrder(prev => {
      const from = prev.indexOf(Number(active.id))
      const to   = prev.indexOf(Number(over.id))
      if (from === -1 || to === -1) return prev
      const next = [...prev]
      next.splice(to, 0, next.splice(from, 1)[0])
      saveCharOrder(next)
      return next
    })
  }, [])

  const [esiStatus, setEsiStatus] = useState<{ players: number; server_version: string; vip: boolean } | null>(null)

  useEffect(() => {
    async function fetchEsiStatus() {
      try {
        const r = await fetch('https://esi.evetech.net/latest/status/?datasource=tranquility', { signal: AbortSignal.timeout(5000) })
        if (r.ok) setEsiStatus(await r.json())
      } catch { /* server offline */ }
    }
    fetchEsiStatus()
    const interval = setInterval(fetchEsiStatus, 60_000)
    return () => clearInterval(interval)
  }, [])

  const [phase1Loading, setPhase1Loading] = useState(true)
  const [phase2Loading, setPhase2Loading] = useState(true)
  const [tokenData, setTokenData]   = useState<TokenData[]>([])
  const [killEntries, setKillEntries] = useState<KillEntry[]>([])
  const [skillNames, setSkillNames]  = useState(new Map<number, string>())
  const [jobNames,   setJobNames]    = useState(new Map<number, string>())
  const [banner, setBanner]          = useState<{ corporationId: number; corp: CorporationInfo | null; allianceId: number | null; alliance: AllianceInfo | null } | null>(null)
  const [refreshKey, setRefreshKey]  = useState(0)
  const [calendarEvents, setCalendarEvents] = useState<CalendarEventDetail[]>([])
  const [calendarLoading, setCalendarLoading] = useState(true)

  useEffect(() => {
    if (allTokens.length === 0) return
    const myId = ++fetchId.current
    setPhase1Loading(true); setPhase2Loading(true)
    setTokenData([]); setKillEntries([])

    async function load() {
      // Phase 1: fast data
      const td = await Promise.all(allTokens.map(async t => {
        const [wallet, journal, queue, jobs, orders] = await Promise.allSettled([
          getWallet(t.characterId, t.accessToken),
          getWalletJournal(t.characterId, t.accessToken, 3),
          getSkillQueue(t.characterId, t.accessToken),
          getIndustryJobs(t.characterId, t.accessToken),
          getMarketOrders(t.characterId, t.accessToken),
        ])
        return {
          charId:  t.characterId,
          wallet:  wallet.status  === 'fulfilled' ? wallet.value  : 0,
          journal: journal.status === 'fulfilled' ? journal.value : [],
          queue:   queue.status   === 'fulfilled' ? queue.value   : [],
          jobs:    jobs.status    === 'fulfilled' ? jobs.value    : [],
          orders:  orders.status  === 'fulfilled' ? orders.value  : [],
        } as TokenData
      }))

      if (myId !== fetchId.current) return
      setTokenData(td)
      setPhase1Loading(false)

      // Resolve skill + job names
      const allSkillIds = [...new Set(td.flatMap(d => d.queue.map(s => s.skill_id)))]
      const allJobIds   = [...new Set(td.flatMap(d => d.jobs.map(j => j.product_type_id).filter((id): id is number => id != null)))]
      const [sn, jn]   = await Promise.all([resolveNames(allSkillIds), resolveNames(allJobIds)])
      if (myId !== fetchId.current) return
      setSkillNames(sn); setJobNames(jn)

      // Phase 2: kills — gebruik alleen de hoofdcharacter (= zkillboard character page)
      const killCharId = (mainCharId ? allTokens.find(t => t.characterId === mainCharId) : null)?.characterId ?? allTokens[0]?.characterId
      const [charKills, charLosses] = await Promise.all([
        getKills(killCharId),
        getLosses(killCharId),
      ])
      const recent    = [
        ...charKills.slice(0, 10).map(k => ({ ...k, type: 'kill' as const })),
        ...charLosses.slice(0, 10).map(k => ({ ...k, type: 'loss' as const })),
      ]
      const details = await Promise.all(recent.map(async k => ({ ...k, km: await getKillmailDetail(k.killmail_id, k.zkb.hash) })))
      if (myId !== fetchId.current) return

      const fbArr    = details.map(d => d.km?.attackers.find(a => a.final_blow))
      const shipIds  = [...new Set(details.map(d => d.km?.victim.ship_type_id).filter(Boolean) as number[])]
      const sysIds   = [...new Set(details.map(d => d.km?.solar_system_id).filter(Boolean) as number[])]
      const charIds  = [...new Set([...details.map(d => d.km?.victim.character_id), ...fbArr.map(a => a?.character_id)].filter(Boolean) as number[])]
      const corpIds  = [...new Set([...details.map(d => d.km?.victim.corporation_id), ...fbArr.map(a => a?.corporation_id)].filter(Boolean) as number[])]
      const aliIds   = [...new Set([...details.map(d => d.km?.victim.alliance_id), ...fbArr.map(a => a?.alliance_id)].filter(Boolean) as number[])]
      const actMap   = await resolveNames([...shipIds, ...sysIds, ...charIds, ...corpIds, ...aliIds])

      const entries: KillEntry[] = details.map((d, i) => {
        const fb = fbArr[i]
        return {
          id: d.killmail_id, type: d.type,
          ship: actMap.get(d.km?.victim.ship_type_id ?? 0) ?? 'Unknown',
          shipTypeId: d.km?.victim.ship_type_id ?? 0,
          victimCharId: d.km?.victim.character_id, victimCharName: d.km?.victim.character_id ? actMap.get(d.km.victim.character_id) : undefined,
          victimCorpId: d.km?.victim.corporation_id, victimCorpName: d.km?.victim.corporation_id ? actMap.get(d.km.victim.corporation_id) : undefined,
          victimAllianceId: d.km?.victim.alliance_id, victimAllianceName: d.km?.victim.alliance_id ? actMap.get(d.km.victim.alliance_id) : undefined,
          finalBlowCharId: fb?.character_id, finalBlowCharName: fb?.character_id ? actMap.get(fb.character_id) : undefined,
          finalBlowCorpId: fb?.corporation_id, finalBlowCorpName: fb?.corporation_id ? actMap.get(fb.corporation_id) : undefined,
          finalBlowAllianceId: fb?.alliance_id, finalBlowAllianceName: fb?.alliance_id ? actMap.get(fb.alliance_id) : undefined,
          isk: d.zkb.totalValue,
          system: actMap.get(d.km?.solar_system_id ?? 0) ?? '—',
          systemId: d.km?.solar_system_id,
          time: d.km ? new Date(d.km.killmail_time) : null,
        }
      }).sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0))

      if (myId !== fetchId.current) return
      setKillEntries(entries)
      setPhase2Loading(false)
    }

    load()
  }, [allTokens.map(t => `${t.characterId}:${t.expiresAt}`).join(','), refreshKey, tick])

  useEffect(() => {
    setCharOrder(loadCharOrder(allTokens.map(t => t.characterId)))
  }, [allTokens.map(t => t.characterId).join(',')])

  useEffect(() => {
    const t = (mainCharId ? allTokens.find(tok => tok.characterId === mainCharId) : null) ?? allTokens[0]
    if (!t) return
    getCharacterInfo(t.characterId).then(async info => {
      const corp = await getCorporation(info.corporation_id).catch(() => null)
      const allianceId = info.alliance_id ?? null
      const alliance = allianceId ? await getAlliance(allianceId).catch(() => null) : null
      setBanner({ corporationId: info.corporation_id, corp, allianceId, alliance })
    }).catch(() => {})
  }, [allTokens.map(t => t.characterId).join(','), mainCharId])

  useEffect(() => {
    if (allTokens.length === 0) return
    setCalendarLoading(true)

    async function loadCalendar() {
      const now = Date.now()
      const allDetails: CalendarEventDetail[] = []

      for (const t of allTokens) {
        try {
          const summary = await getCalendar(t.characterId, t.accessToken)
          const upcoming = summary
            .filter(e => new Date(e.event_date).getTime() > now - 3600000)
            .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime())
            .slice(0, 8)
          const details = await Promise.allSettled(
            upcoming.map(e => getCalendarEventDetail(t.characterId, e.event_id, t.accessToken))
          )
          for (const d of details) {
            if (d.status === 'fulfilled') allDetails.push(d.value)
          }
        } catch { /* silently skip */ }
      }

      const seen = new Set<number>()
      const unique = allDetails
        .filter(e => { if (seen.has(e.event_id)) return false; seen.add(e.event_id); return true })
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(0, 10)

      setCalendarEvents(unique)
      setCalendarLoading(false)
    }

    loadCalendar()
  }, [allTokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const primary     = (mainCharId ? allTokens.find(t => t.characterId === mainCharId) : null) ?? allTokens[0]
  const primaryData = tokenData.find(d => d.charId === primary?.characterId) ?? tokenData[0]
  const totalWallet = tokenData.reduce((s, d) => s + d.wallet, 0)
  const allJournal  = tokenData.flatMap(d => d.journal)
  const allJobs     = tokenData.flatMap(d => d.jobs)
  const allOrders   = tokenData.flatMap(d => d.orders)
  const allQueue    = primaryData?.queue ?? []

  const todayISK     = dayEarnings(allJournal, 0)
  const yesterdayISK = dayEarnings(allJournal, 1)
  const trendUp      = todayISK >= yesterdayISK

  const urgentAlerts = alerts.readyJobs + alerts.unreadMail + allOrders.filter(o => {
    const exp = new Date(o.issued); exp.setDate(exp.getDate() + o.duration)
    return exp.getTime() - Date.now() < 3600000
  }).length

  return (
    <Layout
      header={
        <PageHeader
          title="Dashboard"
          sub={`${primary?.characterName ?? '—'} · ${allTokens.length} account${allTokens.length !== 1 ? 's' : ''}`}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3ecf6e', boxShadow: '0 0 5px #3ecf6e88' }} />
                <span style={{ color: '#3ecf6e', fontSize: '0.68rem', fontWeight: 700 }}>Tranquility</span>
                {esiStatus && (
                  <span style={{ fontSize: '0.62rem', color: 'var(--gold)' }}>
                    · {esiStatus.players.toLocaleString('nl')} online
                  </span>
                )}
              </div>
              <button
                onClick={() => setEditMode(m => !m)}
                style={{ background: editMode ? 'var(--surface2)' : 'none', border: `1px solid ${editMode ? 'var(--blue)' : 'var(--border)'}`, borderRadius: 3, color: editMode ? 'var(--blue)' : 'var(--text-dim)', cursor: 'pointer', fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
              >{editMode ? 'Klaar' : 'Indeling'}</button>
              <button
                onClick={() => setRefreshKey(k => k + 1)}
                disabled={phase1Loading}
                style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 3, color: phase1Loading ? 'var(--border)' : 'var(--text-dim)', cursor: phase1Loading ? 'default' : 'pointer', fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
              >↻</button>
            </div>
          }
        />
      }
      mainStyle={{ padding: '0.875rem 1.25rem 1.5rem' }}
    >
      {/* Urgent alert banner */}
      {!phase1Loading && urgentAlerts > 0 && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.55rem 1rem', background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.3)', borderRadius: 3, marginBottom: GAP }}
        >
          <span style={{ color: 'var(--red)', fontSize: '0.8rem' }}>⚠</span>
          <div style={{ flex: 1, fontSize: '0.72rem', color: 'var(--red)' }}>
            {[
              alerts.readyJobs   > 0 && `${alerts.readyJobs} industry job${alerts.readyJobs !== 1 ? 's' : ''} klaar`,
              alerts.unreadMail  > 0 && `${alerts.unreadMail} ongelezen mail`,
            ].filter(Boolean).join(' · ')}
          </div>
          <span style={{ fontSize: '0.65rem', color: 'var(--red)', opacity: 0.7 }}>Bekijk →</span>
        </div>
      )}

      {/* Character banner */}
      {primary && (
        <div style={{ position: 'relative', height: 110, background: 'linear-gradient(135deg, #0b0b2a 0%, #0f0f3a 60%, #0a0a20 100%)', border: '1px solid var(--border)', borderRadius: 3, marginBottom: GAP, overflow: 'hidden' }}>
          {banner?.corporationId && (
            <EveImage category="corporations" id={banner.corporationId} variation="logo" size={256} px={180}
              style={{ position: 'absolute', right: -20, top: '50%', transform: 'translateY(-50%)', opacity: 0.08, filter: 'blur(2px)', borderRadius: 0 }} />
          )}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '0 1.5rem', gap: '1rem' }}>
            <EveImage category="characters" id={primary.characterId} variation="portrait" size={128} px={72}
              style={{ borderRadius: 3, border: '2px solid var(--border)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, letterSpacing: '0.02em', marginBottom: '0.15rem' }}>{primary.characterName}</div>
              {banner?.corp && (
                <div style={{ fontSize: '0.72rem', marginTop: '0.1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  {banner.corporationId && (
                    <EveImage category="corporations" id={banner.corporationId} variation="logo" size={32} px={16}
                      style={{ borderRadius: 2, border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }} />
                  )}
                  <span style={{ color: 'var(--gold)', fontWeight: 700 }}>[{banner.corp.ticker}]</span>
                  {' '}
                  <span style={{ color: '#f97316' }}>{banner.corp.name}</span>
                </div>
              )}
              {banner?.alliance && banner.allianceId && (
                <div style={{ fontSize: '0.68rem', marginTop: '0.1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <EveImage category="alliances" id={banner.allianceId} variation="logo" size={32} px={16}
                    style={{ borderRadius: 2, border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--gold)', fontWeight: 700 }}>[{banner.alliance.ticker}]</span>
                  {' '}
                  <span style={{ color: 'var(--blue)' }}>{banner.alliance.name}</span>
                </div>
              )}
              {(() => {
                const loc = alerts.locations.get(primary.characterId)
                const system = loc?.system && loc.system !== '—' ? loc.system : null
                const ship = loc?.shipName && loc.shipName !== '—' ? loc.shipName : null
                const shipType = ship && loc?.shipTypeName && loc.shipTypeName !== loc.shipName ? loc.shipTypeName : null
                return (
                  <div style={{ fontSize: '0.62rem', color: 'var(--text)', marginTop: '0.2rem' }}>
                    <span style={{ color: 'var(--green)' }}>⬡</span>{' '}
                    {system
                      ? <SolarSystem name={system} systemId={loc?.systemId ?? undefined} fontSize="0.62rem" />
                      : <span style={{ color: 'var(--text-dim)' }}>—</span>
                    }
                    <span style={{ color: 'var(--text-dim)', margin: '0 0.25rem' }}>·</span>
                    {ship
                      ? <span style={{ color: 'var(--gold)' }}>{ship}{shipType ? ` (${shipType})` : ''}</span>
                      : <span style={{ color: 'var(--text-dim)' }}>—</span>
                    }
                  </div>
                )
              })()}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.25rem' }}>WALLET</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: totalWallet < 0 ? 'var(--red)' : 'var(--gold)' }}>
                {phase1Loading ? '...' : `${fmtISK(totalWallet)} ISK`}
              </div>
              <div style={{ fontSize: '0.65rem', marginTop: '0.15rem', color: trendUp ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                {phase1Loading ? '' : `${trendUp ? '▲' : '▼'} ${fmtISK(todayISK)} vandaag`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Multi-account cards */}
      {allTokens.length > 1 && charOrder.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleCharDragEnd}>
          <SortableContext items={charOrder.map(String)} strategy={horizontalListSortingStrategy}>
            <div style={{ display: 'flex', gap: GAP, marginBottom: GAP, overflowX: 'auto', paddingBottom: '0.25rem' }}>
              {charOrder.map(charId => {
                const t   = allTokens.find(tok => tok.characterId === charId)
                if (!t) return null
                const d   = tokenData.find(td => td.charId === charId)
                const loc = alerts.locations.get(charId)
                const today = d ? dayEarnings(d.journal, 0) : 0
                return (
                  <SortableCharCard key={charId} id={charId} editMode={editMode}>
                    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.625rem 0.875rem', minWidth: 170, flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                        <EveImage category="characters" id={charId} variation="portrait" size={32} px={28} round />
                        <span style={{ fontSize: '0.72rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.characterName}</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gold)' }}>{d ? `${fmtISK(d.wallet)} ISK` : '—'}</div>
                      <div style={{ fontSize: '0.62rem', color: today > 0 ? 'var(--green)' : 'var(--text-dim)', marginTop: '0.1rem' }}>
                        {today > 0 ? `+${fmtISK(today)} vandaag` : 'Geen inkomsten vandaag'}
                      </div>
                      <div style={{ fontSize: '0.58rem', color: 'var(--text)', marginTop: '0.15rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--green)' }}>⬡</span>{' '}
                        {loc?.system && loc.system !== '—'
                          ? <SolarSystem name={loc.system} systemId={loc.systemId ?? undefined} fontSize="0.58rem" />
                          : <span style={{ color: 'var(--text-dim)' }}>—</span>
                        }
                        {loc?.shipName && loc.shipName !== '—' && (
                          <span style={{ color: 'var(--gold)' }}> · {loc.shipName}</span>
                        )}
                      </div>
                    </div>
                  </SortableCharCard>
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* 4 stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: GAP, marginBottom: GAP }}>
        {[
          { label: 'TOTAAL WALLET',  value: phase1Loading ? '...' : `${fmtISK(totalWallet)} ISK`, color: 'var(--gold)' },
          { label: 'VANDAAG',        value: phase1Loading ? '...' : `${fmtISK(todayISK)} ISK`,    color: trendUp ? 'var(--green)' : 'var(--text)',
            sub: phase1Loading ? '' : yesterdayISK > 0 ? `Gisteren: ${fmtISK(yesterdayISK)} ISK` : undefined },
          { label: 'ACTIEVE ORDERS', value: phase1Loading ? '...' : String(allOrders.length),     color: 'var(--blue)',
            sub: phase1Loading ? '' : allOrders.length > 0 ? `${fmtISK(allOrders.filter(o => !o.is_buy_order).reduce((s, o) => s + o.price * o.volume_remain, 0))} ISK te verkopen` : undefined },
          { label: 'INDUSTRY JOBS',  value: phase1Loading ? '...' : String(allJobs.filter(j => j.status === 'active' || j.status === 'ready').length), color: 'var(--blue)',
            sub: phase1Loading ? '' : allJobs.filter(j => j.status === 'ready').length > 0 ? `${allJobs.filter(j => j.status === 'ready').length} klaar` : undefined },
        ].map(({ label, value, color, sub }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem' }}>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.35rem' }}>{label}</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color }}>{value}</div>
            {sub && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{sub}</div>}
          </div>
        ))}
      </div>

      {allTokens.some(t => t.characterId === 1831618559) && !previewMode && (
        <div style={{ marginBottom: GAP }}>
          <LocalChatWidget />
        </div>
      )}

      {/* Sorteerbare widgets */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={widgetOrder} strategy={rectSortingStrategy}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gridAutoRows: '155px', gap: GAP, marginBottom: GAP }}>
            {widgetOrder.map(id => (
              <SortableWidget key={id} id={id} editMode={editMode}>
                {handle => {
                  switch (id) {
                    case 'skill-queue':   return <Section title="SKILL QUEUE"          link="/skills"   dragHandle={handle}><SkillQueueWidget queue={allQueue}         nameMap={skillNames}  loading={phase1Loading} /></Section>
                    case 'industry-jobs': return <Section title="INDUSTRY JOBS"        link="/industry" dragHandle={handle}><IndustryWidget   jobs={allJobs}            nameMap={jobNames}    loading={phase1Loading} /></Section>
                    case 'market-orders': return <Section title="MARKET ORDERS"        link="/market"   dragHandle={handle}><OrdersWidget     orders={allOrders}                              loading={phase1Loading} /></Section>
                    case 'recent-tx':     return <Section title="RECENTE TRANSACTIES"  link="/wallet"   dragHandle={handle}><RecentTxWidget   journal={allJournal}                            loading={phase1Loading} /></Section>
                    case 'net-worth':     return <Section title="NETTO WAARDE"         link="/wallet"   dragHandle={handle}><NetWorthWidget   wallet={totalWallet}      orders={allOrders}    loading={phase1Loading} /></Section>
                    case 'kill-stats':    return <Section title="KILL STATISTIEKEN"    link="/kills"    dragHandle={handle}><KillStatsWidget  entries={killEntries}                           loading={phase2Loading && killEntries.length === 0} /></Section>
                    case 'income':        return <Section title="INKOMSTENVERDELING"   link="/wallet"   dragHandle={handle}><IncomeWidget     journal={allJournal}                            loading={phase1Loading} /></Section>
                    case 'upcoming':      return <Section title="AANKOMEND"            link="/industry" dragHandle={handle}><UpcomingWidget   queue={allQueue} jobs={allJobs} nameMap={skillNames} jobNames={jobNames} loading={phase1Loading} /></Section>
                  }
                }}
              </SortableWidget>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* In-game agenda */}
      <div style={{ marginBottom: GAP }}>
        <Section title="IN-GAME AGENDA">
          <CalendarWidget events={calendarEvents} loading={calendarLoading} />
        </Section>
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: GAP, marginBottom: GAP }}>
        <WalletChart journal={primaryData?.journal ?? []} loading={phase1Loading} />
        <RattingWidget journal={allJournal} loading={phase1Loading} />
      </div>

      {/* Kills */}
      <KillsTable entries={killEntries} characterId={primary?.characterId} loading={phase2Loading && killEntries.length === 0} />
    </Layout>
  )
}
