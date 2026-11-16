import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'
import WaarKaart from '../components/WaarKaart'
import { useAuth } from '../auth/AuthContext'
import { apiHeaders } from '../auth/apiToken'
import { usePageLoading } from '../hooks/usePageLoading'
import { useMemberSettings } from '../utils/memberSettings'
import { LOC_SCOPE } from '../hooks/useLocationReporter'
import { getRegions, getStationInfo, getStructureInfo, getSystems, resolveNames, tokenScopes } from '../api/esi'
import { secColor } from '../utils/secColor'

// Waar is iedereen: live overzicht van waar de corp-leden zitten, per systeem, plus een
// feed van de laatste sprongen. De posities komen van de leden zelf (useLocationReporter
// meldt ze vanuit hun browser), de server bewaart alleen de laatste stand.

interface Lid {
  character_id: number; name: string; solar_system_id: number
  station_id: number | null; structure_id: number | null
  ship_type_id: number | null; ship_name: string | null
  age: number; since_change: number
}
interface Beweging {
  character_id: number; name: string; from_system: number | null; to_system: number
  ship_type_id: number | null; at: string; age: number
}
interface Antwoord { ok: boolean; members: Lid[]; feed: Beweging[] }

const VERVERS_MS = 15_000
const ACTIEF_S   = 5 * 60   // korter dan 5 min geleden gemeld = actief (de rapporteur meldt minstens elke 2 min)

const LABEL: CSSProperties = { fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }
const KAART: CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }
const INPUT: CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none',
}

