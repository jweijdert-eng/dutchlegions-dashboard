import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getMarketOrders, getTransactions, getRegionOrders, resolveNames, openMarketWindow, getWallet,
  type MarketOrder, type WalletTransaction,
} from '../api/esi'
import { loadPositions, loadHidden, loadOverrides } from '../utils/jitaPositions'

// Handelscentrum: alles van je handel in Jita op één pagina. Dezelfde bronnen en
// rekenregels als Trade Vandaag, Order-monitor en Mijn posities (handmatige posities,
// verborgen regels en correcties tellen dus mee), plus wat je echt verdiend hebt.
const THE_FORGE = 10000002
const JITA_STATION = 60003760
const DAG = 86400e3

const PRESETS = [
  { label: 'Geen skills',  broker: 0.05,  tax: 0.08 },
  { label: 'Basis skills', broker: 0.03,  tax: 0.072 },
  { label: 'Max skills',   broker: 0.02,  tax: 0.036 },
  { label: 'Corp/NPC hub', broker: 0.003, tax: 0.036 },
]
const FEES_KEY = 'handel:fees'

function fmtISK(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '-' : ''
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`
  return `${sign}${a.toLocaleString('nl-NL', { maximumFractionDigits: 2 })}`
}
const kleur = (v: number) => (v > 0 ? '#4ade80' : v < 0 ? '#ff5c6c' : 'var(--text-dim)')

interface Verkoop { typeId: number; tijd: number; qty: number; opbrengst: number; kosten: number }
interface Positie { typeId: number; qty: number; buyPrice: number; bron: 'wallet' | 'handmatig' }
interface Order {
  orderId: number; typeId: number; isBuy: boolean; price: number; remain: number; total: number
  waarde: number; dagenOver: number; bovenaan: boolean; voorstel: number | null
}
interface Prijs { sell: number | null; buy: number | null }

/**
 * Wallet-transacties in Jita op volgorde (FIFO): elke verkoop wordt tegen de oudste
 * aankopen weggestreept. Wat overblijft zijn open posities; wat weggestreept is, is
 * verdiend (of verloren). Een verkoop zonder bekende aankoop (ouder dan de 30 dagen
 * die ESI teruggeeft) telt niet mee in de winst, maar wel als "zonder koopprijs".
 */
function verwerk(txs: WalletTransaction[], fee: { broker: number; tax: number }) {
  const gezien = new Set<string>()
  const perType = new Map<number, WalletTransaction[]>()
  for (const t of txs) {
    if (t.location_id !== JITA_STATION) continue
    const sleutel = t.transaction_id + (t.is_buy ? 'k' : 'v')
    if (gezien.has(sleutel)) continue
    gezien.add(sleutel)
    const rij = perType.get(t.type_id) ?? []
    rij.push(t)
    perType.set(t.type_id, rij)
  }
  const open: Positie[] = []
  const verkocht: Verkoop[] = []
  let zonderKoop = 0
  for (const [typeId, rij] of perType) {
    rij.sort((a, b) => +new Date(a.date) - +new Date(b.date))
    const lots: Array<{ qty: number; price: number }> = []
    for (const t of rij) {
      if (t.is_buy) { lots.push({ qty: t.quantity, price: t.unit_price }); continue }
      let rest = t.quantity, gekoppeld = 0, kosten = 0
      while (rest > 0 && lots.length) {
        const l = lots[0], neem = Math.min(rest, l.qty)
        kosten += neem * l.price; gekoppeld += neem; l.qty -= neem; rest -= neem
        if (l.qty <= 0) lots.shift()
      }
      if (gekoppeld > 0) {
        verkocht.push({ typeId, tijd: +new Date(t.date), qty: gekoppeld,
                        opbrengst: gekoppeld * t.unit_price * (1 - fee.broker - fee.tax), kosten })
      }
      if (rest > 0) zonderKoop += rest * t.unit_price
    }
    const qty = lots.reduce((s, l) => s + l.qty, 0)
    if (qty > 0) open.push({ typeId, qty, buyPrice: lots.reduce((s, l) => s + l.qty * l.price, 0) / qty, bron: 'wallet' })
  }
  return { open, verkocht, zonderKoop }
}

const CARD: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.9rem 1rem' }
const KOP: React.CSSProperties = { fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.6rem' }
const LABEL: React.CSSProperties = { fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem', textTransform: 'uppercase' }
const RIJ: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem', padding: '0.35rem 0', borderTop: '1px solid var(--border)' }
const ITEMBTN: React.CSSProperties = { background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const DOF: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }
const KNOP: React.CSSProperties = { padding: '0.4rem 0.8rem', borderRadius: 2, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.72rem' }

function Tegel({ label, waarde, sub, kleurWaarde }: { label: string; waarde: string; sub?: React.ReactNode; kleurWaarde?: string }) {
  return (
    <div style={CARD}>
      <div style={LABEL}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: kleurWaarde ?? 'var(--text)' }}>{waarde}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{sub}</div>}
    </div>
  )
}

const KANSEN = [
  { pad: '/jita-scanner', icoon: '📈', naam: 'Jita Scanner', uitleg: 'Beste flips in Jita, met koopplan voor je budget' },
  { pad: '/gap-scanner', icoon: '🕳️', naam: 'Gap Scanner', uitleg: 'Prijsgaten in de goedkoopste orders (Jita, Amarr)' },
  { pad: '/hub-arbitrage', icoon: '🔀', naam: 'Hub-arbitrage', uitleg: 'Goedkoop in de ene hub, duurder in de andere' },
  { pad: '/market', icoon: '🛒', naam: 'Market', uitleg: 'Eén item uitzoeken: prijs, historie, undercut' },
]

export default function Handelscentrum() {
  const { activeTokens: tokens } = useAuth()
  const [feeIdx, setFeeIdx] = useState<number>(() => {
    try {
      const s = localStorage.getItem(FEES_KEY), n = Number(s)
      if (s !== null && Number.isInteger(n) && n >= 0 && n < PRESETS.length) return n
    } catch { /* opslag geblokkeerd */ }
    return 2
  })
  const fee = PRESETS[feeIdx]
  const [txs, setTxs] = useState<WalletTransaction[]>([])
  const [orders, setOrders] = useState<MarketOrder[]>([])
  const [prijzen, setPrijzen] = useState<Map<number, Prijs>>(new Map())
  const [boeken, setBoeken] = useState<Map<number, MarketOrder[]>>(new Map())
  const [namen, setNamen] = useState<Map<number, string>>(new Map())
  const [wallet, setWallet] = useState<number | null>(null)
  const [laden, setLaden] = useState(false)
  const [fout, setFout] = useState<string | null>(null)
  const [bijgewerkt, setBijgewerkt] = useState<number | null>(null)

  useEffect(() => { try { localStorage.setItem(FEES_KEY, String(feeIdx)) } catch { /* niet erg */ } }, [feeIdx])

  const ververs = useCallback(async () => {
    if (tokens.length === 0) return
    setLaden(true); setFout(null)
    try {
      const [alleOrders, alleTxs, saldi] = await Promise.all([
        Promise.all(tokens.map(t => getMarketOrders(t.characterId, t.accessToken).catch(() => [] as MarketOrder[]))).then(r => r.flat()),
        Promise.all(tokens.map(t => getTransactions(t.characterId, t.accessToken).catch(() => [] as WalletTransaction[]))).then(r => r.flat()),
        Promise.all(tokens.map(t => getWallet(t.characterId, t.accessToken).catch(() => null))),
      ])
      const jitaOrders = alleOrders.filter(o => o.location_id === JITA_STATION)
      const { open } = verwerk(alleTxs, fee)
      const handmatig = loadPositions()
      const typeIds = [...new Set([
        ...jitaOrders.map(o => o.type_id), ...open.map(p => p.typeId), ...handmatig.map(p => p.typeId),
        ...alleTxs.filter(t => t.location_id === JITA_STATION).map(t => t.type_id),
      ])]
      // Orderboeken alleen voor wat je nu hebt (orders en posities): die zijn nodig
      // voor "overboden?" en de live waarde. Voor de winst volstaan de namen.
      const nodig = [...new Set([...jitaOrders.map(o => o.type_id), ...open.map(p => p.typeId), ...handmatig.map(p => p.typeId)])]
      const boek = new Map<number, MarketOrder[]>()
      const pr = new Map<number, Prijs>()
      await Promise.all(nodig.map(async id => {
        const b = ((await getRegionOrders(THE_FORGE, id).catch(() => [])) as unknown as MarketOrder[])
          .filter(o => o.location_id === JITA_STATION)
        boek.set(id, b)
        const sells = b.filter(o => !o.is_buy_order).map(o => o.price)
        const buys = b.filter(o => o.is_buy_order).map(o => o.price)
        pr.set(id, { sell: sells.length ? Math.min(...sells) : null, buy: buys.length ? Math.max(...buys) : null })
      }))
      const nm = await resolveNames(typeIds)
      setOrders(jitaOrders); setTxs(alleTxs); setBoeken(boek); setPrijzen(pr); setNamen(nm)
      const geldig = saldi.filter((s): s is number => typeof s === 'number')
      setWallet(geldig.length ? geldig.reduce((s, x) => s + x, 0) : null)
      setBijgewerkt(Date.now())
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Kon je handel niet laden')
    } finally { setLaden(false) }
  // fee hoort hier niet bij: die rekenen we hieronder opnieuw zonder te herladen
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens])

  useEffect(() => { ververs() }, [ververs])

  const naam = useCallback((id: number) => namen.get(id) ?? `#${id}`, [namen])

  // Alles wat uit de transacties volgt, opnieuw bij een andere fee-keuze.
  const { posities, verkocht, zonderKoop } = useMemo(() => {
    const r = verwerk(txs, fee)
    const verborgen = new Set(loadHidden())
    const correcties = loadOverrides()
    const auto: Positie[] = r.open.filter(p => !verborgen.has(p.typeId)).map(p => ({
      ...p, qty: correcties[p.typeId]?.qty ?? p.qty, buyPrice: correcties[p.typeId]?.buyPrice ?? p.buyPrice,
    }))
    const hand: Positie[] = loadPositions().map(p => ({ typeId: p.typeId, qty: p.qty, buyPrice: p.buyPrice, bron: 'handmatig' }))
    return { posities: [...auto, ...hand], verkocht: r.verkocht, zonderKoop: r.zonderKoop }
  }, [txs, fee])

  const ordersMetStatus = useMemo<Order[]>(() => orders.map(o => {
    // ESI laat is_buy_order bij je eigen verkooporders gewoon weg: afwezig = verkoop.
    const isBuy = !!o.is_buy_order
    const ander = (boeken.get(o.type_id) ?? []).filter(b => b.order_id !== o.order_id && !!b.is_buy_order === isBuy)
    const beste = ander.length ? (isBuy ? Math.max(...ander.map(b => b.price)) : Math.min(...ander.map(b => b.price))) : null
    const overboden = beste !== null && (isBuy ? beste >= o.price : beste <= o.price)
    const verloopt = +new Date(o.issued) + o.duration * DAG
    return {
      orderId: o.order_id, typeId: o.type_id, isBuy, price: o.price,
      remain: o.volume_remain, total: o.volume_total, waarde: o.volume_remain * o.price,
      dagenOver: Math.max(0, (verloopt - Date.now()) / DAG), bovenaan: !overboden,
      voorstel: overboden && beste !== null ? (isBuy ? beste + 0.01 : beste - 0.01) : null,
    }
  }).sort((a, b) => Number(a.bovenaan) - Number(b.bovenaan) || b.waarde - a.waarde), [orders, boeken])

  const positiesLive = useMemo(() => {
    // Wat al in een verkooporder staat, hoef je niet nog eens te gaan verkopen.
    const teKoop = new Map<number, number>()
    for (const o of orders) if (!o.is_buy_order) teKoop.set(o.type_id, (teKoop.get(o.type_id) ?? 0) + o.volume_remain)
    return posities.map(p => {
      const sell = prijzen.get(p.typeId)?.sell ?? null
      const kosten = p.qty * p.buyPrice
      const nu = sell !== null ? p.qty * sell * (1 - fee.broker - fee.tax) : null
      const inOrder = Math.min(p.qty, teKoop.get(p.typeId) ?? 0)
      const vrij = p.qty - inOrder
      const pnlVrij = sell !== null ? vrij * sell * (1 - fee.broker - fee.tax) - vrij * p.buyPrice : null
      return { ...p, sell, kosten, nu, pnl: nu !== null ? nu - kosten : null, inOrder, vrij, pnlVrij }
    }).sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity))
  }, [posities, prijzen, fee, orders])

  const winst = useMemo(() => {
    const middernacht = new Date(); middernacht.setHours(0, 0, 0, 0)
    const som = (vanaf: number) => verkocht.filter(v => v.tijd >= vanaf).reduce((s, v) => s + v.opbrengst - v.kosten, 0)
    const perItem = new Map<number, { qty: number; winst: number; kosten: number }>()
    for (const v of verkocht) {
      const r = perItem.get(v.typeId) ?? { qty: 0, winst: 0, kosten: 0 }
      r.qty += v.qty; r.winst += v.opbrengst - v.kosten; r.kosten += v.kosten
      perItem.set(v.typeId, r)
    }
    return {
      vandaag: som(middernacht.getTime()), week: som(Date.now() - 7 * DAG), maand: som(Date.now() - 30 * DAG),
      items: [...perItem.entries()].map(([typeId, r]) => ({ typeId, ...r, marge: r.kosten > 0 ? (r.winst / r.kosten) * 100 : 0 }))
        .sort((a, b) => b.winst - a.winst),
    }
  }, [verkocht])

  const overboden = ordersMetStatus.filter(o => !o.bovenaan)
  const verkoopbaar = positiesLive.filter(p => p.vrij > 0 && (p.pnlVrij ?? 0) > 0)
  const inBuy = ordersMetStatus.filter(o => o.isBuy).reduce((s, o) => s + o.waarde, 0)
  const inSell = ordersMetStatus.filter(o => !o.isBuy).reduce((s, o) => s + o.waarde, 0)
  const posWaarde = positiesLive.reduce((s, p) => s + (p.nu ?? 0), 0)
  const posPnl = positiesLive.reduce((s, p) => s + (p.pnl ?? 0), 0)

  async function openInEve(typeId: number) {
    const t = tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }
  const Item = ({ id }: { id: number }) => (
    <button style={ITEMBTN} onClick={() => openInEve(id)} title="Openen in de EVE-client">{naam(id)}</button>
  )

  if (tokens.length === 0) {
    return (
      <Layout header={<PageHeader title="Handelscentrum" sub="Al je handel in Jita op één pagina" />}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Log in om je orders, posities en winst te zien.</div>
      </Layout>
    )
  }

  return (
    <Layout header={<PageHeader title="💹 Handelscentrum" sub="Al je handel in Jita op één pagina — klik een item om het in-game te openen" right={
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <select value={feeIdx} onChange={e => setFeeIdx(+e.target.value)} title="Kosten bij verkopen (broker fee + sales tax)"
          style={{ ...KNOP, cursor: 'pointer' }}>
          {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
        <button onClick={ververs} disabled={laden} style={KNOP}>{laden ? 'Laden…' : '↻ Ververs'}</button>
      </div>
    } />}>
      {fout && <div style={{ color: '#ff5c6c', fontSize: '0.75rem', marginBottom: '0.8rem' }}>{fout}</div>}
      {laden && !bijgewerkt && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.8rem' }}>Je orders, wallet en posities laden…</div>}

      {/* Overzicht */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.7rem', marginBottom: '1rem' }}>
        <Tegel label="Wallet" waarde={wallet !== null ? fmtISK(wallet) : '–'} sub={`${tokens.length} character${tokens.length === 1 ? '' : 's'}`} />
        <Tegel label="In orders" waarde={fmtISK(inBuy + inSell)} sub={<>koop {fmtISK(inBuy)} · verkoop {fmtISK(inSell)}</>} />
        <Tegel label="Open posities" waarde={fmtISK(posWaarde)}
          sub={<>nu verkocht: <b style={{ color: kleur(posPnl) }}>{posPnl >= 0 ? '+' : ''}{fmtISK(posPnl)}</b></>} />
        <Tegel label="Winst vandaag" waarde={(winst.vandaag >= 0 ? '+' : '') + fmtISK(winst.vandaag)} kleurWaarde={kleur(winst.vandaag)}
          sub={<>7 d: <b style={{ color: kleur(winst.week) }}>{fmtISK(winst.week)}</b> · 30 d: <b style={{ color: kleur(winst.maand) }}>{fmtISK(winst.maand)}</b></>} />
        <Tegel label="Te doen" waarde={String(overboden.length + verkoopbaar.length)}
          kleurWaarde={overboden.length + verkoopbaar.length ? '#ffce54' : '#4ade80'}
          sub={<>{overboden.length} overboden · {verkoopbaar.length} verkoopbaar</>} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1rem', alignItems: 'start' }}>
        {/* Linkerkant: wat nu, en je orders */}
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={CARD}>
            <div style={{ ...KOP, color: overboden.length + verkoopbaar.length ? '#ffce54' : '#4ade80' }}>
              {overboden.length + verkoopbaar.length ? '⚠️ Nu doen' : '👍 Niks te doen'}
            </div>
            {!overboden.length && !verkoopbaar.length && (
              <div style={DOF}>Al je orders staan bovenaan en er is geen positie die nu met winst weg kan.</div>
            )}
            {overboden.map(o => (
              <div key={o.orderId} style={RIJ}>
                <Item id={o.typeId} />
                <span style={DOF}>{o.isBuy ? 'koop' : 'verkoop'} · {fmtISK(o.price)} → <b style={{ color: 'var(--text)' }}>{fmtISK(o.voorstel ?? o.price)}</b></span>
              </div>
            ))}
            {verkoopbaar.map(p => (
              <div key={p.bron + p.typeId} style={RIJ}>
                <Item id={p.typeId} />
                <span style={DOF}>verkoop {p.vrij.toLocaleString('nl-NL')} st · <b style={{ color: '#4ade80' }}>+{fmtISK(p.pnlVrij ?? 0)}</b></span>
              </div>
            ))}
          </div>

          <div style={CARD}>
            <div style={KOP}>📋 Mijn orders in Jita ({ordersMetStatus.length})</div>
            {!ordersMetStatus.length && <div style={DOF}>Geen open orders in Jita 4-4.</div>}
            {ordersMetStatus.map(o => (
              <div key={o.orderId} style={RIJ}>
                <span style={{ display: 'flex', gap: '0.45rem', alignItems: 'baseline', minWidth: 0 }}>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, color: o.isBuy ? '#4cc9f0' : '#f4a261', width: 34, flex: 'none' }}>{o.isBuy ? 'KOOP' : 'VERK.'}</span>
                  <Item id={o.typeId} />
                </span>
                <span style={DOF}>
                  {o.remain.toLocaleString('nl-NL')}/{o.total.toLocaleString('nl-NL')} · {fmtISK(o.price)} ·{' '}
                  {o.bovenaan ? <b style={{ color: '#4ade80' }}>bovenaan</b> : <b style={{ color: '#ffce54' }}>overboden</b>}
                  {' '}· {o.dagenOver < 1 ? '<1' : Math.floor(o.dagenOver)} d
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Rechterkant: posities en winst */}
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={CARD}>
            <div style={KOP}>💼 Open posities ({positiesLive.length})</div>
            {!positiesLive.length && <div style={DOF}>Geen open posities. <Link to="/jita-positions" style={{ color: 'var(--blue)' }}>Handmatig toevoegen</Link></div>}
            {positiesLive.map(p => (
              <div key={p.bron + p.typeId} style={RIJ}>
                <Item id={p.typeId} />
                <span style={DOF}>
                  {p.qty.toLocaleString('nl-NL')} st{p.inOrder > 0 && <> ({p.inOrder === p.qty ? 'alles' : p.inOrder.toLocaleString('nl-NL')} te koop)</>} · kocht {fmtISK(p.buyPrice)} · nu {p.sell !== null ? fmtISK(p.sell) : '–'} ·{' '}
                  <b style={{ color: kleur(p.pnl ?? 0) }}>{p.pnl === null ? '–' : (p.pnl >= 0 ? '+' : '') + fmtISK(p.pnl)}</b>
                  {p.bron === 'handmatig' && <span title="handmatig toegevoegd"> ✎</span>}
                </span>
              </div>
            ))}
          </div>

          <div style={CARD}>
            <div style={KOP}>💰 Verdiend in 30 dagen: <span style={{ color: kleur(winst.maand) }}>{fmtISK(winst.maand)}</span></div>
            {!winst.items.length && <div style={DOF}>Nog niets verkocht waarvan de aankoop bekend is.</div>}
            {winst.items.slice(0, 15).map(i => (
              <div key={i.typeId} style={RIJ}>
                <Item id={i.typeId} />
                <span style={DOF}>
                  {i.qty.toLocaleString('nl-NL')} st · {i.marge.toFixed(0)}% · <b style={{ color: kleur(i.winst) }}>{i.winst >= 0 ? '+' : ''}{fmtISK(i.winst)}</b>
                </span>
              </div>
            ))}
            {winst.items.length > 15 && <div style={{ ...DOF, marginTop: '0.4rem' }}>+ nog {winst.items.length - 15} items</div>}
            {zonderKoop > 0 && (
              <div style={{ ...DOF, marginTop: '0.5rem', whiteSpace: 'normal' }}>
                Voor {fmtISK(zonderKoop)} aan verkopen is de aankoop ouder dan 30 dagen (ESI kijkt niet verder terug); die tellen niet mee.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Kansen */}
      <div style={{ ...LABEL, marginTop: '1.2rem' }}>Nieuwe kansen zoeken</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.7rem' }}>
        {KANSEN.map(k => (
          <Link key={k.pad} to={k.pad} style={{ ...CARD, textDecoration: 'none', color: 'var(--text)', display: 'block' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{k.icoon} {k.naam}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{k.uitleg}</div>
          </Link>
        ))}
      </div>

      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '1rem' }}>
        Winst en waarde gerekend met {PRESETS[feeIdx].label.toLowerCase()} ({(fee.broker * 100).toFixed(1)}% broker + {(fee.tax * 100).toFixed(1)}% tax bij verkopen), FIFO uit je wallet-transacties van de laatste 30 dagen.
        {bijgewerkt && <> Bijgewerkt {new Date(bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.</>}
      </div>
    </Layout>
  )
}
