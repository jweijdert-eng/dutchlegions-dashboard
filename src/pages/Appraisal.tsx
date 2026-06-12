import { useState, useRef } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { resolveTypeIds, getRegionOrders, getStructureOrders, searchStructure, findStructuresBySystem, findInStructureCache, resolveSystemId, getStructureInfo, getStructureName, getAssets } from '../api/esi'
import { fmtISK, parseItemLines, pLimit } from '../utils/market'
import { useAuth } from '../auth/AuthContext'

const STATIC_MARKETS = [
  { label: 'Jita',    regionId: 10000002, stationId: 60003760,  structureId: null as number | null },
  { label: 'Amarr',   regionId: 10000043, stationId: 60008494,  structureId: null },
  { label: 'Dodixie', regionId: 10000032, stationId: 60011866,  structureId: null },
  { label: 'Rens',    regionId: 10000030, stationId: 60004588,  structureId: null },
  { label: 'Hek',     regionId: 10000042, stationId: 60005686,  structureId: null },
]

interface CustomMarket {
  label: string
  structureId: number
  regionId: null
  stationId: null
}

type Market = typeof STATIC_MARKETS[number] | CustomMarket

interface ResultRow {
  name: string
  qty: number
  sell: number | null
  buy: number | null
}

export default function Appraisal() {
  const { activeTokens } = useAuth()
  const token  = activeTokens[0]?.accessToken ?? null
  const charId = activeTokens[0]?.characterId ?? null

  const [input, setInput]             = useState('')
  const [markets, setMarkets]         = useState<Market[]>(STATIC_MARKETS)
  const [marketIdx, setMarketIdx]     = useState(0)
  const [rows, setRows]               = useState<ResultRow[]>([])
  const [loading, setLoading]         = useState(false)
  const [progress, setProgress]       = useState('')
  const [sortCol, setSortCol]         = useState<'name' | 'qty' | 'sell' | 'buy' | 'totalSell' | 'totalBuy'>('totalSell')
  const [sortAsc, setSortAsc]         = useState(false)

  // Structure search state
  const [structSearch, setStructSearch] = useState('')
  const [structIdInput, setStructIdInput] = useState('')
  const [structResults, setStructResults] = useState<Array<{ id: number; name: string }>>([])
  const [structSearching, setStructSearching] = useState(false)
  const [structError, setStructError] = useState('')
  const [showStructPanel, setShowStructPanel] = useState(false)

  const abortRef = useRef(false)
  const structAbortRef = useRef<AbortController | null>(null)
  const [structSearchPct, setStructSearchPct] = useState(0)
  const [cacheLoading, setCacheLoading] = useState(false)
  const market = markets[marketIdx]

  async function appraise() {
    const items = parseItemLines(input)
    if (items.length === 0) return

    setLoading(true)
    setRows([])
    abortRef.current = false
    setProgress(`Namen oplossen (${items.length} items)...`)

    const nameMap = await resolveTypeIds(items.map(i => i.name))
    const resolved = items.map(i => ({ ...i, typeId: nameMap.get(i.name.toLowerCase()) ?? null }))
    const unknown = resolved.filter(i => !i.typeId)

    // For structure markets, fetch all orders once and index by type_id
    let structOrderMap: Map<number, { sell: number[]; buy: number[] }> | null = null
    if (market.structureId && token) {
      setProgress('Structuur orders ophalen...')
      const allOrders = await getStructureOrders(market.structureId, token)
      if (allOrders.length === 0) {
        setProgress('Geen orders gevonden. Mogelijk ontbreekt de scope — herlog in om toegang te krijgen.')
        setLoading(false)
        return
      }
      structOrderMap = new Map()
      for (const o of allOrders) {
        if (!structOrderMap.has(o.type_id)) structOrderMap.set(o.type_id, { sell: [], buy: [] })
        const entry = structOrderMap.get(o.type_id)!
        if (o.is_buy_order) entry.buy.push(o.price)
        else entry.sell.push(o.price)
      }
    }

    let done = 0
    const knownItems = resolved.filter(i => i.typeId !== null)

    const tasks = knownItems.map(item => async (): Promise<ResultRow> => {
      if (abortRef.current) return { name: item.name, qty: item.qty, sell: null, buy: null }

      let sell: number | null = null
      let buy: number | null = null

      if (structOrderMap) {
        const entry = structOrderMap.get(item.typeId!)
        sell = entry?.sell.length ? Math.min(...entry.sell) : null
        buy  = entry?.buy.length  ? Math.max(...entry.buy)  : null
      } else if (market.regionId !== null) {
        const orders  = await getRegionOrders(market.regionId, item.typeId!)
        const station = orders.filter(o => o.location_id === market.stationId)
        const sells   = station.filter(o => !o.is_buy_order).map(o => o.price)
        const buys    = station.filter(o =>  o.is_buy_order).map(o => o.price)
        sell = sells.length ? Math.min(...sells) : null
        buy  = buys.length  ? Math.max(...buys)  : null
      }

      done++
      setProgress(`Marktdata ophalen... ${done}/${knownItems.length}`)
      return { name: item.name, qty: item.qty, sell, buy }
    })

    const results = await pLimit(tasks, structOrderMap ? 999 : 8)
    for (const item of unknown) results.push({ name: item.name, qty: item.qty, sell: null, buy: null })

    setRows(results)
    setLoading(false)
    setProgress('')
  }

  async function searchStructures() {
    if (!structSearch.trim() || !token || !charId) return
    setStructSearching(true)
    setStructResults([])
    setStructError('')
    setStructSearchPct(0)

    // 1. Check in-memory cache (instant)
    const systemId = await resolveSystemId(structSearch.trim())
    if (systemId) {
      const cached = findInStructureCache(systemId)
      if (cached.length > 0) { setStructResults(cached); setStructSearching(false); return }
    }

    // 2. ESI character search — werkt na herlogin met esi-search.search_structures.v1
    const { ids, forbidden } = await searchStructure(charId, token, structSearch.trim())
    if (forbidden) {
      setStructError('HERLOGIN_NEEDED')
      setStructSearching(false)
      return
    }
    if (ids.length > 0) {
      const resolved = await Promise.all(ids.slice(0, 10).map(async id => {
        const name = await getStructureName(id, token)
        return { id, name: name ?? `Structure ${id}` }
      }))
      setStructResults(systemId ? resolved.filter(r =>
        findInStructureCache(systemId).some(c => c.id === r.id) || true
      ) : resolved)
      setStructSearching(false)
      return
    }

    // 3. Zoek via karakter-activiteit (assets, orders, transacties)
    if (systemId) {
      const fast = await findStructuresBySystem(charId, token, systemId)
      if (fast.length > 0) { setStructResults(fast); setStructSearching(false); return }
    }

    setStructError('Niet gevonden. Herlog in om structuurzoeken te activeren.')
    setStructSearching(false)
  }

  async function loadStructureCache() {
    if (!charId || !token) return
    setCacheLoading(true)
    const assets = await getAssets(charId, token)
    const structIds = [...new Set(assets.map(a => a.location_id).filter(id => id > 1_000_000_000))]
    await Promise.all(structIds.map(id => getStructureInfo(id, token)))
    setCacheLoading(false)
    // Auto-search if there's a query
    if (structSearch.trim()) searchStructures()
  }

  function cancelStructSearch() {
    structAbortRef.current?.abort()
    setStructSearching(false)
    setStructSearchPct(0)
  }

  async function addStructureById() {
    const id = parseInt(structIdInput.trim())
    if (!id || !token) return
    setStructSearching(true)
    setStructError('')
    const info = await getStructureInfo(id, token)
    if (!info) {
      setStructError('Structuur niet gevonden of geen toegang.')
      setStructSearching(false)
      return
    }
    addStructure(id, info.name)
    setStructIdInput('')
    setStructSearching(false)
  }

  function addStructure(id: number, name: string) {
    const short = name.length > 28 ? name.slice(0, 26) + '…' : name
    const exists = markets.findIndex(m => m.structureId === id)
    if (exists >= 0) { setMarketIdx(exists); setShowStructPanel(false); return }
    const updated: Market[] = [...markets, { label: short, structureId: id, regionId: null, stationId: null }]
    setMarkets(updated)
    setMarketIdx(updated.length - 1)
    setShowStructPanel(false)
    setStructSearch('')
    setStructResults([])
  }

  function toggleSort(col: typeof sortCol) {
    if (sortCol === col) setSortAsc(v => !v)
    else { setSortCol(col); setSortAsc(false) }
  }

  const sorted = [...rows].sort((a, b) => {
    if (sortCol === 'name') return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    const vals: Record<Exclude<typeof sortCol, 'name'>, [number, number]> = {
      qty:       [a.qty,              b.qty],
      sell:      [a.sell ?? -1,       b.sell ?? -1],
      buy:       [a.buy  ?? -1,       b.buy  ?? -1],
      totalSell: [(a.sell ?? 0)*a.qty, (b.sell ?? 0)*b.qty],
      totalBuy:  [(a.buy  ?? 0)*a.qty, (b.buy  ?? 0)*b.qty],
    }
    const [va, vb] = vals[sortCol]
    return sortAsc ? va - vb : vb - va
  })

  const totalSell = rows.reduce((s, r) => s + (r.sell ?? 0) * r.qty, 0)
  const totalBuy  = rows.reduce((s, r) => s + (r.buy  ?? 0) * r.qty, 0)

  function SortArrow({ col }: { col: typeof sortCol }) {
    if (sortCol !== col) return <span style={{ opacity: 0.2, marginLeft: 4 }}>↕</span>
    return <span style={{ marginLeft: 4, color: 'var(--blue)' }}>{sortAsc ? '↑' : '↓'}</span>
  }

  const thStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem', textAlign: 'left', fontSize: '0.65rem',
    color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.08em',
    borderBottom: '1px solid var(--border)', cursor: 'pointer', userSelect: 'none',
    whiteSpace: 'nowrap',
  }

  return (
    <Layout header={<PageHeader title="APPRAISAL" sub="Plak items uit EVE clipboard" />}>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>

        {/* Left panel */}
        <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', padding: '1rem' }}>

          {/* Market selector */}
          <div style={{ marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.5rem', letterSpacing: '0.06em', fontWeight: 600 }}>MARKT</div>
            <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
              {markets.map((m, i) => (
                <button
                  key={i}
                  onClick={() => setMarketIdx(i)}
                  style={{
                    padding: '0.25rem 0.625rem', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                    background: marketIdx === i ? 'rgba(0,180,216,0.15)' : 'transparent',
                    border: `1px solid ${marketIdx === i ? 'rgba(0,180,216,0.4)' : 'var(--border)'}`,
                    color: marketIdx === i ? 'var(--blue)' : 'var(--text-dim)',
                    position: 'relative',
                  }}
                  title={m.structureId ? `Structure ID: ${m.structureId}` : undefined}
                >
                  {m.label}
                  {m.structureId && <span style={{ marginLeft: 3, fontSize: '0.55rem', opacity: 0.7 }}>🏰</span>}
                </button>
              ))}

              {/* Add structure button */}
              <button
                onClick={() => setShowStructPanel(v => !v)}
                style={{
                  padding: '0.25rem 0.5rem', borderRadius: 3, fontSize: '0.72rem', cursor: 'pointer',
                  background: showStructPanel ? 'rgba(0,180,216,0.1)' : 'transparent',
                  border: `1px solid ${showStructPanel ? 'rgba(0,180,216,0.3)' : 'var(--border)'}`,
                  color: 'var(--text-dim)',
                }}
                title="Structuur toevoegen"
              >+</button>
            </div>

            {/* Structure search panel */}
            {showStructPanel && (
              <div style={{ marginTop: '0.5rem', padding: '0.625rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 4 }}>
                {!token ? (
                  <div style={{ fontSize: '0.68rem', color: 'var(--red, #e05555)' }}>Inloggen vereist</div>
                ) : (
                  <>
                    {/* Direct ID input */}
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>Structuur-ID (uit EVE)</div>
                    <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '0.5rem' }}>
                      <input
                        value={structIdInput}
                        onChange={e => setStructIdInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && addStructureById()}
                        placeholder="bv. 1038457891234"
                        style={{
                          flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                          borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.5rem',
                          fontFamily: 'inherit', outline: 'none',
                        }}
                      />
                      <button
                        onClick={addStructureById}
                        disabled={structSearching || !structIdInput.trim()}
                        style={{
                          padding: '0.3rem 0.5rem', borderRadius: 3, fontSize: '0.72rem', cursor: 'pointer',
                          background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.25)',
                          color: 'var(--blue)',
                        }}
                      >{structSearching ? '...' : '+'}</button>
                    </div>

                    {/* Pre-load cache */}
                    <button
                      onClick={loadStructureCache}
                      disabled={cacheLoading}
                      style={{
                        width: '100%', marginBottom: '0.5rem', padding: '0.3rem',
                        borderRadius: 3, fontSize: '0.68rem', fontWeight: 600, cursor: cacheLoading ? 'wait' : 'pointer',
                        background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                        color: cacheLoading ? 'var(--text-dim)' : 'var(--text)',
                      }}
                    >
                      {cacheLoading ? 'Structuren laden...' : '⟳ Assets laden (vereist voor onbekende structuren)'}
                    </button>

                    {/* Name search */}
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>Zoek op naam of systeem</div>
                    <div style={{ display: 'flex', gap: '0.375rem' }}>
                      <input
                        value={structSearch}
                        onChange={e => setStructSearch(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !structSearching && searchStructures()}
                        placeholder="Holy Procurer of 3T7-M8..."
                        style={{
                          flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                          borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.5rem',
                          fontFamily: 'inherit', outline: 'none',
                        }}
                      />
                      {structSearching ? (
                        <button onClick={cancelStructSearch} style={{ padding: '0.3rem 0.5rem', borderRadius: 3, fontSize: '0.72rem', cursor: 'pointer', background: 'rgba(224,85,85,0.1)', border: '1px solid rgba(224,85,85,0.25)', color: 'var(--red, #e05555)' }}>✕</button>
                      ) : (
                        <button onClick={searchStructures} disabled={!structSearch.trim()} style={{ padding: '0.3rem 0.5rem', borderRadius: 3, fontSize: '0.72rem', cursor: 'pointer', background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.25)', color: 'var(--blue)' }}>↵</button>
                      )}
                    </div>

                    {structSearching && (
                      <div style={{ marginTop: '0.375rem' }}>
                        <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${structSearchPct}%`, background: 'var(--blue)', transition: 'width 0.2s' }} />
                        </div>
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>Zoeken... {structSearchPct}%</div>
                      </div>
                    )}

                    {structError && !structSearching && (
                      structError === 'HERLOGIN_NEEDED' ? (
                        <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.25)', borderRadius: 3 }}>
                          <div style={{ fontSize: '0.65rem', color: 'var(--red, #e05555)', marginBottom: '0.4rem' }}>
                            Structuurzoeken vereist herlogin (nieuwe scope).
                          </div>
                          <a
                            href="/login"
                            style={{
                              display: 'block', textAlign: 'center', textDecoration: 'none',
                              background: 'rgba(224,85,85,0.12)', border: '1px solid rgba(224,85,85,0.3)',
                              color: 'var(--red, #e05555)', borderRadius: 2, fontSize: '0.68rem',
                              padding: '0.3rem', fontWeight: 600,
                            }}
                          >
                            ↻ Opnieuw inloggen
                          </a>
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.65rem', color: 'var(--red, #e05555)', marginTop: '0.375rem' }}>{structError}</div>
                      )
                    )}

                    {structResults.length > 0 && (
                      <div style={{ marginTop: '0.375rem' }}>
                        {structResults.map(r => (
                          <button
                            key={r.id}
                            onClick={() => addStructure(r.id, r.name)}
                            style={{
                              width: '100%', textAlign: 'left', padding: '0.35rem 0.5rem',
                              background: 'transparent', border: 'none', borderRadius: 3, cursor: 'pointer',
                              color: 'var(--text)', fontSize: '0.7rem', display: 'block',
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,180,216,0.08)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                            <div style={{ color: 'var(--text-dim)', fontSize: '0.6rem' }}>{r.id}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Items textarea */}
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.4rem', letterSpacing: '0.06em', fontWeight: 600 }}>ITEMS</div>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={'Plak items hier...\n\nFormaten:\n• EVE clipboard (Ctrl+C)\n• Naam per regel\n• Naam x Hoeveelheid'}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
              borderRadius: 4, color: 'var(--text)', fontSize: '0.78rem', lineHeight: 1.6,
              padding: '0.75rem', resize: 'none', fontFamily: 'inherit', outline: 'none',
              marginBottom: '0.75rem',
            }}
            onFocus={e => e.currentTarget.style.borderColor = 'rgba(0,180,216,0.4)'}
            onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
          />

          <button
            onClick={appraise}
            disabled={loading || !input.trim()}
            style={{
              width: '100%', padding: '0.55rem', borderRadius: 4,
              background: loading || !input.trim() ? 'rgba(0,180,216,0.04)' : 'rgba(0,180,216,0.12)',
              border: `1px solid ${loading || !input.trim() ? 'rgba(0,180,216,0.1)' : 'rgba(0,180,216,0.3)'}`,
              color: loading || !input.trim() ? 'var(--border)' : 'var(--blue)',
              fontSize: '0.8rem', fontWeight: 700, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              letterSpacing: '0.06em',
            }}
          >
            {loading ? progress || 'Bezig...' : 'APPRAISAL'}
          </button>

          {rows.length > 0 && !loading && (
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Sell totaal</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text)' }}>{fmtISK(totalSell)} ISK</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Buy totaal</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text)' }}>{fmtISK(totalBuy)} ISK</span>
              </div>
            </div>
          )}
        </div>

        {/* Results table */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {rows.length === 0 && !loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Plak items en klik APPRAISAL
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle} onClick={() => toggleSort('name')}>ITEM <SortArrow col="name" /></th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('qty')}>AANTAL <SortArrow col="qty" /></th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('sell')}>SELL/STUK <SortArrow col="sell" /></th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('buy')}>BUY/STUK <SortArrow col="buy" /></th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('totalSell')}>SELL TOTAAL <SortArrow col="totalSell" /></th>
                  <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => toggleSort('totalBuy')}>BUY TOTAAL <SortArrow col="totalBuy" /></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const noData = row.sell === null && row.buy === null
                  return (
                    <tr key={row.name} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                      <td style={{ padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: noData ? 'var(--text-dim)' : 'var(--text)' }}>
                        {row.name}
                        {noData && <span style={{ marginLeft: '0.4rem', fontSize: '0.62rem', color: 'var(--red, #e05555)' }}>niet gevonden</span>}
                      </td>
                      <td style={{ padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: 'var(--text-dim)', textAlign: 'right' }}>
                        {row.qty.toLocaleString('nl-NL')}
                      </td>
                      <td style={{ padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {row.sell !== null ? fmtISK(row.sell) : '—'}
                      </td>
                      <td style={{ padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {row.buy !== null ? fmtISK(row.buy) : '—'}
                      </td>
                      <td style={{ padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: row.sell !== null ? 'var(--green, #4ade80)' : 'var(--text-dim)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {row.sell !== null ? fmtISK(row.sell * row.qty) : '—'}
                      </td>
                      <td style={{ padding: '0.45rem 0.75rem', fontSize: '0.78rem', color: row.buy !== null ? '#f59e0b' : 'var(--text-dim)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {row.buy !== null ? fmtISK(row.buy * row.qty) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {rows.length > 1 && (
                <tfoot>
                  <tr style={{ borderTop: '1px solid var(--border)' }}>
                    <td colSpan={4} style={{ padding: '0.6rem 0.75rem', fontSize: '0.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>
                      TOTAAL ({rows.length} items)
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: 'var(--green, #4ade80)', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtISK(totalSell)} ISK
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem', fontSize: '0.82rem', color: '#f59e0b', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtISK(totalBuy)} ISK
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}
