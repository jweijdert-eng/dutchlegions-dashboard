import { useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getAllRegionOrders, getRegionOrders, getRegionHistory, resolveNames, resolveTypeIds,
  openMarketWindow, type PublicMarketOrder, type RegionHistoryPoint,
} from '../api/esi'

// Alles draait om Jita 4-4.
const THE_FORGE = 10000002
const JITA_STATION = 60003760
const ENRICH_TOP = 80 // aantal topkandidaten dat in "Beste nu" van dag-historie wordt voorzien

function fmtISK(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toLocaleString('nl-NL', { maximumFractionDigits: 2 })
}

interface Fees { broker: number; tax: number } // fracties
const PRESETS = [
  { label: 'Geen skills',  broker: 0.05,  tax: 0.08 },
  { label: 'Basis skills', broker: 0.03,  tax: 0.072 },
  { label: 'Max skills',   broker: 0.02,  tax: 0.036 },
  { label: 'Corp/NPC hub', broker: 0.003, tax: 0.036 },
]

interface Row {
  typeId: number; name: string
  bestBuy: number; bestSell: number; spread: number
  netMargin: number; netMarginPct: number
  tradeVolume: number
  dayVolume?: number; dayProfit?: number; pump?: boolean
}

function scanJita(orders: PublicMarketOrder[], fees: Fees): Omit<Row, 'name'>[] {
  const byType = new Map<number, { bs: number; bb: number; sv: number; bv: number }>()
  for (const o of orders) {
    if (o.location_id !== JITA_STATION) continue
    let a = byType.get(o.type_id)
    if (!a) { a = { bs: Infinity, bb: 0, sv: 0, bv: 0 }; byType.set(o.type_id, a) }
    if (o.is_buy_order) { a.bv += o.volume_remain; if (o.price > a.bb) a.bb = o.price }
    else { a.sv += o.volume_remain; if (o.price < a.bs) a.bs = o.price }
  }
  const rows: Omit<Row, 'name'>[] = []
  for (const [typeId, a] of byType) {
    if (a.bs === Infinity || a.bb === 0) continue
    const buyCost = a.bb * (1 + fees.broker)
    const sellRev = a.bs * (1 - fees.broker - fees.tax)
    const netMargin = sellRev - buyCost
    const netMarginPct = buyCost ? (netMargin / buyCost) * 100 : 0
    rows.push({
      typeId, bestBuy: a.bb, bestSell: a.bs, spread: a.bs - a.bb,
      netMargin, netMarginPct, tradeVolume: Math.min(a.sv, a.bv),
    })
  }
  return rows
}

function dayMetrics(netMargin: number, bestSell: number, orderVol: number, hist: RegionHistoryPoint[]) {
  const last = hist.slice(-14)
  if (last.length === 0) return { dayVolume: 0, dayProfit: 0, pump: false }
  const dayVolume = Math.round(last.reduce((s, h) => s + h.volume, 0) / last.length)
  const avgPrice = last.reduce((s, h) => s + h.average, 0) / last.length
  const capturable = Math.min(orderVol, Math.round(dayVolume * 0.3))
  return { dayVolume, dayProfit: netMargin * capturable, pump: avgPrice > 0 && bestSell > avgPrice * 1.3 }
}

type SortKey = 'dayProfit' | 'netMarginPct' | 'netMargin' | 'spread' | 'tradeVolume' | 'bestSell' | 'name'
type Mode = 'snel' | 'beste'

const INPUT: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', width: '100%', outline: 'none',
}
const LABEL: React.CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem',
}
const TH: React.CSSProperties = {
  textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.35rem 0.7rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }

