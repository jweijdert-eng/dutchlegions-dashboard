import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import {
  getRegionOrders, getTransactions, resolveTypeIds, resolveNames, openMarketWindow,
  type WalletTransaction,
} from '../api/esi'
import { loadPositions, addPosition, removePosition, updatePosition, type Position } from '../utils/jitaPositions'

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

// FIFO: gekochte lots aftrekken tegen verkopen → wat je nog in bezit hebt,
// met de gewogen gemiddelde koopprijs van de resterende lots. Alleen Jita 4-4.
function computeOpenPositions(txs: WalletTransaction[]): Array<{ typeId: number; qty: number; buyPrice: number }> {
  const byType = new Map<number, WalletTransaction[]>()
  for (const t of txs) {
    if (t.location_id !== JITA_STATION) continue
    const a = byType.get(t.type_id) ?? []; a.push(t); byType.set(t.type_id, a)
  }
  const out: Array<{ typeId: number; qty: number; buyPrice: number }> = []
  for (const [typeId, list] of byType) {
    list.sort((a, b) => +new Date(a.date) - +new Date(b.date))
    const lots: Array<{ qty: number; price: number }> = []
    for (const t of list) {
      if (t.is_buy) lots.push({ qty: t.quantity, price: t.unit_price })
      else {
        let rem = t.quantity
        while (rem > 0 && lots.length) {
          const lot = lots[0]; const take = Math.min(rem, lot.qty)
          lot.qty -= take; rem -= take; if (lot.qty <= 0) lots.shift()
        }
      }
    }
    const qty = lots.reduce((s, l) => s + l.qty, 0)
    if (qty <= 0) continue
    const cost = lots.reduce((s, l) => s + l.qty * l.price, 0)
    out.push({ typeId, qty, buyPrice: cost / qty })
  }
  return out
}

interface DisplayRow { key: string; source: 'auto' | 'manual'; manualId?: string; typeId: number; name: string; qty: number; buyPrice: number }

