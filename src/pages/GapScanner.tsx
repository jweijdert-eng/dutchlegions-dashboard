import { Fragment, useEffect, useMemo, useState } from 'react'
import { ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import { getAllRegionOrders, getRegionHistory, openMarketWindow, type PublicMarketOrder, type RegionHistoryPoint } from '../api/esi'
import EveImage from '../components/EveImage'
import Layout, { PageHeader } from '../components/Layout'

// Jita / The Forge
const THE_FORGE = 10000002
const JITA_44 = 60003760

// ── Categorie-definities (via inventory-groepen/categorieën uit de SDE-bundel) ──
type CatKey = 'ships' | 'equipment' | 'implants' | 'drones' | 'mods' | 'shield' | 'turrets'
const CATS: { key: CatKey; label: string; parent?: CatKey; test: (groupName: string, categoryId: number) => boolean }[] = [
  { key: 'ships', label: 'Ships', test: (_n, cat) => cat === 6 },
  // Ship Equipment = alle fitting-modules (categorie 7). Shield en Turrets vallen hieronder.
  { key: 'equipment', label: 'Ship Equipment', test: (_n, cat) => cat === 7 },
  { key: 'implants', label: 'Implants & Boosters', test: (_n, cat) => cat === 20 },
  { key: 'drones', label: 'Drones', test: (_n, cat) => cat === 18 },
  {
    key: 'mods', label: 'Ship & Module Modifications',        // rigs + mutaplasmids
    test: (n, cat) => (cat === 7 && /^rig\s/i.test(n)) || (cat === 17 && /mutaplasmid/i.test(n)),
  },
  { key: 'shield', label: 'Shield', parent: 'equipment', test: (n, cat) => cat === 7 && /shield/i.test(n) },
  {
    key: 'turrets', label: 'Turrets & Launchers', parent: 'equipment',
    test: (n, cat) => cat === 7 && (/(energy|hybrid|projectile)\s*weapon/i.test(n) || /missile launcher/i.test(n)),
  },
]

// ── Stijl (zelfde look als de andere pagina's) ──
const INPUT: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none',
}
const LABEL: React.CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem',
}
const TH: React.CSSProperties = {
  textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.4rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }

function fmtISK(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toLocaleString('nl-NL', { maximumFractionDigits: 0 })
}

// Prijs-historie-grafiek (uitklap onder een rij)
function HistoryChart({ data, cheapest }: { data: RegionHistoryPoint[]; cheapest: number }) {
  const recent = data.slice(-120)
  const chartData = recent.map(d => ({ date: d.date.slice(5), price: d.average, volume: d.volume }))
  const prices = recent.map(d => d.average)
  const min = Math.min(...prices), max = Math.max(...prices)
  const avg = prices.reduce((s, x) => s + x, 0) / (prices.length || 1)
  const vsAvg = avg > 0 ? (cheapest / avg - 1) * 100 : 0
  return (
    <div>
      <div style={{ display: 'flex', gap: '1.1rem', flexWrap: 'wrap', fontSize: '0.66rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>
        <span>90d gem.: <b style={{ color: 'var(--text)' }}>{fmtISK(avg)}</b></span>
        <span>laag: {fmtISK(min)}</span>
        <span>hoog: {fmtISK(max)}</span>
        <span>goedkoopste nu: <b style={{ color: vsAvg <= 0 ? '#4ade80' : '#ff5c6c' }}>{fmtISK(cheapest)}</b> ({vsAvg >= 0 ? '+' : ''}{vsAvg.toFixed(0)}% vs gem.)</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} minTickGap={28} />
          <YAxis yAxisId="price" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtISK(v)} />
          <YAxis yAxisId="vol" orientation="right" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={40} />
          <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: '0.7rem', borderRadius: 4 }}
            formatter={(value: number, name: string) => name === 'price' ? [fmtISK(value), 'gem. prijs'] : [value.toLocaleString('nl-NL'), 'volume']} />
          <Bar yAxisId="vol" dataKey="volume" fill="var(--border)" />
          <Line yAxisId="price" dataKey="price" stroke="#00b4d8" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