export default function JitaScanner() {
  const { activeTokens: tokens } = useAuth()

  const [presetIdx, setPresetIdx] = useState(2) // Max skills
  const fees = PRESETS[presetIdx]

  const [rows, setRows] = useState<Row[] | null>(null)
  const [mode, setMode] = useState<Mode>('snel')
  const [scanning, setScanning] = useState(false)
  const [phase, setPhase] = useState('')
  const [prog, setProg] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const [minMarginPct, setMinMarginPct] = useState(5)
  const [maxMarginPct, setMaxMarginPct] = useState(40)
  const [minVolume, setMinVolume] = useState(50)
  const [minBuyPrice, setMinBuyPrice] = useState(1000)
  const [maxPrice, setMaxPrice] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('netMarginPct')
  const [showFilters, setShowFilters] = useState(false)

  async function openMarket(typeId: number) {
    const t = tokens[0]
    if (!t) { setMsg('Log in om items in-game te openen.'); return }
    try { setMsg(null); await openMarketWindow(typeId, t.accessToken) }
    catch { setMsg('Kon marktvenster niet openen — draait de EVE-client?') }
  }

  async function runScan(m: Mode) {
    if (scanning) return
    setScanning(true); setMode(m); setError(null); setProg({ done: 0, total: 0 })
    try {
      setPhase('Markt ophalen…')
      const orders = await getAllRegionOrders(THE_FORGE, (done, total) => setProg({ done, total }))
      const raw = scanJita(orders, fees)
      setPhase('Namen ophalen…')
      const names = await resolveNames(raw.map(r => r.typeId))
      let withNames: Row[] = raw.map(r => ({ ...r, name: names.get(r.typeId) ?? `#${r.typeId}` }))

      if (m === 'beste') {
        setPhase('Daghandel bepalen…')
        const cands = [...withNames]
          .filter(r => r.netMarginPct >= 5 && r.netMarginPct <= 40 && r.bestBuy >= 1000 && r.tradeVolume >= 20)
          .sort((a, b) => b.netMargin * Math.min(b.tradeVolume, 500) - a.netMargin * Math.min(a.tradeVolume, 500))
          .slice(0, ENRICH_TOP)
        const enr = new Map<number, Partial<Row>>()
        let done = 0; setProg({ done: 0, total: cands.length })
        await Promise.all(cands.map(async r => {
          const hist = await getRegionHistory(THE_FORGE, r.typeId)
          enr.set(r.typeId, dayMetrics(r.netMargin, r.bestSell, r.tradeVolume, hist))
          setProg({ done: ++done, total: cands.length })
        }))
        withNames = withNames.map(r => ({ ...r, ...enr.get(r.typeId) }))
        setSortKey('dayProfit')
      } else {
        setSortKey('netMarginPct')
      }
      setRows(withNames)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan mislukt')
    } finally { setScanning(false); setPhase('') }
  }

  const filtered = useMemo(() => {
    if (!rows) return []
    let out = rows.filter(r =>
      r.netMarginPct >= minMarginPct && r.netMarginPct <= maxMarginPct &&
      r.tradeVolume >= minVolume && r.bestBuy >= minBuyPrice &&
      (maxPrice <= 0 || r.bestSell <= maxPrice))
    if (mode === 'beste') out = out.filter(r => (r.dayVolume ?? 0) >= 20 && !r.pump)
    out.sort((a, b) => sortKey === 'name'
      ? a.name.localeCompare(b.name)
      : ((b[sortKey] as number) ?? 0) - ((a[sortKey] as number) ?? 0))
    return out.slice(0, 200)
  }, [rows, mode, minMarginPct, maxMarginPct, minVolume, minBuyPrice, maxPrice, sortKey])

  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0
  const btn = (bg: string): React.CSSProperties => ({
    padding: '0.5rem 0.9rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 700, cursor: scanning ? 'default' : 'pointer',
    background: bg, color: '#04121f', border: 0, opacity: scanning ? 0.6 : 1,
  })

  return (
    <Layout header={<PageHeader title="Jita Scanner" sub="Beste station-trade flips in Jita 4-4 — live uit ESI" />}>
      <div style={{ maxWidth: 1100 }}>
        {/* Fees */}
        <div style={{ marginBottom: '0.9rem' }}>
          <div style={LABEL}>FEES (BROKER / SALES TAX)</div>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {PRESETS.map((p, i) => (
              <button key={p.label} onClick={() => setPresetIdx(i)} style={{
                padding: '0.25rem 0.55rem', borderRadius: 2, fontSize: '0.65rem', cursor: 'pointer', fontWeight: 600,
                background: presetIdx === i ? 'rgba(0,180,216,0.15)' : 'transparent',
                border: `1px solid ${presetIdx === i ? 'var(--blue)' : 'var(--border)'}`,
                color: presetIdx === i ? 'var(--blue)' : 'var(--text-dim)',
              }}>{p.label} ({(p.broker * 100).toFixed(1)}/{(p.tax * 100).toFixed(1)}%)</button>
            ))}
          </div>
        </div>

        {/* Scan-knoppen */}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
          <button onClick={() => runScan('beste')} disabled={scanning} style={btn('var(--blue)')}>
            {scanning && mode === 'beste' ? `Bezig… ${pct}%` : '⭐ Beste nu (met volume)'}
          </button>
          <button onClick={() => runScan('snel')} disabled={scanning} style={{ ...btn('var(--surface2)'), color: 'var(--text)', border: '1px solid var(--border)' }}>
            {scanning && mode === 'snel' ? `Bezig… ${pct}%` : 'Snel scannen'}
          </button>
          {scanning && (
            <div style={{ flex: 1, minWidth: 140, height: 7, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--blue)', transition: 'width .2s' }} />
            </div>
          )}
          {scanning && phase && <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{phase}</span>}
          {rows && (
            <button onClick={() => setShowFilters(s => !s)} style={{ ...btn('transparent'), color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
              {showFilters ? 'Filters verbergen' : 'Filters'}
            </button>
          )}
        </div>

        {msg && <div style={{ color: 'var(--amber, #ffce54)', fontSize: '0.72rem', marginBottom: '0.6rem', cursor: 'pointer' }} onClick={() => setMsg(null)}>{msg}</div>}
        {error && <div style={{ color: '#ff5c6c', fontSize: '0.75rem', marginBottom: '0.6rem' }}>{error}</div>}

        {rows && showFilters && (
          <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap', marginBottom: '0.8rem', padding: '0.7rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
            {[
              ['Min. marge %', minMarginPct, setMinMarginPct],
              ['Max. marge %', maxMarginPct, setMaxMarginPct],
              ['Min. volume', minVolume, setMinVolume],
              ['Min. buy-prijs', minBuyPrice, setMinBuyPrice],
              ['Max. prijs / budget (0=∞)', maxPrice, setMaxPrice],
            ].map(([label, val, set]) => (
              <div key={label as string} style={{ width: 130 }}>
                <div style={LABEL}>{label as string}</div>
                <input type="number" value={val as number}
                  onChange={e => (set as (n: number) => void)(+e.target.value)} style={INPUT} />
              </div>
            ))}
            <div style={{ width: 150 }}>
              <div style={LABEL}>Sorteer op</div>
              <select value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)} style={INPUT}>
                {mode === 'beste' && <option value="dayProfit">Winst / dag</option>}
                <option value="netMarginPct">Marge %</option>
                <option value="netMargin">Marge / stuk</option>
                <option value="spread">Verschil buy/sell</option>
                <option value="tradeVolume">Orderbook-volume</option>
                <option value="bestSell">Sell-prijs</option>
                <option value="name">Naam</option>
              </select>
            </div>
          </div>
        )}

        {mode === 'beste' && rows && !scanning && (
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>
            Gerangschikt op geschatte <b>winst/dag</b> (winst/stuk × haalbaar dagvolume). Prijs-pieken zijn eruit gefilterd.
          </div>
        )}

        {rows && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface)' }}>
                  <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                  <th style={TH}>Koop @ (buy)</th>
                  <th style={TH}>Verkoop @ (sell)</th>
                  <th style={TH}>Verschil</th>
                  <th style={TH}>Marge %</th>
                  {mode === 'beste' && <th style={TH}>Dag-volume</th>}
                  {mode === 'beste' && <th style={TH}>~Winst/dag</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.typeId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...TD, textAlign: 'left' }}>
                      <button onClick={() => openMarket(r.typeId)} title="Open in-game marktvenster"
                        style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>
                        {r.name}
                      </button>
                    </td>
                    <td style={TD}>{fmtISK(r.bestBuy)}</td>
                    <td style={TD}>{fmtISK(r.bestSell)}</td>
                    <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.spread)}</td>
                    <td style={{ ...TD, color: '#4ade80' }}>{r.netMarginPct.toFixed(1)}%</td>
                    {mode === 'beste' && <td style={TD}>{(r.dayVolume ?? 0).toLocaleString('nl-NL')}</td>}
                    {mode === 'beste' && <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.dayProfit ?? 0)}</td>}
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={mode === 'beste' ? 7 : 5} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)', padding: '1rem' }}>
                    Geen items voldoen aan de filters.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {rows && (
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
            Max. 200 rijen · Verschil = sell − buy · Marge is na broker fee + sales tax · klik op een item om het in-game te openen.
          </div>
        )}

        {!rows && !scanning && (
          <ItemLookup fees={fees} openMarket={openMarket} />
        )}
      </div>
    </Layout>
  )
}

