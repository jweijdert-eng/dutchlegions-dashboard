import { useCallback, useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getMarketOrders, getTransactions, getRegionOrders, resolveNames, openMarketWindow,
  type MarketOrder, type WalletTransaction,
} from '../api/esi'

const THE_FORGE = 10000002
const JITA_STATION = 60003760
// Vaste, redelijke fee-aanname (Max skills) — houdt dit scherm simpel.
const FEES = { broker: 0.02, tax: 0.036 }

function fmtISK(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '-' : ''
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`
  return `${sign}${a.toLocaleString('nl-NL', { maximumFractionDigits: 2 })}`
}

// FIFO open posities uit transacties (gekocht − verkocht), Jita 4-4.
function openPositions(txs: WalletTransaction[]) {
  const byType = new Map<number, WalletTransaction[]>()
  for (const t of txs) { if (t.location_id !== JITA_STATION) continue; const a = byType.get(t.type_id) ?? []; a.push(t); byType.set(t.type_id, a) }
  const out: Array<{ typeId: number; qty: number; buyPrice: number }> = []
  for (const [typeId, list] of byType) {
    list.sort((a, b) => +new Date(a.date) - +new Date(b.date))
    const lots: Array<{ qty: number; price: number }> = []
    for (const t of list) {
      if (t.is_buy) lots.push({ qty: t.quantity, price: t.unit_price })
      else { let rem = t.quantity; while (rem > 0 && lots.length) { const l = lots[0]; const take = Math.min(rem, l.qty); l.qty -= take; rem -= take; if (l.qty <= 0) lots.shift() } }
    }
    const qty = lots.reduce((s, l) => s + l.qty, 0)
    if (qty > 0) out.push({ typeId, qty, buyPrice: lots.reduce((s, l) => s + l.qty * l.price, 0) / qty })
  }
  return out
}

interface Reprice { orderId: number; typeId: number; name: string; isBuy: boolean; myPrice: number; suggested: number }
interface Sell { typeId: number; name: string; qty: number; pnl: number; pnlPct: number }

const CARD: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.9rem 1rem', marginBottom: '1rem' }
const ITEMBTN: React.CSSProperties = { background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, textAlign: 'left' }

export default function JitaToday() {
  const { activeTokens: tokens } = useAuth()
  const [reprice, setReprice] = useState<Reprice[]>([])
  const [sell, setSell] = useState<Sell[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ranOnce, setRanOnce] = useState(false)

  const run = useCallback(async () => {
    if (tokens.length === 0) return
    setLoading(true); setErr(null)
    try {
      const [ordersAll, txsAll] = await Promise.all([
        Promise.all(tokens.map(t => getMarketOrders(t.characterId, t.accessToken).catch(() => [] as MarketOrder[]))).then(r => r.flat()),
        Promise.all(tokens.map(t => getTransactions(t.characterId, t.accessToken).catch(() => [] as WalletTransaction[]))).then(r => r.flat()),
      ])
      const myOrders = ordersAll.filter(o => o.location_id === JITA_STATION)
      const positions = openPositions(txsAll)

      const typeIds = [...new Set([...myOrders.map(o => o.type_id), ...positions.map(p => p.typeId)])]
      const books = new Map<number, MarketOrder[]>()
      await Promise.all(typeIds.map(async id => books.set(id, (await getRegionOrders(THE_FORGE, id).catch(() => [])) as unknown as MarketOrder[])))
      const names = await resolveNames(typeIds)
      const nm = (id: number) => names.get(id) ?? `#${id}`

      // ⚠️ Herprijzen: orders waar je overboden bent.
      const rep: Reprice[] = []
      for (const o of myOrders) {
        const book = (books.get(o.type_id) ?? []).filter(b => b.location_id === JITA_STATION && b.order_id !== o.order_id)
        if (o.is_buy_order) {
          const best = book.filter(b => b.is_buy_order).map(b => b.price)
          const top = best.length ? Math.max(...best) : null
          if (top !== null && top >= o.price) rep.push({ orderId: o.order_id, typeId: o.type_id, name: nm(o.type_id), isBuy: true, myPrice: o.price, suggested: top + 0.01 })
        } else {
          const best = book.filter(b => !b.is_buy_order).map(b => b.price)
          const top = best.length ? Math.min(...best) : null
          if (top !== null && top <= o.price) rep.push({ orderId: o.order_id, typeId: o.type_id, name: nm(o.type_id), isBuy: false, myPrice: o.price, suggested: top - 0.01 })
        }
      }

      // 💰 Verkoopbaar: open posities die nu met winst weg kunnen.
      const sl: Sell[] = []
      for (const p of positions) {
        const sells = (books.get(p.typeId) ?? []).filter(b => b.location_id === JITA_STATION && !b.is_buy_order).map(b => b.price)
        const sellNow = sells.length ? Math.min(...sells) : null
        if (sellNow === null) continue
        const cost = p.qty * p.buyPrice
        const revenue = p.qty * sellNow * (1 - FEES.broker - FEES.tax)
        const pnl = revenue - cost
        if (pnl > 0) sl.push({ typeId: p.typeId, name: nm(p.typeId), qty: p.qty, pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0 })
      }
      sl.sort((a, b) => b.pnl - a.pnl)

      setReprice(rep); setSell(sl); setRanOnce(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Kon gegevens niet laden')
    } finally { setLoading(false) }
  }, [tokens])

  useEffect(() => { run() }, [run])

  async function openMarket(typeId: number) {
    const t = tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }

  if (tokens.length === 0) {
    return (
      <Layout header={<PageHeader title="Trade Vandaag" sub="Wat je nu moet doen" />}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Log in om je orders en posities te zien.</div>
      </Layout>
    )
  }

  const nothing = ranOnce && !loading && reprice.length === 0 && sell.length === 0
  const totalSellPnl = sell.reduce((s, x) => s + x.pnl, 0)

  return (
    <Layout header={<PageHeader title="Trade Vandaag" sub="Wat je nu moet doen — klik een item om het in-game te openen" right={
      <button onClick={run} disabled={loading} style={{ padding: '0.4rem 0.8rem', borderRadius: 2, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.72rem' }}>
        {loading ? 'Laden…' : '↻ Ververs'}
      </button>
    } />}>
      <div style={{ maxWidth: 640 }}>
        {err && <div style={{ color: '#ff5c6c', fontSize: '0.75rem', marginBottom: '0.8rem' }}>{err}</div>}
        {loading && !ranOnce && <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>Je orders en posities laden…</div>}

        {nothing && (
          <div style={{ ...CARD, textAlign: 'center', color: '#4ade80', fontSize: '1rem', fontWeight: 700 }}>
            👍 Niks te doen — al je orders staan bovenaan en geen posities om te verkopen.
          </div>
        )}

        {reprice.length > 0 && (
          <div style={CARD}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.6rem', color: '#ffce54' }}>⚠️ Herprijzen ({reprice.length})</div>
            {reprice.map(r => (
              <div key={r.orderId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem', padding: '0.35rem 0', borderTop: '1px solid var(--border)' }}>
                <button style={ITEMBTN} onClick={() => openMarket(r.typeId)}>{r.name}</button>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {r.isBuy ? 'koop' : 'verkoop'} · {fmtISK(r.myPrice)} → <b style={{ color: 'var(--text)' }}>{fmtISK(r.suggested)}</b>
                </span>
              </div>
            ))}
          </div>
        )}

        {sell.length > 0 && (
          <div style={CARD}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.6rem', color: '#4ade80' }}>
              💰 Verkoopbaar met winst ({sell.length}) · totaal +{fmtISK(totalSellPnl)}
            </div>
            {sell.map(s => (
              <div key={s.typeId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem', padding: '0.35rem 0', borderTop: '1px solid var(--border)' }}>
                <button style={ITEMBTN} onClick={() => openMarket(s.typeId)}>{s.name}</button>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {s.qty.toLocaleString('nl-NL')} st · <b style={{ color: '#4ade80' }}>+{fmtISK(s.pnl)}</b> ({s.pnlPct.toFixed(0)}%)
                </span>
              </div>
            ))}
          </div>
        )}

        {ranOnce && !nothing && (
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
            Winst gerekend met ~2% broker / 3,6% tax. Klik een item → marktvenster om aan te passen of te verkopen.
          </div>
        )}
      </div>
    </Layout>
  )
}