interface GapRow {
  typeId: number
  name: string
  groupName: string
  cheapest: number
  avgBuy: number     // gemiddelde werkelijke koopprijs van de op te kopen units
  buyUnder: number   // bovenkant van het goedkope cluster (koop hieronder)
  sellWall: number   // eerstvolgende order boven het gat
  gapISK: number
  gapPct: number
  units: number      // units ≤ buyUnder (op te kopen)
  netPerUnit: number // na verkoop-fees, o.b.v. echte koopkosten
  potential: number  // echte totale winst (opbrengst − werkelijke koopkosten)
}

// Grootste sprong (≥ minGapPct) BINNEN de ~5 goedkoopste orders: een snelle flip —
// koop de paar goedkoopste, verkoop net onder de eerstvolgende. De rest van de ladder
// negeren we (het gaat om de goedkope kant + snelle omzet, niet om alles opkopen).
const GAP_WINDOW = 5
function bestGap(sell: { price: number; vol: number }[], minGapPct: number) {
  const asc = [...sell].sort((a, b) => a.price - b.price)
  const N = Math.min(GAP_WINDOW, asc.length)
  let best: { i: number; cur: number; next: number; pct: number } | null = null
  for (let i = 0; i < N - 1; i++) {
    const cur = asc[i].price, next = asc[i + 1].price
    const pct = cur > 0 ? (next - cur) / cur : 0
    if (pct * 100 >= minGapPct && (!best || pct > best.pct)) best = { i, cur, next, pct }
  }
  if (!best) return null
  const below = asc.slice(0, best.i + 1) // de goedkoopste orders t/m de sprong (die koop je op)
  const units = below.reduce((s, o) => s + o.vol, 0)
  const buyCost = below.reduce((s, o) => s + o.price * o.vol, 0) // echte kosten
  return { cheapest: asc[0].price, buyUnder: best.cur, sellWall: best.next, gapISK: best.next - best.cur, gapPct: best.pct, units, buyCost }
}

// Gemiddeld dagelijks handelsvolume (laatste ~20 dagen) — maat voor "snelle verkoper".
function avgDailyVolume(hist: RegionHistoryPoint[]): number {
  const recent = hist.slice(-20)
  if (recent.length === 0) return 0
  return recent.reduce((s, d) => s + d.volume, 0) / recent.length
}

