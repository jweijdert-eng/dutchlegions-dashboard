import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

interface Pin { type_id: number; is_input: boolean; quantity: number }
interface Schem { schematic_name: string; cycle_time: number; pins: Pin[] }

// ── SDE + prijzen ───────────────────────────────────────────────────────────
let _schInflight: Promise<Record<string, Schem>> | null = null
function loadSchematics(): Promise<Record<string, Schem>> {
  if (!_schInflight) _schInflight = fetch('/schematics.json').then(r => r.json()).catch(() => ({}))
  return _schInflight
}
let _namesInflight: Promise<Record<string, string>> | null = null
function loadTypeNames(): Promise<Record<string, string>> {
  if (!_namesInflight) _namesInflight = fetch('/type-names.json').then(r => r.json()).catch(() => ({}))
  return _namesInflight
}
async function fetchJita(typeIds: number[]): Promise<Map<number, { buy: number; sell: number }>> {
  const out = new Map<number, { buy: number; sell: number }>()
  if (typeIds.length === 0) return out
  try {
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${typeIds.join(',')}`)
    const j = await r.json()
    for (const id of typeIds) out.set(id, { buy: Number(j?.[id]?.buy?.max ?? 0), sell: Number(j?.[id]?.sell?.min ?? 0) })
  } catch { /* prijzen optioneel */ }
  return out
}

function fmtISK(v: number) {
  const a = Math.abs(v), s = v < 0 ? '-' : ''
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)} mrd`
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)} mln`
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)}k`
  return `${s}${Math.round(a)}`
}
const TIER_COLOR = ['#888', '#3ecf6e', '#00b4d8', '#a78bfa', '#f0a030']  // P0..P4

// PI-facility CPU/Power (PG) + command center-budget per upgrade-level (standaard EVE-waarden).
const FAC = {
  basic:     { name: 'Basic Industry Facility',     cpu: 200,  pg: 800 },
  advanced:  { name: 'Advanced Industry Facility',  cpu: 500,  pg: 700 },
  hitech:    { name: 'High-Tech Industry Facility', cpu: 1100, pg: 400 },
  launchpad: { name: 'Launchpad',                   cpu: 3600, pg: 700 },
  storage:   { name: 'Storage Facility',            cpu: 500,  pg: 700 },
} as const
const CC_BUDGET = [
  { cpu: 1675, pg: 6000 }, { cpu: 7057, pg: 9000 }, { cpu: 12136, pg: 12000 },
  { cpu: 17215, pg: 15000 }, { cpu: 21315, pg: 17700 }, { cpu: 25415, pg: 19000 },
]
const facForTier = (t: number): keyof typeof FAC => t >= 4 ? 'hitech' : t >= 2 ? 'advanced' : 'basic'

// P0-grondstof → planeet-types waar je het kunt winnen (vaste EVE-data).
const P0_PLANETS: Record<string, string[]> = {
  'Aqueous Liquids':   ['Barren', 'Gas', 'Ice', 'Oceanic', 'Storm', 'Temperate'],
  'Autotrophs':        ['Temperate'],
  'Base Metals':       ['Barren', 'Lava', 'Plasma'],
  'Carbon Compounds':  ['Barren', 'Oceanic', 'Temperate'],
  'Complex Organisms': ['Oceanic', 'Temperate'],
  'Felsic Magma':      ['Lava'],
  'Heavy Metals':      ['Lava', 'Plasma'],
  'Ionic Solutions':   ['Gas', 'Storm'],
  'Microorganisms':    ['Barren', 'Gas', 'Oceanic', 'Temperate'],
  'Noble Gas':         ['Gas', 'Ice', 'Storm'],
  'Noble Metals':      ['Barren', 'Plasma'],
  'Non-CS Crystals':   ['Plasma'],
  'Planktic Colonies': ['Ice', 'Oceanic'],
  'Reactive Gas':      ['Gas', 'Storm'],
  'Suspended Plasma':  ['Lava', 'Plasma', 'Storm'],
}

// Reken de keten uit: hoeveel fabrieken per tussenproduct + P0-grondstoffen/uur,
// om `n` eindfabrieken van het doel te voeden.
function computeSetup(outId: number, n: number, producedBy: Map<number, { outQty: number; inputs: Pin[]; cycle: number }>) {
  const fac = new Map<number, number>()
  const raw = new Map<number, number>()
  const visit = (p: number, f: number, depth = 0) => {
    const r = producedBy.get(p)
    if (!r || depth > 12) return
    fac.set(p, (fac.get(p) ?? 0) + f)
    for (const inp of r.inputs) {
      const demand = f * inp.quantity * 3600 / r.cycle   // units/uur van deze input
      const ri = producedBy.get(inp.type_id)
      if (ri) visit(inp.type_id, demand / (ri.outQty * 3600 / ri.cycle), depth + 1)
      else raw.set(inp.type_id, (raw.get(inp.type_id) ?? 0) + demand)
    }
  }
  visit(outId, n)
  return { fac, raw }
}

