import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

// Bouwwinst-scanner: welke blueprints leveren winst op als je ze bouwt en op
// Jita verkoopt? Data uit api/bpprofit.php (alle SDE-recepten × Jita-prijzen,
// server-side gecached). ME instelbaar; filters op marge/volume; sorteerbaar.

interface Row {
  product_id: number
  product: string
  output: number
  matcost: number
  jobfee: number
  sellval: number
  profit: number
  per_unit: number
  margin: number
  sell: number
  volume: number
}

interface Feed {
  ok?: boolean
  me?: number
  aantal?: number
  bijgewerkt?: string
  rows?: Row[]
  error?: string
}

type Sort = 'margin' | 'profit' | 'per_unit' | 'volume'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'margin', label: 'Marge %' },
  { key: 'profit', label: 'Winst/job' },
  { key: 'per_unit', label: 'Winst/stuk' },
  { key: 'volume', label: 'Volume' },
]

function fmtISK(v: number) {
  if (!isFinite(v) || v === 0) return '—'
  const a = Math.abs(v), s = v < 0 ? '−' : ''
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}K`
  return `${s}${Math.round(a)}`
}

export default function BuildProfit() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [laden, setLaden] = useState(true)
  const [fout, setFout] = useState('')
  const [me, setMe] = useState(10)
  const [sort, setSort] = useState<Sort>('margin')
  const [minMarge, setMinMarge] = useState(10)
  const [minVol, setMinVol] = useState(10)

  usePageLoading(laden)

  const haal = useCallback(async (meVal: number, ververs = false) => {
    setLaden(true); setFout('')
    try {
      const res = await fetch(`/api/bpprofit.php?action=list&me=${meVal}${ververs ? '&refresh=1' : ''}`)
      const data = await res.json() as Feed
      if (!res.ok || !data.ok) setFout(data.error || 'Ophalen mislukt.')
      else setFeed(data)
    } catch {
      setFout('Kon de bouwwinst-data niet ophalen.')
    } finally {
      setLaden(false)
    }
  }, [])

  useEffect(() => { void haal(me) }, [haal, me])

  const rows = useMemo(() => {
    const r = (feed?.rows ?? []).filter(x => x.margin >= minMarge && x.volume >= minVol)
    return [...r].sort((a, b) => b[sort] - a[sort])
  }, [feed, sort, minMarge, minVol])

  return (
    <Layout header={
      <PageHeader title="Bouwwinst" sub="blueprints die winst opleveren om te bouwen en op Jita te verkopen" />
    }>
      {fout && <div className="card" style={{ padding: '1rem', color: 'var(--red)' }}>{fout}</div>}

      {/* Instellingen */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', alignItems: 'stretch', marginBottom: '1rem' }}>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 150px', minWidth: 140 }}>
          <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                        textTransform: 'uppercase', color: 'var(--text-dim)' }}>Material Efficiency</div>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.2rem' }}>
            <input type="range" min={0} max={10} value={me} onChange={e => setMe(parseInt(e.target.value))} style={{ flex: 1 }} />
            <span style={{ fontWeight: 800, minWidth: 34, textAlign: 'right' }}>ME{me}</span>
          </div>
        </div>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 140px', minWidth: 130 }}>
          <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                        textTransform: 'uppercase', color: 'var(--text-dim)' }}>Min. marge %</div>
          <input type="number" value={minMarge} onChange={e => setMinMarge(Math.max(0, +e.target.value))}
            style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid var(--border)',
                     borderRadius: 6, color: 'inherit', padding: '.25rem .5rem', fontSize: '.9rem', marginTop: '.2rem' }} />
        </div>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 160px', minWidth: 140 }}>
          <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                        textTransform: 'uppercase', color: 'var(--text-dim)' }}>Min. markt-volume</div>
          <input type="number" value={minVol} onChange={e => setMinVol(Math.max(0, +e.target.value))}
            style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid var(--border)',
                     borderRadius: 6, color: 'inherit', padding: '.25rem .5rem', fontSize: '.9rem', marginTop: '.2rem' }} />
        </div>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 120px', minWidth: 110,
                                       display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                        textTransform: 'uppercase', color: 'var(--text-dim)' }}>Resultaten</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--green)' }}>{rows.length}</div>
        </div>
      </div>

      {/* Sorteer + refresh */}
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.8rem' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>Sorteer op</span>
        {SORTS.map(s => (
          <button key={s.key} onClick={() => setSort(s.key)} className="btn btn-sm"
            style={sort === s.key ? { background: 'var(--blue)', color: '#04121a', fontWeight: 700 } : undefined}>
            {s.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {feed?.bijgewerkt && (
          <span style={{ color: 'var(--text-dim)', fontSize: '.72rem' }}>
            bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <button className="btn btn-sm" onClick={() => void haal(me, true)} disabled={laden}>↻</button>
      </div>

      {!laden && !rows.length && (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-dim)' }}>
          Geen winstgevende blueprints binnen deze filters. Verlaag de min. marge of het volume.
        </div>
      )}

      {!!rows.length && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)' }}>
                {[['Product', 'left'], ['Bouwkosten', 'right'], ['Verkoop (Jita)', 'right'],
                  ['Winst/job', 'right'], ['Winst/stuk', 'right'], ['Marge', 'right'], ['Volume', 'right']].map(([h, al]) => (
                  <th key={h} style={{ padding: '.6rem .7rem', fontSize: '.64rem', fontWeight: 700,
                    letterSpacing: '.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    textAlign: al as 'left' | 'right', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.product_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '.4rem .7rem' }}>
                    <a href={`https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=${r.product_id}`}
                       onClick={e => e.preventDefault()} style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem',
                         color: 'inherit', textDecoration: 'none' }}>
                      <EveImage category="types" id={r.product_id} variation="icon" size={32} px={22} />
                      <span>{r.product}{r.output > 1 && <span style={{ color: 'var(--text-dim)' }}> ×{r.output}</span>}</span>
                    </a>
                  </td>
                  <td style={{ padding: '.4rem .7rem', textAlign: 'right' }}>
                    {fmtISK(r.matcost + r.jobfee)}
                    <div style={{ color: 'var(--text-dim)', fontSize: '.64rem' }}>mat {fmtISK(r.matcost)} · job {fmtISK(r.jobfee)}</div>
                  </td>
                  <td style={{ padding: '.4rem .7rem', textAlign: 'right', color: 'var(--gold)' }}>{fmtISK(r.sellval)}</td>
                  <td style={{ padding: '.4rem .7rem', textAlign: 'right', color: 'var(--green)', fontWeight: 700 }}>{fmtISK(r.profit)}</td>
                  <td style={{ padding: '.4rem .7rem', textAlign: 'right' }}>{fmtISK(r.per_unit)}</td>
                  <td style={{ padding: '.4rem .7rem', textAlign: 'right', color: 'var(--green)', fontWeight: 700 }}>+{r.margin}%</td>
                  <td style={{ padding: '.4rem .7rem', textAlign: 'right', color: 'var(--text-dim)' }}>{r.volume.toLocaleString('nl-NL')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ color: 'var(--text-dim)', fontSize: '.76rem', marginTop: '1rem' }}>
        Bouwkosten = materialen tegen Jita-verkoopprijs (met de gekozen ME) + geschatte job-kosten (EIV × {(0.08 * 100).toFixed(0)}%).
        Verkoop = Jita-verkoopprijs × aantal, minus ~3,6% verkoopkosten. Alleen blueprints waarvan de <strong>BPO op de
        markt te koop is</strong> (dus geen T2/invention en geen event-/faction-recepten). <strong>Let op:</strong> een grove
        indicatie — de marge hangt sterk af van je ME/TE en het bouwsysteem, en bij lage volumes kan één dure order de prijs
        vertekenen (filter op volume). Volume = orders op de Jita-markt (liquiditeit-hint). Prijzen 1 uur gecached; ↻ voor verse data.
      </p>
    </Layout>
  )
}