function fmtSec(s: number) {
  const v = s > 0 && s < 0.05 ? 0.1 : Math.round(s * 10) / 10
  return v.toFixed(1)
}
function geleden(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}u ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d`
}
function klok(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
}

export default function Waar() {
  const { tokens } = useAuth()
  const tokensRef = useRef(tokens); tokensRef.current = tokens
  const settings = useMemberSettings()

  const [data, setData] = useState<Antwoord | null>(null)
  const [fout, setFout] = useState<string | null>(null)
  const [opgehaald, setOpgehaald] = useState(0)        // Date.now() van de laatste succesvolle fetch
  const [nu, setNu] = useState(Date.now())
  const [filter, setFilter] = useState('')
  const [alleenActief, setAlleenActief] = useState(false)
  const [regioKeuze, setRegioKeuze] = useState<'auto' | number>('auto')   // kaart: automatisch = waar de meeste actieve leden zitten
  const [gekozenSysteem, setGekozenSysteem] = useState<number | null>(null)

  const [systemen, setSystemen] = useState<Record<string, [string, number, number]>>({})
  const [regios, setRegios] = useState<Record<string, string>>({})
  const [typeNamen, setTypeNamen] = useState<Map<number, string>>(new Map())
  const [plekNamen, setPlekNamen] = useState<Map<number, string>>(new Map())

  usePageLoading(data === null && fout === null)

  useEffect(() => {
    getSystems().then(setSystemen)
    getRegions().then(setRegios)
  }, [])

  // Ophalen + elke 15 s verversen.
  useEffect(() => {
    let weg = false
    async function laad() {
      try {
        const r = await fetch('/api/locations.php', { headers: apiHeaders() })
        if (!r.ok) throw new Error(r.status === 403 ? 'Geen toegang (log opnieuw in)' : `Server gaf ${r.status}`)
        const j = await r.json() as Antwoord
        if (weg) return
        setData(j); setFout(null); setOpgehaald(Date.now()); setNu(Date.now())
      } catch (e) {
        if (!weg) setFout(e instanceof Error ? e.message : 'Ophalen mislukt')
      }
    }
    laad()
    const id = setInterval(laad, VERVERS_MS)
    const tik = setInterval(() => setNu(Date.now()), 1000)
    return () => { weg = true; clearInterval(id); clearInterval(tik) }
  }, [])

  // Scheepstypes en dock-plekken bij naam.
  useEffect(() => {
    if (!data) return
    const tids = new Set<number>()
    for (const m of data.members) if (m.ship_type_id) tids.add(m.ship_type_id)
    for (const f of data.feed) if (f.ship_type_id) tids.add(f.ship_type_id)
    const nieuw = [...tids].filter(id => !typeNamen.has(id))
    if (nieuw.length) resolveNames(nieuw).then(m => setTypeNamen(prev => new Map([...prev, ...m])))

    for (const m of data.members) {
      const plek = m.station_id ?? m.structure_id
      if (!plek || plekNamen.has(plek)) continue
      const p = m.station_id
        ? getStationInfo(m.station_id).then(s => s?.name ?? null)
        : getStructureInfo(m.structure_id!, tokensRef.current).then(s => s?.name ?? null)
      p.then(naam => setPlekNamen(prev => { const n = new Map(prev); n.set(plek, naam ?? (m.station_id ? 'Station' : 'Structure')); return n }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Verstreken tijd sinds de server het zei + sinds wij het ophaalden.
  const extra = opgehaald ? Math.floor((nu - opgehaald) / 1000) : 0
  const leden = useMemo(() => (data?.members ?? []).map(m => ({ ...m, age: m.age + extra, since_change: m.since_change + extra })), [data, extra])

  const sysNaam = (id: number) => systemen[String(id)]?.[0] ?? `#${id}`
  const sysSec = (id: number) => systemen[String(id)]?.[1]
  const regioNaam = (id: number) => { const r = systemen[String(id)]?.[2]; return r ? (regios[String(r)] ?? '') : '' }

  // Kaart: regio's waar iemand zit (actieve leden tellen dubbel), standaard de drukste; anders Delve.
  const regioTelling = useMemo(() => {
    const t = new Map<number, number>()
    for (const m of leden) {
      const r = systemen[String(m.solar_system_id)]?.[2]; if (!r) continue
      t.set(r, (t.get(r) ?? 0) + (m.age <= ACTIEF_S ? 2 : 1))
    }
    return [...t.entries()].sort((a, b) => b[1] - a[1])
  }, [leden, systemen])
  const kaartRegio = regioKeuze === 'auto' ? (regioTelling[0]?.[0] ?? 10000060) : regioKeuze
  const kaartLeden = useMemo(() => leden.map(m => ({ character_id: m.character_id, name: m.name, solar_system_id: m.solar_system_id, actief: m.age <= ACTIEF_S })), [leden])

  const zoek = filter.trim().toLowerCase()
  const gefilterd = leden.filter(m => {
    if (gekozenSysteem && m.solar_system_id !== gekozenSysteem) return false
    if (alleenActief && m.age > ACTIEF_S) return false
    if (!zoek) return true
    const hooi = [m.name, sysNaam(m.solar_system_id), regioNaam(m.solar_system_id), m.ship_type_id ? typeNamen.get(m.ship_type_id) ?? '' : '', m.ship_name ?? ''].join(' ').toLowerCase()
    return hooi.includes(zoek)
  })

  // Groeperen per systeem: meeste piloten bovenaan, daarna het meest recent gemeld.
  const groepen = useMemo(() => {
    const map = new Map<number, typeof gefilterd>()
    for (const m of gefilterd) { const g = map.get(m.solar_system_id) ?? []; g.push(m); map.set(m.solar_system_id, g) }
    return [...map.entries()]
      .map(([sid, leden]) => ({ sid, leden: leden.sort((a, b) => a.age - b.age), jongste: Math.min(...leden.map(l => l.age)) }))
      .sort((a, b) => b.leden.length - a.leden.length || a.jongste - b.jongste)
  }, [gefilterd])

  const actief = leden.filter(m => m.age <= ACTIEF_S).length
  const aantalSystemen = new Set(leden.filter(m => m.age <= ACTIEF_S).map(m => m.solar_system_id)).size

  // Eigen login: zit het locatie-recht erin?
  const eigenZonderRecht = tokens.filter(t => !tokenScopes(t.accessToken).includes(LOC_SCOPE))
  const eigenIds = new Set(tokens.map(t => t.characterId))

  return (
    <Layout header={
      <PageHeader
        title="📍 Waar is iedereen"
        sub="Live: waar de leden van de corp nu zitten. Iedereen deelt zijn eigen positie vanuit het dashboard."
        right={
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'baseline', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
            <span><strong style={{ color: 'var(--green)', fontSize: '0.95rem' }}>{actief}</strong> actief</span>
            <span><strong style={{ color: 'var(--text)', fontSize: '0.95rem' }}>{aantalSystemen}</strong> systemen</span>
            <span><strong style={{ color: 'var(--text)', fontSize: '0.95rem' }}>{leden.length}</strong> gezien (24u)</span>
            {opgehaald > 0 && <span title="laatste verversing">↻ {geleden(extra)}</span>}
          </div>
        }
      />
    }>
      <div style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        {!settings.shareLocation && (
          <div style={{ ...KAART, padding: '0.5rem 0.8rem', fontSize: '0.7rem', borderColor: 'var(--gold)', color: 'var(--gold)' }}>
            Je deelt je eigen positie niet. Aanzetten kan bij <Link to="/settings" style={{ color: 'var(--blue)' }}>Instellingen → Locatie delen</Link>.
          </div>
        )}
        {settings.shareLocation && eigenZonderRecht.length > 0 && (
          <div style={{ ...KAART, padding: '0.5rem 0.8rem', fontSize: '0.7rem', borderColor: 'var(--gold)', color: 'var(--gold)' }}>
            ⚠ {eigenZonderRecht.map(t => t.characterName).join(', ')}: je login mist het locatie-recht, dus die positie wordt niet gedeeld. Log dat character opnieuw in.
          </div>
        )}
        {fout && (
          <div style={{ ...KAART, padding: '0.5rem 0.8rem', fontSize: '0.7rem', borderColor: 'var(--red)', color: 'var(--red)' }}>{fout}</div>
        )}

        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Zoek piloot, systeem, regio of schip…" style={{ ...INPUT, minWidth: 260 }} />
          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={alleenActief} onChange={e => setAlleenActief(e.target.checked)} />
            alleen actief (laatste 5 min)
          </label>
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
            Grijs = al even niets gehoord (dashboard dicht of offline). Ververst elke 15 s.
          </span>
        </div>

        {/* Regiokaart (stijl DL Intel) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={LABEL}>Kaart</span>
            <select value={regioKeuze} onChange={e => { setRegioKeuze(e.target.value === 'auto' ? 'auto' : Number(e.target.value)); setGekozenSysteem(null) }} style={{ ...INPUT, padding: '0.25rem 0.4rem' }} aria-label="Regio op de kaart">
              <option value="auto">Automatisch{regioTelling[0] ? ` (${regios[String(regioTelling[0][0])] ?? ''})` : ''}</option>
              {regioTelling.map(([rid]) => <option key={rid} value={rid}>{regios[String(rid)] ?? rid}</option>)}
              {!regioTelling.some(([rid]) => rid === 10000060) && <option value={10000060}>Delve</option>}
            </select>
            {gekozenSysteem && (
              <button onClick={() => setGekozenSysteem(null)} style={{ ...INPUT, cursor: 'pointer', fontSize: '0.66rem' }}>
                ✕ alleen {sysNaam(gekozenSysteem)}
              </button>
            )}
            <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>Klik op een systeem om de lijst daarop te zetten.</span>
          </div>
          <WaarKaart systemen={systemen} regios={regios} leden={kaartLeden} regioId={kaartRegio} gekozen={gekozenSysteem} onKies={setGekozenSysteem} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: '0.8rem', alignItems: 'start' }}>
          {/* Per systeem */}
          <div id="waar-lijst" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {data && groepen.length === 0 && (
              <div style={{ ...KAART, padding: '1.2rem', fontSize: '0.75rem', color: 'var(--text-dim)', textAlign: 'center' }}>
                {leden.length === 0
                  ? 'Nog niemand gezien. Zodra een lid het dashboard open heeft met het locatie-recht, verschijnt hij hier.'
                  : 'Niets gevonden met dit filter.'}
              </div>
            )}
            {groepen.map(g => {
              const regio = regioNaam(g.sid)
              const levend = g.leden.some(l => l.age <= ACTIEF_S)
              return (
                <div key={g.sid} style={{ ...KAART, opacity: levend ? 1 : 0.55 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', padding: '0.5rem 0.8rem', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>
                      <SolarSystem name={sysNaam(g.sid)} systemId={g.sid} fontSize="0.95rem" />
                    </span>
                    {regio && <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{regio}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                      {g.leden.length} {g.leden.length === 1 ? 'piloot' : 'piloten'}
                    </span>
                  </div>
                  <div>
                    {g.leden.map(m => {
                      const plek = m.station_id ?? m.structure_id
                      const plekNaam = plek ? plekNamen.get(plek) : null
                      const act = m.age <= ACTIEF_S
                      return (
                        <div key={m.character_id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.8rem', borderBottom: '1px solid rgba(28,28,53,0.5)', fontSize: '0.75rem', opacity: act ? 1 : 0.6 }}>
                          <EveImage category="characters" id={m.character_id} variation="portrait" size={64} px={26} round />
                          <span style={{ fontWeight: 600, minWidth: 150, color: eigenIds.has(m.character_id) ? 'var(--blue)' : 'var(--text)' }}>{m.name}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', minWidth: 180, color: 'var(--text-dim)' }}>
                            {m.ship_type_id ? (
                              <>
                                <EveImage category="types" id={m.ship_type_id} variation="icon" size={32} px={18} />
                                <span style={{ color: 'var(--text)' }}>{typeNamen.get(m.ship_type_id) ?? '…'}</span>
                                {m.ship_name && <span style={{ fontSize: '0.65rem' }}>“{m.ship_name}”</span>}
                              </>
                            ) : <span style={{ fontSize: '0.65rem' }}>schip onbekend</span>}
                          </span>
                          <span style={{ flex: 1, fontSize: '0.65rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {plek ? <>⚓ gedockt{plekNaam ? ` · ${plekNaam}` : ''}</> : <span style={{ color: 'var(--green)' }}>in de ruimte</span>}
                          </span>
                          <span title={`laatste melding ${geleden(m.age)} geleden; hier sinds ${geleden(m.since_change)}`}
                            style={{ fontSize: '0.62rem', fontVariantNumeric: 'tabular-nums', color: act ? 'var(--green)' : 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                            {act ? '●' : '○'} {geleden(m.age)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Bewegingen */}
          <div id="waar-feed" style={KAART}>
            <div style={{ padding: '0.5rem 0.8rem', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
              <span style={LABEL}>Bewegingen</span>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>laatste 24 uur</span>
            </div>
            <div style={{ maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
              {(data?.feed ?? []).length === 0 && (
                <div style={{ padding: '0.8rem', fontSize: '0.68rem', color: 'var(--text-dim)' }}>Nog geen sprongen gezien.</div>
              )}
              {(data?.feed ?? []).map((f, i) => {
                const vanSec = f.from_system ? sysSec(f.from_system) : undefined
                const naarSec = sysSec(f.to_system)
                return (
                  <div key={`${f.character_id}-${f.at}-${i}`} style={{ padding: '0.4rem 0.8rem', borderBottom: '1px solid rgba(28,28,53,0.5)', fontSize: '0.68rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-dim)', fontSize: '0.62rem' }}>{klok(f.at)}</span>
                      <span style={{ fontWeight: 600 }}>{f.name}</span>
                      {f.ship_type_id && <span style={{ color: 'var(--text-dim)', fontSize: '0.62rem' }}>{typeNamen.get(f.ship_type_id) ?? ''}</span>}
                    </div>
                    <div style={{ color: 'var(--text-dim)' }}>
                      {f.from_system ? (
                        <>
                          <span style={{ color: vanSec != null ? secColor(vanSec) : undefined }}>{vanSec != null ? fmtSec(vanSec) + ' ' : ''}</span>{sysNaam(f.from_system)}
                          {' → '}
                        </>
                      ) : 'gezien in '}
                      <span style={{ color: naarSec != null ? secColor(naarSec) : undefined, fontWeight: 700 }}>{naarSec != null ? fmtSec(naarSec) + ' ' : ''}</span>
                      <span style={{ color: 'var(--text)' }}>{sysNaam(f.to_system)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  )
}
