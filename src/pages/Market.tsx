import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import type { TokenData } from '../auth/sso'
import {
  getMarketOrders, getMarketHistory, getTransactions,
  getStructureName, resolveNames,
  type MarketOrder, type WalletTransaction,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import Location from '../components/Location'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedOrder extends MarketOrder {
  itemName: string
  locationName: string
}

interface ResolvedTx extends WalletTransaction {
  itemName: string
  clientName: string
  locationName: string
}

interface UndercutInfo {
  loading: boolean
  competitorPrice: number | null
  undercutPrice: number | null
  isTop: boolean
}

interface HistoryPoint {
  date: string
  average: number
  highest: number
  lowest: number
  volume: number
}

type SortKey = 'item' | 'price' | 'total' | 'volume' | 'expiry' | null
type FilterType = 'all' | 'sell' | 'buy'

async function getRegionForLocation(locationId: number, accessTokens: TokenData[]): Promise<number | null> {
  try {
    let systemId: number
    if (locationId < 1_000_000_000) {
      const r = await fetch(`https://esi.evetech.net/latest/universe/stations/${locationId}/?datasource=tranquility`)
      if (!r.ok) return null
      systemId = (await r.json()).system_id
    } else {
      const token = accessTokens[0]?.accessToken
      if (!token) return null
      const r = await fetch(`https://esi.evetech.net/latest/universe/structures/${locationId}/?datasource=tranquility`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) return null
      systemId = (await r.json()).solar_system_id
    }
    const sysR = await fetch(`https://esi.evetech.net/latest/universe/systems/${systemId}/?datasource=tranquility`)
    if (!sysR.ok) return null
    const conId: number = (await sysR.json()).constellation_id
    const conR = await fetch(`https://esi.evetech.net/latest/universe/constellations/${conId}/?datasource=tranquility`)
    if (!conR.ok) return null
    return (await conR.json()).region_id as number
  } catch { return null }
}

async function getMarketBestPrice(regionId: number, typeId: number, isBuy: boolean, ownOrderId: number): Promise<number | null> {
  try {
    const orderType = isBuy ? 'buy' : 'sell'
    const base = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&order_type=${orderType}&type_id=${typeId}`
    const r1   = await fetch(`${base}&page=1`)
    if (!r1.ok) return null
    const pages = parseInt(r1.headers.get('X-Pages') ?? '1')
    let orders: Array<{ price: number; order_id: number }> = await r1.json()
    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) => i + 2).map(p =>
          fetch(`${base}&page=${p}`).then(r => r.ok ? r.json() : []).catch(() => [])
        )
      )
      orders = [...orders, ...(rest.flat() as typeof orders)]
    }
    const prices = orders.filter(o => o.order_id !== ownOrderId).map(o => o.price)
    if (prices.length === 0) return null
    return isBuy
      ? prices.reduce((m, p) => p > m ? p : m, -Infinity)
      : prices.reduce((m, p) => p < m ? p : m, Infinity)
  } catch { return null }
}

async function getJitaPrice(typeId: number): Promise<{ sell: number | null; buy: number | null }> {
  const base = `https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&type_id=${typeId}`
  const [sellR, buyR] = await Promise.all([
    fetch(`${base}&order_type=sell`).then(r => r.ok ? r.json() : []).catch(() => []),
    fetch(`${base}&order_type=buy`).then(r => r.ok ? r.json() : []).catch(() => []),
  ])
  const sells = (sellR as Array<{ price: number }>).map(o => o.price)
  const buys  = (buyR  as Array<{ price: number }>).map(o => o.price)
  return {
    sell: sells.length ? Math.min(...sells) : null,
    buy:  buys.length  ? Math.max(...buys)  : null,
  }
}

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return v.toLocaleString()
}

function fmtDate(s: string) {
  const d = new Date(s)
  const diff = Date.now() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString('nl', { hour: '2-digit', minute: '2-digit' })
  if (days < 7)  return `${days}d geleden`
  return d.toLocaleDateString('nl', { day: 'numeric', month: 'short' })
}

function orderExpiry(issued: string, duration: number) {
  const exp = new Date(issued)
  exp.setDate(exp.getDate() + duration)
  const days = Math.ceil((exp.getTime() - Date.now()) / 86400000)
  if (days <= 0) return { label: 'Verlopen', color: 'var(--red)', urgent: true }
  if (days <= 1) return { label: `${days}d`, color: 'var(--red)', urgent: true }
  if (days <= 3) return { label: `${days}d`, color: 'var(--gold)', urgent: false }
  return { label: `${days}d`, color: 'var(--text-dim)', urgent: false }
}

const STATE_LABEL: Record<string, { label: string; color: string }> = {
  cancelled: { label: 'Geannuleerd', color: 'var(--red)'      },
  expired:   { label: 'Verlopen',    color: 'var(--text-dim)' },
  fulfilled: { label: 'Voltooid',    color: 'var(--green)'    },
  deleted:   { label: 'Verwijderd',  color: 'var(--text-dim)' },
}

const TH: React.CSSProperties = {
  fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700,
  letterSpacing: '0.12em', padding: '0.45rem 0.85rem', textAlign: 'left',
}
const TD: React.CSSProperties = {
  padding: '0.5rem 0.85rem', borderTop: '1px solid rgba(28,28,53,0.5)', verticalAlign: 'middle',
}

async function resolveLocations(locationIds: number[], accessTokens: TokenData[]) {
  const stationIds   = locationIds.filter(id => id < 1_000_000_000)
  const structureIds = locationIds.filter(id => id >= 1_000_000_000)
  const nameMap = await resolveNames(stationIds)
  const structNames = await Promise.all(
    structureIds.map(async id => {
      const name = await getStructureName(id, accessTokens)
      return [id, name ?? `#${id}`] as [number, string]
    })
  )
  return new Map<number, string>([
    ...stationIds.map(id => [id, nameMap.get(id) ?? `Station ${id}`] as [number, string]),
    ...structNames,
  ])
}

