import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

// Sovereignty Structures Timer voor één regio (default Cobalt Edge): welke
// IHUB/TCU kwetsbaar zijn / wanneer, met ADM en actieve aanvallen. Data uit
// api/sovtimer.php (publieke ESI, server-side gecached). Systemen linken naar
// een dotlan-route vanaf je ingevulde staging-systeem.

interface Row {
  structure_id: number
  type: string
  type_full: string
  system: string
  sec: number
  alliance_id: number | null
  alliance: string
  adm: number | null
  status: 'campaign' | 'vulnerable' | 'upcoming'
  when: string | null
  campaign: boolean
  defender: string
  defender_score: number | null
  attackers_score: number | null
}

interface Feed {
  ok?: boolean
  region?: string
  region_id?: number
  rows?: Row[]
  aantal?: number
  kwetsbaar_nu?: number
  onder_aanval?: number
  bijgewerkt?: string
}

type Filter = 'all' | 'vulnerable' | 'campaign'

function fmtWhen(iso: string | null, now: number) {
  if (!iso) return '—'
  const ms = Date.parse(iso) - now
  if (!isFinite(ms)) return '—'
  if (ms <= -60_000) return 'voorbij'
  if (ms <= 0) return 'nu'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}u`
  if (h) return `${h}u ${m}m`
  return `${m}m`
}

function secClass(sec: number) {
  return sec >= 0.5 ? '#5fd6a0' : sec > 0 ? 'var(--gold)' : 'var(--red)'
}

function admColor(adm: number) {
  return adm >= 5 ? 'var(--green)' : adm >= 3 ? 'var(--gold)' : 'var(--red)'
}

function routeUrl(system: string, from: string) {
  const to = encodeURIComponent(system)
  const f = from.trim()
  return f
    ? `https://evemaps.dotlan.net/route/${encodeURIComponent(f)}:${to}`
    : `https://evemaps.dotlan.net/system/${to}`
}

