import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getBlueprints, resolveNames, type Blueprint } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

interface Material {
  typeId: number
  name: string
  quantity: number
  adjustedQty: number
  jitaSell: number | null
  jitaBuy: number | null
}

interface ProductInfo {
  typeId: number
  name: string
  quantity: number
  jitaSell: number | null
  jitaBuy: number | null
}

interface SdeMaterial { typeid: number; materialtypeid: number; quantity: number }
interface SdeProduct  { typeid: number; producttypeid: number; quantity: number }

interface FuzzAgg {
  buy:  { max: number; min: number }
  sell: { max: number; min: number }
}

// Blueprint-data (manufacturing) uit de SDE, gebundeld als /blueprints.json en met de
// site mee-gedeployd — geen lokale server nodig. Compact: { bpId: { m:[[matId,qty]], p:[prodId,qty] } }
type CompactBp = { m: [number, number][]; p: [number, number] }
let _bpCache: Record<string, CompactBp> | null = null
let _bpInflight: Promise<Record<string, CompactBp>> | null = null
function loadBlueprints(): Promise<Record<string, CompactBp>> {
  if (_bpCache) return Promise.resolve(_bpCache)
  if (!_bpInflight) {
    _bpInflight = fetch('/blueprints.json')
      .then(r => (r.ok ? r.json() : {}))
      .then((d: Record<string, CompactBp>) => { _bpCache = d; return d })
      .catch(() => ({}))
  }
  return _bpInflight
}

function fmtISK(v: number) {
  if (!isFinite(v) || v === 0) return '—'
  const abs = Math.abs(v)
  const s   = v < 0 ? '−' : ''
  if (abs >= 1e9) return `${s}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${s}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${s}${(abs / 1e3).toFixed(1)}K`
  return `${s}${abs.toFixed(2)}`
}

function applyME(qty: number, me: number): number {
  return Math.max(1, Math.ceil(qty * (1 - me / 100)))
}

async function fetchBlueprintData(bpTypeId: number): Promise<{ materials: SdeMaterial[]; product: SdeProduct | null; serverOffline: boolean; sdeError: string | null }> {
  const bps = await loadBlueprints()
  if (Object.keys(bps).length === 0) {
    return { materials: [], product: null, serverOffline: true, sdeError: null }   // data niet geladen
  }
  const bp = bps[String(bpTypeId)]
  if (!bp) {
    return { materials: [], product: null, serverOffline: false, sdeError: `Geen manufacturing-recept voor type ${bpTypeId}` }
  }
  return {
    materials: bp.m.map(([mat, qty]) => ({ typeid: bpTypeId, materialtypeid: mat, quantity: qty })),
    product:   { typeid: bpTypeId, producttypeid: bp.p[0], quantity: bp.p[1] },
    serverOffline: false,
    sdeError: null,
  }
}

