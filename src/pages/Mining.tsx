import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getMining, resolveNames, getReprocessBundle, getTypeInfo, type MiningEntry } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedEntry {
  date: string
  oreName: string
  typeId: number
  system: string
  quantity: number
  charName: string
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
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${typeIds.join(',')}`, { signal: AbortSignal.timeout(6000) })
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
  const [range, setRange]     = useState<'7' | '30' | 'all'>('all')
  const [orePrices, setOrePrices] = useState<Map<number, number>>(new Map())
  const [volMap, setVolMap]   = useState<Map<number, number>>(new Map())   // m³ per erts-unit
  // Reprocessing-recept per erts: { oreTypeId: { portion, mats:[[matId,qty],...] } }
  const [refineMap, setRefineMap] = useState<Map<number, { portion: number; mats: Array<[number, number]> }>>(new Map())
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setEntries([])

    async function load() {
      const allRaw: (MiningEntry & { _name: string; _cid: number })[] = []
      await Promise.all(tokens.map(async t => {
        const m = await getMining(t.characterId, t.accessToken).catch(() => [] as MiningEntry[])
        const name = t.characterName ?? `#${t.characterId}`
        allRaw.push(...m.map(e => ({ ...e, _name: name, _cid: t.characterId })))
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
        charName: e._name,
      }))

      const sorted = resolved.sort((a, b) => b.date.localeCompare(a.date))
      setEntries(sorted)
      setLoading(false)

      // Reprocessing-recepten uit de SDE-bundel → mineralen + portionSize per erts.
      const repBundle = await getReprocessBundle()
      const refine = new Map<number, { portion: number; mats: Array<[number, number]> }>()
      const vol = new Map<number, number>()
      const mineralIds = new Set<number>()
      await Promise.all(typeIds.map(async tid => {
        const info = await getTypeInfo(tid)
        if (info?.volume) vol.set(tid, info.volume)
        const mats = repBundle[String(tid)]
        if (!mats || mats.length === 0) return
        refine.set(tid, { portion: info?.portionSize || 100, mats })
        mats.forEach(([mid]) => mineralIds.add(mid))
      }))
      if (myId !== fetchId.current) return
      setRefineMap(refine)
      setVolMap(vol)

      // Jita-buy-prijzen voor zowel het ruwe erts als de gerefinede mineralen.
      fetchOrePrices([...new Set([...typeIds, ...mineralIds])]).then(prices => {
        if (myId !== fetchId.current) return
        setOrePrices(prices)

        // Bijdragen aan de Top Miners-ranglijst: per character het maand-totaal (m³ + ISK).
        const ym = new Date().toISOString().slice(0, 7)   // YYYY-MM
        const perChar = new Map<number, { name: string; m3: number; isk: number }>()
        for (const e of allRaw) {
          if (!e.date.startsWith(ym)) continue
          const cur = perChar.get(e._cid) ?? { name: e._name, m3: 0, isk: 0 }
          cur.m3  += e.quantity * (vol.get(e.type_id) ?? 0)
          cur.isk += e.quantity * (prices.get(e.type_id) ?? 0)
          perChar.set(e._cid, cur)
        }
        for (const [cid, v] of perChar) {
          fetch('/api/miners.php', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: cid, name: v.name, m3: Math.round(v.m3), isk: Math.round(v.isk) }),
          }).catch(() => {})
        }
      })
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  // Tijdsbereik-filter (7 / 30 dagen / alles)
  const cutoff = range === 'all' ? '' : new Date(Date.now() - (range === '7' ? 7 : 30) * 864e5).toISOString().slice(0, 10)
  const filtered = range === 'all' ? entries : entries.filter(e => e.date >= cutoff)
  const volOf = (typeId: number) => volMap.get(typeId) ?? 0

  // Dagelijkse totalen voor de grafiek
  const chartDays = range === '7' ? 7 : 30
  const dailyMap = new Map<string, number>()
  for (const e of filtered) dailyMap.set(e.date, (dailyMap.get(e.date) ?? 0) + e.quantity)
  const today = new Date()
  const chartData = Array.from({ length: chartDays }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() - (chartDays - 1 - i))
    const date = d.toISOString().slice(0, 10)
    const label = i === chartDays - 1 ? 'Vandaag' : d.toLocaleDateString('nl', { day: 'numeric', month: 'short' })
    return { date, label, quantity: dailyMap.get(date) ?? 0 }
  })

  const totalQty = filtered.reduce((s, e) => s + e.quantity, 0)
  const totalM3  = filtered.reduce((s, e) => s + e.quantity * volOf(e.typeId), 0)
  const todayQty = dailyMap.get(today.toISOString().slice(0, 10)) ?? 0
  const activeDays = dailyMap.size || 1

  // Gerefinede waarde: (aantal / portionSize) × Σ(mineraalAantal × Jita-buy).
  function refinedIsk(typeId: number, quantity: number): number {
    const r = refineMap.get(typeId)
    if (!r) return 0
    const perPortion = r.mats.reduce((s, [mid, q]) => s + q * (orePrices.get(mid) ?? 0), 0)
    return (quantity / r.portion) * perPortion
  }

  // Erts-verdeling
  const oreMap = new Map<string, { typeId: number; quantity: number }>()
  for (const e of filtered) {
    const cur = oreMap.get(e.oreName) ?? { typeId: e.typeId, quantity: 0 }
    oreMap.set(e.oreName, { ...cur, quantity: cur.quantity + e.quantity })
  }
  const oreList = [...oreMap.entries()]
    .map(([name, v]) => ({ name, ...v, m3: v.quantity * volOf(v.typeId), isk: (orePrices.get(v.typeId) ?? 0) * v.quantity, refIsk: refinedIsk(v.typeId, v.quantity) }))
    .sort((a, b) => b.quantity - a.quantity)

  const totalISK    = oreList.reduce((s, o) => s + o.isk, 0)
  const totalRefISK = oreList.reduce((s, o) => s + o.refIsk, 0)
  const bestISK     = Math.max(totalISK, totalRefISK)

  // Per systeem
  const sysMap = new Map<string, { quantity: number; isk: number }>()
  for (const e of filtered) {
    const cur = sysMap.get(e.system) ?? { quantity: 0, isk: 0 }
    cur.quantity += e.quantity; cur.isk += (orePrices.get(e.typeId) ?? 0) * e.quantity
    sysMap.set(e.system, cur)
  }
  const sysList = [...sysMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.quantity - a.quantity)

  // Per piloot (alleen relevant bij meerdere characters)
  const pilotMap = new Map<string, { quantity: number; isk: number }>()
  for (const e of filtered) {
    const cur = pilotMap.get(e.charName) ?? { quantity: 0, isk: 0 }
    cur.quantity += e.quantity; cur.isk += (orePrices.get(e.typeId) ?? 0) * e.quantity
    pilotMap.set(e.charName, cur)
  }
  const pilotList = [...pilotMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.quantity - a.quantity)

  // Tabel-groepering
  const groupMap = new Map<string, ResolvedEntry[]>()
  for (const e of filtered) {
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
        sub={loading ? 'Laden...' : `${fmtQty(totalQty)} units · ${fmtQty(totalM3)} m³${totalISK > 0 ? ` · erts ~${fmtISK(totalISK)}` : ''}${totalRefISK > 0 ? ` · gerefined ~${fmtISK(totalRefISK)}` : ''}${bestISK > 0 ? ` · ~${fmtISK(bestISK / activeDays)}/dag` : ''} · ${fmtQty(todayQty)} vandaag`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button onClick={() => setRange('7')}   style={btnStyle(range === '7')}>7d</button>
            <button onClick={() => setRange('30')}  style={btnStyle(range === '30')}>30d</button>
            <button onClick={() => setRange('all')} style={btnStyle(range === 'all')}>Alles</button>
            <span style={{ width: 1, background: 'var(--border)', margin: '2px 2px' }} />
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
                          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{fmtQty(ore.quantity)}{ore.m3 > 0 ? ` · ${fmtQty(ore.m3)} m³` : ''}</div>
                          {ore.isk > 0 && <div style={{ fontSize: '0.6rem', color: 'var(--gold)' }}>{fmtISK(ore.isk)} ISK</div>}
                          {ore.refIsk > 0 && (
                            <div style={{ fontSize: '0.58rem', color: ore.refIsk >= ore.isk ? 'var(--green)' : 'var(--text-dim)' }} title="Geschatte waarde na reprocessing (Jita buy)">
                              ⚒ {fmtISK(ore.refIsk)}
                            </div>
                          )}
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

          {/* Systemen + piloten */}
          <div style={{ display: 'grid', gridTemplateColumns: pilotList.length > 1 ? '1fr 1fr' : '1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.75rem' }}>TOP SYSTEMEN</div>
              {sysList.length === 0 && <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>—</div>}
              {sysList.slice(0, 6).map((s, i) => {
                const pct = sysList[0]?.quantity ? (s.quantity / sysList[0].quantity) * 100 : 0
                return (
                  <div key={s.name} style={{ marginBottom: '0.45rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem', gap: 8 }}>
                      <span style={{ fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⬡ {s.name}</span>
                      <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtQty(s.quantity)}{s.isk > 0 ? ` · ${fmtISK(s.isk)}` : ''}</span>
                    </div>
                    <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: COLORS[i % COLORS.length], borderRadius: 2 }} />
                    </div>
                  </div>
                )
              })}
            </div>
            {pilotList.length > 1 && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.75rem' }}>PER PILOOT</div>
                {pilotList.map((p, i) => {
                  const pct = pilotList[0]?.quantity ? (p.quantity / pilotList[0].quantity) * 100 : 0
                  return (
                    <div key={p.name} style={{ marginBottom: '0.45rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem', gap: 8 }}>
                        <span style={{ fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtQty(p.quantity)}{p.isk > 0 ? ` · ${fmtISK(p.isk)}` : ''}</span>
                      </div>
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: COLORS[(i + 3) % COLORS.length], borderRadius: 2 }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen mining data in dit bereik</div>
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

