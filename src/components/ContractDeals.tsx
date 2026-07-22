import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import EveImage from './EveImage'
import { usePageLoading } from '../hooks/usePageLoading'
import { useAuth } from '../auth/AuthContext'
import { getStructureName } from '../api/esi'

// Publieke item-exchange-contracten die onder de Jita-prijs staan ("koopjesjacht").
//
// De data komt van api/contractdeals.php: dat haalt de publieke contracten van
// The Forge op (geen token nodig), houdt alleen die in Jita 4-4 over en waardeert
// de inhoud tegen Jita. Omdat het er veel zijn wordt de nieuwste lading eerst
// gescand en groeit de dekking met elk bezoek — vandaar de voortgangsregel en de
// "automatisch scannen"-knop.
//
// Wat dit component er bovenop doet t.o.v. de kale feed:
//   1. Winst ná verkoopkosten (Jita-belasting + broker fee, instelbaar) — zodat
//      het winstcijfer klopt met wat je écht overhoudt.
//   2. Filters (min. winst / min. marge / dunne markt / bpc verbergen) zodat je
//      alleen echte koopjes ziet.
//   3. Automatisch doorscannen zolang de pagina open staat.

interface DealItem {
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
  waardeSell: number
  waardeBuy: number
  nettoSell: number
  nettoBuy: number
  marge: number | null
  items: DealItem[]
  aantalItems: number
  dunneMarkt: boolean
  heeftBpc: boolean
  prijsOnbekend: boolean
  verlooptOp: string
  uitgegeven: string
  locatieId: number
  locatie: string      // stationnaam; leeg bij een player-structure
  systeem: string      // solar system van dat station
  regioId: number
  regio: string
  issuerId: number     // de speler die het contract uitgaf
  issuer: string       // diens naam; leeg als (nog) niet opgelost
  issuerCorpId?: number
  issuerCorp?: string  // corpnaam; alleen ingevuld bij een corp-contract
  forCorp?: boolean
}

// Row + de client-side berekende winst ná verkoopkosten.
interface VRow extends Row {
  nettoNa: number       // winst na verkoopkosten (verkopen op de Jita-markt)
  margeNa: number | null
}

interface Feed {
  ok?: boolean
  regios?: string[]
  rows?: Row[]
  totalen?: {
    kandidaten: number
    gewaardeerd: number
    nog_te_gaan: number
    koopjes: number
    beste: number
    waarde: number
    vraagprijs: number
  }
  bijgewerkt?: string
}

type Sort = 'netto' | 'marge' | 'waarde' | 'prijs' | 'nieuw'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'netto',  label: 'Winst' },
  { key: 'marge',  label: 'Marge %' },
  { key: 'waarde', label: 'Marktwaarde' },
  { key: 'prijs',  label: 'Vraagprijs' },
  { key: 'nieuw',  label: 'Nieuwste' },
]

// Standaard-verkoopkosten: broker fee + verkoopbelasting samen. ~6% is realistisch
// voor gemiddelde skills; met Accounting/Broker Relations V en goede standings zakt
// dit richting ~3%. Instelbaar, want het bepaalt of een krappe marge nog winst is.
const STD_KOSTEN_PCT = 6

