import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'
import { useAuth } from '../auth/AuthContext'
import { getContracts, getContractItems, getStructureInfo, openContractWindow, resolveNames,
         type Contract, type ContractItem } from '../api/esi'
import type { TokenData } from '../auth/sso'

// Mineralen kopen in de eigen ruimte: publieke item-exchange-contracten in Delve
// waar mineralen in zitten, vergeleken met de Jita-prijs. Zo zie je of het
// goedkoper is om lokaal te kopen dan zelf een sleep uit Jita te halen.
//
// De data komt van api/contractdeals.php?action=mineralen. Die kent de sov-kaart
// (welke systemen van onze alliantie zijn) en de NPC-stations; player-structures
// lost deze pagina zelf op met het token van de ingelogde gebruiker, want dat kan
// de server niet tokenloos. Elk verzoek scant ~60 nog onbekende contracten, dus
// de dekking groeit met "automatisch scannen" vanzelf naar 100%.
//
// Contracten die aan je corp of alliantie zijn toegewezen staan NIET in de
// publieke feed. Die haalt deze pagina zelf op uit de contractenlijst van je
// ingelogde characters (zij zien wat hun corp/alliantie ziet), waardeert ze op
// dezelfde manier tegen Jita en zet ze met een bron-label in dezelfde tabel.

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
  bron: Bron
}

type Bron = 'publiek' | 'corp' | 'alliantie' | 'persoonlijk'
const BRON_LABEL: Record<Bron, string> = { publiek: 'Publiek', corp: 'Corp', alliantie: 'Alliantie', persoonlijk: 'Persoonlijk' }
const BRON_KLEUR: Record<Bron, string> = { publiek: 'var(--text-dim)', corp: 'var(--blue)', alliantie: 'var(--green)', persoonlijk: 'var(--gold)' }

// Row + wat deze pagina er zelf bij weet (structure-naam, eigen systeem).
interface VRow extends Row {
  systeemNaam: string
  eigen: boolean
}

interface Feed {
  ok?: boolean
  regio?: string
  eigenSystemen?: Record<string, string>   // {systeemId: naam}
  rows?: Omit<Row, 'bron'>[]
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

// De acht mineralen (SDE-groep 18) — zelfde lijst als de server gebruikt.
const MINERALEN = new Set([34, 35, 36, 37, 38, 39, 40, 11399])

// Contract-inhoud verandert nooit; bewaren in localStorage zodat een herlaad
// geen ESI-call per contract kost. Sleutels van verlopen contracten ruimen we
// op zodra ze niet meer in de lijst staan.
const ITEMS_PREFIX = 'mineralen.items.'
function itemsUitCache(id: number): ContractItem[] | null {
  try { const r = localStorage.getItem(ITEMS_PREFIX + id); return r ? JSON.parse(r) as ContractItem[] : null } catch { return null }
}
function itemsNaarCache(id: number, items: ContractItem[]) {
  try { localStorage.setItem(ITEMS_PREFIX + id, JSON.stringify(items)) } catch { /* vol of geblokkeerd: dan gewoon opnieuw ophalen */ }
}
function ruimItemsCacheOp(bewaar: Set<number>) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(ITEMS_PREFIX) && !bewaar.has(Number(k.slice(ITEMS_PREFIX.length)))) localStorage.removeItem(k)
    }
  } catch { /* niets */ }
}

