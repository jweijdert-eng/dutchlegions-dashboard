import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getMining, resolveNames, type MiningEntry } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedEntry {
  date: string
  oreName: string
  typeId: number
  system: string
  quantity: number
}

function fmtQty(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return `${v}`
}

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${v.toFixed(0)}`
}

async function fetchOrePrices(typeIds: number[]): Promise<Map<number, number>> {
  if (typeIds.length === 0) return new Map()
  try {
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=${typeIds.join(',')}`, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return new Map()
    const data = await r.json() as Record<string, { buy: { max: number }; sell: { min: number } }>
    const map = new Map<number, number>()
    for (const [idStr, agg] of Object.entries(data)) {
      map.set(parseInt(idStr), agg.buy.max)
    }
    return map
  } catch { return new Map() }
}

const COLORS = [
  '#00b4d8','#3ecf6e','#f0c040','#e05555','#a78bfa',
  '#f97316','#06b6d4','#84cc16','#ec4899','#14b8a6',
]

export default function Mining() {
  const { activeTokens: tokens } = useAuth()
  const [entries, setEntries] = useState<ResolvedEntry[]>([])
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [view, setView]       = useState<'date' | 'ore'>('date')
  const [orePrices, setOrePrices] = useState<Map<number, number>>(new Map())
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setEntries([])

    async function load() {
      const allRaw: MiningEntry[] = []
      await Promise.all(tokens.map(async t => {
        const m = await getMining(t.characterId, t.accessToken).catch(() => [] as MiningEntry[])
        allRaw.push(...m)
      }))

      if (myId !== fetchId.current) return

      const typeIds   = [...new Set(allRaw.map(e => e.type_id))]
      const systemIds = [...new Set(allRaw.map(e => e.solar_system_id))]
      const nameMap   = await resolveNames([...typeIds, ...systemIds])

      if (myId !== fetchId.current) return

      const resolved: ResolvedEntry[] = allRaw.map(e => ({
        date:     e.date,
        oreName:  nameMap.get(e.type_id) ?? `Type ${e.type_id}`,
        typeId:   e.type_id,
        system:   nameMap.get(e.solar_system_id) ?? `System ${e.solar_system_id}`,
        quantity: e.quantity,
      }))

      const sorted = resolved.sort((a, b) => b.date.localeCompare(a.date))
      setEntries(sorted)
      setLoading(false)

      // Fetch Jita buy prices (reuse already-collected typeIds)
      fetchOrePrices(typeIds).then(prices => {
        if (myId !== fetchId.current) return
        setOrePrices(prices)
      })
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  // Daily totals for chart (last 14 days)
  const dailyMap = new Map<string, number>()
  for (const e of entries) {
    dailyMap.set(e.date, (dailyMap.get(e.date) ?? 0) + e.quantity)
  }
  const today = new Date()
  const chartData = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() - (13 - i))
    const date = d.toISOString().slice(0, 10)
    const label = i === 13 ? 'Today' : d.toLocaleDateString('nl', { weekday: 'short', day: 'numeric' })
    return { date, label, quantity: dailyMap.get(date) ?? 0 }
  })

  const totalQty = entries.reduce((s, e) => s + e.quantity, 0)
  const todayQty = dailyMap.get(today.toISOString().slice(0, 10)) ?? 0

  // Ore breakdown
  const oreMap = new Map<string, { typeId: number; quantity: number }>()
  for (const e of entries) {
    const cur = oreMap.get(e.oreName) ?? { typeId: e.typeId, quantity: 0 }
    oreMap.set(e.oreName, { ...cur, quantity: cur.quantity + e.quantity })
  }
  const oreList = [...oreMap.entries()]
    .map(([name, v]) => ({ name, ...v, isk: (orePrices.get(v.typeId) ?? 0) * v.quantity }))
    .sort((a, b) => b.quantity - a.quantity)

  const totalISK = oreList.reduce((s, o) => s + o.isk, 0)

  // Group table rows
  const groupMap = new Map<string, ResolvedEntry[]>()
  for (const e of entries) {
    const key = view === 'date' ? e.date : e.oreName
    const g = groupMap.get(key) ?? []
    g.push(e)
    groupMap.set(key, g)
  }

  const btnStyle = (on: boolean) => ({
    padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
    background: on ? 'rgba(0,180,216,0.15)' : 'transparent',
    border: `1px solid ${on ? 'var(--blue)' : 'var(--border)'}`,
    color: on ? 'var(--blue)' : 'var(--text-dim)',
  } as const)

  return (
    <Layout header={
      <PageHeader
        title="Mining"
        sub={loading ? 'Laden...' : `${fmtQty(totalQty)} units${totalISK > 0 ? ` · ~${fmtISK(totalISK)} ISK` : ''} · ${fmtQty(todayQty)} vandaag`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button onClick={() => setView('date')} style={btnStyle(view === 'date')}>Per datum</button>
            <button onClick={() => setView('ore')}  style={btnStyle(view === 'ore')}>Per erts</button>
          </div>
        }
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Mining data laden...
        </div>
      )}

      {!loading && (
        <>
          {/* Stats + chart row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            {/* Ore breakdown */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.75rem' }}>ERTS VERDELING</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {oreList.slice(0, 8).map((ore, i) => {
                  const pct = totalQty > 0 ? (ore.quantity / totalQty) * 100 : 0
                  return (
                    <div key={ore.name}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <img
                            src={`https://images.evetech.net/types/${ore.typeId}/icon?size=32`}
                            alt=""
                            style={{ width: 18, height: 18, borderRadius: 2 }}
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                          <span style={{ fontSize: '0.72rem' }}>{ore.name}</span>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{fmtQty(ore.quantity)}</div>
                          {ore.isk > 0 && <div style={{ fontSize: '0.6rem', color: 'var(--gold)' }}>{fmtISK(ore.isk)} ISK</div>}
                        </div>
                      </div>
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: COLORS[i % COLORS.length], borderRadius: 2 }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Daily chart */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.5rem' }}>DAGELIJKS (14 DAGEN)</div>
              <div style={{ height: 160 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barSize={14}>
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} axisLine={false} tickLine={false} interval={1} />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{ background: '#0b0b1a', border: '1px solid #1c1c35', borderRadius: 3, fontSize: 11 }}
                      formatter={(v: number) => [fmtQty(v) + ' units', 'Gemined']}
                      labelFormatter={(_: unknown, payload: {payload?: {date: string}}[]) => payload?.[0]?.payload?.date ?? ''}
                    />
                    <Bar dataKey="quantity" radius={[2, 2, 0, 0]}>
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.date === today.toISOString().slice(0, 10) ? '#3ecf6e' : '#00b4d8'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Table */}
          {entries.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen mining data gevonden</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {[...groupMap.entries()].map(([groupKey, rows]) => {
                const groupTotal = rows.reduce((s, r) => s + r.quantity, 0)
                return (
                  <div key={groupKey} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ padding: '0.5rem 0.85rem', background: 'var(--surface2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{groupKey}</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{fmtQty(groupTotal)} units</span>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} style={{ borderTop: '1px solid rgba(28,28,53,0.5)', background: i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent' }}>
                            <td style={{ padding: '0.4rem 0.85rem', width: 32 }}>
                              <img
                                src={`https://images.evetech.net/types/${r.typeId}/icon?size=32`}
                                alt=""
                                style={{ width: 26, height: 26, borderRadius: 2, display: 'block', background: '#0b0b1a' }}
                                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            </td>
                            <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.78rem', fontWeight: 600 }}>
                              {view === 'date' ? r.oreName : r.date}
                            </td>
                            <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.7rem', color: 'var(--text-dim)' }}>{r.system}</td>
                            <td style={{ padding: '0.4rem 0.85rem', fontSize: '0.78rem', fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {fmtQty(r.quantity)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </Layout>
  )
}

