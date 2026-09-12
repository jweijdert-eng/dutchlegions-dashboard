import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'
import { useAuth } from '../auth/AuthContext'
import { getStructureInfo, openContractWindow } from '../api/esi'

// Mineralen kopen in de eigen ruimte: publieke item-exchange-contracten in Delve
// waar mineralen in zitten, vergeleken met de Jita-prijs. Zo zie je of het
// goedkoper is om lokaal te kopen dan zelf een sleep uit Jita te halen.
//
// De data komt van api/contractdeals.php?action=mineralen. Die kent de sov-kaart
// (welke systemen van onze alliantie zijn) en de NPC-stations; player-structures
// lost deze pagina zelf op met het token van de ingelogde gebruiker, want dat kan
// de server niet tokenloos. Elk verzoek scant ~60 nog onbekende contracten, dus
// de dekking groeit met "automatisch scannen" vanzelf naar 100%.

interface Mineraal {
  typeId: number
  naam: string
  aantal: number
  jitaSell: number
  jitaBuy: number
  waarde: number
}

interface Overig {
  typeId: number
  naam: string
  aantal: number
  isBpc: boolean
  waarde: number
}

interface Row {
  id: number
  titel: string
  prijs: number
  beloning: number
  betaalt: number
  volume: number
  waardeJita: number
  waardeMineralen: number
  korting: number | null     // % onder Jita-sell (negatief = duurder dan Jita)
  mineralen: Mineraal[]
  overig: Overig[]
  aantalOverig: number
  puur: boolean              // alleen mineralen, verder niets
  perStuk: number | null     // alleen bij één soort mineraal
  heeftInlever: boolean
  prijsOnbekend: boolean
  verlooptOp: string
  uitgegeven: string
  locatieId: number
  locatie: string            // stationnaam; leeg bij een player-structure
  systeem: string
  issuerId: number
  issuer: string
  issuerCorpId?: number
  issuerCorp?: string
  forCorp?: boolean
}

// Row + wat deze pagina er zelf bij weet (structure-naam, eigen systeem).
interface VRow extends Row {
  systeemNaam: string
  eigen: boolean
}

interface Feed {
  ok?: boolean
  regio?: string
  eigenSystemen?: Record<string, string>   // {systeemId: naam}
  rows?: Row[]
  totalen?: { kandidaten: number; gescand: number; nog_te_gaan: number; mineraal: number }
  bijgewerkt?: string
}

type Sort = 'korting' | 'prijs' | 'waarde' | 'nieuw'
const SORTS: { key: Sort; label: string }[] = [
  { key: 'korting', label: 'Korting' },
  { key: 'waarde',  label: 'Mineraalwaarde' },
  { key: 'prijs',   label: 'Prijs' },
  { key: 'nieuw',   label: 'Nieuwste' },
]

// Filters onthouden tussen bezoeken.
const LS_KEY = 'mineralen.v1'
function loadSettings(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}

// ── Stijl (zelfde look als de andere pagina's) ──
const INPUT: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none',
}
const BTN: React.CSSProperties = { ...INPUT, cursor: 'pointer' }
const LABEL: React.CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem',
}
const TH: React.CSSProperties = {
  textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.4rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }
const PANEL: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }

function fmtISK(v: number | null | undefined) {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)} mrd`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)} mln`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}
const fmtAantal = (n: number) => n.toLocaleString('nl-NL')
const fmtStuk   = (v: number) => v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function fmtVerloopt(iso: string) {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() - Date.now()
  if (!isFinite(ms)) return '—'
  if (ms <= 0) return 'verlopen'
  const dagen = Math.floor(ms / 86_400_000)
  if (dagen >= 1) return `${dagen} dg`
  const uren = Math.floor(ms / 3_600_000)
  return uren >= 1 ? `${uren} uur` : `${Math.floor(ms / 60_000)} min`
}

// Een EVE-locatienaam begint altijd met de systeemnaam ("1DQ1-A - ..."), en
// systeemnamen bevatten nooit een spatie.
const systeemUitNaam = (naam: string) => naam.split(' ')[0] ?? ''

async function openContract(id: number, token: string) {
  const ok = await openContractWindow(id, token)
  if (!ok) alert('Kon het contract niet openen. Log één keer opnieuw in (voor de nieuwe rechten) en zorg dat EVE draait.')
}