// Jita 4-4 sell/buy per type (Fuzzwork geeft strings terug).
async function jitaPrijzen(typeIds: number[]): Promise<Map<number, { sell: number; buy: number }>> {
  const uit = new Map<number, { sell: number; buy: number }>()
  const uniq = [...new Set(typeIds)]
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200)
    try {
      const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${chunk.join(',')}`,
                            { signal: AbortSignal.timeout(8000) })
      if (!r.ok) continue
      const data = await r.json() as Record<string, { sell: { percentile: string }; buy: { percentile: string } }>
      for (const [id, agg] of Object.entries(data)) {
        uit.set(Number(id), { sell: Number(agg.sell?.percentile ?? 0), buy: Number(agg.buy?.percentile ?? 0) })
      }
    } catch { /* volgende chunk */ }
  }
  return uit
}

/**
 * Corp-, alliantie- en persoonlijke contracten met mineralen, gezien door je
 * ingelogde characters. Zelfde waardering als de server: Jita-sell per item,
 * inleveritems tellen als kosten, beloning gaat van de prijs af.
 */
async function laadEigenContracten(tokens: TokenData[]): Promise<Row[]> {
  if (!tokens.length) return []
  const mijnIds = new Set(tokens.map(t => t.characterId))

  // Elke character ziet wat zijn corp/alliantie ziet; dubbele (zelfde corp) ontdubbelen.
  const gezien = new Map<number, { c: Contract; t: TokenData }>()
  await Promise.all(tokens.map(async t => {
    const cs = await getContracts(t.characterId, t.accessToken).catch(() => [] as Contract[])
    for (const c of cs) {
      if (c.type !== 'item_exchange' || c.status !== 'outstanding' || c.availability === 'public') continue
      if (mijnIds.has(c.issuer_id)) continue                      // je eigen aanbod
      if (new Date(c.date_expired).getTime() < Date.now()) continue
      if (!gezien.has(c.contract_id)) gezien.set(c.contract_id, { c, t })
    }
  }))
  ruimItemsCacheOp(new Set(gezien.keys()))
  if (!gezien.size) return []

  // Inhoud (uit cache, anders één ESI-call per contract) en meteen zeven op mineralen.
  const met: { c: Contract; t: TokenData; items: ContractItem[] }[] = []
  await Promise.all([...gezien.values()].map(async ({ c, t }) => {
    let items = itemsUitCache(c.contract_id)
    if (!items) {
      items = await getContractItems(t.characterId, c.contract_id, t.accessToken).catch(() => null)
      if (!items) return
      itemsNaarCache(c.contract_id, items)
    }
    if (items.some(i => i.is_included && MINERALEN.has(i.type_id))) met.push({ c, t, items })
  }))
  if (!met.length) return []

  const typeIds = met.flatMap(m => m.items.map(i => i.type_id))
  const naamIds = met.flatMap(m => [m.c.issuer_id, m.c.for_corporation ? (m.c.issuer_corporation_id ?? 0) : 0,
                                    (m.c.start_location_id ?? 0) <= 2_147_483_647 ? (m.c.start_location_id ?? 0) : 0])
  const [prijzen, namen] = await Promise.all([
    jitaPrijzen(typeIds),
    resolveNames([...typeIds, ...naamIds]).catch(() => new Map<number, string>()),
  ])

  return met.map(({ c, items }) => {
    let waardeJita = 0, waardeMineralen = 0, kostenGeef = 0
    let heeftInlever = false, prijsOnbekend = false
    const mineralen = new Map<number, Mineraal>()
    const overig: Overig[] = []
    for (const i of items) {
      const p = prijzen.get(i.type_id)
      // raw_quantity -1/-2 = singleton/BPC; een BPC is niet het originele blueprint.
      const isBpc = i.raw_quantity === -2
      const sell = isBpc ? 0 : (p?.sell ?? 0)
      if (!isBpc && !sell) prijsOnbekend = true
      if (!i.is_included) { kostenGeef += sell * i.quantity; heeftInlever = true; continue }
      waardeJita += sell * i.quantity
      if (MINERALEN.has(i.type_id)) {
        waardeMineralen += sell * i.quantity
        const m = mineralen.get(i.type_id)
        if (m) { m.aantal += i.quantity; m.waarde += sell * i.quantity }
        else mineralen.set(i.type_id, { typeId: i.type_id, naam: namen.get(i.type_id) ?? `#${i.type_id}`, aantal: i.quantity,
                                         jitaSell: sell, jitaBuy: p?.buy ?? 0, waarde: sell * i.quantity })
      } else {
        overig.push({ typeId: i.type_id, naam: namen.get(i.type_id) ?? `#${i.type_id}`, aantal: i.quantity, isBpc, waarde: sell * i.quantity })
      }
    }
    const mins = [...mineralen.values()].sort((a, b) => b.waarde - a.waarde)
    overig.sort((a, b) => b.waarde - a.waarde)
    const betaalt = c.price + kostenGeef - c.reward
    const puur = overig.length === 0
    const locId = c.start_location_id ?? 0
    const locatie = locId && locId <= 2_147_483_647 ? (namen.get(locId) ?? '') : ''
    const bron: Bron = c.availability === 'alliance' ? 'alliantie' : c.availability === 'corporation' ? 'corp' : 'persoonlijk'
    return {
      id: c.contract_id, titel: c.title ?? '', prijs: c.price, beloning: c.reward, betaalt, volume: c.volume ?? 0,
      waardeJita, waardeMineralen,
      korting: waardeJita > 0 ? (waardeJita - betaalt) / waardeJita * 100 : null,
      mineralen: mins, overig: overig.slice(0, 6), aantalOverig: overig.length, puur,
      perStuk: puur && mins.length === 1 && mins[0].aantal > 0 ? betaalt / mins[0].aantal : null,
      heeftInlever, prijsOnbekend,
      verlooptOp: c.date_expired, uitgegeven: c.date_issued,
      locatieId: locId, locatie, systeem: locatie ? systeemUitNaam(locatie) : '',
      issuerId: c.issuer_id, issuer: namen.get(c.issuer_id) ?? '',
      issuerCorpId: c.issuer_corporation_id,
      issuerCorp: c.for_corporation && c.issuer_corporation_id ? (namen.get(c.issuer_corporation_id) ?? '') : '',
      forCorp: c.for_corporation, bron,
    }
  })
}

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
  const [bronnen, setBronnen] = useState<Record<Bron, boolean>>({
    publiek: true, corp: true, alliantie: true, persoonlijk: true,
    ...((saved.bronnen as Partial<Record<Bron, boolean>>) ?? {}),
  })
  const [auto, setAuto] = useState(false)
  // Corp/alliantie-contracten via je eigen characters (los van de publieke feed).
  const [eigenRows, setEigenRows] = useState<Row[]>([])
  const [ladenEigen, setLadenEigen] = useState(false)
  const [foutEigen, setFoutEigen] = useState('')
  const [eigenVersie, setEigenVersie] = useState(0)   // ophogen = opnieuw ophalen

  usePageLoading(laden || ladenEigen)

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ sort, alleenEigen, alleenPuur, alleenGoedkoper, bronnen }))
  }, [sort, alleenEigen, alleenPuur, alleenGoedkoper, bronnen])

  const tokenSleutel = tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')
  useEffect(() => {
    if (!tokens.length) { setEigenRows([]); return }
    let afgebroken = false
    setLadenEigen(true)
    setFoutEigen('')
    laadEigenContracten(tokens)
      .then(rows => { if (!afgebroken) setEigenRows(rows) })
      .catch(() => { if (!afgebroken) setFoutEigen('Corp/alliantie-contracten ophalen mislukt.') })
      .finally(() => { if (!afgebroken) setLadenEigen(false) })
    return () => { afgebroken = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenSleutel, eigenVersie])

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
    const teOpen = [...new Set([...(feed?.rows ?? []), ...eigenRows]
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
  }, [feed, eigenRows, tokens, structuren])

  const eigen = feed?.eigenSystemen ?? {}
  const eigenNamen = useMemo(() => new Set(Object.values(eigen)), [eigen])

  // Publiek (server) + corp/alliantie (eigen characters) in één lijst. Staat een
  // contract in allebei, dan wint de eigen-versie (die weet de bron zeker).
  const alle = useMemo<VRow[]>(() => {
    const eigenIds = new Set(eigenRows.map(r => r.id))
    const samen: Row[] = [
      ...eigenRows,
      ...(feed?.rows ?? []).filter(r => !eigenIds.has(r.id)).map(r => ({ ...r, bron: 'publiek' as Bron })),
    ]
    return samen.map(r => {
      const s = structuren[r.locatieId]
      const systeemNaam = r.systeem || (s ? systeemUitNaam(s.naam) : '')
      const isEigen = (s?.systeemId ? !!eigen[String(s.systeemId)] : false) || eigenNamen.has(systeemNaam)
      return { ...r, systeemNaam, eigen: isEigen }
    })
  }, [feed, eigenRows, structuren, eigen, eigenNamen])

  const rows = useMemo<VRow[]>(() => {
    const g = alle.filter(r =>
      bronnen[r.bron] &&
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
  }, [alle, bronnen, alleenEigen, alleenPuur, alleenGoedkoper, sort])

  const stats = useMemo(() => ({
    totaal:      alle.length,
    publiek:     alle.filter(r => r.bron === 'publiek').length,
    inEigen:     alle.filter(r => r.eigen).length,
    onbekend:    alle.filter(r => !r.systeemNaam).length,
    beste:       rows.reduce((m, r) => Math.max(m, r.korting ?? -Infinity), -Infinity),
    mineraalWaarde: rows.reduce((s, r) => s + r.waardeMineralen, 0),
  }), [alle, rows])

  const t = feed?.totalen
  const token = tokens[0]?.accessToken
  const eigenLijst = Object.values(eigen)

  return (
    <Layout header={<PageHeader title="⛏️ Mineralen" sub="contracten met mineralen in Delve — publiek én corp/alliantie — vergeleken met Jita: kopen zonder sleep" />}>
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
          <div style={LABEL}>BRON</div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {(['publiek', 'corp', 'alliantie'] as Bron[]).map(b => (
              <Toggle key={b} aan={bronnen[b]} label={`${BRON_LABEL[b].toLowerCase()} (${alle.filter(r => r.bron === b || (b === 'corp' && r.bron === 'persoonlijk')).length})`}
                      zet={v => setBronnen(prev => ({ ...prev, [b]: v, ...(b === 'corp' ? { persoonlijk: v } : {}) }))} />
            ))}
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
          <button onClick={() => { void haal(true); setEigenVersie(v => v + 1) }} disabled={laden || ladenEigen} style={BTN}>{laden || ladenEigen ? 'bezig…' : '↻ verversen'}</button>
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
            <b style={{ color: 'var(--text)' }}>Bron.</b> "Publiek" komt uit de openbare contractmarkt (iedereen ziet die).
            "Corp" en "alliantie" zijn contracten die aan je corp of alliantie zijn toegewezen — die staan niet in de
            publieke lijst, maar je ingelogde characters zien ze wél; die halen we via hun eigen contractenlijst op.
            Je eigen aanbod wordt overgeslagen.
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
        <Tegel label="Mineraalcontracten" waarde={String(stats.totaal)} sub={`${stats.publiek} publiek · ${stats.totaal - stats.publiek} corp/alliantie · ${stats.inEigen} in onze systemen`} />
        <Tegel label="Getoond" waarde={String(rows.length)} sub={stats.onbekend ? `${stats.onbekend} op onbekende locatie` : 'alles herkend'} />
        <Tegel label="Beste korting" waarde={isFinite(stats.beste) ? `${stats.beste.toFixed(1)}%` : '—'}
               kleur={isFinite(stats.beste) ? (stats.beste > 0 ? 'var(--green)' : 'var(--red)') : undefined} sub="t.o.v. Jita sell" />
        <Tegel label="Mineraalwaarde" waarde={fmtISK(stats.mineraalWaarde)} sub="Jita-waarde van de getoonde rijen" />
        <Tegel label="Gescand" waarde={t ? `${t.gescand} / ${t.kandidaten}` : '—'}
               sub={t ? (t.nog_te_gaan ? `${t.nog_te_gaan} nog te gaan` : 'alles gescand') : 'contracten in Delve'}
               kleur={t && t.nog_te_gaan ? 'var(--gold)' : undefined} />
      </div>

      {(fout || foutEigen) && <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{[fout, foutEigen].filter(Boolean).join(' ')}</div>}

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
              <th style={{ ...TH, textAlign: 'left' }}>Bron</th>
              <th style={{ ...TH, textAlign: 'left' }}>Uitgever</th>
              <th style={TH}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={10} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)', padding: '1.5rem' }}>
                {(laden && !feed) || ladenEigen ? 'Laden…'
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
                    <td style={{ ...TD, textAlign: 'left' }}>
                      <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                                     color: BRON_KLEUR[r.bron], border: `1px solid ${BRON_KLEUR[r.bron]}`, borderRadius: 3, padding: '0.05rem 0.35rem' }}>
                        {BRON_LABEL[r.bron]}
                      </span>
                    </td>
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
                      <td colSpan={10} style={{ padding: '0.5rem 0.9rem 0.7rem' }}>
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
        {tokens.length
          ? <span>corp/alliantie via {tokens.length} character{tokens.length === 1 ? '' : 's'}{ladenEigen ? ' (ophalen…)' : ''}</span>
          : <span style={{ color: 'var(--gold)' }}>niet ingelogd: geen corp/alliantie-contracten en structures kunnen niet opgezocht worden</span>}
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