export default function PiPlanner() {
  const [sch, setSch] = useState<Record<string, Schem>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [px, setPx] = useState<Map<number, { buy: number; sell: number }>>(new Map())
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [sort, setSort] = useState<'day' | 'margin'>('day')
  const [tierFilter, setTierFilter] = useState<'all' | 1 | 2 | 3 | 4>('all')
  const [factories, setFactories] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    Promise.all([loadSchematics(), loadTypeNames()]).then(([s, n]) => {
      setSch(s); setNames(n)
      const ids = new Set<number>()
      for (const x of Object.values(s)) for (const p of x.pins) ids.add(p.type_id)
      fetchJita([...ids]).then(m => { setPx(m); setLoading(false) })
    })
  }, [])

  const nameOf = (id: number) => names[String(id)] ?? `Type ${id}`
  const buy = (id: number) => px.get(id)?.buy ?? 0
  const sell = (id: number) => px.get(id)?.sell ?? 0

  // product-typeId → recept dat het maakt
  const producedBy = useMemo(() => {
    const m = new Map<number, { outQty: number; inputs: Pin[]; cycle: number }>()
    for (const s of Object.values(sch)) {
      const out = s.pins.find(p => !p.is_input)
      if (out && !m.has(out.type_id)) m.set(out.type_id, { outQty: out.quantity, inputs: s.pins.filter(p => p.is_input), cycle: s.cycle_time })
    }
    return m
  }, [sch])

  // PI-tier (P0 = ruw/geëxtraheerd, P1..P4 = geproduceerd)
  const tierOf = useMemo(() => {
    const cache = new Map<number, number>()
    const calc = (t: number, seen = new Set<number>()): number => {
      if (cache.has(t)) return cache.get(t)!
      const r = producedBy.get(t)
      if (!r || seen.has(t)) { cache.set(t, 0); return 0 }
      const s2 = new Set(seen).add(t)
      const tier = 1 + Math.max(0, ...r.inputs.map(i => calc(i.type_id, s2)))
      cache.set(t, tier); return tier
    }
    return calc
  }, [producedBy])

  // Materiaalkosten per eenheid als je de hele keten zelf maakt (koop alleen P0)
  const rawCost = useMemo(() => {
    const cache = new Map<number, number>()
    const calc = (t: number, seen = new Set<number>()): number => {
      if (cache.has(t)) return cache.get(t)!
      const r = producedBy.get(t)
      if (!r || seen.has(t)) { const c = buy(t); cache.set(t, c); return c }
      const s2 = new Set(seen).add(t)
      const c = r.inputs.reduce((a, i) => a + i.quantity * calc(i.type_id, s2), 0) / r.outQty
      cache.set(t, c); return c
    }
    return calc
  }, [producedBy, px])

  const rows = useMemo(() => {
    const out: {
      id: string; outId: number; outQty: number; outName: string; tier: number; cycle: number; inputs: Pin[]
      outVal: number; inCost: number; perCycle: number; perDay: number; margin: number; chainDay: number
    }[] = []
    for (const [id, s] of Object.entries(sch)) {
      const o = s.pins.find(p => !p.is_input)
      if (!o) continue
      const inputs = s.pins.filter(p => p.is_input)
      const outVal = o.quantity * sell(o.type_id)
      const inCost = inputs.reduce((a, p) => a + p.quantity * buy(p.type_id), 0)
      if (outVal <= 0 || inCost <= 0) continue
      const perCycle = outVal - inCost
      const chainInCost = inputs.reduce((a, p) => a + p.quantity * rawCost(p.type_id), 0)
      const perDayFactor = 86400 / s.cycle_time
      out.push({
        id, outId: o.type_id, outQty: o.quantity, outName: names[String(o.type_id)] ?? s.schematic_name,
        tier: tierOf(o.type_id), cycle: s.cycle_time, inputs, outVal, inCost,
        perCycle, perDay: perCycle * perDayFactor, margin: (perCycle / outVal) * 100,
        chainDay: (outVal - chainInCost) * perDayFactor,
      })
    }
    const filtered = out.filter(r => tierFilter === 'all' || r.tier === tierFilter)
    filtered.sort((a, b) => sort === 'margin' ? b.margin - a.margin : b.perDay - a.perDay)
    return filtered
  }, [sch, px, names, tierFilter, sort, tierOf, rawCost])

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <Layout header={<PageHeader title="PI-winstplanner" sub={loading ? 'Prijzen laden…' : `${rows.length} recepten · live Jita`} />}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {([['day', 'Winst/dag'], ['margin', 'Marge']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setSort(k)} style={pill(sort === k)}>{l}</button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '0 2px' }} />
        {(['all', 1, 2, 3, 4] as const).map(t => (
          <button key={t} onClick={() => setTierFilter(t)} style={pill(tierFilter === t)}>{t === 'all' ? 'Alle' : `P${t}`}</button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem', color: 'var(--text-dim)' }}>
          Factories/planeet
          <input type="number" min={1} max={20} value={factories} onChange={e => setFactories(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
            style={{ width: 56, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', padding: '0.3rem 0.45rem', fontSize: '0.74rem' }} />
        </label>
      </div>

      {/* Kop */}
      <div style={{ ...rowWrap, fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 14, flexShrink: 0 }} />
        <span style={{ width: 32, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>PRODUCT</span>
        <span style={{ width: 90, textAlign: 'right' }}>WINST/CYCLE</span>
        <span style={{ width: 100, textAlign: 'right' }}>WINST/DAG</span>
        <span style={{ width: 56, textAlign: 'right' }}>MARGE</span>
      </div>

      {rows.map(r => {
        const open = expanded.has(r.id)
        return (
          <div key={r.id}>
            <div onClick={() => toggle(r.id)} style={{ ...rowWrap, cursor: 'pointer', borderBottom: '1px solid var(--border)', background: open ? 'rgba(0,180,216,0.05)' : 'transparent' }}>
              <span style={{ width: 14, flexShrink: 0, fontSize: '0.6rem', color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
              <EveImage category="types" id={r.outId} variation="icon" size={32} px={26} style={{ borderRadius: 3, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.78rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.outName}</span>
                <span style={{ fontSize: '0.56rem', fontWeight: 700, color: TIER_COLOR[r.tier], border: `1px solid ${TIER_COLOR[r.tier]}`, borderRadius: 8, padding: '0 5px', flexShrink: 0 }}>P{r.tier}</span>
              </span>
              <span style={{ width: 90, textAlign: 'right', fontSize: '0.74rem', color: 'var(--text-dim)' }}>{fmtISK(r.perCycle)}</span>
              <span style={{ width: 100, textAlign: 'right', fontSize: '0.8rem', fontWeight: 700, color: r.perDay > 0 ? '#3ecf6e' : 'var(--red)' }}>{fmtISK(r.perDay * factories)}</span>
              <span style={{ width: 56, textAlign: 'right', fontSize: '0.72rem', color: r.margin >= 25 ? '#3ecf6e' : r.margin >= 10 ? 'var(--gold)' : 'var(--text-dim)' }}>{r.margin.toFixed(0)}%</span>
            </div>

            {open && (
              <div style={{ padding: '0.6rem 0.7rem 0.8rem 2.2rem', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)', fontSize: '0.7rem' }}>
                <div style={{ color: 'var(--text-dim)', marginBottom: 6 }}>
                  {r.cycle / 3600}u-cyclus → {r.outQty}× {r.outName} · verkoopwaarde <span style={{ color: '#3ecf6e' }}>{fmtISK(r.outVal)}</span> (Jita sell)
                </div>
                {r.inputs.map(p => (
                  <div key={p.type_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                    <EveImage category="types" id={p.type_id} variation="icon" size={32} px={20} style={{ borderRadius: 2, flexShrink: 0 }} />
                    <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.quantity}× {nameOf(p.type_id)}
                      <span style={{ fontSize: '0.54rem', color: TIER_COLOR[tierOf(p.type_id)], marginLeft: 6 }}>P{tierOf(p.type_id)}</span>
                    </span>
                    <span style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>@buy {fmtISK(buy(p.type_id))} = {fmtISK(p.quantity * buy(p.type_id))}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <span>Inputs kopen: <strong style={{ color: r.perDay > 0 ? '#3ecf6e' : 'var(--red)' }}>{fmtISK(r.perDay * factories)}/dag</strong></span>
                  <span title="Maak alle PI-inputs zelf, koop alleen de P0-grondstoffen">Volledige keten (alleen P0 kopen): <strong style={{ color: r.chainDay > 0 ? '#3ecf6e' : 'var(--red)' }}>{fmtISK(r.chainDay * factories)}/dag</strong></span>
                </div>

                {/* Planeet-opstelling (volledige keten zelf maken) */}
                {(() => {
                  const { fac, raw } = computeSetup(r.outId, factories, producedBy)
                  let cpu = FAC.launchpad.cpu + FAC.storage.cpu, pg = FAC.launchpad.pg + FAC.storage.pg
                  const lines = [...fac.entries()].map(([pid, cnt]) => {
                    const c = Math.ceil(cnt), f = FAC[facForTier(tierOf(pid))]
                    cpu += c * f.cpu; pg += c * f.pg
                    return { pid, c, fname: f.name, tier: tierOf(pid) }
                  }).sort((a, b) => b.tier - a.tier)
                  const lvl = CC_BUDGET.findIndex(bk => bk.cpu >= cpu && bk.pg >= pg)
                  return (
                    <div style={{ marginTop: 10, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
                      <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>📋 Planeet-opstelling (volledige keten · {factories} eindfabriek{factories !== 1 ? 'en' : ''})</div>
                      {lines.map(l => (
                        <div key={l.pid} style={{ color: 'var(--text-dim)' }}>
                          <strong style={{ color: '#fff' }}>{l.c}×</strong> {l.fname} <span style={{ color: TIER_COLOR[l.tier] }}>→ {nameOf(l.pid)} (P{l.tier})</span>
                        </div>
                      ))}
                      <div style={{ color: 'var(--text-dim)' }}>+ 1× Launchpad · 1× Storage Facility</div>
                      <div style={{ marginTop: 4 }}>
                        Fabrieken samen: <strong style={{ color: '#fff' }}>~{Math.round(cpu).toLocaleString('nl-NL')} CPU · {Math.round(pg).toLocaleString('nl-NL')} PG</strong> →{' '}
                        {lvl === -1
                          ? <span style={{ color: 'var(--gold)' }}>past niet op één planeet</span>
                          : <span style={{ color: '#3ecf6e' }}>Command Center Upgrade min. Level {lvl}</span>}
                      </div>
                      {(() => {
                        const factoryPlanets = Math.max(1, Math.ceil(cpu / CC_BUDGET[5].cpu), Math.ceil(pg / CC_BUDGET[5].pg))
                        const extractorPlanets = raw.size
                        return (
                          <div style={{ marginTop: 4, color: '#fff' }}>
                            🌍 Planeten (schatting): <strong>~{factoryPlanets + extractorPlanets}</strong>
                            <span style={{ color: 'var(--text-dim)' }}> = {factoryPlanets} fabriek + {extractorPlanets} extractor</span>
                            <span style={{ fontSize: '0.56rem', color: 'var(--text-dim)', opacity: 0.8 }}> (max 6 per character)</span>
                          </div>
                        )
                      })()}
                      {raw.size > 0 && (
                        <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                          <div style={{ marginBottom: 2 }}>P0-grondstoffen nodig (uur · planeet-types):</div>
                          {[...raw.entries()].map(([id, q]) => (
                            <div key={id} style={{ paddingLeft: 6 }}>
                              {Math.ceil(q).toLocaleString('nl-NL')}/u <span style={{ color: '#fff' }}>{nameOf(id)}</span>
                              <span style={{ color: TIER_COLOR[1] }}> → {(P0_PLANETS[nameOf(id)] ?? ['?']).join(' / ')}</span>
                            </div>
                          ))}
                          <span style={{ display: 'block', fontSize: '0.56rem', opacity: 0.8, marginTop: 2 }}>(extractor-heads hangen af van de planeet-rijkdom; CPU/PG hierboven is alleen voor de fabrieken)</span>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        )
      })}

      {!loading && rows.length === 0 && <div style={{ padding: '2rem', color: 'var(--text-dim)' }}>Geen recepten/prijzen gevonden.</div>}

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Winst/dag = winst per cyclus × cycli per dag × factories, met inputs @Jita-buy en output @Jita-sell. "Volledige keten" rekent met zelf alle PI-tussenstappen maken (alleen P0 kopen). Prijzen schommelen; dit is een schatting.
      </div>
    </Layout>
  )
}

const rowWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.45rem 0.7rem' }
const pill = (on: boolean): React.CSSProperties => ({
  padding: '4px 12px', borderRadius: 12, fontSize: '0.66rem', cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? 'var(--blue)' : 'var(--text-dim)'}`,
  background: on ? 'rgba(0,180,216,0.18)' : 'rgba(255,255,255,0.05)',
  color: on ? '#fff' : 'var(--text)',
})