function PriceHistoryModal({ typeId, name, onClose }: { typeId: number; name: string; onClose: () => void }) {
  const [data, setData]       = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`https://esi.evetech.net/latest/markets/10000002/history/?datasource=tranquility&type_id=${typeId}`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: HistoryPoint[]) => { setData(rows.slice(-60)); setLoading(false) })
      .catch(() => setLoading(false))
  }, [typeId])

  const minP = data.length ? Math.min(...data.map(d => d.lowest))  : 0
  const maxP = data.length ? Math.max(...data.map(d => d.highest)) : 0

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '1.5rem', width: 680, maxWidth: '95vw' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <div>
            <div style={{ fontSize: '0.88rem', fontWeight: 700 }}>{name}</div>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>Jita (The Forge) · laatste 60 dagen</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1, padding: '0 0.25rem' }}>×</button>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Laden...</div>}
        {!loading && data.length === 0 && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen data gevonden</div>}

        {!loading && data.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: '2rem', marginBottom: '1rem' }}>
              {[
                { label: 'MIN 60d',    value: fmtISK(minP),                               color: 'var(--red)'  },
                { label: 'GEMIDDELD',  value: fmtISK(data[data.length - 1]?.average ?? 0), color: 'var(--text)' },
                { label: 'MAX 60d',    value: fmtISK(maxP),                               color: 'var(--green)' },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '0.15rem' }}>{label}</div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color }}>{value} ISK</div>
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickFormatter={v => fmtISK(v as number)} width={52} />
                <Tooltip
                  contentStyle={{ background: '#0f0f22', border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.72rem' }}
                  labelStyle={{ color: 'var(--text-dim)', marginBottom: '0.2rem' }}
                  formatter={(v: number) => [`${v.toLocaleString('nl')} ISK`]}
                />
                <Line type="monotone" dataKey="highest" stroke="rgba(0,180,216,0.25)" dot={false} strokeWidth={1} name="Hoogste" />
                <Line type="monotone" dataKey="average"  stroke="var(--blue)"          dot={false} strokeWidth={2} name="Gemiddeld" />
                <Line type="monotone" dataKey="lowest"   stroke="rgba(224,85,85,0.3)"  dot={false} strokeWidth={1} name="Laagste" />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  )
}

