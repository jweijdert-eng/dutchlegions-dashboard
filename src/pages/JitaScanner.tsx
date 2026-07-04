import { useMemo, useState } from 'react'
import { ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getAllRegionOrders, getRegionOrders, getRegionHistory, resolveNames, resolveTypeIds,
  openMarketWindow, getSkillsInfo, type PublicMarketOrder, type RegionHistoryPoint, type SkillEntry,
} from '../api/esi'
import { addPosition } from '../utils/jitaPositions'

// EVE skill type-ids voor trading — voor het uitlezen van fees + order-slots.
const SKILL = { accounting: 16622, brokerRelations: 3446, trade: 3443, retail: 3444, wholesale: 16596, tycoon: 18580 }
function feesFromSkills(skills: SkillEntry[]) {
  const lvl = (id: number) => skills.find(s => s.skill_id === id)?.active_skill_level ?? 0
  const acc = lvl(SKILL.accounting), br = lvl(SKILL.brokerRelations)
  return {
    broker: Math.max(0.01, 0.03 - 0.003 * br),   // Broker Relations: −0,3%/lvl, min 1%
    tax: 0.08 * (1 - 0.11 * acc),                  // Accounting: −11%/lvl van 8% basis
    orders: 5 + 4 * lvl(SKILL.trade) + 8 * lvl(SKILL.retail) + 16 * lvl(SKILL.wholesale) + 32 * lvl(SKILL.tycoon),
    acc, br,
  }
}

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

// Trend-indicator uit trendPct: stijgend / stabiel / dalend.
function trendBadge(pct: number | undefined) {
  const p = pct ?? 0
  if (p > 3) return { sym: '▲', color: '#4ade80', txt: `+${p.toFixed(0)}%` }
  if (p < -3) return { sym: '▼', color: '#ff5c6c', txt: `${p.toFixed(0)}%` }
  return { sym: '→', color: 'var(--text-dim)', txt: `${p >= 0 ? '+' : ''}${p.toFixed(0)}%` }
}

// Eén helder koopadvies uit de losse signalen. vsAvgPct (prijs vs 30d-gem) is
// optioneel — alleen beschikbaar bij het opzoeken van één item.
function buyVerdict(m: { netMarginPct: number; dayVolume?: number; trendPct?: number; vsAvgPct?: number | null }) {
  const reasons: string[] = []
  let bad = false, warn = false
  if (m.netMarginPct < 3) { bad = true; reasons.push('marge te laag') }
  else if (m.netMarginPct < 5) { warn = true; reasons.push('krappe marge') }
  if (m.dayVolume !== undefined) {
    if (m.dayVolume < 20) { bad = true; reasons.push('nauwelijks handel') }
    else if (m.dayVolume < 50) { warn = true; reasons.push('laag volume') }
  }
  if (m.trendPct !== undefined) {
    if (m.trendPct < -8) { bad = true; reasons.push('prijs daalt hard') }
    else if (m.trendPct < -3) { warn = true; reasons.push('prijs daalt') }
  }
  if (m.vsAvgPct != null) {
    if (m.vsAvgPct > 12) { bad = true; reasons.push('prijs op piek') }
    else if (m.vsAvgPct > 5) { warn = true; reasons.push('prijs bovengemiddeld') }
    else if (m.vsAvgPct < -5) reasons.push('goedkoop nu')
  }
  if (bad) return { label: 'NIET KOPEN', color: '#ff5c6c', reason: reasons.find(r => r !== 'goedkoop nu') ?? '' }
  if (warn) return { label: 'TWIJFELACHTIG', color: '#ffce54', reason: reasons.find(r => r !== 'goedkoop nu') ?? '' }
  return { label: 'KOOP NU', color: '#4ade80', reason: reasons.includes('goedkoop nu') ? 'goedkoop t.o.v. 30d' : 'goede marge & volume' }
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
  tradeVolume: number; orderbookVol: number
  dayVolume?: number; dayProfit?: number; pump?: boolean
  trendPct?: number; volatilityPct?: number; iskPerDay?: number
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
      netMargin, netMarginPct, tradeVolume: Math.min(a.sv, a.bv), orderbookVol: a.sv + a.bv,
    })
  }
  return rows
}

