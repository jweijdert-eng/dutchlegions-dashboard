import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { useAuth } from '../auth/AuthContext'
import { usePageLoading } from '../hooks/usePageLoading'

// Open item-exchange-contracten van de corp, met Jita-waardering.
//
// De data komt van api/corpcontracts.php en NIET rechtstreeks uit ESI: het
// corp-contracten-endpoint vereist de rol Director/Accountant. Eén director
// koppelt daar eenmalig zijn token; daarna kan elk lid dit bord bekijken.

interface ContractItem {
  typeId: number
  naam: string
  aantal: number
  isBpc: boolean
  waarde: number
}

interface Row {
  id: number
  titel: string
  uitgever: string
  prijs: number
  beloning: number
  betaalt: number
  waardeSell: number | null
  waardeBuy: number | null
  nettoSell: number | null
  nettoBuy: number | null
  marge: number | null
  items: ContractItem[]
  aantalItems: number
  onbekend: boolean
  leeg: boolean
  dunneMarkt: boolean
  heeftBpc: boolean
  prijsOnbekend: boolean
  verlooptOp: string
  locatieId: number
}

interface Feed {
  ok?: boolean
  error?: string
  corp?: { id: number; naam: string }
  rows?: Row[]
  totalen?: {
    aantal: number
    onbekend: number
    koopjes: number
    waarde: number
    vraagprijs: number
    netto: number
    beste: number
  }
  bijgewerkt?: string | null
  verouderd?: boolean
}

const ADMIN_CHAR_ID = 1831618559

type Sort = 'netto' | 'marge' | 'waarde' | 'prijs' | 'verloopt'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'netto',    label: 'Winst' },
  { key: 'marge',    label: 'Marge %' },
  { key: 'waarde',   label: 'Marktwaarde' },
  { key: 'prijs',    label: 'Vraagprijs' },
  { key: 'verloopt', label: 'Verloopt' },
]

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