export default function Market() {
  const { activeTokens: tokens, tokens: allTokens } = useAuth()
  const [active,  setActive]  = useState<ResolvedOrder[]>([])
  const [history, setHistory] = useState<ResolvedOrder[]>([])
  const [txns,    setTxns]    = useState<ResolvedTx[]>([])
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [tab, setTab] = useState<'active' | 'history' | 'transactions'>('active')

  const [undercuts, setUndercuts] = useState<Map<number, UndercutInfo>>(new Map())
  const [analyzing, setAnalyzing] = useState(false)
  const regionCache = useRef(new Map<number, number>())
  const fetchId = useRef(0)

  const [refreshKey, setRefreshKey] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [countdown, setCountdown]    = useState(300)

  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const [filterType, setFilterType] = useState<FilterType>('all')
  const [filterLoc,  setFilterLoc]  = useState('')

  const [historyModal, setHistoryModal] = useState<{ typeId: number; name: string } | null>(null)

  const [jitaPrices, setJitaPrices] = useState<Map<number, { sell: number | null; buy: number | null }>>(new Map())
  const [jitaLoading, setJitaLoading] = useState(false)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true)
    setUndercuts(new Map())
    setJitaPrices(new Map())
    async function load() {
      const [rawActiveByToken, rawHistory, rawTxns] = await Promise.all([
        Promise.all(tokens.map(async t => {
          const orders = await getMarketOrders(t.characterId, t.accessToken).catch(() => [] as MarketOrder[])
          return orders
        })).then(r => r.flat()),
        Promise.all(tokens.map(t => getMarketHistory(t.characterId, t.accessToken).catch(() => [] as MarketOrder[]))).then(r => r.flat()),
        Promise.all(tokens.map(t => getTransactions(t.characterId, t.accessToken).catch(() => [] as WalletTransaction[]))).then(r => r.flat()),
      ])
      const rawActive = rawActiveByToken as MarketOrder[]

      if (myId !== fetchId.current) return

      const allTypeIds = [...new Set([
        ...rawActive.map(o => o.type_id),
        ...rawHistory.map(o => o.type_id),
        ...rawTxns.map(t => t.type_id),
      ])]
      const allLocationIds = [...new Set([
        ...rawActive.map(o => o.location_id),
        ...rawHistory.map(o => o.location_id),
        ...rawTxns.map(t => t.location_id),
      ])]
      const clientIds = [...new Set(rawTxns.map(t => t.client_id))]

      const [typeMap, clientMap, locationMap] = await Promise.all([
        resolveNames(allTypeIds),
        resolveNames(clientIds),
        resolveLocations(allLocationIds, allTokens),
      ])
      const nameMap = new Map([...typeMap, ...clientMap])

      if (myId !== fetchId.current) return

      setActive(rawActive
        .map(o => ({ ...o, itemName: nameMap.get(o.type_id) ?? `Type ${o.type_id}`, locationName: locationMap.get(o.location_id) ?? '—' }))
        .sort((a, b) => new Date(b.issued).getTime() - new Date(a.issued).getTime())
      )
      setHistory(rawHistory
        .map(o => ({ ...o, itemName: nameMap.get(o.type_id) ?? `Type ${o.type_id}`, locationName: locationMap.get(o.location_id) ?? '—' }))
        .sort((a, b) => new Date(b.issued).getTime() - new Date(a.issued).getTime())
        .slice(0, 100)
      )
      setTxns(rawTxns
        .map(t => ({
          ...t,
          itemName:     nameMap.get(t.type_id)   ?? `Type ${t.type_id}`,
          clientName:   nameMap.get(t.client_id)  ?? `ID ${t.client_id}`,
          locationName: locationMap.get(t.location_id) ?? '—',
        }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 100)
      )
      setLoading(false)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(','), refreshKey])

  useEffect(() => {
    if (!autoRefresh) return
    setCountdown(300)
    const tick = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { setRefreshKey(k => k + 1); return 300 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [autoRefresh])

  async function analyzeUndercuts() {
    if (analyzing || active.length === 0) return
    setAnalyzing(true)
    setUndercuts(new Map(active.map(o => [o.order_id, { loading: true, competitorPrice: null, undercutPrice: null, isTop: false }])))

    const uniqueLocs = [...new Set(active.map(o => o.location_id))]
    await Promise.all(uniqueLocs.map(async locId => {
      if (!regionCache.current.has(locId)) {
        const rid = await getRegionForLocation(locId, allTokens)
        if (rid) regionCache.current.set(locId, rid)
      }
    }))

    await Promise.all(active.map(async order => {
      const regionId = regionCache.current.get(order.location_id) ?? null
      let info: UndercutInfo = { loading: false, competitorPrice: null, undercutPrice: null, isTop: false }
      if (regionId) {
        const best = await getMarketBestPrice(regionId, order.type_id, order.is_buy_order, order.order_id)
        if (best !== null) {
          const undercutPrice = order.is_buy_order
            ? Math.round((best + 0.01) * 100) / 100
            : Math.round((best - 0.01) * 100) / 100
          const isTop = order.is_buy_order ? order.price > best : order.price < best
          info = { loading: false, competitorPrice: best, undercutPrice, isTop }
        } else {
          info = { loading: false, competitorPrice: null, undercutPrice: null, isTop: true }
        }
      }
      setUndercuts(prev => new Map([...prev, [order.order_id, info]]))
    }))
    setAnalyzing(false)
  }

  async function fetchJitaPrices() {
    if (jitaLoading || active.length === 0) return
    setJitaLoading(true)
    const typeIds = [...new Set(active.map(o => o.type_id))]
    await Promise.all(typeIds.map(async typeId => {
      const p = await getJitaPrice(typeId)
      setJitaPrices(prev => new Map([...prev, [typeId, p]]))
    }))
    setJitaLoading(false)
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return ' ↕'
    return sortDir === 'asc' ? ' ↑' : ' ↓'
  }

  const filteredActive = active.filter(o => {
    if (filterType === 'sell' && o.is_buy_order) return false
    if (filterType === 'buy' && !o.is_buy_order) return false
    if (filterLoc && !o.locationName.toLowerCase().includes(filterLoc.toLowerCase())) return false
    return true
  })

  const displayActive = [...filteredActive].sort((a, b) => {
    if (!sortKey) return 0
    if (sortKey === 'item') return sortDir === 'asc'
      ? a.itemName.localeCompare(b.itemName)
      : b.itemName.localeCompare(a.itemName)
    let av: number, bv: number
    switch (sortKey) {
      case 'price':  av = a.price; bv = b.price; break
      case 'total':  av = a.price * a.volume_remain; bv = b.price * b.volume_remain; break
      case 'volume': av = a.volume_remain; bv = b.volume_remain; break
      case 'expiry':
        av = new Date(a.issued).getTime() + a.duration * 86400000
        bv = new Date(b.issued).getTime() + b.duration * 86400000
        break
      default: return 0
    }
    return sortDir === 'asc' ? av - bv : bv - av
  })

  const sellOrders = active.filter(o => !o.is_buy_order)
  const buyOrders  = active.filter(o => o.is_buy_order)
  const sellISK    = sellOrders.reduce((s, o) => s + o.price * o.volume_remain, 0)
  const buyEscrow  = active.reduce((s, o) => s + (o.escrow ?? 0), 0)
  const locations  = [...new Set(active.map(o => o.locationName))].filter(l => l !== '—')

  const btnStyle = (on: boolean) => ({
    padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
    background: on ? 'rgba(0,180,216,0.15)' : 'transparent',
    border: `1px solid ${on ? 'var(--blue)' : 'var(--border)'}`,
    color: on ? 'var(--blue)' : 'var(--text-dim)',
  } as const)

  return (
    <>
      <Layout header={
        <PageHeader
          title="Market"
          sub={loading ? 'Laden...' : `${active.length} actief · ${fmtISK(sellISK)} ISK te verkopen · ${fmtISK(buyEscrow)} ISK escrow`}
          right={
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <button
                onClick={() => setAutoRefresh(a => !a)}
                title={autoRefresh ? 'Auto-refresh uitschakelen' : 'Auto-refresh elke 5 min'}
                style={{
                  padding: '0.3rem 0.6rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer', minWidth: 52,
                  background: autoRefresh ? 'rgba(0,180,216,0.12)' : 'transparent',
                  border: `1px solid ${autoRefresh ? 'var(--blue)' : 'var(--border)'}`,
                  color: autoRefresh ? 'var(--blue)' : 'var(--text-dim)',
                }}
              >
                {autoRefresh
                  ? `${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`
                  : '⏱ Auto'}
              </button>
              <button
                onClick={() => { setRefreshKey(k => k + 1); if (autoRefresh) setCountdown(300) }}
                disabled={loading}
                title="Data herladen"
                style={{
                  padding: '0.3rem 0.55rem', borderRadius: 2, fontSize: '0.8rem', fontWeight: 600,
                  cursor: loading ? 'default' : 'pointer',
                  background: 'transparent', border: '1px solid var(--border)',
                  color: loading ? 'var(--border)' : 'var(--text-dim)',
                }}
              >↻</button>
              <button onClick={() => setTab('active')}       style={btnStyle(tab === 'active')}>Actief ({active.length})</button>
              <button onClick={() => setTab('history')}      style={btnStyle(tab === 'history')}>Geschiedenis ({history.length})</button>
              <button onClick={() => setTab('transactions')} style={btnStyle(tab === 'transactions')}>Transacties ({txns.length})</button>
              {tab === 'active' && (
                <>
                  <button
                    onClick={analyzeUndercuts}
                    disabled={analyzing || loading || active.length === 0}
                    style={{
                      padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600,
                      cursor: analyzing ? 'default' : 'pointer',
                      background: 'rgba(240,192,64,0.08)', border: `1px solid ${analyzing ? 'rgba(240,192,64,0.5)' : 'rgba(240,192,64,0.3)'}`,
                      color: 'var(--gold)',
                    }}
                  >{analyzing ? '◈ Laden...' : '◈ Undercut'}</button>
                  <button
                    onClick={fetchJitaPrices}
                    disabled={jitaLoading || loading || active.length === 0}
                    style={{
                      padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600,
                      cursor: jitaLoading ? 'default' : 'pointer',
                      background: 'rgba(0,180,216,0.08)', border: `1px solid ${jitaLoading ? 'rgba(0,180,216,0.5)' : 'rgba(0,180,216,0.3)'}`,
                      color: 'var(--blue)',
                    }}
                  >{jitaLoading ? '⬡ Laden...' : '⬡ Jita'}</button>
                </>
              )}
            </div>
          }
        />
      }>
        {!loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
            {[
              { label: 'SELL ORDERS', value: String(sellOrders.length), color: 'var(--green)' },
              { label: 'BUY ORDERS',  value: String(buyOrders.length),  color: 'var(--blue)'  },
              { label: 'TE VERKOPEN', value: `${fmtISK(sellISK)} ISK`,  color: 'var(--green)' },
              { label: 'ESCROW',      value: `${fmtISK(buyEscrow)} ISK`, color: 'var(--gold)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.4rem' }}>{label}</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Market data laden...</div>
        )}

        {/* Filter bar */}
        {!loading && tab === 'active' && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            {(['all', 'sell', 'buy'] as FilterType[]).map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                style={{
                  padding: '0.22rem 0.6rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer',
                  background: filterType === t
                    ? (t === 'sell' ? 'rgba(0,220,110,0.12)' : t === 'buy' ? 'rgba(0,180,216,0.12)' : 'rgba(255,255,255,0.05)')
                    : 'transparent',
                  border: `1px solid ${filterType === t
                    ? (t === 'sell' ? 'var(--green)' : t === 'buy' ? 'var(--blue)' : 'var(--border)')
                    : 'var(--border)'}`,
                  color: filterType === t
                    ? (t === 'sell' ? 'var(--green)' : t === 'buy' ? 'var(--blue)' : 'var(--text)')
                    : 'var(--text-dim)',
                }}
              >{t === 'all' ? 'Alles' : t === 'sell' ? 'Sell' : 'Buy'}</button>
            ))}
            <select
              value={filterLoc}
              onChange={e => setFilterLoc(e.target.value)}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2,
                color: filterLoc ? 'var(--text)' : 'var(--text-dim)', fontSize: '0.68rem', padding: '0.22rem 0.5rem', cursor: 'pointer',
              }}
            >
              <option value="">Alle locaties</option>
              {locations.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            {(filterType !== 'all' || filterLoc) && (
              <button
                onClick={() => { setFilterType('all'); setFilterLoc('') }}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '0.68rem', cursor: 'pointer', padding: '0.22rem' }}
              >✕ Reset</button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: 'var(--text-dim)' }}>
              {filteredActive.length !== active.length ? `${filteredActive.length} / ${active.length}` : ''}
            </span>
          </div>
        )}

        {/* Active orders */}
        {!loading && tab === 'active' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                  {([
                    { label: 'Item',     key: 'item'   as SortKey },
                    { label: 'Type',     key: null },
                    { label: 'Prijs',    key: 'price'  as SortKey },
                    { label: 'Undercut', key: null },
                    { label: 'Jita',     key: null },
                    { label: 'Aantal',   key: 'volume' as SortKey },
                    { label: 'Totaal',   key: 'total'  as SortKey },
                    { label: 'Locatie',  key: null },
                    { label: 'Verloopt', key: 'expiry' as SortKey },
                  ] as { label: string; key: SortKey }[]).map(({ label, key }) => (
                    <th
                      key={label}
                      onClick={key ? () => toggleSort(key) : undefined}
                      style={{ ...TH, cursor: key ? 'pointer' : 'default', userSelect: 'none' }}
                    >
                      {label}{key ? sortArrow(key) : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayActive.length === 0 && (
                  <tr><td colSpan={9} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)' }}>Geen actieve orders</td></tr>
                )}
                {displayActive.map((o, i) => {
                  const exp  = orderExpiry(o.issued, o.duration)
                  const pct  = ((o.volume_total - o.volume_remain) / o.volume_total) * 100
                  const uc   = undercuts.get(o.order_id)
                  const diff = uc?.undercutPrice != null ? uc.undercutPrice - o.price : null
                  const jp   = jitaPrices.get(o.type_id)
                  const jitaPrice = jp ? (o.is_buy_order ? jp.buy : jp.sell) : undefined
                  const jitaDiff  = jitaPrice != null ? jitaPrice - o.price : null
                  const rowBg = exp.urgent
                    ? 'rgba(224,85,85,0.06)'
                    : i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent'
                  return (
                    <tr key={o.order_id} style={{ background: rowBg }}>
                      <td style={TD}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <img
                            src={`https://images.evetech.net/types/${o.type_id}/icon?size=32`}
                            alt=""
                            title="Prijsgeschiedenis (Jita)"
                            style={{ width: 28, height: 28, borderRadius: 3, background: '#0b0b1a', flexShrink: 0, cursor: 'pointer' }}
                            onClick={() => setHistoryModal({ typeId: o.type_id, name: o.itemName })}
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                          <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{o.itemName}</span>
                        </div>
                      </td>
                      <td style={TD}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: o.is_buy_order ? 'var(--blue)' : 'var(--green)' }}>
                          {o.is_buy_order ? 'BUY' : 'SELL'}
                        </span>
                      </td>
                      <td style={{ ...TD, fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {fmtISK(o.price)} ISK
                      </td>
                      <td style={{ ...TD, minWidth: 120 }}>
                        {!uc && !analyzing && <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>—</span>}
                        {(uc?.loading || (!uc && analyzing)) && <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>...</span>}
                        {uc && !uc.loading && uc.isTop && (
                          <span style={{ color: 'var(--green)', fontSize: '0.72rem', fontWeight: 700 }}>✓ Beste prijs</span>
                        )}
                        {uc && !uc.loading && !uc.isTop && uc.undercutPrice != null && (
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gold)', whiteSpace: 'nowrap' }} title={uc.undercutPrice.toFixed(2)}>
                                {fmtISK(uc.undercutPrice)} ISK
                              </span>
                              <button
                                onClick={() => navigator.clipboard?.writeText(uc.undercutPrice!.toFixed(2))}
                                title="Kopieer prijs"
                                style={{ background: 'rgba(240,192,64,0.1)', border: '1px solid rgba(240,192,64,0.25)', color: 'var(--gold)', borderRadius: 2, fontSize: '0.65rem', padding: '0.1rem 0.35rem', cursor: 'pointer' }}
                              >⎘</button>
                            </div>
                            {diff != null && (
                              <div style={{ fontSize: '0.6rem', color: Math.abs(diff) > 1e6 ? 'var(--red)' : 'var(--text-dim)', marginTop: '0.15rem' }}>
                                {diff >= 0 ? '+' : '−'}{fmtISK(Math.abs(diff))} ISK
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ ...TD, minWidth: 100 }}>
                        {jitaPrices.size === 0 && !jitaLoading && <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>—</span>}
                        {jitaLoading && !jp && <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>...</span>}
                        {jp && jitaPrice != null && (
                          <div>
                            <div style={{ fontSize: '0.73rem', fontWeight: 600, color: 'var(--blue)', whiteSpace: 'nowrap' }}>
                              {fmtISK(jitaPrice)} ISK
                            </div>
                            {jitaDiff != null && (
                              <div style={{ fontSize: '0.6rem', marginTop: '0.1rem', color: jitaDiff > 0 ? 'var(--green)' : 'var(--red)' }}>
                                {jitaDiff >= 0 ? '+' : '−'}{fmtISK(Math.abs(jitaDiff))} ISK
                              </div>
                            )}
                          </div>
                        )}
                        {jp && jitaPrice == null && <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>—</span>}
                      </td>
                      <td style={{ ...TD, minWidth: 110 }}>
                        <div style={{ fontSize: '0.7rem', marginBottom: '0.2rem' }}>
                          {o.volume_remain.toLocaleString()} / {o.volume_total.toLocaleString()}
                        </div>
                        <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: o.is_buy_order ? 'var(--blue)' : 'var(--green)', borderRadius: 2 }} />
                        </div>
                      </td>
                      <td style={{ ...TD, fontSize: '0.75rem', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>
                        {fmtISK(o.price * o.volume_remain)} ISK
                      </td>
                      <td style={{ ...TD, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Location locationId={o.location_id} name={o.locationName} fontSize="0.68rem" />
                      </td>
                      <td style={{ ...TD, fontSize: '0.72rem', color: exp.color, whiteSpace: 'nowrap', fontWeight: exp.urgent ? 700 : 400 }}>
                        {exp.urgent ? '⚠ ' : ''}{exp.label}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Order history */}
        {!loading && tab === 'history' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                  {['Item', 'Type', 'Prijs', 'Aantal', 'Locatie', 'Status', 'Datum'].map(h => (
                    <th key={h} style={TH}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.length === 0 && (
                  <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)' }}>Geen ordergeschiedenis</td></tr>
                )}
                {history.map((o, i) => {
                  const state = STATE_LABEL[o.state ?? ''] ?? { label: o.state ?? '—', color: 'var(--text-dim)' }
                  return (
                    <tr key={o.order_id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent' }}>
                      <td style={TD}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <img src={`https://images.evetech.net/types/${o.type_id}/icon?size=32`} alt="" style={{ width: 28, height: 28, borderRadius: 3, background: '#0b0b1a', flexShrink: 0 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{o.itemName}</span>
                        </div>
                      </td>
                      <td style={TD}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: o.is_buy_order ? 'var(--blue)' : 'var(--green)' }}>
                          {o.is_buy_order ? 'BUY' : 'SELL'}
                        </span>
                      </td>
                      <td style={{ ...TD, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtISK(o.price)} ISK</td>
                      <td style={{ ...TD, fontSize: '0.72rem' }}>{o.volume_total.toLocaleString()}</td>
                      <td style={{ ...TD, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Location locationId={o.location_id} name={o.locationName} fontSize="0.68rem" />
                      </td>
                      <td style={{ ...TD, fontSize: '0.7rem', color: state.color, fontWeight: 600 }}>{state.label}</td>
                      <td style={{ ...TD, fontSize: '0.68rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtDate(o.issued)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Transactions */}
        {!loading && tab === 'transactions' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                  {['Item', 'Type', 'Aantal', 'Stukprijs', 'Totaal', 'Tegenpartij', 'Datum'].map(h => (
                    <th key={h} style={TH}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txns.length === 0 && (
                  <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)' }}>Geen transacties gevonden</td></tr>
                )}
                {txns.map((t, i) => (
                  <tr key={t.transaction_id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent' }}>
                    <td style={TD}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <img src={`https://images.evetech.net/types/${t.type_id}/icon?size=32`} alt="" style={{ width: 28, height: 28, borderRadius: 3, background: '#0b0b1a', flexShrink: 0 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{t.itemName}</span>
                      </div>
                    </td>
                    <td style={TD}>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: t.is_buy ? 'var(--blue)' : 'var(--green)' }}>
                        {t.is_buy ? 'GEKOCHT' : 'VERKOCHT'}
                      </span>
                    </td>
                    <td style={{ ...TD, fontSize: '0.78rem' }}>{t.quantity.toLocaleString()}</td>
                    <td style={{ ...TD, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtISK(t.unit_price)} ISK</td>
                    <td style={{ ...TD, fontSize: '0.75rem', fontWeight: 600, color: t.is_buy ? 'var(--red)' : 'var(--green)', whiteSpace: 'nowrap' }}>
                      {t.is_buy ? '−' : '+'}{fmtISK(t.unit_price * t.quantity)} ISK
                    </td>
                    <td style={{ ...TD, fontSize: '0.7rem', color: 'var(--text-dim)' }}>{t.clientName}</td>
                    <td style={{ ...TD, fontSize: '0.68rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Layout>

      {historyModal && (
        <PriceHistoryModal
          typeId={historyModal.typeId}
          name={historyModal.name}
          onClose={() => setHistoryModal(null)}
        />
      )}
    </>
  )
}
