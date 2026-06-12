import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import {
  getMail, getIndustryJobs, getMarketOrders, getPlanets, getPlanetDetail,
  resolveNames, type MailHeader, type IndustryJob, type MarketOrder, type PlanetPin,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'

type Severity = 'error' | 'warning' | 'info'
type NType    = 'mail' | 'job' | 'market' | 'pi' | 'skill'

interface AppNotification {
  id:       string
  type:     NType
  severity: Severity
  icon:     string
  title:    string
  body:     string
  time?:    string
  link:     string
}

function timeLeft(isoDate: string): string {
  const diff = new Date(isoDate).getTime() - Date.now()
  if (diff <= 0) return 'Verlopen'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h >= 48) return `${Math.ceil(h / 24)}d`
  if (h >= 1)  return `${h}u ${m}m`
  return `${m}m`
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (d > 0)  return `${d}d geleden`
  if (h > 0)  return `${h}u geleden`
  return 'Zojuist'
}

function orderExpiry(issued: string, duration: number): Date {
  const d = new Date(issued)
  d.setDate(d.getDate() + duration)
  return d
}

const SEVERITY_COLOR: Record<Severity, string> = {
  error:   'var(--red)',
  warning: 'var(--gold)',
  info:    'var(--blue)',
}

const TYPE_LABEL: Record<NType, string> = {
  mail:   'Mail',
  job:    'Industry',
  market: 'Market',
  pi:     'PI',
  skill:  'Skills',
}

const TYPE_ICON: Record<NType, string> = {
  mail:   '✉',
  job:    '◫',
  market: '◊',
  pi:     '○',
  skill:  '◎',
}