export default function GapScanner() {
  const { tokens, activeTokens } = useAuth()
  const [msg, setMsg] = useState<string | null>(null)

  const [bundles, setBundles] = useState<{
    typeInfo: Record<string, [number, number, number]>
    groups: Record<string, [string, number]>
    names: Record<string, string>
  } | null>(null)

  const [cats, setCats] = useState<Record<CatKey, boolean>>({
    ships: true, equipment: false, implants: false, drones: false, mods: false, shield: false, turrets: false,
  })
  const [minGapPct, setMinGapPct] = useState(15)
  const [minValue, setMinValue] = useState(100_000_000)
  const [feePct, setFeePct] = useState(8)
  const [minVolume, setMinVolume] = useState(1)

  const [orders, setOrders] = useState<PublicMarketOrder[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Prijs-historie per item (lazy, gecached) — ook gebruikt voor het dagvolume
  const [expanded, setExpanded] = useState<number | null>(null)
  const [histCache, setHistCache] = useState<Record<number, RegionHistoryPoint[]>>({})
  const [histLoading, setHistLoading] = useState<number | null>(null)
  const [volProgress, setVolProgress] = useState<{ done: number; total: number } | null>(null)

  // Bundels laden
  useEffect(() => {
    Promise.all([
      fetch('/type-info.json').then(r => r.json()),
      fetch('/groups.json').then(r => r.json()),
      fetch('/type-names.json').then(r => r.json()),
    ]).then(([typeInfo, groups, names]) => setBundles({ typeInfo, groups, names }))
      .catch(() => setErr('Kon de SDE-bundel niet laden.'))
  }, [])

  // Type-ids voor de gekozen categorieën
  const typeSet = useMemo(() => {
    const set = new Set<number>()
    if (!bundles) return set
    const active = CATS.filter(c => cats[c.key])
    if (active.length === 0) return set
    for (const [id, t] of Object.entries(bundles.typeInfo)) {
      const groupId = t[0]
      const g = bundles.groups[String(groupId)]
      if (!g) continue
      const [groupName, categoryId] = g
      if (active.some(c => c.test(groupName, categoryId))) set.add(Number(id))
    }
    return set
  }, [bundles, cats])

  const scan = async () => {
    setLoading(true); setErr(null); setProgress({ done: 0, total: 1 })
    try {
      const all = await getAllRegionOrders(THE_FORGE, (done, total) => setProgress({ done, total }))
      setOrders(all)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Scan mislukt.')
    } finally {
      setLoading(false); setProgress(null)
    }
  }

  // Gaten berekenen (herberekent direct bij het aanpassen van filters/categorieën)
  const gapRows = useMemo<GapRow[]>(() => {
    if (!orders || !bundles || typeSet.size === 0) return []
    const byType = new Map<number, { price: number; vol: number }[]>()
    for (const o of orders) {
      if (o.is_buy_order || o.location_id !== JITA_44 || !typeSet.has(o.type_id)) continue
      const arr = byType.get(o.type_id) ?? []
      arr.push({ price: o.price, vol: o.volume_remain })
      byType.set(o.type_id, arr)
    }
    const fee = feePct / 100
    const out: GapRow[] = []
    for (const [typeId, sell] of byType) {
      if (sell.length < 2) continue
      const g = bestGap(sell, minGapPct) // eerste sprong ≥ drempel = de muur na het cluster
      if (!g) continue
      if (g.cheapest < minValue) continue
      // Echte koopkosten: elke op te kopen order tegen z'n eigen prijs
      const revenue = g.units * g.sellWall * (1 - fee)
      const netTotal = revenue - g.buyCost
      if (netTotal <= 0) continue
      const avgBuy = g.units > 0 ? g.buyCost / g.units : g.buyUnder
      const grp = bundles.groups[String(bundles.typeInfo[String(typeId)]?.[0])]
      out.push({
        typeId,
        name: bundles.names[String(typeId)] ?? `#${typeId}`,
        groupName: grp?.[0] ?? '',
        cheapest: g.cheapest, avgBuy, buyUnder: g.buyUnder, sellWall: g.sellWall,
        gapISK: g.gapISK, gapPct: g.gapPct, units: g.units,
        netPerUnit: netTotal / g.units, potential: netTotal,
      })
    }
    return out.sort((a, b) => b.potential - a.potential)
  }, [orders, bundles, typeSet, minGapPct, minValue, feePct])

  // Voor de gap-kandidaten de markt-historie ophalen (voor het dagvolume), parallel + gecached.
  useEffect(() => {
    const missing = gapRows.map(r => r.typeId).filter(id => !(id in histCache)).slice(0, 250)
    if (missing.length === 0) { setVolProgress(null); return }
    let cancelled = false
    setVolProgress({ done: 0, total: missing.length })
    ;(async () => {
      const batch = 15
      for (let i = 0; i < missing.length && !cancelled; i += batch) {
        const slice = missing.slice(i, i + batch)
        const res = await Promise.all(slice.map(id => getRegionHistory(THE_FORGE, id).then(h => [id, h] as const)))
        if (cancelled) return
        setHistCache(c => { const n = { ...c }; for (const [id, h] of res) n[id] = h; return n })
        setVolProgress({ done: Math.min(i + batch, missing.length), total: missing.length })
      }
      if (!cancelled) setVolProgress(null)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapRows])

  // Dagvolume erbij + filter op "snelle verkopers" + sortering
  const rows = useMemo(() => {
    return gapRows
      .map(r => {
        const h = histCache[r.typeId]
        return { ...r, dailyVolume: h ? avgDailyVolume(h) : -1 } // -1 = nog onbekend
      })
      .filter(r => r.dailyVolume < 0 || r.dailyVolume >= minVolume)
      .sort((a, b) => b.potential - a.potential)
  }, [gapRows, histCache, minVolume])

  const openInEve = async (typeId: number) => {
    const t = activeTokens[0] ?? tokens[0]
    if (!t) { setMsg('Log in / selecteer een character om items in-game te openen.'); return }
    setMsg(null)
    const ok = await openMarketWindow(typeId, t.accessToken)
    if (!ok) setMsg('Kon het marktvenster niet openen — draait de EVE-client, en is het actieve character ingelogd?')
  }

  const toggleHistory = async (typeId: number) => {
    if (expanded === typeId) { setExpanded(null); return }
    setExpanded(typeId)
    if (!histCache[typeId]) {
      setHistLoading(typeId)
      const h = await getRegionHistory(THE_FORGE, typeId)
      setHistCache(c => ({ ...c, [typeId]: h }))
      setHistLoading(null)
    }
  }

  return (
    <Layout header={<PageHeader title="🕳️ Jita Gap Scanner" sub="Snelle flips in Jita: een prijs-gat in de goedkoopste orders, gefilterd op dagelijks handelsvolume (snelle verkopers)." />}>
      <div style={{ maxWidth: 1200 }}>

      {/* Categorieën */}
      <div style={{ marginBottom: '0.7rem' }}>
        <div style={LABEL}>CATEGORIEËN</div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {CATS.filter(c => !c.parent).map(c => (
            <button key={c.key} onClick={() => setCats(s => ({ ...s, [c.key]: !s[c.key] }))}
              style={{
                ...INPUT, cursor: 'pointer', fontWeight: 600,
                background: cats[c.key] ? 'var(--blue)' : 'var(--surface2)',
                color: cats[c.key] ? '#0a0a12' : 'var(--text)',
                borderColor: cats[c.key] ? 'var(--blue)' : 'var(--border)',
              }}>
              {c.label}
            </button>
          ))}
        </div>
        {/* Sub-categorieën van Ship Equipment */}
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.35rem', paddingLeft: '0.5rem' }}>
          <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>↳ onderdeel van Ship Equipment:</span>
          {CATS.filter(c => c.parent === 'equipment').map(c => {
            const on = cats[c.key] || cats.equipment
            return (
              <button key={c.key} onClick={() => setCats(s => ({ ...s, [c.key]: !s[c.key] }))}
                title={cats.equipment ? 'Zit al in Ship Equipment' : undefined}
                style={{
                  ...INPUT, cursor: 'pointer', fontWeight: 600, fontSize: '0.68rem', padding: '0.25rem 0.55rem',
                  background: on ? 'var(--blue)' : 'var(--surface2)',
                  color: on ? '#0a0a12' : 'var(--text)',
                  borderColor: on ? 'var(--blue)' : 'var(--border)',
                  opacity: cats.equipment && !cats[c.key] ? 0.75 : 1,
                }}>
                {c.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Filters + scan */}
      <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
        <div>
          <div style={LABEL}>MIN. GAT %</div>
          <input type="number" value={minGapPct} min={0} onChange={e => setMinGapPct(+e.target.value)} style={{ ...INPUT, width: 90 }} />
        </div>
        <div>
          <div style={LABEL}>MIN. WAARDE (ISK)</div>
          <input type="number" value={minValue} min={0} step={1_000_000} onChange={e => setMinValue(+e.target.value)} style={{ ...INPUT, width: 130 }} />
        </div>
        <div>
          <div style={LABEL}>VERKOOP-FEES %</div>
          <input type="number" value={feePct} min={0} step={0.5} onChange={e => setFeePct(+e.target.value)} style={{ ...INPUT, width: 90 }} />
        </div>
        <div>
          <div style={LABEL}>MIN. VOL/DAG</div>
          <input type="number" value={minVolume} min={0} onChange={e => setMinVolume(+e.target.value)} style={{ ...INPUT, width: 90 }} />
        </div>
        <button onClick={scan} disabled={loading || typeSet.size === 0} style={{
          ...INPUT, cursor: loading ? 'wait' : 'pointer', fontWeight: 700,
          background: 'var(--blue)', color: '#0a0a12', borderColor: 'var(--blue)', padding: '0.4rem 1rem',
        }}>
          {loading ? 'Scannen…' : orders ? 'Opnieuw scannen' : 'Scan Jita'}
        </button>
        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
          {typeSet.size > 0 ? `${typeSet.size.toLocaleString('nl-NL')} types in scope` : 'kies een categorie'}
        </div>
      </div>

      {progress && (
        <div style={{ marginBottom: '0.8rem' }}>
          <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round((progress.done / progress.total) * 100)}%`, background: 'var(--blue)', transition: 'width .2s' }} />
          </div>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
            Orders ophalen… pagina {progress.done}/{progress.total}
          </div>
        </div>
      )}

      {err && <div style={{ color: '#ff5c6c', fontSize: '0.72rem', marginBottom: '0.6rem' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--blue)', fontSize: '0.72rem', marginBottom: '0.6rem' }}>{msg}</div>}

      {orders && !loading && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
          {rows.length} flip-kans{rows.length === 1 ? '' : 'en'} — gesorteerd op potentieel · klik op een rij voor de prijs-historie{volProgress ? ` · dagvolume laden ${volProgress.done}/${volProgress.total}…` : ''}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                <th style={TH}>Goedkoopste</th>
                <th style={TH}>Gem. koop</th>
                <th style={TH}>Muur</th>
                <th style={TH}>Gat %</th>
                <th style={TH}>Gat ISK</th>
                <th style={TH}>Units</th>
                <th style={TH}>Vol/dag</th>
                <th style={TH}>Net/stuk</th>
                <th style={TH}>Potentieel</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map(r => (
                <Fragment key={r.typeId}>
                <tr onClick={() => toggleHistory(r.typeId)}
                    style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: expanded === r.typeId ? 'var(--surface2)' : undefined }}>
                  <td style={{ ...TD, textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <EveImage category="types" id={r.typeId} variation="icon" size={32} px={28} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>{r.groupName}</div>
                      </div>
                    </div>
                  </td>
                  <td style={TD}>{fmtISK(r.cheapest)}</td>
                  <td style={TD} title={`t/m ${fmtISK(r.buyUnder)}`}>{fmtISK(r.avgBuy)}</td>
                  <td style={TD}>{fmtISK(r.sellWall)}</td>
                  <td style={{ ...TD, color: '#4ade80', fontWeight: 700 }}>{(r.gapPct * 100).toFixed(0)}%</td>
                  <td style={TD}>{fmtISK(r.gapISK)}</td>
                  <td style={TD}>{r.units.toLocaleString('nl-NL')}</td>
                  <td style={{ ...TD, color: r.dailyVolume < 0 ? 'var(--text-dim)' : (r.dailyVolume >= 10 ? '#4ade80' : 'var(--text)') }}>
                    {r.dailyVolume < 0 ? '…' : Math.round(r.dailyVolume).toLocaleString('nl-NL')}
                  </td>
                  <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.netPerUnit)}</td>
                  <td style={{ ...TD, fontWeight: 700 }}>{fmtISK(r.potential)}</td>
                  <td style={TD}>
                    <button onClick={e => { e.stopPropagation(); openInEve(r.typeId) }} title="Open in EVE" style={{ ...INPUT, cursor: 'pointer', padding: '0.15rem 0.4rem' }}>⧉</button>
                  </td>
                </tr>
                {expanded === r.typeId && (
                  <tr>
                    <td colSpan={11} style={{ padding: '0.7rem 1rem', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                      {histLoading === r.typeId
                        ? <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Prijs-historie laden…</div>
                        : (histCache[r.typeId]?.length
                          ? <HistoryChart data={histCache[r.typeId]} cheapest={r.cheapest} />
                          : <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Geen historie beschikbaar.</div>)}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </Layout>
  )
}