function fmtISK(v: number | null | undefined) {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)} bln`
  if (abs >= 1e9)  return `${(v / 1e9).toFixed(2)} mrd`
  if (abs >= 1e6)  return `${(v / 1e6).toFixed(2)} mln`
  if (abs >= 1e3)  return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}

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

export default function ContractDeals() {
  const { activeTokens: tokens } = useAuth()
  const [feed, setFeed] = useState<Feed | null>(null)
  // Player-structures kan de server niet opzoeken (dat vereist een token);
  // die vullen we hier aan met het token van de ingelogde gebruiker.
  const [structuren, setStructuren] = useState<Record<number, string>>({})
  const [laden, setLaden] = useState(true)
  const [fout, setFout] = useState('')
  const [sort, setSort] = useState<Sort>('netto')
  const [open, setOpen] = useState<number | null>(null)
  const [regio, setRegio] = useState('alles')
  const [hulpOpen, setHulpOpen] = useState(false)

  // --- instellingen (filters + verkoopkosten) --------------------------------
  const [kostenPct, setKostenPct]         = useState(STD_KOSTEN_PCT)
  const [minWinstMln, setMinWinstMln]     = useState(0)   // in miljoen ISK
  const [minMarge, setMinMarge]           = useState(0)   // in %
  const [verbergDun, setVerbergDun]       = useState(false)
  const [verbergBpc, setVerbergBpc]       = useState(false)
  const [verbergOnbekend, setVerbergOnbekend] = useState(false)

  // --- automatisch doorscannen -----------------------------------------------
  const [auto, setAuto] = useState(false)

  usePageLoading(laden)

  const haal = useCallback(async (ververs = false) => {
    setLaden(true)
    setFout('')
    try {
      const res = await fetch(`/api/contractdeals.php?action=list${ververs ? '&refresh=1' : ''}`)
      const data = await res.json() as Feed
      if (!res.ok) setFout('Ophalen mislukt.')
      else setFeed(data)
    } catch {
      setFout('Kon de contracten niet ophalen.')
    } finally {
      setLaden(false)
    }
  }, [])

  useEffect(() => { void haal() }, [haal])

  // Automatisch scannen: elke keer dat we ?action=list ophalen scant de server ook
  // ~60 nieuwe contracten, dus herhaald ophalen laat de dekking (en dus het aantal
  // koopjes) vanzelf groeien. We overlappen nooit twee verzoeken (guard op `laden`).
  const ladenRef = useRef(laden)
  ladenRef.current = laden
  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => { if (!ladenRef.current) void haal() }, 7000)
    return () => clearInterval(t)
  }, [auto, haal])

  useEffect(() => {
    const teOpen = [...new Set((feed?.rows ?? [])
      .filter(r => !r.locatie && r.locatieId > 2_147_483_647)
      .map(r => r.locatieId))]
    if (!teOpen.length || !tokens.length) return
    let afgebroken = false
    void Promise.all(teOpen.map(async id => {
      const naam = await getStructureName(id, tokens).catch(() => null)
      return [id, naam] as const
    })).then(paren => {
      if (afgebroken) return
      const nieuw: Record<number, string> = {}
      for (const [id, naam] of paren) if (naam) nieuw[id] = naam
      if (Object.keys(nieuw).length) setStructuren(prev => ({ ...prev, ...nieuw }))
    })
    return () => { afgebroken = true }
  }, [feed, tokens])

  // Verrijk elke rij met winst ná verkoopkosten, filter en sorteer.
  const rows = useMemo<VRow[]>(() => {
    const k = kostenPct / 100
    const verrijkt: VRow[] = (feed?.rows ?? []).map(r => {
      // Je koopt via het contract (geen kosten), maar bij het dóórverkopen op de
      // Jita-markt gaat er broker fee + verkoopbelasting af. Beloning (als het
      // contract jou ISK geeft) is netto.
      const nettoNa = r.waardeSell * (1 - k) + r.beloning - r.betaalt
      const margeNa = r.betaalt > 0 ? (nettoNa / r.betaalt) * 100 : null
      return { ...r, nettoNa, margeNa }
    })

    const gefilterd = verrijkt.filter(r =>
      (regio === 'alles' || r.regio === regio) &&
      r.nettoNa >= minWinstMln * 1e6 &&
      (r.margeNa ?? -Infinity) >= minMarge &&
      (!verbergDun || !r.dunneMarkt) &&
      (!verbergBpc || !r.heeftBpc) &&
      (!verbergOnbekend || !r.prijsOnbekend))

    gefilterd.sort((a, b) => {
      switch (sort) {
        case 'marge':  return (b.margeNa ?? -Infinity) - (a.margeNa ?? -Infinity)
        case 'waarde': return b.waardeSell - a.waardeSell
        case 'prijs':  return b.betaalt - a.betaalt
        case 'nieuw':  return new Date(b.uitgegeven).getTime() - new Date(a.uitgegeven).getTime()
        default:       return b.nettoNa - a.nettoNa
      }
    })
    return gefilterd
  }, [feed, sort, regio, kostenPct, minWinstMln, minMarge, verbergDun, verbergBpc, verbergOnbekend])

  // Statistieken op basis van wat er ná filteren overblijft, zodat de tegels met
  // je filters meebewegen.
  const stats = useMemo(() => {
    const beste = rows.reduce((m, r) => Math.max(m, r.nettoNa), 0)
    const totaalWinst = rows.reduce((s, r) => s + r.nettoNa, 0)
    const totaalWaarde = rows.reduce((s, r) => s + r.waardeSell, 0)
    return { aantal: rows.length, beste, totaalWinst, totaalWaarde }
  }, [rows])

  const t = feed?.totalen

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    flexWrap: 'wrap', gap: '.5rem', marginBottom: '.75rem' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: '.78rem' }}>
          {feed?.regios?.length
            ? `${feed.regios.join(' + ')} — publieke item exchange onder de Jita-prijs`
            : 'publieke item-exchange-contracten'}
        </span>
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setHulpOpen(o => !o)}>
            {hulpOpen ? '✕ uitleg' : '? hoe word ik rijk'}
          </button>
          {feed?.bijgewerkt && (
            <span style={{ color: 'var(--text-dim)', fontSize: '.72rem' }}>
              bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL',
                { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button className="btn btn-sm" onClick={() => void haal(true)} disabled={laden}>↻</button>
        </div>
      </div>

      {hulpOpen && <Uitleg />}

      {fout && <div className="card" style={{ padding: '1rem', color: 'var(--red)' }}>{fout}</div>}

      {t && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', marginBottom: '1rem' }}>
          <Stat label="Koopjes (na filters)" waarde={String(stats.aantal)} kleur="var(--green)" />
          <Stat label="Beste koopje" waarde={fmtISK(stats.beste)} kleur="var(--green)" />
          <Stat label="Totale winst hier" waarde={fmtISK(stats.totaalWinst)} kleur="var(--green)" />
          <Stat label="Gewaardeerd" waarde={`${t.gewaardeerd} / ${t.kandidaten}`} />
          <Stat label="Totale marktwaarde" waarde={fmtISK(stats.totaalWaarde)} kleur="var(--gold)" />
        </div>
      )}

      {/* Instellingen: verkoopkosten + filters + automatisch scannen. */}
      <div className="card" style={{ padding: '.7rem .9rem', marginBottom: '1rem',
                                     display: 'flex', flexWrap: 'wrap', gap: '1rem 1.4rem',
                                     alignItems: 'flex-end' }}>
        <Veld label="Verkoopkosten %"
              hint="Jita-belasting + broker fee die van je verkoopprijs af gaat">
          <input type="number" min={0} max={20} step={0.5} value={kostenPct}
                 onChange={e => setKostenPct(Math.max(0, Number(e.target.value) || 0))}
                 style={inputStyle} />
        </Veld>
        <Veld label="Min. winst (mln)" hint="Verberg koopjes met minder winst dan dit">
          <input type="number" min={0} step={10} value={minWinstMln}
                 onChange={e => setMinWinstMln(Math.max(0, Number(e.target.value) || 0))}
                 style={inputStyle} />
        </Veld>
        <Veld label="Min. marge %" hint="Verberg koopjes met een kleinere marge">
          <input type="number" min={0} step={1} value={minMarge}
                 onChange={e => setMinMarge(Math.max(0, Number(e.target.value) || 0))}
                 style={inputStyle} />
        </Veld>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
          <span style={{ fontSize: '.66rem', fontWeight: 700, letterSpacing: '.05em',
                         textTransform: 'uppercase', color: 'var(--text-dim)' }}>Verberg risico</span>
          <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
            <Toggle aan={verbergDun} zet={setVerbergDun} label="dunne markt" />
            <Toggle aan={verbergBpc} zet={setVerbergBpc} label="bpc" />
            <Toggle aan={verbergOnbekend} zet={setVerbergOnbekend} label="prijs?" />
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
          <span style={{ fontSize: '.66rem', fontWeight: 700, letterSpacing: '.05em',
                         textTransform: 'uppercase', color: 'var(--text-dim)' }}>Automatisch</span>
          <button
            onClick={() => setAuto(a => !a)}
            className="btn btn-sm"
            style={auto
              ? { background: 'var(--green)', color: '#04121a', fontWeight: 700 }
              : undefined}
          >{auto ? '● scant automatisch' : '▶ scan automatisch'}</button>
        </div>
      </div>

      {!!t?.nog_te_gaan && (
        <div className="card" style={{ padding: '.6rem .9rem', marginBottom: '1rem',
                                       fontSize: '.82rem', color: 'var(--text-dim)' }}>
          Nog {t.nog_te_gaan} contracten te scannen — de inhoud van een contract kost één
          losse ESI-call, dus dat gaat stapsgewijs. Zet <strong>automatisch scannen</strong> aan
          (of klik op ↻) om verder te scannen; wat al gescand is blijft bewaard.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', alignItems: 'center',
                    marginBottom: '.8rem' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>Sorteer op</span>
        {SORTS.map(s => (
          <button
            key={s.key}
            onClick={() => setSort(s.key)}
            className="btn btn-sm"
            style={sort === s.key
              ? { background: 'var(--blue)', color: '#04121a', fontWeight: 700 }
              : undefined}
          >{s.label}</button>
        ))}

        {(feed?.regios?.length ?? 0) > 1 && (
          <>
            <span style={{ color: 'var(--border)' }}>|</span>
            <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>Regio</span>
            {['alles', ...(feed?.regios ?? [])].map(rg => (
              <button
                key={rg}
                onClick={() => setRegio(rg)}
                className="btn btn-sm"
                style={regio === rg
                  ? { background: 'var(--blue)', color: '#04121a', fontWeight: 700 }
                  : undefined}
              >{rg === 'alles' ? 'Alles' : rg}</button>
            ))}
          </>
        )}
      </div>

      {!laden && !rows.length && (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-dim)' }}>
          Geen koopjes die aan je filters voldoen. Zet de filters ruimer, of klik op ↻ /
          zet automatisch scannen aan om meer contracten te scannen.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
        {rows.map(r => (
          <div
            key={r.id}
            className="card"
            onClick={() => setOpen(open === r.id ? null : r.id)}
            style={{ padding: '.7rem .9rem', cursor: 'pointer',
                     borderLeft: '3px solid var(--green)' }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.8rem',
                          alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 240, flex: '1 1 300px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem',
                              flexWrap: 'wrap', fontWeight: 600 }}>
                  {r.titel || <span style={{ color: 'var(--text-dim)' }}>zonder titel</span>}
                  {r.dunneMarkt    && <Badge kleur="amber" tekst="dunne markt" />}
                  {r.heeftBpc      && <Badge kleur="amber" tekst="bpc" />}
                  {r.prijsOnbekend && <Badge kleur="amber" tekst="prijs?" />}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem',
                              marginTop: '.25rem', fontSize: '.82rem' }}>
                  {r.items.slice(0, 3).map(i => (
                    <span key={i.typeId} style={{ display: 'inline-flex', alignItems: 'center', gap: '.25rem' }}>
                      <EveImage category="types" id={i.typeId} variation="icon" size={32} px={18} />
                      {i.aantal > 1 ? `${i.aantal.toLocaleString('nl-NL')}× ` : ''}{i.naam}
                    </span>
                  ))}
                  {r.aantalItems > 3 && (
                    <span style={{ color: 'var(--text-dim)' }}>+{r.aantalItems - 3} meer</span>
                  )}
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: '.76rem', marginTop: '.2rem' }}>
                  📍 <span style={{ color: 'var(--blue)' }}>{r.regio}</span>
                  {(() => {
                    const naam = r.locatie || structuren[r.locatieId] || ''
                    // Een locatienaam begint met het systeem; voor structures die
                    // we hier pas oplossen leiden we het systeem er zo ook uit af.
                    const systeem = r.systeem || naam.split(' ')[0]
                    return <>
                      {systeem && ` · ${systeem}`}
                      {' · '}{naam || `locatie #${r.locatieId}`}
                    </>
                  })()}
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: '.76rem' }}>
                  verloopt over {fmtVerloopt(r.verlooptOp)}
                  {r.volume > 0 && ` · ${r.volume.toLocaleString('nl-NL')} m³`}
                </div>
                {r.issuer && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.35rem',
                                marginTop: '.3rem', fontSize: '.78rem' }}>
                    <EveImage category="characters" id={r.issuerId} variation="portrait"
                              size={32} px={20} round />
                    <span style={{ color: 'var(--text-dim)' }}>van</span>
                    <span style={{ fontWeight: 600 }}>{r.issuer}</span>
                    {r.forCorp && r.issuerCorp && (
                      <span style={{ color: 'var(--text-dim)' }}>· namens {r.issuerCorp}</span>
                    )}
                    <CopyKnop tekst={r.issuer} />
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '1.2rem', textAlign: 'right' }}>
                <Cel label="Vraagprijs"  waarde={fmtISK(r.betaalt)} />
                <Cel label="Jita-waarde" waarde={fmtISK(r.waardeSell)} kleur="var(--gold)" />
                <Cel label="Winst na kosten" waarde={fmtISK(r.nettoNa)} kleur="var(--green)" groot />
                <Cel label="Marge"
                     waarde={r.margeNa === null ? '—' : `+${r.margeNa.toFixed(0)}%`}
                     kleur="var(--green)" />
              </div>
            </div>

            {open === r.id && (
              <div style={{ marginTop: '.7rem', paddingTop: '.7rem', borderTop: '1px solid var(--border)' }}>
                <table style={{ width: '100%', fontSize: '.82rem' }}>
                  <tbody>
                    {r.items.map(i => (
                      <tr key={i.typeId}>
                        <td style={{ padding: '.15rem 0' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
                            <EveImage category="types" id={i.typeId} variation="icon" size={32} px={20} />
                            {i.naam}{i.isBpc && <Badge kleur="amber" tekst="bpc" />}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>
                          {i.aantal.toLocaleString('nl-NL')}×
                        </td>
                        <td style={{ textAlign: 'right' }}>{fmtISK(i.waarde)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.aantalItems > r.items.length && (
                  <div style={{ color: 'var(--text-dim)', fontSize: '.78rem', marginTop: '.3rem' }}>
                    (alleen de {r.items.length} waardevolste van {r.aantalItems} items)
                  </div>
                )}
                <div style={{ color: 'var(--text-dim)', fontSize: '.78rem', marginTop: '.4rem' }}>
                  Bruto Jita-waarde {fmtISK(r.waardeSell)}, ná {kostenPct}% verkoopkosten houd je
                  ± {fmtISK(r.nettoNa)} over. Direct doorverkopen aan Jita-koop-orders (buy) levert
                  ± {fmtISK(r.nettoBuy)} op. Contract-id {r.id} — zoek 'm in-game via Contracts →
                  zoeken op de titel of de naam van de verkoper.
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <p style={{ color: 'var(--text-dim)', fontSize: '.78rem', marginTop: '1rem' }}>
        Alleen publieke item-exchange-contracten van 200 mln tot 50 mrd worden
        bekeken — daaronder zijn contracten vrijwel altijd blueprint-copies, die geen
        marktprijs hebben. Jita-waarde = de inhoud tegen de Jita-verkoopprijs; winst = die waarde
        (min de door jou ingestelde verkoopkosten) minus de vraagprijs. Blueprint-copies tellen als 0
        (hun typeprijs zegt niets over een kopie), en staat een verkoopprijs meer dan 10× boven het bod,
        dan waarderen we conservatief op de biedprijs — dat contract krijgt de melding <em>dunne markt</em>.
        Alle getoonde contracten liggen in <strong>Jita 4-4</strong>, dus je hoeft niets te verslepen.
      </p>
    </>
  )
}

const inputStyle: React.CSSProperties = {
  width: 90, padding: '.3rem .5rem', fontSize: '.85rem',
  background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 6,
}

// Kort, in gewone taal: hoe verdien je hier ISK mee.
function Uitleg() {
  const stap: React.CSSProperties = { margin: '.15rem 0' }
  return (
    <div className="card" style={{ padding: '1rem 1.1rem', marginBottom: '1rem', fontSize: '.85rem',
                                   lineHeight: 1.5, borderLeft: '3px solid var(--blue)' }}>
      <div style={{ fontWeight: 700, marginBottom: '.4rem', color: 'var(--blue)' }}>
        Zo word je hier rijk mee 💰
      </div>
      <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
        <li style={stap}>De scanner kijkt naar <strong>publieke contracten in Jita 4-4</strong>
          waarvan de spullen méér waard zijn dan de vraagprijs.</li>
        <li style={stap}>Zet <strong>automatisch scannen</strong> aan en laat de pagina open staan —
          hij haalt vanzelf nieuwe contracten binnen. Verse koopjes zie je bovenaan bij <em>Nieuwste</em>.</li>
        <li style={stap}>Zie je een dik koopje? Kopieer de naam van de verkoper (knop <em>⧉ kopieer</em>),
          zoek het contract in-game via <strong>Contracts</strong> en accepteer het.</li>
        <li style={stap}>Verkoop de spullen weer in Jita. <strong>Winst na kosten</strong> houdt al
          rekening met verkoopbelasting + broker fee (pas het % aan naar jouw skills).</li>
        <li style={stap}>Let op de gekleurde labels: <em>dunne markt</em> = weinig handel, prijs onzeker;
          <em> bpc</em> = er zit een blueprint-kopie in die als 0 telt; <em>prijs?</em> = niet alles
          heeft een marktprijs. Verberg ze met de <em>risico</em>-knoppen als je zeker wilt spelen.</li>
      </ol>
      <div style={{ marginTop: '.5rem', color: 'var(--text-dim)' }}>
        Tip: begin met <strong>Min. marge 15%</strong> en <em>dunne markt</em> verbergen — dan hou je
        alleen de betrouwbare koopjes over.
      </div>
    </div>
  )
}

function Veld({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }} title={hint}>
      <span style={{ fontSize: '.66rem', fontWeight: 700, letterSpacing: '.05em',
                     textTransform: 'uppercase', color: 'var(--text-dim)' }}>{label}</span>
      {children}
    </label>
  )
}

function Toggle({ aan, zet, label }: { aan: boolean; zet: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => zet(!aan)}
      className="btn btn-sm"
      style={aan
        ? { background: '#f0932b', color: '#1a1206', fontWeight: 700 }
        : undefined}
    >{aan ? '✓ ' : ''}{label}</button>
  )
}

function Stat({ label, waarde, kleur }: { label: string; waarde: string; kleur?: string }) {
  return (
    <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 140px', minWidth: 130 }}>
      <div style={{ fontSize: '.66rem', fontWeight: 700, letterSpacing: '.05em',
                    textTransform: 'uppercase', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: kleur }}>{waarde}</div>
    </div>
  )
}

function Cel({ label, waarde, kleur, groot }: {
  label: string; waarde: string; kleur?: string; groot?: boolean
}) {
  return (
    <div>
      <div style={{ fontSize: '.64rem', color: 'var(--text-dim)', textTransform: 'uppercase',
                    letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontWeight: 700, color: kleur, fontSize: groot ? '1.05rem' : '.92rem' }}>
        {waarde}
      </div>
    </div>
  )
}

function CopyKnop({ tekst }: { tekst: string }) {
  const [gekopieerd, setGekopieerd] = useState(false)
  const kopieer = (e: React.MouseEvent) => {
    e.stopPropagation()   // niet de kaart open/dicht klappen
    void navigator.clipboard?.writeText(tekst).then(() => {
      setGekopieerd(true)
      setTimeout(() => setGekopieerd(false), 1200)
    }).catch(() => {})
  }
  return (
    <button
      onClick={kopieer}
      title={`Naam "${tekst}" kopiëren`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '.2rem',
        padding: '.05rem .35rem', fontSize: '.68rem', lineHeight: 1.4,
        borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap',
        color: gekopieerd ? 'var(--green)' : 'var(--text-dim)',
        background: gekopieerd ? 'rgba(63,185,110,.12)' : 'rgba(255,255,255,.05)',
        border: `1px solid ${gekopieerd ? 'rgba(63,185,110,.5)' : 'var(--border)'}`,
      }}
    >{gekopieerd ? '✓ gekopieerd' : '⧉ kopieer'}</button>
  )
}

function Badge({ tekst, kleur }: { tekst: string; kleur: 'red' | 'amber' | 'dim' }) {
  const kleuren = {
    red:   { c: 'var(--red)',      bg: 'rgba(224,85,85,.15)',   b: 'rgba(224,85,85,.5)' },
    amber: { c: '#f0932b',         bg: 'rgba(240,147,43,.15)',  b: 'rgba(240,147,43,.5)' },
    dim:   { c: 'var(--text-dim)', bg: 'rgba(255,255,255,.05)', b: 'var(--border)' },
  }[kleur]
  return (
    <span style={{
      fontSize: '.62rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
      padding: '.08rem .4rem', borderRadius: 999, whiteSpace: 'nowrap',
      color: kleuren.c, background: kleuren.bg, border: `1px solid ${kleuren.b}`,
    }}>{tekst}</span>
  )
}