function NotifCard({ n, onNav }: { n: AppNotification; onNav: (link: string) => void }) {
  const color = SEVERITY_COLOR[n.severity]
  return (
    <div
      onClick={() => onNav(n.link)}
      style={{
        display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
        padding: '0.75rem 1rem',
        borderBottom: '1px solid rgba(28,28,53,0.5)',
        borderLeft: `3px solid ${color}`,
        cursor: 'pointer',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ width: 28, height: 28, borderRadius: 3, background: `${color}18`, border: `1px solid ${color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', flexShrink: 0 }}>
        {n.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>{n.title}</span>
          {n.time && <span style={{ fontSize: '0.62rem', color: color, flexShrink: 0, fontWeight: 600 }}>{n.time}</span>}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {n.body}
        </div>
      </div>
    </div>
  )
}

export default function Notifications() {
  const { activeTokens: tokens, tokens: allTokens } = useAuth()
  const navigate = useNavigate()
  const [notifs, setNotifs]   = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState<NType | 'all'>('all')
  usePageLoading(loading)
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) { setLoading(false); return }
    const myId = ++fetchId.current
    setLoading(true)

    async function load() {
      const result: AppNotification[] = []

      await Promise.all(tokens.map(async t => {
        const [mail, jobs, orders, planets] = await Promise.allSettled([
          getMail(t.characterId, t.accessToken),
          getIndustryJobs(t.characterId, t.accessToken),
          getMarketOrders(t.characterId, t.accessToken),
          getPlanets(t.characterId, t.accessToken),
        ])

        // ── Mail ──────────────────────────────────────────────────────
        if (mail.status === 'fulfilled') {
          const unread = mail.value.filter(m => !m.is_read).slice(0, 20)
          const senderIds = [...new Set(unread.map(m => m.from))]
          const nameMap = await resolveNames(senderIds).catch(() => new Map<number, string>())
          for (const m of unread) {
            result.push({
                id:       `mail-${t.characterId}-${m.mail_id}`,
              link:     '/mail',
            })
          }
        }

        // ── Industry jobs ─────────────────────────────────────────────
        if (jobs.status === 'fulfilled') {
          const ready  = jobs.value.filter(j => j.status === 'ready')
          const active = jobs.value.filter(j => j.status === 'active')
          const typeIds = [...new Set([...ready, ...active].map(j => j.product_type_id).filter((id): id is number => id != null))]
          const nameMap = await resolveNames(typeIds).catch(() => new Map<number, string>())

          for (const j of ready) {
            const name = j.product_type_id ? (nameMap.get(j.product_type_id) ?? `Type ${j.product_type_id}`) : 'Onbekend'
            result.push({
              id:       `job-${j.job_id}`,
              type:     'job',
              severity: 'warning',
              icon:     '◫',
              title:    `Job klaar: ${name}`,
              body:     `×${j.runs} · Klaar om op te halen`,
              time:     'Klaar',
              link:     '/industry',
            })
          }

          for (const j of active) {
            const msLeft = new Date(j.end_date).getTime() - Date.now()
            if (msLeft < 4 * 3600000 && msLeft > 0) {
              const name = j.product_type_id ? (nameMap.get(j.product_type_id) ?? `Type ${j.product_type_id}`) : 'Onbekend'
              result.push({
                id:       `job-soon-${j.job_id}`,
                type:     'job',
                severity: 'info',
                icon:     '◫',
                title:    `Job bijna klaar: ${name}`,
                body:     `×${j.runs}`,
                time:     timeLeft(j.end_date),
                link:     '/industry',
              })
            }
          }
        }

        // ── Market orders ─────────────────────────────────────────────
        if (orders.status === 'fulfilled') {
          const typeIds = [...new Set(orders.value.map(o => o.type_id))]
          const nameMap = await resolveNames(typeIds).catch(() => new Map<number, string>())
          for (const o of orders.value) {
            const exp  = orderExpiry(o.issued, o.duration)
            const msLeft = exp.getTime() - Date.now()
            if (msLeft <= 0) {
              result.push({
                id:       `order-exp-${o.order_id}`,
                type:     'market',
                severity: 'error',
                icon:     '◊',
                title:    `Order verlopen: ${nameMap.get(o.type_id) ?? `Type ${o.type_id}`}`,
                body:     `${o.is_buy_order ? 'BUY' : 'SELL'} · ${o.volume_remain.toLocaleString()} over`,
                time:     'Verlopen',
                link:     '/market',
              })
            } else if (msLeft < 24 * 3600000) {
              result.push({
                id:       `order-soon-${o.order_id}`,
                type:     'market',
                severity: 'error',
                icon:     '◊',
                title:    `Order verloopt binnenkort: ${nameMap.get(o.type_id) ?? `Type ${o.type_id}`}`,
                body:     `${o.is_buy_order ? 'BUY' : 'SELL'} · ${o.volume_remain.toLocaleString()} over`,
                time:     timeLeft(exp.toISOString()),
                link:     '/market',
              })
            } else if (msLeft < 3 * 86400000) {
              result.push({
                id:       `order-warn-${o.order_id}`,
                type:     'market',
                severity: 'warning',
                icon:     '◊',
                title:    `Order verloopt: ${nameMap.get(o.type_id) ?? `Type ${o.type_id}`}`,
                body:     `${o.is_buy_order ? 'BUY' : 'SELL'} · ${o.volume_remain.toLocaleString()} over`,
                time:     timeLeft(exp.toISOString()),
                link:     '/market',
              })
            }
          }
        }

        // ── PI ────────────────────────────────────────────────────────
        if (planets.status === 'fulfilled') {
          const systemIds = [...new Set(planets.value.map(p => p.solar_system_id))]
          const nameMap   = await resolveNames(systemIds).catch(() => new Map<number, string>())

          await Promise.all(planets.value.map(async planet => {
            try {
              const detail = await getPlanetDetail(t.characterId, planet.planet_id, t.accessToken)
              const expiries = detail.pins
                .filter(p => p.expiry_time)
                .map(p => new Date(p.expiry_time!))
                .filter(d => !isNaN(d.getTime()))
              if (expiries.length === 0) return
              const earliest = expiries.reduce((a, b) => a < b ? a : b)
              const msLeft   = earliest.getTime() - Date.now()
              const system   = nameMap.get(planet.solar_system_id) ?? '—'
              if (msLeft <= 0) {
                result.push({
                  id:       `pi-exp-${planet.planet_id}`,
                  type:     'pi',
                  severity: 'error',
                  icon:     '○',
                  title:    `PI verlopen: ${system}`,
                  body:     `${planet.planet_type} planet — extractors gestopt`,
                  time:     'Verlopen',
                  link:     '/planets',
                })
              } else if (msLeft < 4 * 3600000) {
                result.push({
                  id:       `pi-soon-${planet.planet_id}`,
                  type:     'pi',
                  severity: 'warning',
                  icon:     '○',
                  title:    `PI verloopt binnenkort: ${system}`,
                  body:     `${planet.planet_type} planet`,
                  time:     timeLeft(earliest.toISOString()),
                  link:     '/planets',
                })
              }
            } catch { /* skip */ }
          }))
        }
      }))

      if (myId !== fetchId.current) return

      // Sorteer: error eerst, dan warning, dan info; daarna op type
      const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
      result.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

      setNotifs(result)
      setLoading(false)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const displayed = filter === 'all' ? notifs : notifs.filter(n => n.type === filter)

  const countByType = (type: NType) => notifs.filter(n => n.type === type).length
  const errorCount  = notifs.filter(n => n.severity === 'error').length

  const filterBtn = (key: NType | 'all', label: string, count: number) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      style={{
        padding: '0.25rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer',
        background: filter === key ? 'rgba(0,180,216,0.15)' : 'transparent',
        border: `1px solid ${filter === key ? 'var(--blue)' : 'var(--border)'}`,
        color: filter === key ? 'var(--blue)' : 'var(--text-dim)',
      }}
    >
      {label} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}
    </button>
  )

  return (
    <Layout header={
      <PageHeader
        title="Notificaties"
        sub={loading ? 'Laden...' : `${notifs.length} meldingen${errorCount > 0 ? ` · ${errorCount} urgent` : ''}`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {filterBtn('all',    'Alles',    notifs.length)}
            {filterBtn('mail',   'Mail',     countByType('mail'))}
            {filterBtn('job',    'Industry', countByType('job'))}
            {filterBtn('market', 'Market',   countByType('market'))}
            {filterBtn('pi',     'PI',       countByType('pi'))}
          </div>
        }
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Notificaties laden...</div>
      )}

      {!loading && displayed.length === 0 && (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem', opacity: 0.3 }}>◈</div>
          <div style={{ fontSize: '0.82rem' }}>Geen meldingen</div>
          <div style={{ fontSize: '0.7rem', marginTop: '0.35rem', opacity: 0.6 }}>Alles is in orde</div>
        </div>
      )}

      {!loading && displayed.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          {/* Group by type */}
          {(['error', 'warning', 'info'] as Severity[]).map(sev => {
            const group = displayed.filter(n => n.severity === sev)
            if (group.length === 0) return null
            return group.map(n => (
              <NotifCard key={n.id} n={n} onNav={link => navigate(link)} />
            ))
          })}
        </div>
      )}
    </Layout>
  )
}