// Stats uit de markt-historie: recent dagvolume, 30d gemiddelde/min/max,
// trend (recente helft vs oudere helft, in %) en volatiliteit (variatie-
// coëfficiënt = stdev/gemiddelde, in %).
function historyStats(hist: RegionHistoryPoint[]) {
  const h30 = hist.slice(-30)
  const avgs = h30.map(h => h.average)
  const n = avgs.length
  if (n === 0) return { dayVolume: 0, avg30: 0, min30: 0, max30: 0, trendPct: 0, volatilityPct: 0 }
  const last14 = hist.slice(-14)
  const dayVolume = Math.round(last14.reduce((s, h) => s + h.volume, 0) / last14.length)
  const avg30 = avgs.reduce((s, v) => s + v, 0) / n
  const min30 = Math.min(...avgs)
  const max30 = Math.max(...avgs)
  const half = Math.floor(n / 2) || 1
  const older = avgs.slice(0, half), recent = avgs.slice(-half)
  const olderAvg = older.reduce((s, v) => s + v, 0) / older.length
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length
  const trendPct = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0
  const variance = avgs.reduce((s, v) => s + (v - avg30) ** 2, 0) / n
  const volatilityPct = avg30 > 0 ? (Math.sqrt(variance) / avg30) * 100 : 0
  return { dayVolume, avg30, min30, max30, trendPct, volatilityPct }
}