export default function JitaPositions() {
  const { activeTokens: tokens } = useAuth()
  const [manual, setManual] = useState<Position[]>(loadPositions)
  const [auto, setAuto] = useState<Array<{ typeId: number; name: string; qty: number; buyPrice: number }>>([])
  const [prices, setPrices] = useState<Map<number, Price>>(new Map())
  const [loading, setLoading] = useState(false)
  const [presetIdx, setPresetIdx] = useState(2)
  const fees = PRESETS[presetIdx]

  // Handmatig toevoegen
  const [q, setQ] = useState('')
  const [qty, setQty] = useState('1')
  const [buyPrice, setBuyPrice] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const man = loadPositions()
      setManual(man)

      // Automatisch: open posities uit wallet-transacties (alle characters).
      let autoPos: Array<{ typeId: number; name: string; qty: number; buyPrice: number }> = []
      if (tokens.length > 0) {
        const txs = (await Promise.all(
          tokens.map(t => getTransactions(t.characterId, t.accessToken).catch(() => [] as WalletTransaction[])),
        )).flat()
        const open = computeOpenPositions(txs)
        const names = await resolveNames(open.map(o => o.typeId))
        autoPos = open.map(o => ({ ...o, name: names.get(o.typeId) ?? `#${o.typeId}` }))
      }
      setAuto(autoPos)

      // Prijzen voor alle betrokken types.
      const typeIds = [...new Set([...autoPos.map(a => a.typeId), ...man.map(m => m.typeId)])]
      const map = new Map<number, Price>()
      await Promise.all(typeIds.map(async id => {
        const orders = (await getRegionOrders(THE_FORGE, id).catch(() => [])).filter(o => o.location_id === JITA_STATION)
        const sells = orders.filter(o => !o.is_buy_order).map(o => o.price)
        const buys = orders.filter(o => o.is_buy_order).map(o => o.price)
        map.set(id, { sell: sells.length ? Math.min(...sells) : null, buy: buys.length ? Math.max(...buys) : null })
      }))
      setPrices(map)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Kon posities niet laden')
    } finally { setLoading(false) }
  }, [tokens])

  useEffect(() => { refresh() }, [refresh])

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
      setQ(''); setQty('1'); setBuyPrice(''); refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fout bij toevoegen') }
    finally { setAdding(false) }
  }

  function remove(id: string) { removePosition(id); setManual(loadPositions()) }

  // Inline bewerken van een handmatige positie (aantal + koopprijs).
  const [editing, setEditing] = useState<string | null>(null)
  const [eQty, setEQty] = useState('')
  const [ePrice, setEPrice] = useState('')
  function startEdit(id: string, qty: number, price: number) {
    setEditing(id); setEQty(String(qty)); setEPrice(String(price)); setErr(null)
  }
  function saveEdit() {
    if (!editing) return
    const nQty = parseInt(eQty) || 0
    const nPrice = parseFloat(ePrice.replace(',', '.')) || 0
    if (nQty < 1 || nPrice <= 0) { setErr('Vul een geldig aantal en koopprijs in.'); return }
    updatePosition(editing, { qty: nQty, buyPrice: nPrice })
    setEditing(null); setManual(loadPositions())
  }

  async function openMarket(typeId: number) {
    const t = tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }

  const rows = useMemo<Array<DisplayRow & { cost: number; sellNow: number | null; revenue: number | null; pnl: number | null; pnlPct: number | null }>>(() => {
    const display: DisplayRow[] = [
      ...auto.map(a => ({ key: `a${a.typeId}`, source: 'auto' as const, typeId: a.typeId, name: a.name, qty: a.qty, buyPrice: a.buyPrice })),
      ...manual.map(m => ({ key: `m${m.id}`, source: 'manual' as const, manualId: m.id, typeId: m.typeId, name: m.name, qty: m.qty, buyPrice: m.buyPrice })),
    ]
    return display.map(d => {
      const px = prices.get(d.typeId)
      const cost = d.qty * d.buyPrice
      const sellNow = px?.sell ?? null
      const revenue = sellNow !== null ? d.qty * sellNow * (1 - fees.broker - fees.tax) : null
      const pnl = revenue !== null ? revenue - cost : null
      const pnlPct = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null
      return { ...d, cost, sellNow, revenue, pnl, pnlPct }
    })
  }, [auto, manual, prices, fees])

  const totals = useMemo(() => {
    let cost = 0, value = 0, known = 0
    for (const r of rows) { cost += r.cost; if (r.revenue !== null) { value += r.revenue; known += r.cost } }
    return { cost, value, pnl: value - known, hasValue: known > 0 }
  }, [rows])

  return (
    <Layout header={<PageHeader title="Mijn posities" sub="Open posities uit je wallet + handmatige aankopen, met live winst/verlies" />}>
      <div style={{ maxWidth: 1040 }}>
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
          <button onClick={refresh} disabled={loading} style={{ marginLeft: 'auto', padding: '0.35rem 0.8rem', borderRadius: 2, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.7rem' }}>
            {loading ? 'Laden…' : '↻ Ververs (uit wallet)'}
          </button>
        </div>

        {tokens.length === 0 && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '0.8rem' }}>
            Log in om je aankopen automatisch uit je wallet-transacties te halen. Zonder login kun je hieronder handmatig toevoegen.
          </div>
        )}
        {err && <div style={{ color: '#ff5c6c', fontSize: '0.72rem', marginBottom: '0.6rem' }}>{err}</div>}

        {rows.length === 0 && !loading ? (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
            Nog geen open posities gevonden. Koop iets op Jita 4-4 (verschijnt hier automatisch) of voeg hieronder handmatig toe.
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: 'var(--surface)' }}>
                  <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                  <th style={{ ...TH, textAlign: 'left' }}>Bron</th>
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
                    const isEditing = r.source === 'manual' && editing === r.manualId
                    const advies = r.pnl === null ? { t: '—', c: 'var(--text-dim)' }
                      : good ? { t: 'Verkoopbaar met winst', c: '#4ade80' }
                      : { t: 'Verlies — wacht', c: '#ff5c6c' }
                    return (
                      <tr key={r.key} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ ...TD, textAlign: 'left' }}>
                          <button onClick={() => openMarket(r.typeId)} title="Open in-game marktvenster" style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>{r.name}</button>
                        </td>
                        <td style={{ ...TD, textAlign: 'left', color: 'var(--text-dim)', fontSize: '0.65rem' }} title={r.source === 'auto' ? 'Automatisch uit wallet-transacties' : 'Handmatig toegevoegd'}>{r.source === 'auto' ? '🔄 wallet' : '✏️ hand'}</td>
                        <td style={TD}>
                          {isEditing
                            ? <input type="number" min={1} value={eQty} onChange={e => setEQty(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null) }}
                                autoFocus style={{ ...INPUT, width: 80, textAlign: 'right' }} />
                            : r.qty.toLocaleString('nl-NL')}
                        </td>
                        <td style={TD}>
                          {isEditing
                            ? <input value={ePrice} onChange={e => setEPrice(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null) }}
                                placeholder="ISK" style={{ ...INPUT, width: 110, textAlign: 'right' }} />
                            : fmtISK(r.buyPrice)}
                        </td>
                        <td style={TD}>{fmtISK(r.cost)}</td>
                        <td style={TD}>{r.sellNow !== null ? fmtISK(r.sellNow) : '—'}</td>
                        <td style={TD}>{r.revenue !== null ? fmtISK(r.revenue) : '—'}</td>
                        <td style={{ ...TD, color: r.pnl === null ? 'var(--text)' : good ? '#4ade80' : '#ff5c6c', fontWeight: 700 }}>
                          {r.pnl !== null ? `${fmtISK(r.pnl)}${r.pnlPct !== null ? ` (${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%)` : ''}` : '—'}
                        </td>
                        <td style={{ ...TD, textAlign: 'left', color: advies.c, fontWeight: 700 }}>{advies.t}</td>
                        <td style={TD}>
                          {r.source === 'manual' && r.manualId && (
                            isEditing ? (
                              <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                                <button onClick={saveEdit} title="Opslaan" style={{ background: 'rgba(74,222,128,0.15)', border: '1px solid #4ade80', borderRadius: 2, color: '#4ade80', cursor: 'pointer', fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}>✓</button>
                                <button onClick={() => setEditing(null)} title="Annuleren" style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}>✕</button>
                              </span>
                            ) : (
                              <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                                <button onClick={() => startEdit(r.manualId!, r.qty, r.buyPrice)} title="Bewerken" style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}>✏️</button>
                                <button onClick={() => remove(r.manualId!)} title="Verwijderen" style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}>🗑</button>
                              </span>
                            )
                          )}
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
              🔄 wallet = automatisch uit je transacties (gekocht − verkocht, FIFO, echte koopprijs). "Waarde nu" = verkoop tegen huidige laagste sell na broker fee + sales tax.
            </div>
          </>
        )}

        {/* Handmatig toevoegen (voor items buiten je transactie-venster) */}
        <details style={{ marginTop: '1.2rem' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: '0.68rem', letterSpacing: '0.06em' }}>Handmatig een aankoop toevoegen</summary>
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.5rem', padding: '0.7rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
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
              {adding ? '…' : '+ Toevoegen'}
            </button>
          </div>
        </details>
      </div>
    </Layout>
  )
}
