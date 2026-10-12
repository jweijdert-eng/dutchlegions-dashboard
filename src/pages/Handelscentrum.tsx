import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getMarketOrders, getTransactions, getRegionOrders, getStructureOrders, getWalletJournal, getWallet,
  getStationInfo, getStructureName, resolveNames, type MarketOrder, type PublicMarketOrder, type WalletTransaction,
} from '../api/esi'
import { loadPositions, loadHidden, loadOverrides } from '../utils/jitaPositions'
import {
  bewaarKosten, bewaarTx, bewaardSinds, DAG, fifo, HUBS, hubKey, hubVan, isCitadel, JITA, leesAlles, PRESETS, uitlegHub,
} from '../utils/handel'
import { KNOP, type EigenOrder, type Gegevens, type OrderStatus, type PositieLive } from '../components/handel/delen'
import Overzicht from '../components/handel/Overzicht'
import Statistiek from '../components/handel/Statistiek'
import Kansen from '../components/handel/Kansen'
import Logboek from '../components/handel/Logboek'
import ItemDetail from '../components/handel/ItemDetail'

// Handelscentrum: al je handel op één pagina, met tabbladen voor overzicht,
// statistiek, kansen en het logboek, over alle hubs en citadels heen. Je
// transacties en betaalde kosten worden in deze browser bewaard (ESI geeft er
// maar 30 dagen van), zodat je geschiedenis groeit zolang je kijkt.
type Tab = 'overzicht' | 'statistiek' | 'kansen' | 'logboek'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overzicht', label: '🧭 Overzicht' }, { key: 'statistiek', label: '📊 Statistiek' },
  { key: 'kansen', label: '🔎 Kansen' }, { key: 'logboek', label: '📒 Logboek' },
]
const HUB_OPTIES = [{ key: 'alle', label: 'Alle hubs' }, ...HUBS.map(h => ({ key: h.key, label: h.naam })), { key: 'overig', label: 'Overig' }]

function bewaard<T extends string>(sleutel: string, geldig: readonly T[], standaard: T): T {
  try { const v = localStorage.getItem(sleutel) as T | null; if (v && geldig.includes(v)) return v } catch { /* geblokkeerd */ }
  return standaard
}
function onthoud(sleutel: string, waarde: string) { try { localStorage.setItem(sleutel, waarde) } catch { /* niet erg */ } }

