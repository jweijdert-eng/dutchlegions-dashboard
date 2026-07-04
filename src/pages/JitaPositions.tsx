import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import { getRegionOrders, resolveTypeIds, resolveNames, openMarketWindow } from '../api/esi'
import { loadPositions, addPosition, removePosition, type Position } from '../utils/jitaPositions'

const THE_FORGE = 10000002
const JITA_STATION = 60003760

function fmtISK(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '-' : ''
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`
  return `${sign}${a.toLocaleString('nl-NL', { maximumFractionDigits: 2 })}`
}

const PRESETS = [
  { label: 'Geen skills',  broker: 0.05,  tax: 0.08 },
  { label: 'Basis skills', broker: 0.03,  tax: 0.072 },
  { label: 'Max skills',   broker: 0.02,  tax: 0.036 },
  { label: 'Corp/NPC hub', broker: 0.003, tax: 0.036 },
]

const LABEL: React.CSSProperties = { fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem' }
const INPUT: React.CSSProperties = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none' }
const TH: React.CSSProperties = { textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.35rem 0.7rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }

interface Price { buy: number | null; sell: number | null }

export default function JitaPositions() {
  const { activeTokens: tokens } = useAuth()
  const [positions, setPositions] = useState<Position[]>(loadPositions)
  const [prices, setPrices] = useState<Map<number, Price>>(new Map())
  const [loading, setLoading] = useState(false)
  const [presetIdx, setPresetIdx] = useState(2)
  const fees = PRESETS[presetIdx]

  // Toevoeg-formulier
  const [q, setQ] = useState('')
  const [qty, setQty] = useState('1')
  const [buyPrice, setBuyPrice] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refreshPrices = useCallback(async (list: Position[]) => {
    const typeIds = [...new Set(list.map(p => p.typeId))]
    if (typeIds.length === 0) { setPrices(new Map()); return }
    setLoading(true)
    try {
      const map = new Map<number, Price>()
      await Promise.all(typeIds.map(async id => {
        const orders = (await getRegionOrders(THE_FORGE, id).catch(() => [])).filter(o => o.location_id === JITA_STATION)
        const sells = orders.filter(o => !o.is_buy_order).map(o => o.price)
        const buys = orders.filter(o => o.is_buy_order).map(o => o.price)
        map.set(id, { sell: sells.length ? Math.min(...sells) : null, buy: buys.length ? Math.max(...buys) : null })
      }))
      setPrices(map)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { refreshPrices(positions) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    const name = q.trim(); const nQty = parseInt(qty) || 0; const nPrice = parseFloat(buyPrice.replace(',', '.')) || 0
    if (!name) { setErr('Vul een itemnaam in.'); return }
    if (nQty < 1 || nPrice <= 0) { setErr('Vul een geldig aantal en koopprijs in.'); return }
    setAdding(true); setErr(null)
    try {
      const ids = await resolveTypeIds([name])
      const typeId = ids.get(name.toLowerCase())
      if (!typeId) { setErr(`Geen item gevonden voor "${name}" (exacte naam).`); return }
      const names = await resolveNames([typeId])
      addPosition({ typeId, name: names.get(typeId) ?? name, qty: nQty, buyPrice: nPrice })
      const next = loadPositions()
      setPositions(next); setQ(''); setQty('1'); setBuyPrice('')
      refreshPrices(next)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fout bij toevoegen') }
    finally { setAdding(false) }
  }

  function remove(id: string) { removePosition(id); setPositions(loadPositions()) }

  async function openMarket(typeId: number) {
    const t = tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }

  // Bereken per positie de huidige waarde (verkoop @ best sell na fees) en W/V.
  const rows = useMemo(() => positions.map(p => {
    const px = prices.get(p.typeId)
    const cost = p.qty * p.buyPrice
    const sellNow = px?.sell ?? null
    const revenue = sellNow !== null ? p.qty * sellNow * (1 - fees.broker - fees.tax) : null
    const pnl = revenue !== null ? revenue - cost : null
    const pnlPct = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null
    return { ...p, cost, sellNow, revenue, pnl, pnlPct }
  }), [positions, prices, fees])

  const totals = useMemo(() => {
    let cost = 0, value = 0, known = 0
    for (const r of rows) { cost += r.cost; if (r.revenue !== null) { value += r.revenue; known += r.cost } }
    return { cost, value, pnl: value - known, hasValue: known > 0 }
  }, [rows])

  return (
    <Layout header={<PageHeader title="Mijn posities" sub="Je aankopen met live winst/verlies op Jita 4-4" />}>
      <div style={{ maxWidth: 1000 }}>
        {/* Toevoegen */}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '0.5rem', padding: '0.7rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={LABEL}>Item (exacte naam)</div>
            <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder='bv. "PLEX"' style={{ ...INPUT, width: '100%' }} />
          </div>
          <div style={{ width: 90 }}>
            <div style={LABEL}>Aantal</div>
            <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} style={{ ...INPUT, width: '100%' }} />
          </div>
          <div style={{ width: 130 }}>
            <div style={LABEL}>Koopprijs / stuk</div>
            <input value={buyPrice} onChange={e => setBuyPrice(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="ISK" style={{ ...INPUT, width: '100%' }} />
          </div>
          <button onClick={add} disabled={adding} style={{ padding: '0.45rem 0.9rem', borderRadius: 2, border: 0, background: 'var(--blue)', color: '#04121f', fontWeight: 700, cursor: 'pointer', fontSize: '0.72rem', opacity: adding ? 0.6 : 1 }}>
            {adding ? '…' : '+ Bewaar aankoop'}
          </button>
        </div>
        {err && <div style={{ color: '#ff5c6c', fontSize: '0.72rem', marginBottom: '0.6rem' }}>{err}</div>}

        {/* Fees + refresh */}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
          <span style={{ ...LABEL, marginBottom: 0 }}>FEES:</span>
          {PRESETS.map((p, i) => (
            <button key={p.label} onClick={() => setPresetIdx(i)} style={{
              padding: '0.2rem 0.5rem', borderRadius: 2, fontSize: '0.63rem', cursor: 'pointer', fontWeight: 600,
              background: presetIdx === i ? 'rgba(0,180,216,0.15)' : 'transparent',
              border: `1px solid ${presetIdx === i ? 'var(--blue)' : 'var(--border)'}`,
              color: presetIdx === i ? 'var(--blue)' : 'var(--text-dim)',
            }}>{p.label}</button>
          ))}
          <button onClick={() => refreshPrices(positions)} disabled={loading} style={{ marginLeft: 'auto', padding: '0.35rem 0.8rem', borderRadius: 2, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.7rem' }}>
            {loading ? 'Prijzen laden…' : '↻ Ververs prijzen'}
          </button>
        </div>

        {rows.length === 0 ? (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            Nog geen posities. Voeg hierboven een aankoop toe (of gebruik de knop op de Jita Scanner na het opzoeken van een item).
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: 'var(--surface)' }}>
                  <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                  <th style={TH}>Aantal</th>
                  <th style={TH}>Koopprijs</th>
                  <th style={TH}>Kostprijs</th>
                  <th style={TH}>Huidige sell</th>
                  <th style={TH}>Waarde nu (na fees)</th>
                  <th style={TH}>Winst/verlies</th>
                  <th style={{ ...TH, textAlign: 'left' }}>Advies</th>
                  <th style={TH}></th>
                </tr></thead>
                <tbody>
                  {rows.map(r => {
                    const good = r.pnl !== null && r.pnl > 0
                    const advies = r.pnl === null ? { t: '—', c: 'var(--text-dim)' }
                      : good ? { t: 'Verkoopbaar met winst', c: '#4ade80' }
                      : { t: 'Verlies — wacht', c: '#ff5c6c' }
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...TD, textAlign: 'left' }}>
                          <button onClick={() => openMarket(r.typeId)} title="Open in-game marktvenster" style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>{r.name}</button>
                        </td>
                        <td style={TD}>{r.qty.toLocaleString('nl-NL')}</td>
                        <td style={TD}>{fmtISK(r.buyPrice)}</td>
                        <td style={TD}>{fmtISK(r.cost)}</td>
                        <td style={TD}>{r.sellNow !== null ? fmtISK(r.sellNow) : '—'}</td>
                        <td style={TD}>{r.revenue !== null ? fmtISK(r.revenue) : '—'}</td>
                        <td style={{ ...TD, color: r.pnl === null ? 'var(--text)' : good ? '#4ade80' : '#ff5c6c', fontWeight: 700 }}>
                          {r.pnl !== null ? `${fmtISK(r.pnl)}${r.pnlPct !== null ? ` (${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%)` : ''}` : '—'}
                        </td>
                        <td style={{ ...TD, textAlign: 'left', color: advies.c, fontWeight: 700 }}>{advies.t}</td>
                        <td style={{ ...TD }}>
                          <button onClick={() => remove(r.id)} title="Verwijderen (verkocht/annuleren)" style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}>✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginTop: '0.7rem', fontSize: '0.78rem' }}>
              <span>Totaal ingelegd: <b>{fmtISK(totals.cost)}</b></span>
              {totals.hasValue && <span>Huidige waarde: <b>{fmtISK(totals.value)}</b></span>}
              {totals.hasValue && <span>Totaal W/V: <b style={{ color: totals.pnl >= 0 ? '#4ade80' : '#ff5c6c' }}>{fmtISK(totals.pnl)}</b></span>}
            </div>
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
              "Waarde nu" = verkoop tegen de huidige laagste sell-prijs, ná broker fee + sales tax. Lokaal opgeslagen in je browser. Verwijder een regel als je hebt verkocht.
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
