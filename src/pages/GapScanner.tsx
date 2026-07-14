import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getAllRegionOrders, openMarketWindow, type PublicMarketOrder } from '../api/esi'
import EveImage from '../components/EveImage'
import Layout, { PageHeader } from '../components/Layout'

// Jita / The Forge
const THE_FORGE = 10000002
const JITA_44 = 60003760

// ── Categorie-definities (via inventory-groepen/categorieën uit de SDE-bundel) ──
type CatKey = 'ships' | 'shield' | 'turrets'
const CATS: { key: CatKey; label: string; test: (groupName: string, categoryId: number) => boolean }[] = [
  { key: 'ships', label: 'Ships', test: (_n, cat) => cat === 6 },
  { key: 'shield', label: 'Shield', test: (n, cat) => cat === 7 && /shield/i.test(n) },
  {
    key: 'turrets', label: 'Turrets & Launchers',
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

interface GapRow {
  typeId: number
  name: string
  groupName: string
  cheapest: number
  buyUnder: number   // bovenkant van het goedkope cluster (koop hieronder)
  sellWall: number   // eerstvolgende order boven het gat
  gapISK: number
  gapPct: number
  units: number      // units ≤ buyUnder (op te kopen)
  netPerUnit: number // na verkoop-fees
  potential: number
}

// Grootste prijs-gat onderin de sell-ladder van één item.
function bestGap(sell: { price: number; vol: number }[]) {
  const asc = [...sell].sort((a, b) => a.price - b.price)
  const N = Math.min(asc.length, 25)
  let best: { i: number; cur: number; next: number; gap: number; pct: number } | null = null
  for (let i = 0; i < N - 1; i++) {
    const cur = asc[i].price, next = asc[i + 1].price
    const gap = next - cur, pct = cur > 0 ? gap / cur : 0
    if (!best || pct > best.pct) best = { i, cur, next, gap, pct }
  }
  if (!best) return null
  const units = asc.slice(0, best.i + 1).reduce((s, o) => s + o.vol, 0)
  return { cheapest: asc[0].price, buyUnder: best.cur, sellWall: best.next, gapISK: best.gap, gapPct: best.pct, units }
}

export default function GapScanner() {
  const { tokens } = useAuth()

  const [bundles, setBundles] = useState<{
    typeInfo: Record<string, [number, number, number]>
    groups: Record<string, [string, number]>
    names: Record<string, string>
  } | null>(null)

  const [cats, setCats] = useState<Record<CatKey, boolean>>({ ships: true, shield: false, turrets: false })
  const [minGapPct, setMinGapPct] = useState(15)
  const [minValue, setMinValue] = useState(100_000_000)
  const [feePct, setFeePct] = useState(8)

  const [orders, setOrders] = useState<PublicMarketOrder[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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
  const rows = useMemo<GapRow[]>(() => {
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
      const g = bestGap(sell)
      if (!g) continue
      if (g.gapPct * 100 < minGapPct) continue
      if (g.cheapest < minValue) continue
      const netPerUnit = g.sellWall * (1 - fee) - g.buyUnder
      if (netPerUnit <= 0) continue
      const grp = bundles.groups[String(bundles.typeInfo[String(typeId)]?.[0])]
      out.push({
        typeId,
        name: bundles.names[String(typeId)] ?? `#${typeId}`,
        groupName: grp?.[0] ?? '',
        cheapest: g.cheapest, buyUnder: g.buyUnder, sellWall: g.sellWall,
        gapISK: g.gapISK, gapPct: g.gapPct, units: g.units,
        netPerUnit, potential: netPerUnit * g.units,
      })
    }
    return out.sort((a, b) => b.potential - a.potential)
  }, [orders, bundles, typeSet, minGapPct, minValue, feePct])

  const openInEve = (typeId: number) => {
    const t = tokens[0]
    if (t) openMarketWindow(typeId, t.accessToken).catch(() => {})
  }

  return (
    <Layout header={<PageHeader title="🕳️ Jita Gap Scanner" sub="Zoekt grote prijs-gaten in de Jita sell-orders — koop het goedkope cluster, verkoop net onder de volgende laag." />}>
      <div style={{ maxWidth: 1200 }}>

      {/* Categorieën */}
      <div style={{ marginBottom: '0.7rem' }}>
        <div style={LABEL}>CATEGORIEËN</div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {CATS.map(c => (
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

      {orders && !loading && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
          {rows.length} flip-kans{rows.length === 1 ? '' : 'en'} gevonden — gesorteerd op potentieel.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                <th style={TH}>Goedkoopste</th>
                <th style={TH}>Koop &lt;</th>
                <th style={TH}>Muur</th>
                <th style={TH}>Gat %</th>
                <th style={TH}>Gat ISK</th>
                <th style={TH}>Units</th>
                <th style={TH}>Net/stuk</th>
                <th style={TH}>Potentieel</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map(r => (
                <tr key={r.typeId} style={{ borderBottom: '1px solid var(--border)' }}>
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
                  <td style={TD}>{fmtISK(r.buyUnder)}</td>
                  <td style={TD}>{fmtISK(r.sellWall)}</td>
                  <td style={{ ...TD, color: '#4ade80', fontWeight: 700 }}>{(r.gapPct * 100).toFixed(0)}%</td>
                  <td style={TD}>{fmtISK(r.gapISK)}</td>
                  <td style={TD}>{r.units.toLocaleString('nl-NL')}</td>
                  <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.netPerUnit)}</td>
                  <td style={{ ...TD, fontWeight: 700 }}>{fmtISK(r.potential)}</td>
                  <td style={TD}>
                    <button onClick={() => openInEve(r.typeId)} title="Open in EVE" style={{ ...INPUT, cursor: 'pointer', padding: '0.15rem 0.4rem' }}>⧉</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </Layout>
  )
}
