import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import EveImage from './EveImage'
import type { TokenData } from '../auth/sso'
import { getRegionOrders, getStructureInfo, getStructureOrders, resolveNames, searchStructure,
         type PublicMarketOrder } from '../api/esi'

// Mineralen op de markt in de eigen ruimte, vergeleken met Jita.
//
// Nullsec-markten zitten in Upwell-structures en die zijn niet publiek: we
// zoeken ze op met het token van de gebruiker (structure-search per sov-systeem,
// alleen L/XL-types die een Market Hub kunnen dragen) en lezen dan het hele
// orderboek uit. Daarnaast de NPC-stations in Delve via de publieke regio-orders.
// Per mineraal tonen we de goedkoopste lokale sell-orders naast de Jita-prijs.

const DELVE = 10000060
const MINERALEN: Record<number, string> = {
  34: 'Tritanium', 35: 'Pyerite', 36: 'Mexallon', 37: 'Isogen',
  38: 'Nocxium', 39: 'Zydrine', 40: 'Megacyte', 11399: 'Morphite',
}
// Alleen structures waar een Standup Market Hub in past (L/XL): Fortizar (+faction),
// Keepstar (+Palatine), Azbel, Sotiyo, Tatara. Astrahus/Raitaru/Athanor kunnen dat niet.
const MARKT_TYPES = new Set([35833, 35834, 35826, 35827, 35836, 40340, 47512, 47513, 47514, 47515, 47516])
const CACHE_KEY = 'mineralen.markt.v1'
const CACHE_UREN = 24

interface Structuur { id: number; naam: string; systeemId: number; typeId: number }
interface Order { prijs: number; volume: number; locatieId: number; locatie: string; systeem: string; structure: boolean }
interface Rij { typeId: number; naam: string; jita: number; orders: Order[] }

const TH: React.CSSProperties = {
  textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.4rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }
const PANEL: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }
const BTN: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none', cursor: 'pointer',
}

const fmtStuk   = (v: number) => v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtAantal = (n: number) => n.toLocaleString('nl-NL')
const systeemUitNaam = (naam: string) => naam.split(' ')[0] ?? ''

function verschilPct(lokaal: number, jita: number) { return jita > 0 ? (lokaal - jita) / jita * 100 : null }
function verschilKleur(p: number | null) { return p === null ? 'var(--text-dim)' : p <= 0 ? 'var(--green)' : 'var(--red)' }
function fmtVerschil(p: number | null) { return p === null ? '—' : `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%` }