// Compacte los-item-opzoeker (zichtbaar vóór de eerste scan).
function ItemLookup({ fees, openMarket }: { fees: Fees; openMarket: (t: number) => void }) {
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<{ name: string; typeId: number; buy: number | null; sell: number | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function search() {
    const name = q.trim()
    if (!name || loading) return
    setLoading(true); setErr(null)
    try {
      const ids = await resolveTypeIds([name])
      const typeId = ids.get(name.toLowerCase())
      if (!typeId) { setErr(`Geen item gevonden voor "${name}" (exacte naam).`); setRes(null); return }
      const orders = (await getRegionOrders(THE_FORGE, typeId)).filter(o => o.location_id === JITA_STATION)
      const sells = orders.filter(o => !o.is_buy_order).map(o => o.price)
      const buys = orders.filter(o => o.is_buy_order).map(o => o.price)
      const names = await resolveNames([typeId])
      setRes({
        name: names.get(typeId) ?? name, typeId,
        buy: buys.length ? Math.max(...buys) : null,
        sell: sells.length ? Math.min(...sells) : null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fout'); setRes(null) }
    finally { setLoading(false) }
  }

  const spread = res && res.buy !== null && res.sell !== null ? res.sell - res.buy : null
  const margin = res && res.buy !== null && res.sell !== null
    ? res.sell * (1 - fees.broker - fees.tax) - res.buy * (1 + fees.broker) : null

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div style={LABEL}>OF ZOEK ÉÉN ITEM OP</div>
      <div style={{ display: 'flex', gap: '0.5rem', maxWidth: 460 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
          placeholder='Exacte itemnaam, bv. "PLEX"' style={INPUT} />
        <button onClick={search} disabled={loading} style={{ padding: '0.35rem 0.8rem', borderRadius: 2, border: 0, background: 'var(--blue)', color: '#04121f', fontWeight: 700, cursor: 'pointer', fontSize: '0.72rem' }}>
          {loading ? '…' : 'Zoek'}
        </button>
      </div>
      {err && <div style={{ color: '#ff5c6c', fontSize: '0.72rem', marginTop: '0.5rem' }}>{err}</div>}
      {res && (
        <div style={{ marginTop: '0.8rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <button onClick={() => openMarket(res.typeId)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700 }}>{res.name}</button>
          <span style={{ fontSize: '0.75rem' }}>Buy: <b>{res.buy !== null ? fmtISK(res.buy) : '—'}</b></span>
          <span style={{ fontSize: '0.75rem' }}>Sell: <b>{res.sell !== null ? fmtISK(res.sell) : '—'}</b></span>
          <span style={{ fontSize: '0.75rem' }}>Verschil: <b style={{ color: '#4ade80' }}>{spread !== null ? fmtISK(spread) : '—'}</b></span>
          <span style={{ fontSize: '0.75rem' }}>Marge/stuk: <b style={{ color: margin !== null && margin > 0 ? '#4ade80' : '#ff5c6c' }}>{margin !== null ? fmtISK(margin) : '—'}</b></span>
        </div>
      )}
    </div>
  )
}