export default function Mineralen() {
  const { activeTokens: tokens } = useAuth()
  const saved = useMemo(loadSettings, [])
  const [feed, setFeed] = useState<Feed | null>(null)
  const [structuren, setStructuren] = useState<Record<number, { naam: string; systeemId: number }>>({})
  const [laden, setLaden] = useState(true)
  const [fout, setFout] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [hulpOpen, setHulpOpen] = useState(false)
  const [sort, setSort] = useState<Sort>((saved.sort as Sort) || 'korting')
  const [alleenEigen, setAlleenEigen] = useState(saved.alleenEigen !== false)
  const [alleenPuur, setAlleenPuur] = useState(saved.alleenPuur === true)
  const [alleenGoedkoper, setAlleenGoedkoper] = useState(saved.alleenGoedkoper === true)
  const [auto, setAuto] = useState(false)

  usePageLoading(laden)

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ sort, alleenEigen, alleenPuur, alleenGoedkoper }))
  }, [sort, alleenEigen, alleenPuur, alleenGoedkoper])

  const haal = useCallback(async (ververs = false) => {
    setLaden(true)
    setFout('')
    try {
      const res = await fetch(`/api/contractdeals.php?action=mineralen${ververs ? '&refresh=1' : ''}`)
      const data = await res.json() as Feed
      if (!res.ok || !data.ok) setFout('Ophalen mislukt.')
      else setFeed(data)
    } catch {
      setFout('Kon de contracten niet ophalen.')
    } finally {
      setLaden(false)
    }
  }, [])

  useEffect(() => { void haal() }, [haal])

  // Automatisch doorscannen: elk verzoek scant ~60 nieuwe contracten, dus
  // herhalen tot nog_te_gaan 0 is. Nooit twee verzoeken tegelijk.
  const ladenRef = useRef(laden)
  ladenRef.current = laden
  useEffect(() => {
    if (!auto) return
    if (feed?.totalen && feed.totalen.nog_te_gaan === 0) { setAuto(false); return }
    const t = setInterval(() => { if (!ladenRef.current) void haal() }, 5000)
    return () => clearInterval(t)
  }, [auto, haal, feed])

  // Player-structures opzoeken met het token van de gebruiker (naam + systeem).
  useEffect(() => {
    const teOpen = [...new Set((feed?.rows ?? [])
      .filter(r => !r.locatie && r.locatieId > 2_147_483_647 && !structuren[r.locatieId])
      .map(r => r.locatieId))]
    if (!teOpen.length || !tokens.length) return
    let afgebroken = false
    void Promise.all(teOpen.map(async id => {
      const info = await getStructureInfo(id, tokens).catch(() => null)
      return [id, info] as const
    })).then(paren => {
      if (afgebroken) return
      const nieuw: Record<number, { naam: string; systeemId: number }> = {}
      for (const [id, info] of paren) if (info?.name) nieuw[id] = { naam: info.name, systeemId: info.solar_system_id }
      if (Object.keys(nieuw).length) setStructuren(prev => ({ ...prev, ...nieuw }))
    })
    return () => { afgebroken = true }
  }, [feed, tokens, structuren])

  const eigen = feed?.eigenSystemen ?? {}
  const eigenNamen = useMemo(() => new Set(Object.values(eigen)), [eigen])

  const alle = useMemo<VRow[]>(() => (feed?.rows ?? []).map(r => {
    const s = structuren[r.locatieId]
    const systeemNaam = r.systeem || (s ? systeemUitNaam(s.naam) : '')
    const isEigen = (s?.systeemId ? !!eigen[String(s.systeemId)] : false) || eigenNamen.has(systeemNaam)
    return { ...r, systeemNaam, eigen: isEigen }
  }), [feed, structuren, eigen, eigenNamen])

  const rows = useMemo<VRow[]>(() => {
    const g = alle.filter(r =>
      (!alleenEigen || r.eigen) &&
      (!alleenPuur || r.puur) &&
      (!alleenGoedkoper || (r.korting ?? -Infinity) > 0))
    g.sort((a, b) => {
      switch (sort) {
        case 'waarde': return b.waardeMineralen - a.waardeMineralen
        case 'prijs':  return a.betaalt - b.betaalt
        case 'nieuw':  return new Date(b.uitgegeven).getTime() - new Date(a.uitgegeven).getTime()
        default:       return (b.korting ?? -Infinity) - (a.korting ?? -Infinity)
      }
    })
    return g
  }, [alle, alleenEigen, alleenPuur, alleenGoedkoper, sort])

  const stats = useMemo(() => ({
    totaal:      alle.length,
    inEigen:     alle.filter(r => r.eigen).length,
    onbekend:    alle.filter(r => !r.systeemNaam).length,
    beste:       rows.reduce((m, r) => Math.max(m, r.korting ?? -Infinity), -Infinity),
    mineraalWaarde: rows.reduce((s, r) => s + r.waardeMineralen, 0),
  }), [alle, rows])

  const t = feed?.totalen
  const token = tokens[0]?.accessToken
  const eigenLijst = Object.values(eigen)

  return (
    <Layout header={<PageHeader title="⛏️ Mineralen" sub="publieke contracten met mineralen in Delve, vergeleken met Jita — kopen zonder sleep" />}>
      {/* Balk: filters + sorteren + scannen */}
      <div style={{ ...PANEL, padding: '0.75rem 1rem', marginBottom: '0.75rem',
                    display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
        <div>
          <div style={LABEL}>TONEN</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <Toggle aan={alleenEigen} zet={setAlleenEigen} label={`alleen onze systemen${eigenLijst.length ? ` (${eigenLijst.length})` : ''}`} />
            <Toggle aan={alleenPuur} zet={setAlleenPuur} label="alleen puur mineralen" />
            <Toggle aan={alleenGoedkoper} zet={setAlleenGoedkoper} label="alleen goedkoper dan Jita" />
          </div>
        </div>
        <div>
          <div style={LABEL}>SORTEREN</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {SORTS.map(s => (
              <button key={s.key} onClick={() => setSort(s.key)}
                style={sort === s.key ? { ...BTN, borderColor: 'var(--blue)', color: 'var(--blue)', fontWeight: 700 } : BTN}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Toggle aan={auto} zet={setAuto} label={auto ? 'scant…' : 'automatisch scannen'} />
          <button onClick={() => void haal(true)} disabled={laden} style={BTN}>{laden ? 'bezig…' : '↻ verversen'}</button>
          <button onClick={() => setHulpOpen(o => !o)} style={BTN}>{hulpOpen ? '✕ uitleg' : '? uitleg'}</button>
        </div>
      </div>

      {hulpOpen && (
        <div style={{ ...PANEL, padding: '0.75rem 1rem', marginBottom: '0.75rem', fontSize: '0.78rem', lineHeight: 1.55, color: 'var(--text-dim)' }}>
          <p style={{ margin: '0 0 0.4rem' }}>
            <b style={{ color: 'var(--text)' }}>Wat je ziet.</b> Alle publieke item-exchange-contracten in Delve waar mineralen in zitten
            (Tritanium t/m Morphite). De <b>Jita-waarde</b> is wat dezelfde inhoud in Jita 4-4 kost (sell-orders).
            <b> Korting</b> is hoeveel procent je daaronder betaalt — rood betekent duurder dan Jita, maar dat kan nog
            steeds uit als je er een sleep mee uitspaart.
          </p>
          <p style={{ margin: '0 0 0.4rem' }}>
            <b style={{ color: 'var(--text)' }}>Onze systemen</b> zijn de systemen waar de alliantie sov heeft
            ({eigenLijst.length ? eigenLijst.join(', ') : 'nog niet geladen'}). Contracten in player-structures worden
            met je eigen token opgezocht; kan dat niet (geen docking-rechten), dan blijft het systeem leeg en valt
            het contract buiten "alleen onze systemen".
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--text)' }}>Dekking.</b> De inhoud van een contract kost één ESI-call, dus per verzoek
            worden er ~60 nieuwe gescand (nieuwste eerst). Zet "automatisch scannen" aan tot alles gescand is; daarna
            blijft de inhoud permanent bewaard en gaat het snel.
          </p>
        </div>
      )}

      {/* Tegels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginBottom: '0.75rem' }}>
        <Tegel label="Mineraalcontracten" waarde={String(stats.totaal)} sub={`${stats.inEigen} in onze systemen`} />
        <Tegel label="Getoond" waarde={String(rows.length)} sub={stats.onbekend ? `${stats.onbekend} op onbekende locatie` : 'alles herkend'} />
        <Tegel label="Beste korting" waarde={isFinite(stats.beste) ? `${stats.beste.toFixed(1)}%` : '—'}
               kleur={isFinite(stats.beste) ? (stats.beste > 0 ? 'var(--green)' : 'var(--red)') : undefined} sub="t.o.v. Jita sell" />
        <Tegel label="Mineraalwaarde" waarde={fmtISK(stats.mineraalWaarde)} sub="Jita-waarde van de getoonde rijen" />
        <Tegel label="Gescand" waarde={t ? `${t.gescand} / ${t.kandidaten}` : '—'}
               sub={t ? (t.nog_te_gaan ? `${t.nog_te_gaan} nog te gaan` : 'alles gescand') : 'contracten in Delve'}
               kleur={t && t.nog_te_gaan ? 'var(--gold)' : undefined} />
      </div>

      {fout && <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{fout}</div>}

      {/* Tabel */}
      <div style={{ ...PANEL, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--surface2)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>Systeem</th>
              <th style={{ ...TH, textAlign: 'left' }}>Mineralen</th>
              <th style={TH}>Jita-waarde</th>
              <th style={TH}>Prijs</th>
              <th style={TH}>Korting</th>
              <th style={TH}>Per stuk</th>
              <th style={TH}>Verloopt</th>
              <th style={{ ...TH, textAlign: 'left' }}>Uitgever</th>
              <th style={TH}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)', padding: '1.5rem' }}>
                {laden && !feed ? 'Laden…'
                  : alle.length === 0
                    ? (t && t.nog_te_gaan ? 'Nog geen mineraalcontracten gevonden — zet "automatisch scannen" aan.' : 'Geen mineraalcontracten in Delve op dit moment.')
                    : 'Niets over na filteren — zet "alleen onze systemen" of "alleen puur mineralen" uit.'}
              </td></tr>
            )}
            {rows.map(r => {
              const isOpen = open === r.id
              const kortingKleur = r.korting === null ? 'var(--text-dim)' : r.korting > 0 ? 'var(--green)' : 'var(--red)'
              const structuur = structuren[r.locatieId]
              const locatieNaam = r.locatie || structuur?.naam || (r.locatieId > 2_147_483_647 ? `structure ${r.locatieId}` : `station ${r.locatieId}`)
              return (
                <Fragment key={r.id}>
                  <tr onClick={() => setOpen(isOpen ? null : r.id)}
                      style={{ borderTop: '1px solid var(--border)', cursor: 'pointer',
                               background: isOpen ? 'var(--surface2)' : undefined }}>
                    <td style={{ ...TD, textAlign: 'left' }}>
                      <div style={{ fontWeight: 700, color: r.eigen ? 'var(--gold)' : 'var(--text)' }}>
                        {r.eigen ? '★ ' : ''}{r.systeemNaam || '?'}
                      </div>
                      <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={locatieNaam}>
                        {locatieNaam}
                      </div>
                    </td>
                    <td style={{ ...TD, textAlign: 'left', whiteSpace: 'normal', minWidth: 220 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                        {r.mineralen.map(m => (
                          <span key={m.typeId} title={`${fmtAantal(m.aantal)} × ${m.naam} · Jita ${fmtStuk(m.jitaSell)}`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem',
                                         background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.1rem 0.4rem' }}>
                            <EveImage category="types" id={m.typeId} variation="icon" size={32} px={14} />
                            {m.naam} <b>{fmtAantal(m.aantal)}</b>
                          </span>
                        ))}
                        {!r.puur && (
                          <span style={{ fontSize: '0.66rem', color: 'var(--gold)', alignSelf: 'center' }}>
                            +{r.aantalOverig} ander{r.aantalOverig === 1 ? '' : 'e'} item{r.aantalOverig === 1 ? '' : 's'}
                          </span>
                        )}
                        {r.heeftInlever && <span style={{ fontSize: '0.66rem', color: 'var(--red)', alignSelf: 'center' }}>inleveren vereist</span>}
                        {r.prijsOnbekend && <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)', alignSelf: 'center' }}>prijs?</span>}
                      </div>
                    </td>
                    <td style={TD}>{fmtISK(r.waardeJita)}</td>
                    <td style={{ ...TD, fontWeight: 700 }}>{fmtISK(r.betaalt)}</td>
                    <td style={{ ...TD, fontWeight: 700, color: kortingKleur }}>
                      {r.korting === null ? '—' : `${r.korting > 0 ? '−' : '+'}${Math.abs(r.korting).toFixed(1)}%`}
                    </td>
                    <td style={TD}>
                      {r.perStuk !== null && r.mineralen[0]
                        ? <span title={`Jita sell ${fmtStuk(r.mineralen[0].jitaSell)} · buy ${fmtStuk(r.mineralen[0].jitaBuy)}`}>
                            {fmtStuk(r.perStuk)} <span style={{ color: 'var(--text-dim)', fontSize: '0.68rem' }}>/ {fmtStuk(r.mineralen[0].jitaSell)}</span>
                          </span>
                        : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                    </td>
                    <td style={{ ...TD, color: 'var(--text-dim)' }}>{fmtVerloopt(r.verlooptOp)}</td>
                    <td style={{ ...TD, textAlign: 'left', color: 'var(--text-dim)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.forCorp && r.issuerCorp ? r.issuerCorp : (r.issuer || '—')}
                    </td>
                    <td style={TD}>
                      {token && (
                        <button onClick={e => { e.stopPropagation(); void openContract(r.id, token) }}
                                title="Open contract in de EVE-client" style={{ ...BTN, padding: '0.2rem 0.45rem' }}>▶</button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background: 'var(--surface2)' }}>
                      <td colSpan={9} style={{ padding: '0.5rem 0.9rem 0.7rem' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', fontSize: '0.74rem' }}>
                          <div>
                            <div style={LABEL}>INHOUD</div>
                            <table style={{ borderCollapse: 'collapse' }}>
                              <tbody>
                                {r.mineralen.map(m => (
                                  <tr key={`m${m.typeId}`}>
                                    <td style={{ padding: '0.15rem 0.6rem 0.15rem 0' }}>{m.naam}</td>
                                    <td style={{ padding: '0.15rem 0.6rem', textAlign: 'right' }}>{fmtAantal(m.aantal)}</td>
                                    <td style={{ padding: '0.15rem 0.6rem', textAlign: 'right', color: 'var(--text-dim)' }}>à {fmtStuk(m.jitaSell)}</td>
                                    <td style={{ padding: '0.15rem 0 0.15rem 0.6rem', textAlign: 'right' }}>{fmtISK(m.waarde)}</td>
                                  </tr>
                                ))}
                                {r.overig.map(o => (
                                  <tr key={`o${o.typeId}`} style={{ color: 'var(--text-dim)' }}>
                                    <td style={{ padding: '0.15rem 0.6rem 0.15rem 0' }}>{o.naam}{o.isBpc ? ' (BPC)' : ''}</td>
                                    <td style={{ padding: '0.15rem 0.6rem', textAlign: 'right' }}>{fmtAantal(o.aantal)}</td>
                                    <td></td>
                                    <td style={{ padding: '0.15rem 0 0.15rem 0.6rem', textAlign: 'right' }}>{fmtISK(o.waarde)}</td>
                                  </tr>
                                ))}
                                {r.aantalOverig > r.overig.length && (
                                  <tr style={{ color: 'var(--text-dim)' }}><td colSpan={4} style={{ padding: '0.15rem 0' }}>… en nog {r.aantalOverig - r.overig.length} items</td></tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                          <div style={{ color: 'var(--text-dim)', lineHeight: 1.7 }}>
                            <div style={LABEL}>CONTRACT</div>
                            {r.titel && <div>“{r.titel}”</div>}
                            <div>Vraagprijs {fmtISK(r.prijs)}{r.beloning > 0 ? ` · beloning ${fmtISK(r.beloning)}` : ''}</div>
                            <div>Volume {fmtAantal(Math.round(r.volume))} m³</div>
                            <div>Uitgegeven {new Date(r.uitgegeven).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                            <div>Door {r.issuer || '—'}{r.issuerCorp ? ` (${r.issuerCorp})` : ''}</div>
                            <div>Locatie {locatieNaam}</div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '0.5rem', fontSize: '0.68rem', color: 'var(--text-dim)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {feed?.bijgewerkt && <span>bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</span>}
        <span>Jita-waarde = sell-orders Jita 4-4 (Fuzzwork), prijzen max. 1 uur oud</span>
        {!tokens.length && <span style={{ color: 'var(--gold)' }}>niet ingelogd: structures kunnen niet opgezocht worden</span>}
      </div>
    </Layout>
  )
}

function Toggle({ aan, zet, label }: { aan: boolean; zet: (v: boolean) => void; label: string }) {
  return (
    <button onClick={() => zet(!aan)}
      style={aan ? { ...BTN, background: 'var(--gold)', color: '#1a1206', borderColor: 'var(--gold)', fontWeight: 700 } : BTN}>
      {aan ? '✓ ' : ''}{label}
    </button>
  )
}

function Tegel({ label, waarde, sub, kleur }: { label: string; waarde: string; sub?: string; kleur?: string }) {
  return (
    <div className="stat-card" style={{ ...PANEL, padding: '0.7rem 0.9rem', '--accent': kleur ?? 'var(--blue)' } as React.CSSProperties}>
      <div style={LABEL}>{label.toUpperCase()}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: kleur }}>{waarde}</div>
      {sub && <div style={{ fontSize: '0.64rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>{sub}</div>}
    </div>
  )
}
