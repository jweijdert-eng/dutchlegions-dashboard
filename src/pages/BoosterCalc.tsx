import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

interface CompactBp { m: [number, number][]; p: [number, number] }
interface Recipe { perRun: number; materials: [number, number][]; kind: 'mfg' | 'rx' }

let _names: Promise<Record<string, string>> | null = null
const loadNames = () => (_names ??= fetch('/type-names.json').then(r => r.json()).catch(() => ({})))

function fmtISK(v: number) {
  const a = Math.abs(v), s = v < 0 ? '-' : ''
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)} mrd`
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)} mln`
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)}k`
  return `${s}${Math.round(a)}`
}

async function fetchJita(ids: number[]): Promise<Map<number, { buy: number; sell: number }>> {
  const out = new Map<number, { buy: number; sell: number }>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    try {
      const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${chunk.join(',')}`)
      const j = await r.json()
      for (const id of chunk) out.set(id, { buy: Number(j?.[id]?.buy?.max ?? 0), sell: Number(j?.[id]?.sell?.min ?? 0) })
    } catch { /* ignore */ }
  }
  return out
}

export default function BoosterCalc() {
  const [boosters, setBoosters] = useState<number[]>([])
  const [recipes, setRecipes] = useState<Map<number, Recipe>>(new Map())
  const [names, setNames] = useState<Record<string, string>>({})
  const [px, setPx] = useState<Map<number, { buy: number; sell: number }>>(new Map())
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/boosters.json').then(r => r.json()).catch(() => []),
      fetch('/blueprints.json').then(r => r.json()).catch(() => ({})),
      fetch('/reactions.json').then(r => r.json()).catch(() => ({})),
      loadNames(),
    ]).then(([bo, bps, rx, nm]: [number[], Record<string, CompactBp>, Record<string, CompactBp>, Record<string, string>]) => {
      const m = new Map<number, Recipe>()
      for (const b of Object.values(rx)) if (!m.has(b.p[0])) m.set(b.p[0], { perRun: b.p[1], materials: b.m, kind: 'rx' })
      for (const b of Object.values(bps)) if (!m.has(b.p[0])) m.set(b.p[0], { perRun: b.p[1], materials: b.m, kind: 'mfg' })
      setBoosters(bo); setRecipes(m); setNames(nm)
      // alle type-ids in de booster-ketens verzamelen → prijzen
      const ids = new Set<number>()
      const walk = (t: number, seen = new Set<number>()) => {
        ids.add(t); const r = m.get(t)
        if (r && !seen.has(t)) { const s2 = new Set(seen).add(t); for (const [mat] of r.materials) walk(mat, s2) }
      }
      bo.forEach(b => walk(b))
      fetchJita([...ids]).then(p => { setPx(p); setLoading(false) })
    })
  }, [])

  const nameOf = (id: number) => names[String(id)] ?? `Type ${id}`
  const buy = (id: number) => px.get(id)?.buy ?? 0
  const sell = (id: number) => px.get(id)?.sell ?? 0

  // Volledige-keten materiaalkosten per eenheid (koop alle blad-materialen @buy)
  const chainCost = useMemo(() => {
    const cache = new Map<number, number>()
    const calc = (t: number, seen = new Set<number>()): number => {
      if (cache.has(t)) return cache.get(t)!
      const r = recipes.get(t)
      if (!r || seen.has(t)) { const c = buy(t); cache.set(t, c); return c }
      const s2 = new Set(seen).add(t)
      const c = r.materials.reduce((a, [mat, q]) => a + q * calc(mat, s2), 0) / r.perRun
      cache.set(t, c); return c
    }
    return calc
  }, [recipes, px])

  const rows = useMemo(() => {
    return boosters.map(id => {
      const r = recipes.get(id)
      const sellV = sell(id)
      const cost = chainCost(id)
      const profit = sellV - cost
      return { id, name: nameOf(id), sellV, cost, profit, margin: sellV > 0 ? (profit / sellV) * 100 : 0, recipe: r }
    }).filter(x => x.sellV > 0).sort((a, b) => b.profit - a.profit)
  }, [boosters, recipes, px, names])

  return (
    <Layout header={<PageHeader title="Booster-productie" sub={loading ? 'Prijzen laden…' : `${rows.length} boosters · volledige keten · live Jita`} />}>
      <div style={{ ...rowWrap, fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 14, flexShrink: 0 }} />
        <span style={{ width: 30, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>BOOSTER</span>
        <span style={{ width: 90, textAlign: 'right' }}>KOSTEN</span>
        <span style={{ width: 90, textAlign: 'right' }}>VERKOOP</span>
        <span style={{ width: 90, textAlign: 'right' }}>WINST</span>
        <span style={{ width: 54, textAlign: 'right' }}>MARGE</span>
      </div>
      {rows.map(r => {
        const open = expanded === r.id
        return (
          <div key={r.id}>
            <div onClick={() => setExpanded(open ? null : r.id)} style={{ ...rowWrap, cursor: 'pointer', borderBottom: '1px solid var(--border)', background: open ? 'rgba(0,180,216,0.05)' : 'transparent' }}>
              <span style={{ width: 14, flexShrink: 0, fontSize: '0.6rem', color: 'var(--text-dim)' }}>{r.recipe ? (open ? '▾' : '▸') : ''}</span>
              <EveImage category="types" id={r.id} variation="icon" size={32} px={24} style={{ borderRadius: 3, flexShrink: 0 }} />
              <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ width: 90, textAlign: 'right', color: 'var(--text-dim)' }}>{fmtISK(r.cost)}</span>
              <span style={{ width: 90, textAlign: 'right', color: 'var(--text-dim)' }}>{fmtISK(r.sellV)}</span>
              <span style={{ width: 90, textAlign: 'right', fontWeight: 700, color: r.profit > 0 ? '#3ecf6e' : 'var(--red)' }}>{fmtISK(r.profit)}</span>
              <span style={{ width: 54, textAlign: 'right', color: r.margin >= 25 ? '#3ecf6e' : r.margin >= 10 ? 'var(--gold)' : 'var(--text-dim)' }}>{r.margin.toFixed(0)}%</span>
            </div>
            {open && r.recipe && (
              <div style={{ padding: '0.6rem 0.7rem 0.7rem 2.1rem', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)', fontSize: '0.68rem' }}>
                <div style={{ color: 'var(--text-dim)', marginBottom: 5 }}>Recept ({r.recipe.kind === 'rx' ? 'reactie' : 'manufacturing'}) → {r.recipe.perRun}× per run:</div>
                {r.recipe.materials.map(([mat, q]) => {
                  const sub = recipes.get(mat)
                  return (
                    <div key={mat} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '1px 0' }}>
                      <EveImage category="types" id={mat} variation="icon" size={32} px={18} style={{ borderRadius: 2, flexShrink: 0 }} />
                      <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q}× {nameOf(mat)}{sub && <span style={{ color: 'var(--gold)', fontSize: '0.56rem', marginLeft: 6 }}>{sub.kind === 'rx' ? '⚗️ reactie' : '🔧 maakbaar'}</span>}
                      </span>
                      <span style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>@buy {fmtISK(buy(mat))}{sub ? ` · keten ${fmtISK(chainCost(mat))}` : ''}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {!loading && rows.length === 0 && <div style={{ padding: '2rem', color: 'var(--text-dim)' }}>Geen booster-prijzen gevonden.</div>}
      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Winst = verkoop (@Jita-sell) − materiaalkosten van de **volledige keten** (gas/fuel/water @Jita-buy, via reactie → manufacturing). Job-fees zijn niet meegerekend. Prijzen live; gas-clouds zelf harvesten verhoogt de marge.
      </div>
    </Layout>
  )
}

const rowWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.45rem 0.6rem', fontSize: '0.74rem' }
