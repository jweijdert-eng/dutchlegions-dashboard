import { useEffect, useMemo, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts'
import { getRegionHistory, getRegionOrders, openMarketWindow, resolveNames, type PublicMarketOrder, type RegionHistoryPoint } from '../../api/esi'
import EveImage from '../EveImage'
import { historyStats } from '../../pages/JitaScanner'
import { fmtISK, hubVan, HUBS, JITA, kleur, leesVolg, nettoWinst, plus, zetVolg, type Hub } from '../../utils/handel'
import { CARD, DOF, KnopGroep, KNOP, KOP, LABEL, RIJ, TD, TH, type Gegevens } from './delen'

interface HubPrijs { hub: Hub; buy: number | null; sell: number | null }

export default function ItemDetail({ typeId, plek, g, onClose }: { typeId: number; plek?: number; g: Gegevens; onClose: () => void }) {
  const [hubKey, setHubKey] = useState<string>(() => (plek && hubVan(plek)?.key) || 'jita')
  const hub = HUBS.find(h => h.key === hubKey) ?? JITA
  const [hist, setHist] = useState<RegionHistoryPoint[] | null>(null)
  const [boek, setBoek] = useState<PublicMarketOrder[] | null>(null)
  const [perHub, setPerHub] = useState<HubPrijs[] | null>(null)
  const [volgt, setVolgt] = useState(() => leesVolg().includes(typeId))
  // Items uit de scan of de volglijst staan niet altijd in de namen van de pagina.
  const [eigenNaam, setEigenNaam] = useState<string | null>(null)
  useEffect(() => {
    if (g.namen.has(typeId)) return
    let weg = false
    resolveNames([typeId]).then(m => { if (!weg) setEigenNaam(m.get(typeId) ?? null) }).catch(() => {})
    return () => { weg = true }
  }, [typeId, g.namen])
  const naam = g.namen.get(typeId) ?? eigenNaam ?? `#${typeId}`

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  // Prijzen in alle vijf de hubs, één keer per item.
  useEffect(() => {
    let weg = false
    Promise.all(HUBS.map(async h => {
      const b = (await getRegionOrders(h.regio, typeId).catch(() => [])).filter(o => o.location_id === h.station)
      const buys = b.filter(o => o.is_buy_order).map(o => o.price), sells = b.filter(o => !o.is_buy_order).map(o => o.price)
      return { hub: h, buy: buys.length ? Math.max(...buys) : null, sell: sells.length ? Math.min(...sells) : null }
    })).then(r => { if (!weg) setPerHub(r) })
    return () => { weg = true }
  }, [typeId])

  // Historie en orderboek van de gekozen hub.
  useEffect(() => {
    let weg = false
    setHist(null); setBoek(null)
    getRegionHistory(hub.regio, typeId).catch(() => []).then(h => { if (!weg) setHist(h) })
    getRegionOrders(hub.regio, typeId).catch(() => []).then(b => { if (!weg) setBoek(b.filter(o => o.location_id === hub.station)) })
    return () => { weg = true }
  }, [typeId, hub.regio, hub.station])

  const mijnOrderIds = useMemo(() => new Set(g.orders.map(o => o.order_id)), [g.orders])
  const st = hist && hist.length ? historyStats(hist) : null
  const buys = (boek ?? []).filter(o => o.is_buy_order).sort((a, b) => b.price - a.price)
  const sells = (boek ?? []).filter(o => !o.is_buy_order).sort((a, b) => a.price - b.price)
  const bestBuy = buys[0]?.price ?? null, bestSell = sells[0]?.price ?? null
  const margePct = bestBuy && bestSell ? ((bestSell * (1 - g.fee.broker - g.fee.tax) - bestBuy * (1 + g.fee.broker)) / (bestBuy * (1 + g.fee.broker))) * 100 : null

  // Grafiek: 90 dagen gemiddelde prijs en volume, met jouw aan- en verkopen in deze hub.
  const grafiek = useMemo(() => {
    if (!hist) return []
    const mijn = new Map<string, { koop: number[]; verkoop: number[] }>()
    for (const t of g.txs) {
      if (t.type_id !== typeId || t.location_id !== hub.station) continue
      const d = t.date.slice(0, 10)
      const r = mijn.get(d) ?? { koop: [], verkoop: [] }
      ;(t.is_buy ? r.koop : r.verkoop).push(t.unit_price)
      mijn.set(d, r)
    }
    const gem = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : undefined)
    return hist.slice(-90).map(h => ({
      dag: h.date.slice(5), gem: h.average, laag: h.lowest, hoog: h.highest, volume: h.volume,
      koop: gem(mijn.get(h.date)?.koop ?? []), verkoop: gem(mijn.get(h.date)?.verkoop ?? []),
    }))
  }, [hist, g.txs, typeId, hub.station])

  const plekNaam = (loc: number) => hubVan(loc)?.naam ?? g.plekken.get(loc) ?? (loc > 1e12 ? 'citadel' : 'station')
  const mijnOrders = g.status.filter(s => s.order.type_id === typeId)
  const mijnPos = g.posities.filter(p => p.typeId === typeId)
  const gerealiseerd = g.verkocht.filter(v => v.typeId === typeId)
  const winst = gerealiseerd.reduce((s, v) => s + nettoWinst(v, g.fee), 0)

  async function openInEve() {
    const t = g.tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }
  function wisselVolg() { zetVolg(typeId, !volgt); setVolgt(!volgt) }

  const boekRij = (o: PublicMarketOrder) => (
    <tr key={o.order_id} style={{ borderTop: '1px solid var(--border)', background: mijnOrderIds.has(o.order_id) ? 'rgba(0,180,216,0.12)' : undefined }}>
      <td style={TD}>{fmtISK(o.price)}</td>
      <td style={TD}>{o.volume_remain.toLocaleString('nl-NL')}</td>
      <td style={{ ...TD, color: 'var(--blue)', fontSize: '0.62rem' }}>{mijnOrderIds.has(o.order_id) ? 'JIJ' : ''}</td>
    </tr>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '4vh 1rem', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ ...CARD, width: '100%', maxWidth: 1050, background: 'var(--bg, #0b0b14)', padding: '1.1rem 1.2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginBottom: '0.9rem', flexWrap: 'wrap' }}>
          <EveImage category="types" id={typeId} size={64} px={44}
            variation={/(Blueprint|Reaction Formula)$/.test(naam) ? 'bp' : 'icon'} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>{naam}</div>
            <div style={DOF}>{hub.naam} · {st ? <>dagvolume {st.dayVolume.toLocaleString('nl-NL')} · gem. 30 d {fmtISK(st.avg30)} · trend <span style={{ color: kleur(st.trendPct) }}>{st.trendPct >= 0 ? '+' : ''}{st.trendPct.toFixed(0)}%</span></> : 'historie laden…'}</div>
          </div>
          <button onClick={wisselVolg} style={{ ...KNOP, color: volgt ? '#ffce54' : 'var(--text)' }}>{volgt ? '★ Volgt' : '☆ Volgen'}</button>
          <button onClick={openInEve} style={{ ...KNOP, background: 'var(--blue)', color: '#0a0a12', borderColor: 'var(--blue)', fontWeight: 700 }}>Open in EVE</button>
          <button onClick={onClose} style={KNOP} title="Sluiten (Esc)">✕</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          <KnopGroep<string> waarde={hubKey} onKies={setHubKey} opties={HUBS.map(h => ({ key: h.key, label: h.naam }))} />
          <span style={DOF}>
            koop {bestBuy !== null ? fmtISK(bestBuy) : '–'} · verkoop {bestSell !== null ? fmtISK(bestSell) : '–'} ·{' '}
            marge <b style={{ color: kleur(margePct ?? 0) }}>{margePct !== null ? `${margePct.toFixed(1)}%` : '–'}</b>
          </span>
        </div>

        <div style={{ ...CARD, marginBottom: '1rem' }}>
          <div style={KOP}>📈 Prijs en volume (90 dagen) met jouw trades</div>
          {!hist && <div style={DOF}>Laden…</div>}
          {hist && !hist.length && <div style={DOF}>Geen historie in deze regio.</div>}
          {!!grafiek.length && (
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={grafiek} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="dag" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} minTickGap={28} />
                <YAxis yAxisId="prijs" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={56} tickFormatter={(v: number) => fmtISK(v)} domain={['auto', 'auto']} />
                <YAxis yAxisId="vol" orientation="right" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={44} />
                <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: '0.7rem', borderRadius: 4 }}
                  formatter={(v: number, n: string) => [n === 'volume' ? v.toLocaleString('nl-NL') : fmtISK(v), n]} />
                <Legend wrapperStyle={{ fontSize: '0.68rem' }} />
                <Bar yAxisId="vol" dataKey="volume" name="volume" fill="var(--border)" />
                <Line yAxisId="prijs" dataKey="gem" name="gemiddeld" stroke="#00b4d8" strokeWidth={2} dot={false} />
                <Line yAxisId="prijs" dataKey="laag" name="laagst" stroke="#00b4d8" strokeOpacity={0.35} strokeDasharray="3 3" dot={false} />
                <Line yAxisId="prijs" dataKey="hoog" name="hoogst" stroke="#00b4d8" strokeOpacity={0.35} strokeDasharray="3 3" dot={false} />
                <Scatter yAxisId="prijs" dataKey="koop" name="jij kocht" fill="#4ade80" />
                <Scatter yAxisId="prijs" dataKey="verkoop" name="jij verkocht" fill="#f4a261" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem' }}>
          <div style={CARD}>
            <div style={KOP}>📗 Orderboek {hub.naam}</div>
            {!boek && <div style={DOF}>Laden…</div>}
            {boek && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                <div>
                  <div style={{ ...LABEL, color: '#4cc9f0' }}>Koop ({buys.length})</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{buys.slice(0, 5).map(boekRij)}</tbody></table>
                </div>
                <div>
                  <div style={{ ...LABEL, color: '#f4a261' }}>Verkoop ({sells.length})</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{sells.slice(0, 5).map(boekRij)}</tbody></table>
                </div>
              </div>
            )}
          </div>

          <div style={CARD}>
            <div style={KOP}>🗺️ Prijs per hub</div>
            {!perHub && <div style={DOF}>Laden…</div>}
            {perHub && (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Hub</th><th style={TH}>Koop</th><th style={TH}>Verkoop</th></tr></thead>
                <tbody>
                  {perHub.map(p => {
                    const goedkoopst = Math.min(...perHub.filter(x => x.sell !== null).map(x => x.sell as number))
                    const duurst = Math.max(...perHub.filter(x => x.buy !== null).map(x => x.buy as number))
                    return (
                      <tr key={p.hub.key} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...TD, textAlign: 'left', fontWeight: p.hub.key === hubKey ? 700 : 400 }}>{p.hub.naam}</td>
                        <td style={{ ...TD, color: p.buy !== null && p.buy === duurst ? '#4ade80' : undefined }}>{p.buy !== null ? fmtISK(p.buy) : '–'}</td>
                        <td style={{ ...TD, color: p.sell !== null && p.sell === goedkoopst ? '#4ade80' : undefined }}>{p.sell !== null ? fmtISK(p.sell) : '–'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <div style={{ ...DOF, marginTop: '0.4rem', whiteSpace: 'normal' }}>Groen: goedkoopste om te kopen en duurste koper.</div>
          </div>

          <div style={CARD}>
            <div style={KOP}>🧾 Jij en dit item</div>
            {mijnOrders.map(s => {
              const dagen = st && st.dayVolume > 0 ? s.order.volume_remain / (st.dayVolume * 0.3) : null
              return (
                <div key={s.order.order_id} style={RIJ}>
                  <span style={{ fontSize: '0.78rem' }}>{s.isBuy ? 'Koop' : 'Verkoop'}order {fmtISK(s.order.price)} <span style={{ color: 'var(--text-dim)', fontSize: '0.68rem' }}>· {plekNaam(s.order.location_id)}</span></span>
                  <span style={DOF}>
                    {s.order.volume_remain.toLocaleString('nl-NL')} over ·{' '}
                    {s.overboden === null ? 'stand onbekend' : s.overboden ? <b style={{ color: '#ffce54' }}>{s.boven} boven je</b> : <b style={{ color: '#4ade80' }}>bovenaan</b>}
                    {dagen !== null && <span title="Als je 30% van de dagelijkse handel pakt"> · ±{dagen < 1 ? '<1' : Math.round(dagen)} d</span>}
                  </span>
                </div>
              )
            })}
            {mijnPos.map(p => (
              <div key={p.bron + p.locationId} style={RIJ}>
                <span style={{ fontSize: '0.78rem' }}>Positie {p.qty.toLocaleString('nl-NL')} st <span style={{ color: 'var(--text-dim)', fontSize: '0.68rem' }}>· {plekNaam(p.locationId)}</span></span>
                <span style={DOF}>kocht {fmtISK(p.buyPrice)} · <b style={{ color: kleur(p.pnl ?? 0) }}>{p.pnl === null ? '–' : plus(p.pnl)}</b></span>
              </div>
            ))}
            <div style={RIJ}>
              <span style={{ fontSize: '0.78rem' }}>Verdiend tot nu toe</span>
              <span style={DOF}>{gerealiseerd.length} verkopen · <b style={{ color: kleur(winst) }}>{plus(winst)}</b></span>
            </div>
            {!mijnOrders.length && !mijnPos.length && !gerealiseerd.length && <div style={{ ...DOF, marginTop: '0.4rem' }}>Je hebt dit item nog niet verhandeld.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