export default function Handelscentrum() {
  const { activeTokens: tokens } = useAuth()
  const [tab, setTab] = useState<Tab>(() => bewaard('handel:tab', TABS.map(t => t.key), 'overzicht'))
  const [hub, setHub] = useState<string>(() => bewaard('handel:hub', HUB_OPTIES.map(h => h.key), 'alle'))
  const [feeIdx, setFeeIdx] = useState<number>(() => {
    const k = bewaard('handel:fees', PRESETS.map((_, i) => String(i)), '2')
    return Number(k)
  })
  const fee = PRESETS[feeIdx]

  const [orders, setOrders] = useState<EigenOrder[]>([])
  const [opslag, setOpslag] = useState(() => leesAlles())
  const [boeken, setBoeken] = useState<Map<string, PublicMarketOrder[]>>(new Map())
  const [namen, setNamen] = useState<Map<number, string>>(new Map())
  const [plekken, setPlekken] = useState<Map<number, string>>(new Map())
  const [wallet, setWallet] = useState<number | null>(null)
  const [laden, setLaden] = useState(false)
  const [fout, setFout] = useState<string | null>(null)
  const [bijgewerkt, setBijgewerkt] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ typeId: number; plek?: number } | null>(null)

  useEffect(() => onthoud('handel:tab', tab), [tab])
  useEffect(() => onthoud('handel:hub', hub), [hub])
  useEffect(() => onthoud('handel:fees', String(feeIdx)), [feeIdx])

  const charIds = useMemo(() => new Set(tokens.map(t => t.characterId)), [tokens])
  const chars = useMemo(() => new Map(tokens.map(t => [t.characterId, t.characterName])), [tokens])
  // Alleen de handel van de characters die nu geselecteerd zijn.
  const txs = useMemo(() => opslag.txs.filter(t => charIds.has(t.charId)), [opslag, charIds])
  const kosten = useMemo(() => opslag.kosten.filter(k => charIds.has(k.charId)), [opslag, charIds])
  const fifoAlles = useMemo(() => fifo(txs), [txs])

  const ververs = useCallback(async () => {
    if (tokens.length === 0) return
    setLaden(true); setFout(null)
    try {
      const perChar = await Promise.all(tokens.map(async t => {
        const [o, tx, jr, w] = await Promise.all([
          getMarketOrders(t.characterId, t.accessToken).catch(() => [] as MarketOrder[]),
          getTransactions(t.characterId, t.accessToken).catch(() => [] as WalletTransaction[]),
          getWalletJournal(t.characterId, t.accessToken, 5).catch(() => []),
          getWallet(t.characterId, t.accessToken).catch(() => null),
        ])
        bewaarTx(t.characterId, tx)
        bewaarKosten(t.characterId, jr)
        return { orders: o.map(x => ({ ...x, charId: t.characterId }) as EigenOrder), wallet: w }
      }))
      const alleOrders = perChar.flatMap(p => p.orders)
      const nieuweOpslag = leesAlles()
      const mijnTx = nieuweOpslag.txs.filter(t => charIds.has(t.charId))
      const { open } = fifo(mijnTx)
      const handmatig = loadPositions()

      // Orderboeken: per (regio, item) voor NPC-stations, per citadel in één keer.
      const regioVraag = new Map<string, { regio: number; typeId: number }>()
      const citadels = new Set<number>()
      const vraag = (loc: number, typeId: number, regio?: number) => {
        if (isCitadel(loc)) { citadels.add(loc); return }
        const r = regio ?? hubVan(loc)?.regio
        if (r) regioVraag.set(r + ':' + typeId, { regio: r, typeId })
      }
      for (const o of alleOrders) vraag(o.location_id, o.type_id, o.region_id)
      for (const l of open) { vraag(l.locationId, l.typeId); vraag(JITA.station, l.typeId) }
      for (const p of handmatig) vraag(JITA.station, p.typeId)
      const boek = new Map<string, PublicMarketOrder[]>()
      const leg = (lijst: PublicMarketOrder[]) => {
        for (const x of lijst) {
          const k = x.location_id + ':' + x.type_id
          const r = boek.get(k) ?? []
          r.push(x)
          boek.set(k, r)
        }
      }
      await Promise.all([...regioVraag.values()].map(async v => leg(await getRegionOrders(v.regio, v.typeId).catch(() => []))))
      await Promise.all([...citadels].map(async id => {
        const nodig = new Set([...alleOrders.filter(o => o.location_id === id).map(o => o.type_id), ...open.filter(l => l.locationId === id).map(l => l.typeId)])
        const lijst = await getStructureOrders(id, tokens[0].accessToken).catch(() => [])
        leg(lijst.filter(x => nodig.has(x.type_id)).map(x => ({ ...x, location_id: id })))
      }))

      const typeIds = [...new Set([...alleOrders.map(o => o.type_id), ...mijnTx.map(t => t.type_id), ...handmatig.map(p => p.typeId)])]
      const nm = await resolveNames(typeIds)
      setOrders(alleOrders); setOpslag(nieuweOpslag); setBoeken(boek); setNamen(nm)
      const saldi = perChar.map(p => p.wallet).filter((s): s is number => typeof s === 'number')
      setWallet(saldi.length ? saldi.reduce((s, x) => s + x, 0) : null)
      setBijgewerkt(Date.now())

      // Namen van stations en citadels mogen achteraf binnendruppelen.
      const plekIds = [...new Set([...alleOrders.map(o => o.location_id), ...mijnTx.map(t => t.location_id), ...open.map(l => l.locationId)])]
        .filter(id => !hubVan(id))
      const pl = new Map<number, string>()
      await Promise.all(plekIds.slice(0, 60).map(async id => {
        const n = isCitadel(id) ? await getStructureName(id, tokens).catch(() => null) : (await getStationInfo(id).catch(() => null))?.name
        if (n) pl.set(id, n)
      }))
      setPlekken(pl)
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Kon je handel niet laden')
    } finally { setLaden(false) }
  }, [tokens, charIds])

  useEffect(() => { ververs() }, [ververs])

  const plekNaam = useCallback((loc: number) =>
    hubVan(loc)?.naam ?? plekken.get(loc) ?? (isCitadel(loc) ? 'citadel' : 'station'), [plekken])
  const inHub = useCallback((loc: number) => hub === 'alle' || hubKey(loc) === hub, [hub])

  const status = useMemo<OrderStatus[]>(() => orders.filter(o => inHub(o.location_id)).map(o => {
    // ESI laat is_buy_order bij je eigen verkooporders weg: afwezig = verkoop.
    const isBuy = !!o.is_buy_order
    const b = boeken.get(o.location_id + ':' + o.type_id)
    const verloopt = +new Date(o.issued) + o.duration * DAG
    const basis = { order: o, isBuy, waarde: o.volume_remain * o.price, dagenOver: Math.max(0, (verloopt - Date.now()) / DAG) }
    if (!b) return { ...basis, overboden: null, boven: 0, voorstel: null, beste: null }
    const ander = b.filter(x => x.order_id !== o.order_id && !!x.is_buy_order === isBuy)
    const beste = ander.length ? (isBuy ? Math.max(...ander.map(x => x.price)) : Math.min(...ander.map(x => x.price))) : null
    const overboden = beste !== null && (isBuy ? beste >= o.price : beste <= o.price)
    const boven = ander.filter(x => (isBuy ? x.price > o.price : x.price < o.price)).length
    return { ...basis, overboden, boven: Math.max(boven, overboden ? 1 : 0), beste,
             voorstel: overboden && beste !== null ? (isBuy ? beste + 0.01 : beste - 0.01) : null }
  }).sort((a, b) => Number(!!b.overboden) - Number(!!a.overboden) || b.waarde - a.waarde), [orders, boeken, inHub])

  const posities = useMemo<PositieLive[]>(() => {
    const verborgen = new Set(loadHidden())
    const correcties = loadOverrides()
    const lots = fifoAlles.open
      .filter(l => !(l.locationId === JITA.station && verborgen.has(l.typeId)))
      .map(l => l.locationId === JITA.station && correcties[l.typeId]
        ? { ...l, qty: correcties[l.typeId].qty ?? l.qty, buyPrice: correcties[l.typeId].buyPrice ?? l.buyPrice } : l)
      .map(l => ({ typeId: l.typeId, locationId: l.locationId, qty: l.qty, buyPrice: l.buyPrice, bron: 'wallet' as const }))
    const hand = loadPositions().map(p => ({ typeId: p.typeId, locationId: JITA.station, qty: p.qty, buyPrice: p.buyPrice, bron: 'handmatig' as const }))
    const teKoop = new Map<string, number>()
    for (const o of orders) if (!o.is_buy_order) {
      const k = o.location_id + ':' + o.type_id
      teKoop.set(k, (teKoop.get(k) ?? 0) + o.volume_remain)
    }
    const laagste = (k: string) => {
      const s = (boeken.get(k) ?? []).filter(x => !x.is_buy_order).map(x => x.price)
      return s.length ? Math.min(...s) : null
    }
    return [...lots, ...hand].filter(p => inHub(p.locationId)).map(p => {
      const hier = laagste(p.locationId + ':' + p.typeId)
      const jita = hier === null ? laagste(JITA.station + ':' + p.typeId) : null
      const sell = hier ?? jita
      const netto = (n: number) => (sell !== null ? n * sell * (1 - fee.broker - fee.tax) : null)
      const kosten = p.qty * p.buyPrice
      const nu = netto(p.qty)
      const inOrder = Math.min(p.qty, teKoop.get(p.locationId + ':' + p.typeId) ?? 0)
      const vrij = p.qty - inOrder
      const nuVrij = netto(vrij)
      return { ...p, sell, prijsVan: hier !== null ? 'hier' as const : jita !== null ? 'jita' as const : null,
               kosten, nu, pnl: nu !== null ? nu - kosten : null, inOrder, vrij, pnlVrij: nuVrij !== null ? nuVrij - vrij * p.buyPrice : null }
    }).sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity))
  }, [fifoAlles.open, orders, boeken, fee, inHub])

  const g: Gegevens = useMemo(() => ({
    tokens, chars, orders, status, posities,
    txs: txs.filter(t => inHub(t.location_id)),
    kosten,
    verkocht: fifoAlles.verkocht.filter(v => inHub(v.locationId)),
    zonderKoop: fifoAlles.zonderKoop,
    open: fifoAlles.open.filter(l => inHub(l.locationId)),
    boeken, namen, plekken, wallet, fee, hub, sinds: bewaardSinds(txs),
  }), [tokens, chars, orders, status, posities, txs, kosten, fifoAlles, boeken, namen, plekken, wallet, fee, hub, inHub])

  const onItem = useCallback((typeId: number, plek?: number) => setDetail({ typeId, plek }), [])
  const zonderKoopWaarde = fifoAlles.zonderKoop.filter(z => z.tijd >= Date.now() - 30 * DAG).reduce((s, z) => s + z.waarde, 0)

  if (tokens.length === 0) {
    return (
      <Layout header={<PageHeader title="💹 Handelscentrum" sub="Al je handel op één pagina" />}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Log in om je orders, posities en winst te zien.</div>
      </Layout>
    )
  }

  return (
    <Layout header={<PageHeader title="💹 Handelscentrum" sub="Al je handel op één pagina — klik een item voor alle details" right={
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={hub} onChange={e => setHub(e.target.value)} title="Welke markt" style={{ ...KNOP, cursor: 'pointer' }}>
          {HUB_OPTIES.map(h => <option key={h.key} value={h.key}>{h.label}</option>)}
        </select>
        <select value={feeIdx} onChange={e => setFeeIdx(+e.target.value)} title="Kosten bij verkopen (broker fee + sales tax)" style={{ ...KNOP, cursor: 'pointer' }}>
          {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
        <button onClick={ververs} disabled={laden} style={KNOP}>{laden ? 'Laden…' : '↻ Ververs'}</button>
      </div>
    } />}>
      <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '1rem', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 0, borderBottom: `2px solid ${tab === t.key ? 'var(--blue)' : 'transparent'}`,
            color: tab === t.key ? 'var(--text)' : 'var(--text-dim)', padding: '0.5rem 0.9rem', cursor: 'pointer',
            fontSize: '0.8rem', fontWeight: 700, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {fout && <div style={{ color: '#ff5c6c', fontSize: '0.75rem', marginBottom: '0.8rem' }}>{fout}</div>}
      {laden && !bijgewerkt && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.8rem' }}>Je orders, wallet en handel laden…</div>}

      {tab === 'overzicht' && <Overzicht g={g} onItem={onItem} plekNaam={plekNaam} naarTab={setTab} />}
      {tab === 'statistiek' && <Statistiek g={g} onItem={onItem} />}
      {tab === 'kansen' && <Kansen g={g} onItem={onItem} />}
      {tab === 'logboek' && <Logboek g={g} onItem={onItem} plekNaam={plekNaam} />}

      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '1rem', lineHeight: 1.5 }}>
        Markt: {uitlegHub(hub)}. Winst met {PRESETS[feeIdx].label.toLowerCase()} ({(fee.broker * 100).toFixed(1)}% broker + {(fee.tax * 100).toFixed(1)}% tax bij verkopen),
        FIFO over alle hubs. Je handel wordt in deze browser bewaard{g.sinds ? ` (sinds ${new Date(g.sinds).toLocaleDateString('nl-NL')})` : ''}.
        {zonderKoopWaarde > 0 && <> Voor {fmtKort(zonderKoopWaarde)} aan verkopen (30 d) is de aankoop onbekend; die tellen niet mee.</>}
        {bijgewerkt && <> Bijgewerkt {new Date(bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.</>}
      </div>

      {detail && <ItemDetail typeId={detail.typeId} plek={detail.plek} g={g} onClose={() => setDetail(null)} />}
    </Layout>
  )
}

const fmtKort = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`)
