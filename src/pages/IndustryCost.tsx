import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'
import { getIndustryCostIndices } from '../api/esi'

type Sys = [string, number, number]  // [naam, security, regionId]
const ACTS = [
  ['manufacturing', 'Manufacturing'],
  ['reaction', 'Reacties'],
  ['invention', 'Invention'],
] as const
type Activity = typeof ACTS[number][0]
const HUBS: [number, string][] = [[30000142, 'Jita'], [30002187, 'Amarr'], [30002659, 'Dodixie'], [30002510, 'Rens'], [30002053, 'Hek']]
const SCC = 0.04  // SCC-toeslag (4% van EIV), overal gelijk

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} mrd`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} mln`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}
const secRound = (s: number) => Math.round(s * 10) / 10
const secColor = (s: number) => { const r = secRound(s); return r >= 0.5 ? '#3ecf6e' : r > 0 ? '#f0a030' : '#e05555' }

export default function IndustryCost() {
  const [ci, setCi] = useState<Map<number, Record<string, number>>>(new Map())
  const [systems, setSystems] = useState<Record<string, Sys>>({})
  const [regions, setRegions] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [activity, setActivity] = useState<Activity>('manufacturing')
  const [secFilter, setSecFilter] = useState<'all' | 'high' | 'low' | 'null'>('high')
  const [search, setSearch] = useState('')
  const [eiv, setEiv] = useState(100)  // in miljoen ISK

  useEffect(() => {
    Promise.all([
      getIndustryCostIndices(),
      fetch('/systems.json').then(r => r.json()).catch(() => ({})),
      fetch('/regions.json').then(r => r.json()).catch(() => ({})),
    ]).then(([m, s, rg]) => { setCi(m); setSystems(s); setRegions(rg); setLoading(false) })
  }, [])

  const eivISK = eiv * 1e6
  const fee = (idx: number) => eivISK * (idx + SCC)
  const bandOf = (sec: number): 'high' | 'low' | 'null' => { const r = secRound(sec); return r >= 0.5 ? 'high' : r > 0 ? 'low' : 'null' }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: { id: number; name: string; sec: number; region: string; idx: number }[] = []
    for (const [id, acts] of ci) {
      const s = systems[String(id)]
      if (!s) continue
      const [name, sec, regionId] = s
      if (secFilter !== 'all' && bandOf(sec) !== secFilter) continue
      const region = regions[String(regionId)] ?? '—'
      if (q && !name.toLowerCase().includes(q) && !region.toLowerCase().includes(q)) continue
      out.push({ id, name, sec, region, idx: acts[activity] ?? 0 })
    }
    out.sort((a, b) => a.idx - b.idx)
    return out
  }, [ci, systems, regions, activity, secFilter, search])

  const hubRows = HUBS.map(([id, label]) => ({ label, idx: ci.get(id)?.[activity] ?? null })).filter(h => h.idx !== null)

  return (
    <Layout header={<PageHeader title="Industrie-kosten" sub={loading ? 'Laden…' : `${rows.length} systemen · live cost-indices`} />}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.75rem' }}>
        {ACTS.map(([k, l]) => <button key={k} onClick={() => setActivity(k)} style={pill(activity === k)}>{l}</button>)}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
        {(['all', 'high', 'low', 'null'] as const).map(s => <button key={s} onClick={() => setSecFilter(s)} style={pill(secFilter === s)}>{s === 'all' ? 'Alle' : s === 'high' ? 'High' : s === 'low' ? 'Low' : 'Null'}</button>)}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoek systeem / regio…" style={{ ...input, flex: 1, minWidth: 140 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem', color: 'var(--text-dim)' }}>
          EIV (mln)
          <input type="number" min={1} value={eiv} onChange={e => setEiv(Math.max(1, parseInt(e.target.value) || 1))} style={{ ...input, width: 70 }} title="Geschatte item-waarde — bepaalt de job-fee" />
        </label>
      </div>

      {/* Trade hubs ter referentie */}
      {hubRows.length > 0 && (
        <div style={{ ...card, display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: '0.75rem', fontSize: '0.72rem' }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 700 }}>HUBS:</span>
          {hubRows.map(h => (
            <span key={h.label}>{h.label}: <strong style={{ color: '#fff' }}>{(h.idx! * 100).toFixed(2)}%</strong> <span style={{ color: 'var(--text-dim)' }}>· fee ~{fmtISK(fee(h.idx!))}</span></span>
          ))}
        </div>
      )}

      {/* Tabel */}
      <div style={{ ...rowWrap, fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', borderBottom: '1px solid var(--border)' }}>
        <span style={{ flex: 1 }}>SYSTEEM</span>
        <span style={{ width: 140 }}>REGIO</span>
        <span style={{ width: 44, textAlign: 'right' }}>SEC</span>
        <span style={{ width: 80, textAlign: 'right' }}>INDEX</span>
        <span style={{ width: 100, textAlign: 'right' }}>JOB-FEE</span>
      </div>
      {rows.slice(0, 200).map(r => (
        <div key={r.id} style={{ ...rowWrap, borderBottom: '1px solid var(--border)' }}>
          <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          <span style={{ width: 140, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.region}</span>
          <span style={{ width: 44, textAlign: 'right', color: secColor(r.sec), fontWeight: 700 }}>{secRound(r.sec).toFixed(1)}</span>
          <span style={{ width: 80, textAlign: 'right', color: r.idx <= 0.01 ? '#3ecf6e' : r.idx >= 0.05 ? 'var(--gold)' : 'var(--text)' }}>{(r.idx * 100).toFixed(2)}%</span>
          <span style={{ width: 100, textAlign: 'right', color: 'var(--text-dim)' }}>~{fmtISK(fee(r.idx))}</span>
        </div>
      ))}
      {!loading && rows.length === 0 && <div style={{ padding: '2rem', color: 'var(--text-dim)' }}>Geen systemen gevonden.</div>}
      {rows.length > 200 && <div style={{ padding: '0.6rem', fontSize: '0.62rem', color: 'var(--text-dim)' }}>Eerste 200 getoond — verfijn met zoeken/filter.</div>}

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Job-fee ≈ EIV × (cost-index + {(SCC * 100).toFixed(0)}% SCC-toeslag). Facility-tax (per structure/station) is hier niet meegerekend; lagere index = goedkoper bouwen. Cost-indices komen live van ESI en stijgen bij meer activiteit in een systeem.
      </div>
    </Layout>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.6rem 0.85rem' }
const rowWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.4rem 0.5rem', fontSize: '0.74rem' }
const input: React.CSSProperties = { background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', padding: '0.32rem 0.5rem', fontSize: '0.74rem' }
const pill = (on: boolean): React.CSSProperties => ({
  padding: '4px 11px', borderRadius: 12, fontSize: '0.66rem', cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? 'var(--blue)' : 'var(--text-dim)'}`,
  background: on ? 'rgba(0,180,216,0.18)' : 'rgba(255,255,255,0.05)',
  color: on ? '#fff' : 'var(--text)',
})