async function jitaPrijzen(): Promise<Map<number, number>> {
  const uit = new Map<number, number>()
  try {
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${Object.keys(MINERALEN).join(',')}`,
                          { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return uit
    const data = await r.json() as Record<string, { sell: { percentile: string } }>
    for (const [id, agg] of Object.entries(data)) uit.set(Number(id), Number(agg.sell?.percentile ?? 0))
  } catch { /* leeg: dan geen vergelijking */ }
  return uit
}

// Een handvol tegelijk, niet alle 24 systemen in één klap.
async function inPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const uit: R[] = []
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const t = items[i++]; uit.push(await fn(t)) }
  }))
  return uit
}

interface Cache { ts: number; chars: string; structuren: Structuur[]; forbidden: boolean }
function cacheLezen(chars: string): Cache | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Cache | null
    if (!c || c.chars !== chars || Date.now() - c.ts > CACHE_UREN * 3600e3) return null
    return c
  } catch { return null }
}

/**
 * Structures met een markt in onze sov-systemen, gezien door de ingelogde
 * characters. Duur (search per systeem + info per structure), dus 24 uur bewaard.
 */
async function vindStructuren(tokens: TokenData[], systemen: Record<string, string>): Promise<{ structuren: Structuur[]; forbidden: boolean }> {
  const chars = tokens.map(t => t.characterId).sort().join(',')
  const cache = cacheLezen(chars)
  if (cache) return { structuren: cache.structuren, forbidden: cache.forbidden }

  const eigenIds = new Set(Object.keys(systemen).map(Number))
  const ids = new Set<number>()
  let forbidden = false
  const t = tokens[0]
  await inPool(Object.values(systemen), 4, async naam => {
    const r = await searchStructure(t.characterId, t.accessToken, naam)
    if (r.forbidden) forbidden = true
    for (const id of r.ids) ids.add(id)
  })

  const structuren: Structuur[] = []
  await inPool([...ids], 6, async id => {
    const info = await getStructureInfo(id, tokens).catch(() => null)
    if (!info || !MARKT_TYPES.has(info.type_id) || !eigenIds.has(info.solar_system_id)) return
    structuren.push({ id, naam: info.name, systeemId: info.solar_system_id, typeId: info.type_id })
  })
  structuren.sort((a, b) => a.naam.localeCompare(b.naam))
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), chars, structuren, forbidden } satisfies Cache)) } catch { /* niets */ }
  return { structuren, forbidden }
}

async function structuurOrders(s: Structuur, tokens: TokenData[]): Promise<PublicMarketOrder[] | null> {
  // Niet elke character mag overal docken: probeer ze op volgorde.
  for (const t of tokens) {
    const orders = await getStructureOrders(s.id, t.accessToken).catch(() => [] as PublicMarketOrder[])
    if (orders.length) return orders
  }
  return null
}

export default function MineralenMarkt({ tokens, systemen }: { tokens: TokenData[]; systemen: Record<string, string> }) {
  const [laden, setLaden] = useState(false)
  const [status, setStatus] = useState('')
  const [rijen, setRijen] = useState<Rij[]>([])
  const [structuren, setStructuren] = useState<Structuur[]>([])
  const [zonderMarkt, setZonderMarkt] = useState<string[]>([])
  const [forbidden, setForbidden] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [bijgewerkt, setBijgewerkt] = useState<Date | null>(null)
  const [versie, setVersie] = useState(0)

  const systemenSleutel = Object.keys(systemen).join(',')
  const tokenSleutel = tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')

  const laad = useCallback(async (afgebroken: () => boolean) => {
    setLaden(true)
    setStatus('Jita-prijzen en Delve-stations ophalen…')
    const typeIds = Object.keys(MINERALEN).map(Number)

    const [jita, regioOrders] = await Promise.all([
      jitaPrijzen(),
      Promise.all(typeIds.map(tid => getRegionOrders(DELVE, tid).catch(() => [] as PublicMarketOrder[]))),
    ])
    if (afgebroken()) return
    const alleOrders: PublicMarketOrder[] = regioOrders.flat().filter(o => !o.is_buy_order)

    let gevonden: Structuur[] = []
    let metMarkt: Structuur[] = []
    let verboden = false
    if (tokens.length && Object.keys(systemen).length) {
      setStatus('Structures in onze systemen zoeken…')
      const r = await vindStructuren(tokens, systemen)
      if (afgebroken()) return
      gevonden = r.structuren
      verboden = r.forbidden
      setStatus(`Orderboeken van ${gevonden.length} structures lezen…`)
      await inPool(gevonden, 3, async s => {
        const orders = await structuurOrders(s, tokens)
        if (!orders) return
        metMarkt.push(s)
        for (const o of orders) if (!o.is_buy_order && MINERALEN[o.type_id]) alleOrders.push({ ...o, location_id: s.id })
      })
      if (afgebroken()) return
    }

    // Namen van NPC-stations (structures kennen we al).
    const stationIds = [...new Set(alleOrders.map(o => o.location_id).filter(id => id <= 2_147_483_647))]
    const namen = await resolveNames(stationIds).catch(() => new Map<number, string>())
    if (afgebroken()) return
    const structuurNaam = new Map(gevonden.map(s => [s.id, s.naam]))

    const perType = new Map<number, Order[]>()
    for (const o of alleOrders) {
      const isStructure = o.location_id > 2_147_483_647
      const locatie = isStructure ? (structuurNaam.get(o.location_id) ?? `structure ${o.location_id}`) : (namen.get(o.location_id) ?? `station ${o.location_id}`)
      const lijst = perType.get(o.type_id) ?? []
      lijst.push({ prijs: o.price, volume: o.volume_remain, locatieId: o.location_id, locatie, systeem: systeemUitNaam(locatie), structure: isStructure })
      perType.set(o.type_id, lijst)
    }
    metMarkt = metMarkt.sort((a, b) => a.naam.localeCompare(b.naam))
    setRijen(typeIds.map(tid => ({
      typeId: tid, naam: MINERALEN[tid], jita: jita.get(tid) ?? 0,
      orders: (perType.get(tid) ?? []).sort((a, b) => a.prijs - b.prijs),
    })))
    setStructuren(metMarkt)
    setZonderMarkt(gevonden.filter(s => !metMarkt.some(m => m.id === s.id)).map(s => s.naam))
    setForbidden(verboden)
    setBijgewerkt(new Date())
    setStatus('')
    setLaden(false)
  }, [tokens, systemen])

  useEffect(() => {
    let stop = false
    void laad(() => stop)
    return () => { stop = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenSleutel, systemenSleutel, versie])

  const goedkoper = useMemo(() => rijen.filter(r => r.orders[0] && r.jita > 0 && r.orders[0].prijs <= r.jita).length, [rijen])

  return (
    <div style={{ ...PANEL, marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>MARKT IN EIGEN RUIMTE</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
            {laden ? status : rijen.length
              ? `${goedkoper} van ${rijen.length} mineralen lokaal goedkoper dan (of gelijk aan) Jita · ${structuren.length} structure${structuren.length === 1 ? '' : 's'} met markt · NPC-stations in Delve`
              : 'sell-orders in onze structures en de Delve-stations, naast de Jita-prijs'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {bijgewerkt && <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{bijgewerkt.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</span>}
          <button style={BTN} disabled={laden} onClick={() => { try { localStorage.removeItem(CACHE_KEY) } catch { /* niets */ } setVersie(v => v + 1) }}>
            {laden ? 'bezig…' : '↻ markt verversen'}
          </button>
        </div>
      </div>

      {(forbidden || (!tokens.length) || (!laden && tokens.length > 0 && !structuren.length && rijen.length > 0)) && (
        <div style={{ padding: '0.4rem 0.9rem', fontSize: '0.7rem', color: 'var(--gold)', borderBottom: '1px solid var(--border)' }}>
          {!tokens.length ? 'Niet ingelogd: alleen de NPC-stations in Delve; structures vragen je token.'
            : forbidden ? 'Structure-zoeken geweigerd (403): log één keer opnieuw in voor de zoek-rechten.'
            : `Geen structure met markt gevonden in onze systemen${zonderMarkt.length ? ` (wel gevonden, maar zonder orders: ${zonderMarkt.join(', ')})` : ''}.`}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--surface2)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>Mineraal</th>
              <th style={TH}>Jita sell</th>
              <th style={TH}>Lokaal beste</th>
              <th style={TH}>Verschil</th>
              <th style={TH}>Volume</th>
              <th style={{ ...TH, textAlign: 'left' }}>Waar</th>
              <th style={TH}>Orders ≤ Jita</th>
            </tr>
          </thead>
          <tbody>
            {rijen.map(r => {
              const beste = r.orders[0]
              const pct = beste ? verschilPct(beste.prijs, r.jita) : null
              const onderJita = r.orders.filter(o => r.jita > 0 && o.prijs <= r.jita)
              const volumeOnderJita = onderJita.reduce((s, o) => s + o.volume, 0)
              const isOpen = open === r.typeId
              return (
                <Fragment key={r.typeId}>
                  <tr onClick={() => setOpen(isOpen ? null : r.typeId)}
                      style={{ borderTop: '1px solid var(--border)', cursor: r.orders.length ? 'pointer' : 'default', background: isOpen ? 'var(--surface2)' : undefined }}>
                    <td style={{ ...TD, textAlign: 'left' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontWeight: 700 }}>
                        <EveImage category="types" id={r.typeId} variation="icon" size={32} px={18} />{r.naam}
                      </span>
                    </td>
                    <td style={{ ...TD, color: 'var(--text-dim)' }}>{r.jita ? fmtStuk(r.jita) : '—'}</td>
                    <td style={{ ...TD, fontWeight: 700 }}>{beste ? fmtStuk(beste.prijs) : <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>geen aanbod</span>}</td>
                    <td style={{ ...TD, fontWeight: 700, color: verschilKleur(pct) }}>{fmtVerschil(pct)}</td>
                    <td style={TD}>{beste ? fmtAantal(beste.volume) : '—'}</td>
                    <td style={{ ...TD, textAlign: 'left', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={beste?.locatie}>
                      {beste ? <><b>{beste.systeem}</b> <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem' }}>{beste.locatie.slice(beste.systeem.length).replace(/^\s*-\s*/, '')}</span></> : '—'}
                    </td>
                    <td style={{ ...TD, color: onderJita.length ? 'var(--green)' : 'var(--text-dim)' }}>
                      {onderJita.length ? `${onderJita.length} · ${fmtAantal(volumeOnderJita)} st.` : '0'}
                    </td>
                  </tr>
                  {isOpen && r.orders.length > 0 && (
                    <tr style={{ background: 'var(--surface2)' }}>
                      <td colSpan={7} style={{ padding: '0.3rem 0.9rem 0.6rem' }}>
                        <table style={{ borderCollapse: 'collapse', fontSize: '0.74rem' }}>
                          <tbody>
                            {r.orders.slice(0, 12).map((o, i) => {
                              const p = verschilPct(o.prijs, r.jita)
                              return (
                                <tr key={i}>
                                  <td style={{ padding: '0.12rem 0.8rem 0.12rem 0', textAlign: 'right', fontWeight: 700 }}>{fmtStuk(o.prijs)}</td>
                                  <td style={{ padding: '0.12rem 0.8rem', textAlign: 'right', color: verschilKleur(p) }}>{fmtVerschil(p)}</td>
                                  <td style={{ padding: '0.12rem 0.8rem', textAlign: 'right' }}>{fmtAantal(o.volume)} st.</td>
                                  <td style={{ padding: '0.12rem 0', color: 'var(--text-dim)' }}>{o.locatie}{o.structure ? '' : ' (NPC)'}</td>
                                </tr>
                              )
                            })}
                            {r.orders.length > 12 && <tr><td colSpan={4} style={{ color: 'var(--text-dim)', padding: '0.12rem 0' }}>… en nog {r.orders.length - 12} orders</td></tr>}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {!rijen.length && (
              <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)', padding: '1rem' }}>{laden ? status || 'Laden…' : 'Geen marktdata.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {structuren.length > 0 && (
        <div style={{ padding: '0.35rem 0.9rem', fontSize: '0.66rem', color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>
          structures met markt: {structuren.map(s => s.naam).join(' · ')}
        </div>
      )}
    </div>
  )
}
