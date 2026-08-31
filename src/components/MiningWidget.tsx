import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import { getMining, type MiningEntry } from '../api/esi'

function fmt(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${Math.round(v)}`
}

// Jita-buy-prijs per erts (fuzzwork aggregates) — voor een ruwe ISK-schatting.
async function fetchOrePrices(typeIds: number[]): Promise<Map<number, number>> {
  if (typeIds.length === 0) return new Map()
  try {
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${typeIds.join(',')}`, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return new Map()
    const data = await r.json() as Record<string, { buy: { max: number } }>
    const m = new Map<number, number>()
    for (const [id, agg] of Object.entries(data)) m.set(parseInt(id), agg.buy.max)
    return m
  } catch { return new Map() }
}

export default function MiningWidget() {
  const { activeTokens } = useAuth()
  const [entries, setEntries] = useState<MiningEntry[]>([])
  const [prices, setPrices] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (activeTokens.length === 0) { setLoading(false); setEntries([]); return }
    let cancel = false
    setLoading(true)
    ;(async () => {
      const all: MiningEntry[] = []
      await Promise.all(activeTokens.map(async t => {
        const m = await getMining(t.characterId, t.accessToken).catch(() => [] as MiningEntry[])
        all.push(...m)
      }))
      if (cancel) return
      setEntries(all); setLoading(false)
      const typeIds = [...new Set(all.map(e => e.type_id))]
      fetchOrePrices(typeIds).then(p => { if (!cancel) setPrices(p) })
    })()
    return () => { cancel = true }
  }, [activeTokens.map(t => t.characterId).join(',')])

  const byDate = new Map<string, number>()
  for (const e of entries) byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.quantity)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i))
    const date = d.toISOString().slice(0, 10)
    const label = i === 6 ? 'Today' : d.toLocaleDateString('nl', { weekday: 'short' })
    return { date, label, units: byDate.get(date) ?? 0 }
  })
  const todayUnits = days[6].units
  const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
  const isk7d = entries.filter(e => e.date >= cutoff).reduce((s, e) => s + (prices.get(e.type_id) ?? 0) * e.quantity, 0)

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>MINING</div>
        {!loading && todayUnits > 0 && <div style={{ fontSize: '0.68rem', color: '#f0c040', fontWeight: 600 }}>{fmt(todayUnits)} vandaag</div>}
        {loading && <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Laden...</div>}
      </div>

      <div style={{ flex: 1, minHeight: 100 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} barSize={10} barCategoryGap="30%">
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#0b0b1a', border: '1px solid #1c1c35', borderRadius: 3, fontSize: 11 }}
              formatter={(v: number) => [`${fmt(v)} units`, 'Gemined']}
            />
            <Bar dataKey="units" fill="#f0c040" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
        <div style={{ background: 'rgba(240,192,64,0.06)', border: '1px solid rgba(240,192,64,0.15)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: '#f0c040', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>VANDAAG</div>
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{fmt(todayUnits)}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>units</div>
        </div>
        <div style={{ background: 'rgba(0,180,216,0.06)', border: '1px solid rgba(0,180,216,0.15)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>WAARDE 7D</div>
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{isk7d > 0 ? fmt(isk7d) : '—'}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>ISK (Jita buy)</div>
        </div>
      </div>
    </div>
  )
}