async function fetchJitaPrices(typeIds: number[]): Promise<Map<number, { sell: number; buy: number }>> {
  if (typeIds.length === 0) return new Map()
  try {
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=${typeIds.join(',')}`)
    if (!r.ok) return new Map()
    const data = await r.json() as Record<string, FuzzAgg>
    const map = new Map<number, { sell: number; buy: number }>()
    for (const [idStr, agg] of Object.entries(data)) {
      map.set(parseInt(idStr), { sell: agg.sell.min, buy: agg.buy.max })
    }
    return map
  } catch { return new Map() }
}

// CCP's "adjusted price" per type — de basis voor de job-installatiekosten (EIV).
// Eén publieke ESI-call, module-gecached (verandert maar ~1× per dag).
let _adjCache: Map<number, number> | null = null
let _adjInflight: Promise<Map<number, number>> | null = null
function fetchAdjustedPrices(): Promise<Map<number, number>> {
  if (_adjCache) return Promise.resolve(_adjCache)
  if (!_adjInflight) {
    _adjInflight = fetch('https://esi.evetech.net/latest/markets/prices/?datasource=tranquility')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Array<{ type_id: number; adjusted_price?: number }>) => {
        const m = new Map<number, number>()
        for (const row of rows) if (row.adjusted_price != null) m.set(row.type_id, row.adjusted_price)
        _adjCache = m
        return m
      })
      .catch(() => new Map<number, number>())
  }
  return _adjInflight
}

// SCC-surcharge: vaste 4% van de EIV bovenop de job-kosten (sinds de industry-herziening).
const SCC_SURCHARGE = 0.04

const TH: React.CSSProperties = { fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', padding: '0.4rem 0.85rem', textAlign: 'left' }
const TD: React.CSSProperties = { padding: '0.45rem 0.85rem', borderTop: '1px solid rgba(28,28,53,0.5)', verticalAlign: 'middle' }
const LABEL: React.CSSProperties = { fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.3rem' }

export default function BuildvsBuy() {
  const { activeTokens: tokens } = useAuth()
  const [blueprints, setBlueprints] = useState<(Blueprint & { typeName: string })[]>([])
  const [bpLoading, setBpLoading]   = useState(true)
  usePageLoading(bpLoading)
  const fetchId = useRef(0)

  const [search, setSearch]   = useState('')
  const [selected, setSelected] = useState<(Blueprint & { typeName: string }) | null>(null)
  const [me, setMe]             = useState(10)
  const [runs, setRuns]         = useState(1)
  const [priceMode, setPriceMode] = useState<'sell' | 'buy'>('sell')  // materiaal-aankoop
  const [costIndex, setCostIndex]   = useState(4)  // system manufacturing cost index (%)
  const [facilityTax, setFacilityTax] = useState(1) // facility/structure tax (%)

  const [calculating, setCalculating]   = useState(false)
  const [materials, setMaterials]       = useState<Material[]>([])
  const [product, setProduct]           = useState<ProductInfo | null>(null)
  const [eiv, setEiv]                   = useState(0)  // Estimated Item Value (basis job-kosten)
  const [sdeError, setSdeError]         = useState<string | null>(null)
  const [serverOffline, setServerOffline] = useState(false)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setBpLoading(true)

    async function load() {
      const all: Blueprint[] = []
      await Promise.all(tokens.map(async t => {
        const bps = await getBlueprints(t.characterId, t.accessToken).catch(() => [] as Blueprint[])
        all.push(...bps)
      }))
      if (myId !== fetchId.current) return
      const typeIds = [...new Set(all.map(b => b.type_id))]
      const nameMap = await resolveNames(typeIds)
      if (myId !== fetchId.current) return
      setBlueprints(
        all.map(b => ({ ...b, typeName: nameMap.get(b.type_id) ?? `Type ${b.type_id}` }))
           .sort((a, b) => a.typeName.localeCompare(b.typeName))
      )
      setBpLoading(false)
    }
    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  async function calculate() {
    if (!selected || calculating) return
    setCalculating(true)
    setSdeError(false)
    setServerOffline(false)
    setMaterials([])
    setProduct(null)

    const { materials: sdeMats, product: sdeProd, serverOffline: offline, sdeError: sdeErr } = await fetchBlueprintData(selected.type_id)

    if (offline) {
      setServerOffline(true)
      setCalculating(false)
      return
    }

    if (sdeMats.length === 0 && !sdeProd) {
      setSdeError(sdeErr ?? 'Geen data gevonden')
      setCalculating(false)
      return
    }

    const allTypeIds = [
      ...sdeMats.map(m => m.materialtypeid),
      ...(sdeProd ? [sdeProd.producttypeid] : []),
    ]
    const [nameMap, priceMap, adjustedMap] = await Promise.all([
      resolveNames(allTypeIds),
      fetchJitaPrices(allTypeIds),
      fetchAdjustedPrices(),
    ])

    // EIV = Σ(basishoeveelheid × CCP adjusted_price) — vóór ME, dit is de job-kostenbasis.
    const eivVal = sdeMats.reduce((s, m) => s + (adjustedMap.get(m.materialtypeid) ?? 0) * (m.quantity * runs), 0)
    setEiv(eivVal)

    const mats: Material[] = sdeMats.map(m => {
      const baseQty   = m.quantity * runs
      const adjusted  = applyME(baseQty, me)
      const prices    = priceMap.get(m.materialtypeid)
      return {
        typeId:      m.materialtypeid,
        name:        nameMap.get(m.materialtypeid) ?? `Type ${m.materialtypeid}`,
        quantity:    baseQty,
        adjustedQty: adjusted,
        jitaSell:    prices?.sell ?? null,
        jitaBuy:     prices?.buy  ?? null,
      }
    })

    let prod: ProductInfo | null = null
    if (sdeProd) {
      const prices = priceMap.get(sdeProd.producttypeid)
      prod = {
        typeId:   sdeProd.producttypeid,
        name:     nameMap.get(sdeProd.producttypeid) ?? `Type ${sdeProd.producttypeid}`,
        quantity: sdeProd.quantity * runs,
        jitaSell: prices?.sell ?? null,
        jitaBuy:  prices?.buy  ?? null,
      }
    }

    setMaterials(mats)
    setProduct(prod)
    setCalculating(false)
  }

  const filteredBps = blueprints.filter(b =>
    b.typeName.toLowerCase().includes(search.toLowerCase())
  )

  // Materiaal-aankoopprijs volgens de gekozen modus (buy = met buy orders, sell = direct kopen).
  const matUnit = (m: Material) => (priceMode === 'buy' ? m.jitaBuy : m.jitaSell) ?? 0
  const materialsCost    = materials.reduce((s, m) => s + matUnit(m) * m.adjustedQty, 0)
  // Job-installatiekosten = EIV × (system cost index + facility tax + SCC-surcharge).
  const jobCost          = eiv * (costIndex / 100 + facilityTax / 100 + SCC_SURCHARGE)
  const totalBuildCost   = materialsCost + jobCost
  const jitaSellRevenue  = product ? (product.jitaSell ?? 0) * product.quantity : 0
  const jitaBuyRevenue   = product ? (product.jitaBuy  ?? 0) * product.quantity : 0
  const profitSell       = jitaSellRevenue - totalBuildCost
  const profitBuy        = jitaBuyRevenue  - totalBuildCost
  const roiSell          = totalBuildCost > 0 ? (profitSell / totalBuildCost) * 100 : 0

  return (
    <Layout header={<PageHeader title="Build vs Buy" sub="Vergelijk bouwen met Jita koopprijs" />}>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '0.75rem', alignItems: 'start' }}>

        {/* Blueprint selector */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--border)' }}>
            <div style={LABEL}>BLUEPRINT SELECTEREN</div>
            <input
              type="text"
              placeholder="Zoek blueprint..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.5rem', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {bpLoading && (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Blueprints laden...</div>
            )}
            {!bpLoading && filteredBps.length === 0 && (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen blueprints gevonden</div>
            )}
            {filteredBps.map(b => (
              <div
                key={`${b.type_id}-${b.item_id}`}
                onClick={() => { setSelected(b); setMaterials([]); setProduct(null); setSdeError(false) }}
                style={{
                  padding: '0.45rem 0.75rem',
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  cursor: 'pointer',
                  background: selected?.item_id === b.item_id ? 'rgba(0,180,216,0.08)' : 'transparent',
                  borderLeft: `2px solid ${selected?.item_id === b.item_id ? 'var(--blue)' : 'transparent'}`,
                  borderBottom: '1px solid rgba(28,28,53,0.3)',
                }}
              >
                <EveImage category="types" id={b.type_id} variation={b.quantity === -1 ? 'bp' : 'bpc'} size={32} px={24} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.typeName}
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                    {b.quantity === -1 ? 'BPO' : `BPC ×${b.quantity}`} · ME {b.material_efficiency}%
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {/* Controls */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1rem', display: 'flex', gap: '1.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={LABEL}>MATERIAL EFFICIENCY (ME)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="range" min={0} max={10} value={me} onChange={e => setMe(Number(e.target.value))}
                  style={{ width: 100 }} />
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--green)', minWidth: 28 }}>{me}%</span>
                {selected && selected.material_efficiency !== me && (
                  <button
                    onClick={() => setMe(selected.material_efficiency)}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', fontSize: '0.62rem', padding: '0.15rem 0.4rem', cursor: 'pointer' }}
                  >Blueprint ME ({selected.material_efficiency}%)</button>
                )}
              </div>
            </div>
            <div>
              <div style={LABEL}>RUNS</div>
              <input type="number" min={1} value={runs} onChange={e => setRuns(Math.max(1, Number(e.target.value)))}
                style={{ width: 70, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.8rem', padding: '0.3rem 0.5rem', outline: 'none' }} />
            </div>
            <div>
              <div style={LABEL}>MATERIAAL KOPEN VIA</div>
              <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                {(['sell', 'buy'] as const).map(mode => (
                  <button key={mode} onClick={() => setPriceMode(mode)} style={{
                    padding: '0.3rem 0.65rem', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer', border: 'none',
                    background: priceMode === mode ? 'rgba(0,180,216,0.15)' : 'transparent',
                    color: priceMode === mode ? 'var(--blue)' : 'var(--text-dim)',
                  }}>{mode === 'sell' ? 'Jita Sell' : 'Jita Buy'}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={LABEL} title="System manufacturing cost index">COST INDEX %</div>
              <input type="number" min={0} step={0.1} value={costIndex} onChange={e => setCostIndex(Math.max(0, Number(e.target.value)))}
                style={{ width: 64, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.8rem', padding: '0.3rem 0.5rem', outline: 'none' }} />
            </div>
            <div>
              <div style={LABEL} title="Facility/structure tax">FACILITY TAX %</div>
              <input type="number" min={0} step={0.1} value={facilityTax} onChange={e => setFacilityTax(Math.max(0, Number(e.target.value)))}
                style={{ width: 64, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.8rem', padding: '0.3rem 0.5rem', outline: 'none' }} />
            </div>
            <button
              onClick={calculate}
              disabled={!selected || calculating}
              style={{
                padding: '0.4rem 1.25rem', borderRadius: 2, fontSize: '0.75rem', fontWeight: 700, cursor: selected && !calculating ? 'pointer' : 'default',
                background: selected && !calculating ? 'rgba(0,180,216,0.12)' : 'transparent',
                border: `1px solid ${selected && !calculating ? 'var(--blue)' : 'var(--border)'}`,
                color: selected && !calculating ? 'var(--blue)' : 'var(--text-dim)',
              }}
            >
              {calculating ? 'Berekenen...' : '◈ Berekenen'}
            </button>
          </div>

          {serverOffline && (
            <div style={{ background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.3)', borderRadius: 3, padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--red)', lineHeight: 1.7 }}>
              Kan de blueprint-data niet laden. Probeer de pagina te verversen.
            </div>
          )}

          {sdeError && (
            <div style={{ background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.3)', borderRadius: 3, padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--red)' }}>
              {sdeError}
            </div>
          )}

          {/* Results */}
          {materials.length > 0 && product && (
            <>
              {/* Summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                {[
                  { label: 'BOUWKOSTEN',    value: `${fmtISK(totalBuildCost)} ISK`,  color: 'var(--red)'   },
                  { label: 'JITA SELL',     value: `${fmtISK(jitaSellRevenue)} ISK`, color: 'var(--green)' },
                  { label: 'WINST (SELL)',  value: `${fmtISK(profitSell)} ISK`,      color: profitSell >= 0 ? 'var(--green)' : 'var(--red)' },
                  { label: 'ROI',           value: `${roiSell.toFixed(1)}%`,         color: roiSell >= 0 ? 'var(--green)' : 'var(--red)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                    <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.15em', marginBottom: '0.3rem' }}>{label}</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Kosten-opsplitsing: materiaal + job-installatie */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.6rem 1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                <span>Materiaal ({priceMode === 'buy' ? 'Jita buy' : 'Jita sell'}): <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtISK(materialsCost)} ISK</span></span>
                <span>+ Job-kosten: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtISK(jobCost)} ISK</span></span>
                <span style={{ opacity: 0.7 }}>EIV {fmtISK(eiv)} × ({costIndex}% index + {facilityTax}% tax + {(SCC_SURCHARGE * 100).toFixed(0)}% SCC)</span>
                {runs > 1 && <span style={{ opacity: 0.7 }}>· {runs} runs · per stuk: <span style={{ color: profitSell >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmtISK(product ? profitSell / product.quantity : 0)} ISK</span></span>}
              </div>

              {/* Product */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <EveImage category="types" id={product.typeId} variation="icon" size={64} px={40} />
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>{product.name}</div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>
                    ×{product.quantity.toLocaleString()} · Jita sell: <span style={{ color: 'var(--green)', fontWeight: 600 }}>{fmtISK(product.jitaSell ?? 0)} ISK</span>
                    {' '}· Jita buy: <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{fmtISK(product.jitaBuy ?? 0)} ISK</span>
                  </div>
                  <div style={{ fontSize: '0.68rem', marginTop: '0.1rem', color: profitBuy >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    Sell naar buy orders: {fmtISK(profitBuy)} ISK winst ({totalBuildCost > 0 ? ((profitBuy / totalBuildCost) * 100).toFixed(1) : '—'}% ROI)
                  </div>
                </div>
              </div>

              {/* Materials table */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                      {['Materiaal', 'Basis', `ME ${me}%`, priceMode === 'buy' ? 'Jita Buy' : 'Jita Sell', 'Totaal', '%'].map(h => (
                        <th key={h} style={TH}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {materials.map(m => {
                      const cost = matUnit(m) * m.adjustedQty
                      const pct  = totalBuildCost > 0 ? (cost / totalBuildCost) * 100 : 0
                      return (
                        <tr key={m.typeId}>
                          <td style={TD}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <EveImage category="types" id={m.typeId} variation="icon" size={32} px={24} />
                              <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{m.name}</span>
                            </div>
                          </td>
                          <td style={{ ...TD, fontSize: '0.72rem', color: 'var(--text-dim)' }}>{m.quantity.toLocaleString()}</td>
                          <td style={{ ...TD, fontSize: '0.75rem', fontWeight: 600, color: m.adjustedQty < m.quantity ? 'var(--green)' : 'var(--text)' }}>
                            {m.adjustedQty.toLocaleString()}
                            {m.adjustedQty < m.quantity && (
                              <span style={{ fontSize: '0.6rem', color: 'var(--green)', marginLeft: '0.3rem' }}>
                                −{m.quantity - m.adjustedQty}
                              </span>
                            )}
                          </td>
                          <td style={{ ...TD, fontSize: '0.73rem', whiteSpace: 'nowrap' }}>
                            {matUnit(m) > 0 ? `${fmtISK(matUnit(m))} ISK` : <span style={{ color: 'var(--border)' }}>—</span>}
                          </td>
                          <td style={{ ...TD, fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap', color: 'var(--red)' }}>
                            {fmtISK(cost)} ISK
                          </td>
                          <td style={{ ...TD, minWidth: 80 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <div style={{ flex: 1, height: 3, background: 'var(--border)', borderRadius: 2 }}>
                                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--red)', borderRadius: 2 }} />
                              </div>
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', minWidth: 28, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!selected && !calculating && materials.length === 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '3rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Selecteer een blueprint links om te beginnen
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}
