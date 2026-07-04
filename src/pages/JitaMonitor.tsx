import { useCallback, useEffect, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getMarketOrders, getRegionOrders, resolveNames, openMarketWindow, type MarketOrder,
} from '../api/esi'

const THE_FORGE = 10000002
const JITA_STATION = 60003760

function fmtISK(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toLocaleString('nl-NL', { maximumFractionDigits: 2 })
}

interface OrderRow {
  orderId: number; typeId: number; name: string; charName: string
  isBuy: boolean; myPrice: number; volumeRemain: number
  competitor: number | null; isTop: boolean; suggested: number | null
}

const LABEL: React.CSSProperties = { fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem' }
const INPUT: React.CSSProperties = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', width: 90, outline: 'none' }
const TH: React.CSSProperties = { textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.35rem 0.7rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }
const btn = (bg: string, on = true): React.CSSProperties => ({ padding: '0.45rem 0.85rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', background: bg, color: on ? '#04121f' : 'var(--text)', border: on ? 0 : '1px solid var(--border)' })

export default function JitaMonitor() {
  const { activeTokens: tokens } = useAuth()

  const [rows, setRows] = useState<OrderRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastCheck, setLastCheck] = useState<Date | null>(null)
  const [monitoring, setMonitoring] = useState(false)
  const [intervalSec, setIntervalSec] = useState(120)
  const [notifOn, setNotifOn] = useState(false)
  const [skipped, setSkipped] = useState(0)

  // Vorige "bovenaan?"-status per order, om alleen bij een omslag (top → overboden)
  // te melden i.p.v. elke poll opnieuw. null = eerste poll (nog niet melden).
  const prevTop = useRef<Map<number, boolean> | null>(null)

  const check = useCallback(async () => {
    if (tokens.length === 0) return
    setLoading(true); setError(null)
    try {
      // Orders van alle actieve characters ophalen.
      const perChar = await Promise.all(
        tokens.map(async t => ({
          char: t.characterName,
          orders: await getMarketOrders(t.characterId, t.accessToken).catch(() => [] as MarketOrder[]),
        })),
      )
      const all = perChar.flatMap(p => p.orders.map(o => ({ ...o, charName: p.char })))
      const jita = all.filter(o => o.location_id === JITA_STATION)
      setSkipped(all.length - jita.length)

      // Per uniek type de huidige Jita-orderbook ophalen.
      const typeIds = [...new Set(jita.map(o => o.type_id))]
      const books = new Map<number, MarketOrder[]>()
      await Promise.all(typeIds.map(async id =>
        books.set(id, (await getRegionOrders(THE_FORGE, id).catch(() => [])) as unknown as MarketOrder[])))
      const names = await resolveNames(typeIds)

      const result: OrderRow[] = jita.map(o => {
        const book = (books.get(o.type_id) ?? []).filter(b => b.location_id === JITA_STATION && b.order_id !== o.order_id)
        let competitor: number | null = null, isTop = true, suggested: number | null = null
        if (o.is_buy_order) {
          const buys = book.filter(b => b.is_buy_order).map(b => b.price)
          competitor = buys.length ? Math.max(...buys) : null
          isTop = competitor === null ? true : o.price > competitor
          if (!isTop && competitor !== null) suggested = competitor + 0.01
        } else {
          const sells = book.filter(b => !b.is_buy_order).map(b => b.price)
          competitor = sells.length ? Math.min(...sells) : null
          isTop = competitor === null ? true : o.price < competitor
          if (!isTop && competitor !== null) suggested = competitor - 0.01
        }
        return {
          orderId: o.order_id, typeId: o.type_id, name: names.get(o.type_id) ?? `#${o.type_id}`,
          charName: o.charName, isBuy: o.is_buy_order, myPrice: o.price, volumeRemain: o.volume_remain,
          competitor, isTop, suggested,
        }
      })
      result.sort((a, b) => Number(a.isTop) - Number(b.isTop))

      // Meldingen: alleen orders die sinds de vorige poll van "bovenaan" → "overboden" gingen.
      if (prevTop.current !== null && notifOn && 'Notification' in window && Notification.permission === 'granted') {
        const newlyOutbid = result.filter(r => !r.isTop && prevTop.current!.get(r.orderId) !== false)
        if (newlyOutbid.length > 0) {
          const first = newlyOutbid[0]
          new Notification(`Overboden op Jita: ${newlyOutbid.length} order(s)`, {
            body: newlyOutbid.length === 1
              ? `${first.name} (${first.isBuy ? 'koop' : 'verkoop'}) — zet naar ${first.suggested !== null ? fmtISK(first.suggested) : '—'}`
              : `o.a. ${first.name}. Open het dashboard om je orders aan te passen.`,
            tag: 'jita-undercut',
          })
        }
      }
      prevTop.current = new Map(result.map(r => [r.orderId, r.isTop]))
      setRows(result)
      setLastCheck(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kon orders niet checken')
    } finally { setLoading(false) }
  }, [tokens, notifOn])

  // Poll-lus zolang monitoring aanstaat.
  useEffect(() => {
    if (!monitoring) return
    check()
    const id = setInterval(check, Math.max(30, intervalSec) * 1000)
    return () => clearInterval(id)
  }, [monitoring, intervalSec, check])

  async function enableNotifs() {
    if (!('Notification' in window)) { setError('Deze browser ondersteunt geen meldingen.'); return }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    setNotifOn(perm === 'granted')
    if (perm !== 'granted') setError('Meldingen geweigerd — sta ze toe in je browser voor waarschuwingen.')
  }

  async function openMarket(typeId: number) {
    const t = tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }

  if (tokens.length === 0) {
    return (
      <Layout header={<PageHeader title="Order-monitor" sub="Waarschuwt als je op Jita bent overboden" />}>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Log in om je markt-orders te monitoren.</div>
      </Layout>
    )
  }

  const outbid = rows?.filter(r => !r.isTop).length ?? 0

  return (
    <Layout header={<PageHeader title="Order-monitor" sub="Waarschuwt als je op Jita 4-4 bent overboden of onderboden" />}>
      <div style={{ maxWidth: 1000 }}>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
          <button onClick={() => setMonitoring(m => !m)} style={btn(monitoring ? '#ff5c6c' : 'var(--blue)')}>
            {monitoring ? '⏸ Stop monitoren' : '▶ Start monitoren'}
          </button>
          <button onClick={check} disabled={loading} style={{ ...btn('var(--surface2)', false), opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Checken…' : 'Nu checken'}
          </button>
          <div>
            <div style={LABEL}>Interval (sec)</div>
            <input type="number" min={30} value={intervalSec} onChange={e => setIntervalSec(Math.max(30, +e.target.value))} style={INPUT} />
          </div>
          <button onClick={enableNotifs} style={btn(notifOn ? '#4ade80' : 'var(--surface2)', notifOn)}>
            {notifOn ? '🔔 Meldingen aan' : '🔕 Meldingen aanzetten'}
          </button>
        </div>

        {error && <div style={{ color: '#ff5c6c', fontSize: '0.75rem', marginBottom: '0.6rem' }}>{error}</div>}

        {rows && (
          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>
            {rows.length} order(s) op Jita 4-4 · <b style={{ color: outbid > 0 ? '#ff5c6c' : '#4ade80' }}>{outbid} overboden</b>
            {lastCheck && ` · laatst gecheckt ${lastCheck.toLocaleTimeString('nl-NL')}`}
            {monitoring && ` · auto elke ${intervalSec}s`}
            {skipped > 0 && ` · ${skipped} order(s) buiten Jita niet getoond`}
          </div>
        )}

        {rows && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: 'var(--surface)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                <th style={{ ...TH, textAlign: 'left' }}>Type</th>
                <th style={TH}>Jouw prijs</th>
                <th style={TH}>Beste concurrent</th>
                <th style={{ ...TH, textAlign: 'left' }}>Status</th>
                <th style={TH}>Zet naar</th>
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.orderId} style={{ borderTop: '1px solid var(--border)', background: r.isTop ? undefined : 'rgba(255,92,108,0.06)' }}>
                    <td style={{ ...TD, textAlign: 'left' }}>
                      <button onClick={() => openMarket(r.typeId)} title="Open in-game marktvenster"
                        style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>{r.name}</button>
                      {tokens.length > 1 && <span style={{ color: 'var(--text-dim)', fontSize: '0.6rem', marginLeft: 6 }}>{r.charName}</span>}
                    </td>
                    <td style={{ ...TD, textAlign: 'left' }}>{r.isBuy ? 'Koop' : 'Verkoop'}</td>
                    <td style={TD}>{fmtISK(r.myPrice)}</td>
                    <td style={TD}>{r.competitor !== null ? fmtISK(r.competitor) : '—'}</td>
                    <td style={{ ...TD, textAlign: 'left', color: r.isTop ? '#4ade80' : '#ff5c6c', fontWeight: 700 }}>{r.isTop ? 'Bovenaan' : 'Overboden'}</td>
                    <td style={TD}>{r.suggested !== null ? fmtISK(r.suggested) : '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={6} style={{ ...TD, textAlign: 'center', color: 'var(--text-dim)', padding: '1rem' }}>Geen open orders op Jita 4-4.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!rows && !loading && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
            Klik <b>Start monitoren</b> (of <b>Nu checken</b>). Zet <b>Meldingen</b> aan om een browser-waarschuwing te krijgen zodra je overboden wordt — de tab mag op de achtergrond staan.
          </div>
        )}

        {rows && (
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
            Meldingen komen alleen bij een omslag (bovenaan → overboden). Aanpassen doe je zelf in-game (klik het item → marktvenster) — dat houdt het binnen de EVE-regels.
          </div>
        )}
      </div>
    </Layout>
  )
}