export default function CorpContracts() {
  const { tokens, mainCharId } = useAuth()
  const [feed, setFeed] = useState<Feed | null>(null)
  const [laden, setLaden] = useState(true)
  const [fout, setFout] = useState('')
  const [sort, setSort] = useState<Sort>('netto')
  const [alleenKoopjes, setAlleenKoopjes] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [koppelen, setKoppelen] = useState(false)

  usePageLoading(laden)

  const haal = useCallback(async (ververs = false) => {
    setLaden(true)
    setFout('')
    try {
      const res = await fetch(`/api/corpcontracts.php?action=list${ververs ? '&refresh=1' : ''}`)
      const data = await res.json() as Feed
      if (!res.ok && !data.rows) {
        setFout(data.error === 'no_token'
          ? 'no_token'
          : `Ophalen mislukt (${data.error ?? res.status})`)
        setFeed(null)
      } else {
        setFeed(data)
      }
    } catch {
      setFout('Kon de corp-contracten niet ophalen.')
    } finally {
      setLaden(false)
    }
  }, [])

  useEffect(() => { void haal() }, [haal])

  // Eenmalige koppeling door een director (alleen zichtbaar voor de admin).
  const koppelToken = async () => {
    const token = tokens.find(t => t.characterId === mainCharId) ?? tokens[0]
    if (!token) return
    setKoppelen(true)
    try {
      const res = await fetch('/api/corpcontracts.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.accessToken,
          refreshToken: token.refreshToken,
          charId: token.characterId,
          charName: token.characterName,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        alert(`Koppelen mislukt: ${data.error ?? res.status}\n${data.hint ?? ''}`)
      } else {
        await haal(true)
      }
    } finally {
      setKoppelen(false)
    }
  }

  const rows = useMemo(() => {
    let r = feed?.rows ?? []
    if (alleenKoopjes) r = r.filter(x => !x.onbekend && (x.nettoSell ?? 0) > 0)
    const gesorteerd = [...r].sort((a, b) => {
      if (a.onbekend !== b.onbekend) return a.onbekend ? 1 : -1
      switch (sort) {
        case 'marge':    return (b.marge ?? -Infinity) - (a.marge ?? -Infinity)
        case 'waarde':   return (b.waardeSell ?? 0) - (a.waardeSell ?? 0)
        case 'prijs':    return b.betaalt - a.betaalt
        case 'verloopt': return (new Date(a.verlooptOp).getTime() || Infinity)
                              - (new Date(b.verlooptOp).getTime() || Infinity)
        default:         return (b.nettoSell ?? -Infinity) - (a.nettoSell ?? -Infinity)
      }
    })
    return gesorteerd
  }, [feed, sort, alleenKoopjes])

  const t = feed?.totalen
  const isAdmin = tokens.some(x => x.characterId === ADMIN_CHAR_ID)

  if (fout === 'no_token') {
    return (
      <Layout header={<PageHeader title="Corp Contracten" sub="open contracten van de corp" />}>
        <div className="card" style={{ padding: '1.5rem', maxWidth: 640 }}>
          <h3 style={{ marginTop: 0 }}>Nog niet gekoppeld</h3>
          <p style={{ color: 'var(--text-dim)' }}>
            Om de corp-contracten te kunnen tonen moet één keer een character met de rol{' '}
            <strong>Director</strong> of <strong>Accountant</strong> gekoppeld worden. Daarna
            ziet iedereen de contracten, zonder zelf rechten nodig te hebben.
          </p>
          {isAdmin ? (
            <button className="btn" onClick={koppelToken} disabled={koppelen}>
              {koppelen ? 'Bezig…' : 'Mijn token koppelen'}
            </button>
          ) : (
            <p style={{ color: 'var(--text-dim)', fontSize: '.85rem' }}>
              Vraag een director om dit in te stellen.
            </p>
          )}
        </div>
      </Layout>
    )
  }

  return (
    <Layout header={
      <PageHeader
        title="Corp Contracten"
        sub={feed?.corp ? `${feed.corp.naam} — open item exchange` : 'open contracten van de corp'}
        right={
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            {feed?.bijgewerkt && (
              <span style={{ color: 'var(--text-dim)', fontSize: '.78rem' }}>
                bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL',
                  { hour: '2-digit', minute: '2-digit' })}
                {feed.verouderd ? ' (verouderd)' : ''}
              </span>
            )}
            <button className="btn btn-sm" onClick={() => void haal(true)} disabled={laden}>↻</button>
          </div>
        }
      />
    }>
      {fout && <div className="card" style={{ padding: '1rem', color: 'var(--red)' }}>{fout}</div>}

      {t && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', marginBottom: '1rem' }}>
          <Stat label="Open contracten" waarde={String(t.aantal)} />
          <Stat label="Onder Jita-prijs" waarde={String(t.koopjes)} kleur="var(--green)" />
          <Stat label="Beste koopje" waarde={fmtISK(t.beste)} kleur="var(--green)" />
          <Stat label="Totale marktwaarde" waarde={fmtISK(t.waarde)} kleur="var(--gold)" />
          <Stat label="Totale vraagprijs" waarde={fmtISK(t.vraagprijs)} />
        </div>
      )}

      {!!t?.onbekend && (
        <div className="card" style={{ padding: '.6rem .9rem', marginBottom: '1rem',
                                       fontSize: '.82rem', color: 'var(--text-dim)' }}>
          Van {t.onbekend} contracten is de inhoud nog niet opgehaald — die staan onderaan zonder
          waardering en tellen niet mee in de totalen. Ze worden bij de volgende verversingen
          vanzelf aangevuld.
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
        <label style={{ marginLeft: '.6rem', fontSize: '.82rem', display: 'flex',
                        alignItems: 'center', gap: '.35rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={alleenKoopjes}
                 onChange={e => setAlleenKoopjes(e.target.checked)} />
          alleen koopjes
        </label>
      </div>

      {!laden && !rows.length && (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-dim)' }}>
          Geen open item-exchange-contracten gevonden.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
        {rows.map(r => {
          const winst = (r.nettoSell ?? 0) > 0
          return (
            <div
              key={r.id}
              className="card"
              onClick={() => setOpen(open === r.id ? null : r.id)}
              style={{
                padding: '.7rem .9rem', cursor: 'pointer',
                borderLeft: `3px solid ${r.onbekend ? 'var(--border)'
                  : winst ? 'var(--green)' : 'var(--red)'}`,
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.8rem',
                            alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ minWidth: 240, flex: '1 1 300px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem',
                                flexWrap: 'wrap', fontWeight: 600 }}>
                    {r.titel || <span style={{ color: 'var(--text-dim)' }}>zonder titel</span>}
                    {r.onbekend    && <Badge kleur="dim"   tekst="inhoud onbekend" />}
                    {r.leeg        && <Badge kleur="red"   tekst="leeg" />}
                    {r.dunneMarkt  && <Badge kleur="amber" tekst="dunne markt" />}
                    {r.heeftBpc    && <Badge kleur="amber" tekst="bpc" />}
                    {r.prijsOnbekend && <Badge kleur="amber" tekst="prijs?" />}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem',
                                marginTop: '.25rem', fontSize: '.82rem' }}>
                    {r.items.slice(0, 3).map(i => (
                      <span key={i.typeId} style={{ display: 'inline-flex', alignItems: 'center',
                                                    gap: '.25rem' }}>
                        <EveImage category="types" id={i.typeId} variation="icon" size={32} px={18} />
                        {i.aantal > 1 ? `${i.aantal.toLocaleString('nl-NL')}× ` : ''}{i.naam}
                      </span>
                    ))}
                    {r.aantalItems > 3 && (
                      <span style={{ color: 'var(--text-dim)' }}>+{r.aantalItems - 3} meer</span>
                    )}
                  </div>
                  {r.uitgever && (
                    <div style={{ color: 'var(--text-dim)', fontSize: '.76rem', marginTop: '.2rem' }}>
                      van {r.uitgever} · verloopt over {fmtVerloopt(r.verlooptOp)}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '1.2rem', textAlign: 'right' }}>
                  <Cel label="Vraagprijs" waarde={fmtISK(r.betaalt)} />
                  <Cel label="Jita-waarde" waarde={r.onbekend ? '?' : fmtISK(r.waardeSell)}
                       kleur="var(--gold)" />
                  <Cel
                    label="Winst"
                    waarde={r.onbekend ? '?' : fmtISK(r.nettoSell)}
                    kleur={r.onbekend ? undefined : winst ? 'var(--green)' : 'var(--red)'}
                    groot
                  />
                  <Cel
                    label="Marge"
                    waarde={r.marge === null ? '—' : `${r.marge > 0 ? '+' : ''}${r.marge.toFixed(0)}%`}
                    kleur={r.onbekend ? undefined : winst ? 'var(--green)' : 'var(--red)'}
                  />
                </div>
              </div>

              {open === r.id && !r.onbekend && (
                <div style={{ marginTop: '.7rem', paddingTop: '.7rem',
                              borderTop: '1px solid var(--border)' }}>
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
                    Direct doorverkopen aan Jita-koop-orders levert {fmtISK(r.nettoBuy)} op.
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p style={{ color: 'var(--text-dim)', fontSize: '.78rem', marginTop: '1rem' }}>
        Jita-waarde = de inhoud tegen de Jita-verkoopprijs. Winst = die waarde minus de
        vraagprijs. Staat er een verkoopprijs meer dan 10× boven het bod (of is er nauwelijks
        aanbod), dan is die niet te vertrouwen en waarderen we conservatief op de biedprijs —
        dat contract krijgt dan de melding <em>dunne markt</em>.
      </p>
    </Layout>
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

function Badge({ tekst, kleur }: { tekst: string; kleur: 'red' | 'amber' | 'dim' }) {
  const kleuren = {
    red:   { c: 'var(--red)',      bg: 'rgba(224,85,85,.15)',  b: 'rgba(224,85,85,.5)' },
    amber: { c: '#f0932b',         bg: 'rgba(240,147,43,.15)', b: 'rgba(240,147,43,.5)' },
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
