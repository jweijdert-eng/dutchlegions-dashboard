import { useState, useRef } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { resolveTypeIds, getRegionOrders } from '../api/esi'
import { fmtISK, parseItemLines, pLimit } from '../utils/market'

const MARKETS = [
  { label: 'Jita',    regionId: 10000002, stationId: 60003760 },
  { label: 'Amarr',   regionId: 10000043, stationId: 60008494 },
  { label: 'Dodixie', regionId: 10000032, stationId: 60011866 },
  { label: 'Rens',    regionId: 10000030, stationId: 60004588 },
  { label: 'Hek',     regionId: 10000042, stationId: 60005686 },
]

interface Row {
  name: string
  qty: number
  sell: number | null
  buy: number | null
}

export default function CargoScanner() {
  const [text, setText]           = useState('')
  const [rows, setRows]           = useState<Row[]>([])
  const [loading, setLoading]     = useState(false)
  const [progress, setProgress]   = useState('')
  const [marketIdx, setMarketIdx] = useState(0)
  const abortRef = useRef(false)

  const market = MARKETS[marketIdx]

  async function run(raw: string) {
    const items = parseItemLines(raw)
    if (items.length === 0) { setRows([]); return }

    setLoading(true)
    setRows([])
    abortRef.current = false
    setProgress(`Namen oplossen...`)

    const nameMap  = await resolveTypeIds(items.map(i => i.name))
    const resolved = items.map(i => ({ ...i, typeId: nameMap.get(i.name.toLowerCase()) ?? null }))
    const known    = resolved.filter(i => i.typeId !== null)
    const unknown  = resolved.filter(i => i.typeId === null)

    let done = 0
    const tasks = known.map(item => async (): Promise<Row> => {
      if (abortRef.current) return { name: item.name, qty: item.qty, sell: null, buy: null }
      const orders  = await getRegionOrders(market.regionId, item.typeId!)
      const station = orders.filter(o => o.location_id === market.stationId)
      const sells   = station.filter(o => !o.is_buy_order).map(o => o.price)
      const buys    = station.filter(o =>  o.is_buy_order).map(o => o.price)
      done++
      setProgress(`Marktdata... ${done}/${known.length}`)
      return {
        name: item.name,
        qty: item.qty,
        sell: sells.length ? Math.min(...sells) : null,
        buy:  buys.length  ? Math.max(...buys)  : null,
      }
    })

    const results = await pLimit(tasks, 8)
    for (const item of unknown) results.push({ name: item.name, qty: item.qty, sell: null, buy: null })

    results.sort((a, b) => (b.sell ?? 0) * b.qty - (a.sell ?? 0) * a.qty)
    setRows(results)
    setLoading(false)
    setProgress('')
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = e.clipboardData.getData('text')
    setText(pasted)
    e.preventDefault()
    run(pasted)
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value)
  }

  function handleMarket(i: number) {
    setMarketIdx(i)
    if (text.trim()) run(text)
  }

  const totalSell = rows.reduce((s, r) => s + (r.sell ?? 0) * r.qty, 0)
  const totalBuy  = rows.reduce((s, r) => s + (r.buy  ?? 0) * r.qty, 0)

  return (
    <Layout header={<PageHeader title="CARGO SCANNER" sub="Plak cargo scan — directe waardebepaling" />}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

        {/* Top bar: market + totals */}
        <div style={{ padding: '0.75rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '1.5rem', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '0.375rem' }}>
            {MARKETS.map((m, i) => (
              <button
                key={m.label}
                onClick={() => handleMarket(i)}
                style={{
                  padding: '0.2rem 0.6rem', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                  background: marketIdx === i ? 'rgba(0,180,216,0.15)' : 'transparent',
                  border: `1px solid ${marketIdx === i ? 'rgba(0,180,216,0.4)' : 'var(--border)'}`,
                  color: marketIdx === i ? 'var(--blue)' : 'var(--text-dim)',
                }}
              >{m.label}</button>
            ))}
          </div>

          {rows.length > 0 && !loading && (
            <div style={{ display: 'flex', gap: '1.5rem', marginLeft: 'auto' }}>
              <div>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginRight: '0.4rem' }}>SELL</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--green, #4ade80)', fontVariantNumeric: 'tabular-nums' }}>{fmtISK(totalSell)} ISK</span>
              </div>
              <div>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginRight: '0.4rem' }}>BUY</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>{fmtISK(totalBuy)} ISK</span>
              </div>
            </div>
          )}

          {loading && (
            <div style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-dim)' }}>{progress}</div>
          )}
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* Paste area */}
          <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '0.75rem', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginBottom: '0.4rem', letterSpacing: '0.06em', fontWeight: 600 }}>CARGO SCAN / ITEMS</div>
            <textarea
              value={text}
              onChange={handleChange}
              onPaste={handlePaste}
              placeholder={'Ctrl+V cargo scan hier\nof typ items handmatig\n\nFormaten:\n• Cargo scanner output\n• EVE clipboard\n• Naam per regel\n• 5x Tritanium'}
              style={{
                flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                borderRadius: 4, color: 'var(--text)', fontSize: '0.75rem', lineHeight: 1.6,
                padding: '0.625rem', resize: 'none', fontFamily: 'inherit', outline: 'none',
              }}
              onFocus={e => e.currentTarget.style.borderColor = 'rgba(0,180,216,0.4)'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
            />
            {text.trim() && (
              <button
                onClick={() => run(text)}
                disabled={loading}
                style={{
                  marginTop: '0.5rem', padding: '0.4rem', borderRadius: 3, fontSize: '0.75rem', fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.25)', color: 'var(--blue)',
                }}
              >{loading ? progress || '...' : '↻ Herbereken'}</button>
            )}
          </div>

          {/* Results */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {rows.length === 0 && !loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: '0.5rem', color: 'var(--text-dim)' }}>
                <div style={{ fontSize: '2rem', opacity: 0.2 }}>◎</div>
                <div style={{ fontSize: '0.8rem' }}>Plak een cargo scan (Ctrl+V)</div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>ITEM</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>AANTAL</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>SELL/STUK</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>BUY/STUK</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>SELL TOTAAL</th>
                    <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>BUY TOTAAL</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const noData = row.sell === null && row.buy === null
                    return (
                      <tr key={row.name} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                        <td style={{ padding: '0.4rem 0.75rem', fontSize: '0.78rem', color: noData ? 'var(--text-dim)' : 'var(--text)' }}>
                          {row.name}
                          {noData && <span style={{ marginLeft: '0.4rem', fontSize: '0.6rem', color: 'var(--red, #e05555)' }}>onbekend</span>}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', fontSize: '0.78rem', color: 'var(--text-dim)', textAlign: 'right' }}>
                          {row.qty.toLocaleString('nl-NL')}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', fontSize: '0.78rem', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {row.sell !== null ? fmtISK(row.sell) : '—'}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', fontSize: '0.78rem', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {row.buy !== null ? fmtISK(row.buy) : '—'}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600, color: row.sell !== null ? 'var(--green, #4ade80)' : 'var(--text-dim)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {row.sell !== null ? fmtISK(row.sell * row.qty) : '—'}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', fontSize: '0.82rem', fontWeight: 600, color: row.buy !== null ? '#f59e0b' : 'var(--text-dim)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {row.buy !== null ? fmtISK(row.buy * row.qty) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {rows.length > 1 && (
                  <tfoot>
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td colSpan={4} style={{ padding: '0.55rem 0.75rem', fontSize: '0.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>
                        TOTAAL ({rows.length} items)
                      </td>
                      <td style={{ padding: '0.55rem 0.75rem', fontSize: '0.85rem', color: 'var(--green, #4ade80)', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        {fmtISK(totalSell)} ISK
                      </td>
                      <td style={{ padding: '0.55rem 0.75rem', fontSize: '0.85rem', color: '#f59e0b', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        {fmtISK(totalBuy)} ISK
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
}