export default function SovTimer() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [laden, setLaden] = useState(true)
  const [fout, setFout] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [now, setNow] = useState(() => Date.now())
  const [from, setFrom] = useState(() => localStorage.getItem('sov_from') || '')

  usePageLoading(laden)

  const haal = useCallback(async (ververs = false) => {
    setLaden(true); setFout('')
    try {
      const res = await fetch(`/api/sovtimer.php?action=list${ververs ? '&refresh=1' : ''}`)
      const data = await res.json() as Feed
      if (!res.ok || !data.ok) setFout('Ophalen mislukt.')
      else setFeed(data)
    } catch {
      setFout('Kon de sovereignty-data niet ophalen.')
    } finally {
      setLaden(false)
    }
  }, [])

  useEffect(() => { void haal() }, [haal])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  useEffect(() => { localStorage.setItem('sov_from', from) }, [from])

  const rows = useMemo(() => {
    const r = feed?.rows ?? []
    if (filter === 'vulnerable') return r.filter(x => x.status === 'vulnerable' || x.status === 'campaign')
    if (filter === 'campaign') return r.filter(x => x.status === 'campaign')
    return r
  }, [feed, filter])

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'Alles' },
    { key: 'vulnerable', label: 'Kwetsbaar' },
    { key: 'campaign', label: 'Onder aanval' },
  ]

  return (
    <Layout header={
      <PageHeader
        title={feed?.region ? `Sov Timers — ${feed.region}` : 'Sov Timers'}
        sub="sovereignty-structuren & kwetsbaarheidstimers — live uit ESI"
      />
    }>
      {fout && <div className="card" style={{ padding: '1rem', color: 'var(--red)' }}>{fout}</div>}

      {/* Stats + acties */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', alignItems: 'stretch', marginBottom: '1rem' }}>
        <Stat label="Structuren" waarde={String(feed?.aantal ?? 0)} />
        <Stat label="Kwetsbaar nu" waarde={String(feed?.kwetsbaar_nu ?? 0)} kleur="var(--gold)" />
        <Stat label="Onder aanval" waarde={String(feed?.onder_aanval ?? 0)} kleur="var(--red)" />
        <div className="card" style={{ padding: '.55rem .8rem', flex: '2 1 240px', minWidth: 200,
                                       display: 'flex', flexDirection: 'column', gap: '.25rem', justifyContent: 'center' }}>
          <label style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                          textTransform: 'uppercase', color: 'var(--text-dim)' }}>Route vanaf (staging-systeem)</label>
          <input
            value={from}
            onChange={e => setFrom(e.target.value)}
            placeholder="bijv. je thuissysteem…"
            style={{ background: 'rgba(255,255,255,.05)', border: '1px solid var(--border)',
                     borderRadius: 6, color: 'inherit', padding: '.3rem .5rem', fontSize: '.85rem' }}
          />
        </div>
      </div>

      {/* Filters + refresh */}
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.8rem' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>Toon</span>
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} className="btn btn-sm"
            style={filter === f.key ? { background: 'var(--blue)', color: '#04121a', fontWeight: 700 } : undefined}>
            {f.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {feed?.bijgewerkt && (
          <span style={{ color: 'var(--text-dim)', fontSize: '.72rem' }}>
            bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <button className="btn btn-sm" onClick={() => void haal(true)} disabled={laden}>↻</button>
      </div>

      {!laden && !rows.length && (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-dim)' }}>
          Geen sov-structuren gevonden voor deze regio (of alles is rustig).
        </div>
      )}

      {!!rows.length && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                {['Status', 'Tijd', 'Systeem', 'Type', 'Eigenaar', 'ADM', 'Aanval'].map((h, i) => (
                  <th key={h} style={{ padding: '.6rem .7rem', fontSize: '.64rem', fontWeight: 700,
                                       letterSpacing: '.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                                       textAlign: i === 5 ? 'right' : 'left', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.structure_id} style={{
                  borderBottom: '1px solid var(--border)',
                  background: r.status === 'campaign' ? 'rgba(224,85,85,.06)'
                    : r.status === 'vulnerable' ? 'rgba(240,147,43,.05)' : undefined,
                }}>
                  <td style={{ padding: '.5rem .7rem' }}>
                    {r.status === 'campaign' ? <Badge tekst="ONDER AANVAL" kleur="red" />
                      : r.status === 'vulnerable' ? <Badge tekst="KWETSBAAR" kleur="amber" />
                      : <Badge tekst="veilig" kleur="dim" />}
                  </td>
                  <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtWhen(r.when, now)}</div>
                    <div style={{ color: 'var(--text-dim)', fontSize: '.66rem' }}>
                      {r.status === 'vulnerable' ? 'nog kwetsbaar' : r.status === 'campaign' ? 'node-start' : 'tot kwetsbaar'}
                    </div>
                  </td>
                  <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap' }}>
                    <span style={{ color: secClass(r.sec), fontWeight: 700, marginRight: '.35rem',
                                   fontVariantNumeric: 'tabular-nums' }}>{r.sec.toFixed(1)}</span>
                    <a href={routeUrl(r.system, from)} target="_blank" rel="noopener"
                       title={from.trim() ? `Route van ${from.trim()} naar ${r.system}` : `${r.system} op dotlan`}
                       style={{ color: 'var(--blue)', textDecoration: 'none' }}>{r.system}</a>
                  </td>
                  <td style={{ padding: '.5rem .7rem' }}>
                    <span title={r.type_full} style={{ fontSize: '.62rem', fontWeight: 800, padding: '.12rem .4rem',
                      borderRadius: 5, background: 'rgba(0,180,216,.12)', border: '1px solid rgba(0,180,216,.4)',
                      color: '#7fe0ff' }}>{r.type}</span>
                  </td>
                  <td style={{ padding: '.5rem .7rem' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
                      {r.alliance_id
                        ? <EveImage category="alliances" id={r.alliance_id} variation="logo" size={32} px={20} round />
                        : null}
                      <span>{r.alliance}</span>
                    </span>
                  </td>
                  <td style={{ padding: '.5rem .7rem', textAlign: 'right' }}>
                    {r.adm != null
                      ? <span style={{ fontWeight: 800, padding: '.1rem .45rem', borderRadius: 6,
                          color: admColor(r.adm), background: 'rgba(255,255,255,.05)',
                          fontVariantNumeric: 'tabular-nums' }}>{r.adm.toFixed(1)}</span>
                      : '—'}
                  </td>
                  <td style={{ padding: '.5rem .7rem' }}>
                    {r.campaign ? (
                      <>
                        <div title={`Verdediger ${r.defender_score}% · Aanvaller ${r.attackers_score}%`}
                             style={{ display: 'flex', width: 120, height: 8, borderRadius: 5, overflow: 'hidden',
                                      background: 'rgba(255,255,255,.06)' }}>
                          <span style={{ width: `${r.defender_score}%`, background: 'var(--green)' }} />
                          <span style={{ width: `${r.attackers_score}%`, background: 'var(--red)' }} />
                        </div>
                        <span style={{ color: 'var(--text-dim)', fontSize: '.66rem' }}>
                          {r.defender_score}% def · {r.attackers_score}% att
                        </span>
                      </>
                    ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ color: 'var(--text-dim)', fontSize: '.76rem', marginTop: '1rem' }}>
        Data uit de publieke ESI-endpoints <code>/sovereignty/structures</code> &amp; <code>/campaigns</code> (geen token).
        ADM = Activity Defense Multiplier (1–6): hoe hoger, hoe langer een IHUB standhoudt. Klik een systeem voor
        de dotlan-route vanaf je staging. Tijden zijn EVE-tijd (UTC).
      </p>
    </Layout>
  )
}

function Stat({ label, waarde, kleur }: { label: string; waarde: string; kleur?: string }) {
  return (
    <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 130px', minWidth: 110 }}>
      <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                    textTransform: 'uppercase', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 800, color: kleur }}>{waarde}</div>
    </div>
  )
}

function Badge({ tekst, kleur }: { tekst: string; kleur: 'red' | 'amber' | 'dim' }) {
  const k = {
    red:   { c: 'var(--red)',      bg: 'rgba(224,85,85,.14)',   b: 'rgba(224,85,85,.5)' },
    amber: { c: '#f0932b',         bg: 'rgba(240,147,43,.14)',  b: 'rgba(240,147,43,.5)' },
    dim:   { c: 'var(--text-dim)', bg: 'rgba(255,255,255,.05)', b: 'var(--border)' },
  }[kleur]
  return (
    <span style={{ fontSize: '.6rem', fontWeight: 800, letterSpacing: '.04em', padding: '.14rem .45rem',
                   borderRadius: 999, whiteSpace: 'nowrap', color: k.c, background: k.bg,
                   border: `1px solid ${k.b}` }}>{tekst}</span>
  )
}