type SortKey = 'iskPerDay' | 'dayVolume' | 'dayProfit' | 'netMarginPct' | 'netMargin' | 'spread' | 'tradeVolume' | 'bestSell' | 'name'
type Mode = 'snel' | 'beste' | 'traded'

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
  const { activeTokens: tokens, tokens: allTokens } = useAuth()

  const [presetIdx, setPresetIdx] = useState(2) // Max skills
  // Uit ESI berekende fees + order-slots (per gekozen character).
  const [skill, setSkill] = useState<{ broker: number; tax: number; orders: number; name: string } | null>(null)
  const [skillCharId, setSkillCharId] = useState<number | null>(null)
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillErr, setSkillErr] = useState<string | null>(null)
  const fees = skill ? { broker: skill.broker, tax: skill.tax } : PRESETS[presetIdx]

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
  const [hideFalling, setHideFalling] = useState(false) // trend-filter: dalende markt verbergen
  const [hideSkins, setHideSkins] = useState(true)       // SKINs (cosmetisch) verbergen

  // Strategie-planner
  const [budgetM, setBudgetM] = useState(500) // budget in miljoen ISK
  const [slots, setSlots] = useState(8)        // aantal gelijktijdige order-slots

  async function openMarket(typeId: number) {
    const t = tokens[0]
    if (!t) { setMsg('Log in om items in-game te openen.'); return }
    try { setMsg(null); await openMarketWindow(typeId, t.accessToken) }
    catch { setMsg('Kon marktvenster niet openen — draait de EVE-client?') }
  }

  // Lees trade-skills van een character → fees + order-slots automatisch invullen.
  async function loadSkills(charId: number) {
    const t = allTokens.find(x => x.characterId === charId)
    if (!t) return
    setSkillLoading(true); setSkillErr(null); setSkillCharId(charId)
    try {
      const info = await getSkillsInfo(charId, t.accessToken)
      const f = feesFromSkills(info.skills ?? [])
      setSkill({ broker: f.broker, tax: f.tax, orders: f.orders, name: t.characterName })
      setSlots(f.orders)
    } catch (e) {
      setSkillErr(e instanceof Error ? e.message : 'Kon skills niet laden')
    } finally { setSkillLoading(false) }
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

      if (m === 'beste' || m === 'traded') {
        setPhase('Daghandel bepalen…')
        // Kandidaten: "beste" = beste flip-potentie; "traded" = grootste markten
        // (orderbook-volume × prijs), zodat we de meest verhandelde items pakken.
        const cands = m === 'beste'
          ? [...withNames]
              .filter(r => r.netMarginPct >= 5 && r.netMarginPct <= 40 && r.bestBuy >= 1000 && r.tradeVolume >= 20)
              .sort((a, b) => b.netMargin * Math.min(b.tradeVolume, 500) - a.netMargin * Math.min(a.tradeVolume, 500))
              .slice(0, ENRICH_TOP)
          : [...withNames]
              .sort((a, b) => b.orderbookVol * b.bestSell - a.orderbookVol * a.bestSell)
              .slice(0, 200)
        const enr = new Map<number, Partial<Row>>()
        let done = 0; setProg({ done: 0, total: cands.length })
        await Promise.all(cands.map(async r => {
          const hist = await getRegionHistory(THE_FORGE, r.typeId)
          const st = historyStats(hist)
          const capturable = Math.min(r.tradeVolume, Math.round(st.dayVolume * 0.3))
          enr.set(r.typeId, {
            dayVolume: st.dayVolume,
            dayProfit: r.netMargin * capturable,
            pump: st.avg30 > 0 && r.bestSell > st.avg30 * 1.3,
            trendPct: st.trendPct,
            volatilityPct: st.volatilityPct,
            iskPerDay: st.dayVolume * st.avg30,
          })
          setProg({ done: ++done, total: cands.length })
        }))
        withNames = withNames.map(r => ({ ...r, ...enr.get(r.typeId) }))
        setSortKey(m === 'beste' ? 'dayProfit' : 'iskPerDay')
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
    let out: Row[]
    if (mode === 'traded') {
      // Meest verhandeld: geen marge-filters, alleen items met echte daghandel.
      out = rows.filter(r => (r.dayVolume ?? 0) > 0 && (maxPrice <= 0 || r.bestSell <= maxPrice))
    } else {
      out = rows.filter(r =>
        r.netMarginPct >= minMarginPct && r.netMarginPct <= maxMarginPct &&
        r.tradeVolume >= minVolume && r.bestBuy >= minBuyPrice &&
        (maxPrice <= 0 || r.bestSell <= maxPrice))
      if (mode === 'beste') out = out.filter(r => (r.dayVolume ?? 0) >= 20 && !r.pump)
      if (mode === 'beste' && hideFalling) out = out.filter(r => (r.trendPct ?? 0) >= -3)
    }
    if (hideSkins) out = out.filter(r => !/\bskin\b/i.test(r.name))
    out.sort((a, b) => sortKey === 'name'
      ? a.name.localeCompare(b.name)
      : ((b[sortKey] as number) ?? 0) - ((a[sortKey] as number) ?? 0))
    return out.slice(0, 200)
  }, [rows, mode, minMarginPct, maxMarginPct, minVolume, minBuyPrice, maxPrice, sortKey, hideFalling, hideSkins])

  // Bouwt een concreet koop-portfolio: verdeel het budget over de beste items op
  // winst/dag, per item begrensd door budget/slots én ~30% van het dagvolume
  // (wat je realistisch per dag kunt wegzetten). Alleen zinvol na een "Beste nu"-scan.
  const strategy = useMemo(() => {
    if (!rows || mode !== 'beste') return null
    const budget = budgetM * 1e6
    const perItem = budget / Math.max(1, slots)
    const pool = rows
      .filter(r => (r.dayVolume ?? 0) >= 20 && !r.pump &&
        r.netMarginPct >= minMarginPct && r.netMarginPct <= maxMarginPct &&
        r.bestBuy >= minBuyPrice && (maxPrice <= 0 || r.bestSell <= maxPrice))
      .sort((a, b) => (b.dayProfit ?? 0) - (a.dayProfit ?? 0))
    const picks: Array<Row & { qty: number; capital: number; profitDay: number }> = []
    let totalCap = 0, totalProfit = 0
    for (const r of pool) {
      if (picks.length >= slots) break
      const qty = Math.min(Math.floor(0.3 * (r.dayVolume ?? 0)), Math.floor(perItem / r.bestBuy))
      if (qty < 1) continue
      const capital = qty * r.bestBuy
      const profitDay = qty * r.netMargin
      picks.push({ ...r, qty, capital, profitDay })
      totalCap += capital; totalProfit += profitDay
    }
    return { picks, totalCap, totalProfit, roi: totalCap ? (totalProfit / totalCap) * 100 : 0 }
  }, [rows, mode, budgetM, slots, minMarginPct, maxMarginPct, minBuyPrice, maxPrice])

  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0
  const enriched = mode !== 'snel' // beste & traded hebben historie-kolommen
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
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {PRESETS.map((p, i) => {
              const active = !skill && presetIdx === i
              return (
                <button key={p.label} onClick={() => { setPresetIdx(i); setSkill(null) }} style={{
                  padding: '0.25rem 0.55rem', borderRadius: 2, fontSize: '0.65rem', cursor: 'pointer', fontWeight: 600,
                  background: active ? 'rgba(0,180,216,0.15)' : 'transparent',
                  border: `1px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
                  color: active ? 'var(--blue)' : 'var(--text-dim)',
                }}>{p.label} ({(p.broker * 100).toFixed(1)}/{(p.tax * 100).toFixed(1)}%)</button>
              )
            })}
            {allTokens.length > 0 && (
              <span style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center', marginLeft: '0.4rem', paddingLeft: '0.5rem', borderLeft: '1px solid var(--border)' }}>
                {allTokens.length > 1 && (
                  <select value={skillCharId ?? allTokens[0].characterId} onChange={e => setSkillCharId(+e.target.value)}
                    style={{ ...INPUT, fontSize: '0.63rem', padding: '0.2rem 0.3rem' }}>
                    {allTokens.map(t => <option key={t.characterId} value={t.characterId}>{t.characterName}</option>)}
                  </select>
                )}
                <button onClick={() => loadSkills(skillCharId ?? allTokens[0].characterId)} disabled={skillLoading} style={{
                  padding: '0.25rem 0.55rem', borderRadius: 2, fontSize: '0.65rem', cursor: 'pointer', fontWeight: 600,
                  background: skill ? 'rgba(0,180,216,0.15)' : 'transparent',
                  border: `1px solid ${skill ? 'var(--blue)' : 'var(--border)'}`, color: skill ? 'var(--blue)' : 'var(--text-dim)',
                }}>{skillLoading ? '⏳ laden…' : '⚙ Uit mijn skills'}</button>
              </span>
            )}
          </div>
          {skill && (
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
              Uit <b style={{ color: 'var(--text)' }}>{skill.name}</b>: broker <b>{(skill.broker * 100).toFixed(1)}%</b> · tax <b>{(skill.tax * 100).toFixed(1)}%</b> · <b>{skill.orders}</b> order-slots (ingevuld in de strategie-planner)
            </div>
          )}
          {skillErr && <div style={{ fontSize: '0.62rem', color: '#ff5c6c', marginTop: '0.35rem' }}>{skillErr}</div>}
        </div>

        {/* Scan-knoppen */}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
          <button onClick={() => runScan('beste')} disabled={scanning} style={btn('var(--blue)')}>
            {scanning && mode === 'beste' ? `Bezig… ${pct}%` : '⭐ Beste nu (met volume)'}
          </button>
          <button onClick={() => runScan('traded')} disabled={scanning} style={{ ...btn('var(--surface2)'), color: 'var(--text)', border: '1px solid var(--border)' }}>
            {scanning && mode === 'traded' ? `Bezig… ${pct}%` : '📊 Meest verhandeld'}
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
                {mode === 'traded' && <option value="iskPerDay">ISK-omzet / dag</option>}
                {enriched && <option value="dayVolume">Dagvolume</option>}
                {mode === 'beste' && <option value="dayProfit">Winst / dag</option>}
                <option value="netMarginPct">Marge %</option>
                <option value="netMargin">Marge / stuk</option>
                <option value="spread">Verschil buy/sell</option>
                <option value="tradeVolume">Orderbook-volume</option>
                <option value="bestSell">Sell-prijs</option>
                <option value="name">Naam</option>
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-end', fontSize: '0.68rem', color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={hideSkins} onChange={e => setHideSkins(e.target.checked)} />
              Verberg SKINs
            </label>
          </div>
        )}

        {mode === 'beste' && rows && !scanning && (
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>
            Gerangschikt op geschatte <b>winst/dag</b> (winst/stuk × haalbaar dagvolume). Prijs-pieken zijn eruit gefilterd.
            <label style={{ marginLeft: '0.9rem', cursor: 'pointer', color: 'var(--text)' }}>
              <input type="checkbox" checked={hideFalling} onChange={e => setHideFalling(e.target.checked)} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Verberg dalende markt (trend ▼)
            </label>
          </div>
        )}

        {mode === 'traded' && rows && !scanning && (
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>
            De <b>meest verhandelde</b> items in Jita 4-4, gerangschikt op <b>ISK-omzet/dag</b> (dagvolume × prijs).
            Dit zijn de meest liquide markten — veilig om te flippen, maar vaak met dunne marges.
          </div>
        )}

        {/* Strategie-planner: concreet koop-portfolio op basis van budget + slots */}
        {mode === 'beste' && strategy && !scanning && (
          <div style={{ marginBottom: '1rem', padding: '0.85rem', background: 'var(--surface)', border: '1px solid var(--blue)', borderRadius: 3 }}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
              <div>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '0.3rem' }}>📋 STRATEGIE — KOOPPLAN</div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Verdeel je budget over de beste flips</div>
              </div>
              <div style={{ width: 130 }}>
                <div style={LABEL}>Budget (M ISK)</div>
                <input type="number" value={budgetM} onChange={e => setBudgetM(Math.max(0, +e.target.value))} style={INPUT} />
              </div>
              <div style={{ width: 110 }}>
                <div style={LABEL}>Order-slots</div>
                <input type="number" value={slots} onChange={e => setSlots(Math.max(1, +e.target.value))} style={INPUT} />
              </div>
            </div>

            {strategy.picks.length === 0 ? (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                Geen items passen binnen dit budget/filter. Verhoog het budget of versoepel de filters.
              </div>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={{ ...TH, textAlign: 'left' }}>Koop dit</th>
                      <th style={TH}>Koop @</th>
                      <th style={TH}>Aantal</th>
                      <th style={TH}>Kapitaal</th>
                      <th style={TH}>Marge %</th>
                      <th style={TH}>~Winst/dag</th>
                    </tr></thead>
                    <tbody>
                      {strategy.picks.map(p => (
                        <tr key={p.typeId} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ ...TD, textAlign: 'left' }}>
                            <button onClick={() => openMarket(p.typeId)} title="Open in-game marktvenster"
                              style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>{p.name}</button>
                          </td>
                          <td style={TD}>{fmtISK(p.bestBuy)}</td>
                          <td style={TD}>{p.qty.toLocaleString('nl-NL')}</td>
                          <td style={TD}>{fmtISK(p.capital)}</td>
                          <td style={{ ...TD, color: '#4ade80' }}>{p.netMarginPct.toFixed(1)}%</td>
                          <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(p.profitDay)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginTop: '0.7rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)', fontSize: '0.75rem' }}>
                  <span>Kapitaal ingezet: <b>{fmtISK(strategy.totalCap)}</b></span>
                  <span>Verwachte winst/dag: <b style={{ color: '#4ade80' }}>{fmtISK(strategy.totalProfit)}</b></span>
                  <span>Rendement: <b style={{ color: '#4ade80' }}>{strategy.roi.toFixed(1)}% / dag</b></span>
                  <span style={{ color: 'var(--text-dim)' }}>≈ {fmtISK(strategy.totalProfit * 30)} / maand</span>
                </div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.4rem' }}>
                  Aantal = min(budget/slots, ~30% dagvolume). Plaats buy-orders op "Koop @", verkoop op de sell-prijs, en houd je orders bovenaan (Market-pagina). Schatting, geen garantie.
                </div>
              </>
            )}
          </div>
        )}

        {rows && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface)' }}>
                  <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                  {mode === 'beste' && <th style={{ ...TH, textAlign: 'left' }}>Advies</th>}
                  <th style={TH}>Koop @ (buy)</th>
                  <th style={TH}>Verkoop @ (sell)</th>
                  <th style={TH}>Verschil</th>
                  <th style={TH}>Marge %</th>
                  {enriched && <th style={TH}>Dag-volume</th>}
                  {mode === 'traded' && <th style={TH}>ISK-omzet/dag</th>}
                  {mode === 'beste' && <th style={TH}>~Winst/dag</th>}
                  {enriched && <th style={TH}>Trend</th>}
                  {enriched && <th style={TH}>Volatiliteit</th>}
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
                    {mode === 'beste' && (() => { const v = buyVerdict({ netMarginPct: r.netMarginPct, dayVolume: r.dayVolume, trendPct: r.trendPct }); return (
                      <td style={{ ...TD, textAlign: 'left', color: v.color, fontWeight: 700 }} title={v.reason}>{v.label}</td>
                    ) })()}
                    <td style={TD}>{fmtISK(r.bestBuy)}</td>
                    <td style={TD}>{fmtISK(r.bestSell)}</td>
                    <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.spread)}</td>
                    <td style={{ ...TD, color: '#4ade80' }}>{r.netMarginPct.toFixed(1)}%</td>
                    {enriched && <td style={TD}>{(r.dayVolume ?? 0).toLocaleString('nl-NL')}</td>}
                    {mode === 'traded' && <td style={{ ...TD, fontWeight: 700 }}>{fmtISK(r.iskPerDay ?? 0)}</td>}
                    {mode === 'beste' && <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.dayProfit ?? 0)}</td>}
                    {enriched && (() => { const t = trendBadge(r.trendPct); return (
                      <td style={{ ...TD, color: t.color }} title="Prijstrend: recente vs. oudere helft (30d)">{t.sym} {t.txt}</td>
                    ) })()}
                    {enriched && <td style={{ ...TD, color: (r.volatilityPct ?? 0) > 15 ? '#ffce54' : 'var(--text)' }} title="Prijsschommeling (variatiecoëfficiënt, 30d)">{(r.volatilityPct ?? 0).toFixed(0)}%</td>}
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={mode === 'beste' ? 10 : mode === 'traded' ? 9 : 5} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)', padding: '1rem' }}>
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

// Los-item-opzoeker met prijshistorie: buy/sell/marge + koop-laag/verkoop-hoog-
// signaal + grafiek van gemiddelde prijs & dagvolume (90 dagen).
interface LookupRes {
  name: string; typeId: number; buy: number | null; sell: number | null
  hist: RegionHistoryPoint[]
  stats: ReturnType<typeof historyStats>
}
function ItemLookup({ fees, openMarket }: { fees: Fees; openMarket: (t: number) => void }) {
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<LookupRes | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Aankoop opslaan
  const [saveQty, setSaveQty] = useState('1')
  const [savePrice, setSavePrice] = useState('')
  const [saved, setSaved] = useState(false)

  async function search() {
    const name = q.trim()
    if (!name || loading) return
    setLoading(true); setErr(null)
    try {
      const ids = await resolveTypeIds([name])
      const typeId = ids.get(name.toLowerCase())
      if (!typeId) { setErr(`Geen item gevonden voor "${name}" (exacte naam).`); setRes(null); return }
      const [ordersAll, hist, names] = await Promise.all([
        getRegionOrders(THE_FORGE, typeId),
        getRegionHistory(THE_FORGE, typeId),
        resolveNames([typeId]),
      ])
      const orders = ordersAll.filter(o => o.location_id === JITA_STATION)
      const sells = orders.filter(o => !o.is_buy_order).map(o => o.price)
      const buys = orders.filter(o => o.is_buy_order).map(o => o.price)
      const bestBuy = buys.length ? Math.max(...buys) : null
      setRes({
        name: names.get(typeId) ?? name, typeId,
        buy: bestBuy,
        sell: sells.length ? Math.min(...sells) : null,
        hist, stats: historyStats(hist),
      })
      setSavePrice(bestBuy !== null ? String(Math.round(bestBuy)) : ''); setSaved(false)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fout'); setRes(null) }
    finally { setLoading(false) }
  }

  const spread = res && res.buy !== null && res.sell !== null ? res.sell - res.buy : null
  const margin = res && res.buy !== null && res.sell !== null
    ? res.sell * (1 - fees.broker - fees.tax) - res.buy * (1 + fees.broker) : null

  // Koop-laag/verkoop-hoog: huidige sell t.o.v. 30d-gemiddelde + positie in de band.
  const s = res?.stats
  const ref = res?.sell ?? null
  const vsAvg = s && s.avg30 > 0 && ref !== null ? ((ref - s.avg30) / s.avg30) * 100 : null
  const bandPos = s && ref !== null && s.max30 > s.min30 ? Math.max(0, Math.min(1, (ref - s.min30) / (s.max30 - s.min30))) : null
  const signal = vsAvg === null ? null
    : vsAvg < -5 ? { txt: 'LAAG — goedkoop t.o.v. 30d (goede instap)', color: '#4ade80' }
    : vsAvg > 5 ? { txt: 'HOOG — duur t.o.v. 30d (voorzichtig kopen)', color: '#ffce54' }
    : { txt: 'ROND GEMIDDELDE', color: 'var(--text-dim)' }

  const chartData = (res?.hist ?? []).slice(-90).map(h => ({ date: h.date.slice(5), price: h.average, volume: h.volume }))

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div style={LABEL}>OF ZOEK ÉÉN ITEM OP (met prijshistorie)</div>
      <div style={{ display: 'flex', gap: '0.5rem', maxWidth: 460 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
          placeholder='Exacte itemnaam, bv. "PLEX"' style={INPUT} />
        <button onClick={search} disabled={loading} style={{ padding: '0.35rem 0.8rem', borderRadius: 2, border: 0, background: 'var(--blue)', color: '#04121f', fontWeight: 700, cursor: 'pointer', fontSize: '0.72rem' }}>
          {loading ? '…' : 'Zoek'}
        </button>
      </div>
      {err && <div style={{ color: '#ff5c6c', fontSize: '0.72rem', marginTop: '0.5rem' }}>{err}</div>}
      {res && (
        <>
          {(() => {
            const marginPct = res.buy && margin !== null ? (margin / res.buy) * 100 : 0
            const v = buyVerdict({ netMarginPct: marginPct, dayVolume: s?.dayVolume, trendPct: s?.trendPct, vsAvgPct: vsAvg })
            return (
              <div style={{ marginTop: '0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.9rem', borderRadius: 3, border: `1px solid ${v.color}`, background: 'var(--surface)' }}>
                <span style={{ fontSize: '1rem', fontWeight: 800, color: v.color, letterSpacing: '0.02em' }}>{v.label}</span>
                {v.reason && <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>— {v.reason}</span>}
              </div>
            )
          })()}
          <div style={{ marginTop: '0.8rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            <button onClick={() => openMarket(res.typeId)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700 }}>{res.name}</button>
            <span style={{ fontSize: '0.75rem' }}>Buy: <b>{res.buy !== null ? fmtISK(res.buy) : '—'}</b></span>
            <span style={{ fontSize: '0.75rem' }}>Sell: <b>{res.sell !== null ? fmtISK(res.sell) : '—'}</b></span>
            <span style={{ fontSize: '0.75rem' }}>Verschil: <b style={{ color: '#4ade80' }}>{spread !== null ? fmtISK(spread) : '—'}</b></span>
            <span style={{ fontSize: '0.75rem' }}>Marge/stuk: <b style={{ color: margin !== null && margin > 0 ? '#4ade80' : '#ff5c6c' }}>{margin !== null ? fmtISK(margin) : '—'}</b></span>
          </div>

          {/* Aankoop bewaren → Mijn posities */}
          <div style={{ marginTop: '0.7rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ width: 80 }}>
              <div style={LABEL}>Aantal</div>
              <input type="number" min={1} value={saveQty} onChange={e => setSaveQty(e.target.value)} style={{ ...INPUT, width: '100%' }} />
            </div>
            <div style={{ width: 120 }}>
              <div style={LABEL}>Koopprijs/stuk</div>
              <input value={savePrice} onChange={e => setSavePrice(e.target.value)} style={{ ...INPUT, width: '100%' }} />
            </div>
            <button
              onClick={() => {
                const qy = parseInt(saveQty) || 0, pr = parseFloat(savePrice.replace(',', '.')) || 0
                if (qy < 1 || pr <= 0) return
                addPosition({ typeId: res.typeId, name: res.name, qty: qy, buyPrice: pr })
                setSaved(true)
              }}
              style={{ padding: '0.4rem 0.8rem', borderRadius: 2, border: 0, background: saved ? '#4ade80' : 'var(--blue)', color: '#04121f', fontWeight: 700, cursor: 'pointer', fontSize: '0.72rem' }}
            >{saved ? '✓ Bewaard' : '+ Bewaar aankoop'}</button>
            {saved && <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Zie <b>Mijn posities</b> voor je winst/verlies</span>}
          </div>

          {/* Koop-laag/verkoop-hoog signaal */}
          {s && signal && (
            <div style={{ marginTop: '0.9rem', padding: '0.7rem 0.85rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, maxWidth: 560 }}>
              <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', alignItems: 'baseline', fontSize: '0.72rem' }}>
                <span style={{ fontWeight: 700, color: signal.color }}>{signal.txt}</span>
                <span>vs 30d-gem: <b style={{ color: signal.color }}>{vsAvg! >= 0 ? '+' : ''}{vsAvg!.toFixed(1)}%</b></span>
                <span style={{ color: 'var(--text-dim)' }}>30d: {fmtISK(s.min30)} – {fmtISK(s.max30)} (gem {fmtISK(s.avg30)})</span>
                <span>Volatiliteit: <b>{s.volatilityPct.toFixed(0)}%</b></span>
              </div>
              {/* Positie-balk in de 30d-bandbreedte */}
              {bandPos !== null && (
                <div style={{ marginTop: '0.5rem', position: 'relative', height: 6, background: 'linear-gradient(90deg,#4ade80,#ffce54,#ff5c6c)', borderRadius: 4, opacity: 0.85 }}>
                  <div style={{ position: 'absolute', left: `${bandPos * 100}%`, top: -3, width: 3, height: 12, background: 'var(--text)', transform: 'translateX(-50%)', borderRadius: 2 }} />
                </div>
              )}
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
                Balk = waar de huidige sell-prijs staat binnen de 30-daagse bandbreedte (links laag/goedkoop, rechts hoog/duur).
              </div>
            </div>
          )}

          {/* Prijs- & volumegrafiek */}
          {chartData.length > 1 && (
            <div style={{ marginTop: '0.9rem', padding: '0.7rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, maxWidth: 720 }}>
              <div style={LABEL}>GEM. PRIJS &amp; DAGVOLUME (90 DAGEN)</div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartData} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} minTickGap={28} />
                  <YAxis yAxisId="price" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} tickFormatter={v => fmtISK(v)} width={52} />
                  <YAxis yAxisId="vol" orientation="right" hide />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
                    formatter={(val: number, n) => n === 'price' ? [`${fmtISK(val)} ISK`, 'Prijs'] : [val.toLocaleString('nl-NL'), 'Volume']} />
                  <Bar yAxisId="vol" dataKey="volume" fill="var(--border)" />
                  <Line yAxisId="price" dataKey="price" stroke="#00b4d8" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  )
}
