import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getContracts, getContractItems, getContractBids, getStructureName, resolveNames, openContractWindow,
  type Contract, type ContractItem, type ContractBid,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedContract extends Contract {
  issuerName: string
  assigneeName?: string
  acceptorName?: string
  startLocationName?: string
  endLocationName?: string
  charId: number
  accessToken: string
}

interface ResolvedItem extends ContractItem { typeName: string }

const STATUS_COLOR: Record<string, string> = {
  outstanding:          '#00b4d8',
  in_progress:          '#f0c040',
  finished:             '#3ecf6e',
  finished_issuer:      '#3ecf6e',
  finished_contractor:  '#3ecf6e',
  cancelled:            'var(--text-dim)',
  rejected:             'var(--red)',
  failed:               'var(--red)',
  deleted:              'var(--text-dim)',
  reversed:             'var(--text-dim)',
}

const STATUS_LABEL: Record<string, string> = {
  outstanding:          'Actief',
  in_progress:          'Loopt',
  finished:             'Klaar',
  finished_issuer:      'Klaar',
  finished_contractor:  'Klaar',
  cancelled:            'Geannuleerd',
  rejected:             'Afgewezen',
  failed:               'Mislukt',
  deleted:              'Verwijderd',
  reversed:             'Teruggedraaid',
}

const TYPE_ICON: Record<string, string> = {
  item_exchange: '⇄',
  auction:       '◑',
  courier:       '◎',
  loan:          '◐',
  unknown:       '?',
}

const TYPE_COLOR: Record<string, string> = {
  item_exchange: 'var(--blue)',
  auction:       'var(--gold)',
  courier:       '#3ecf6e',
  loan:          '#f97316',
  unknown:       'var(--text-dim)',
}

const AVAIL_LABEL: Record<string, string> = {
  public:      'Publiek',
  personal:    'Persoonlijk',
  corporation: 'Corp',
  alliance:    'Alliance',
}

function fmtISK(v: number) {
  const abs = Math.abs(v), neg = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: '2-digit' })
}

function timeLeft(exp: string) {
  const diff = new Date(exp).getTime() - Date.now()
  if (diff <= 0) return { label: 'Verlopen', color: 'var(--red)' }
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  if (d > 0) return { label: `${d}d ${h}u`, color: d < 2 ? '#f0c040' : 'var(--text-dim)' }
  return { label: `${h}u`, color: '#f97316' }
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ fontSize: '1rem', fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}

function ItemsPanel({ charId, contractId, token, type }: { charId: number; contractId: number; token: string; type: Contract['type'] }) {
  const [items, setItems]     = useState<ResolvedItem[] | null>(null)
  const [bids, setBids]       = useState<ContractBid[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [itemsRes, bidsRes] = await Promise.allSettled([
        getContractItems(charId, contractId, token),
        type === 'auction' ? getContractBids(charId, contractId, token) : Promise.resolve([]),
      ])

      if (itemsRes.status === 'fulfilled') {
        const raw = itemsRes.value
        const nameMap = await resolveNames(raw.map(i => i.type_id)).catch(() => new Map<number, string>())
        setItems(raw.map(i => ({ ...i, typeName: nameMap.get(i.type_id) ?? `Type ${i.type_id}` })))
      } else {
        setItems([])
      }

      if (bidsRes.status === 'fulfilled') setBids(bidsRes.value)
      setLoading(false)
    }
    load()
  }, [contractId])

  if (loading) return <div style={{ padding: '0.75rem 1.5rem', fontSize: '0.7rem', color: 'var(--text-dim)' }}>Laden...</div>

  const highestBid = bids && bids.length > 0 ? Math.max(...bids.map(b => b.amount)) : null

  return (
    <div style={{ padding: '0.5rem 1.5rem 0.75rem', background: 'rgba(0,0,0,0.15)', borderTop: '1px solid var(--border)' }}>
      {/* Bids */}
      {bids && bids.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--gold)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem' }}>
            BIEDINGEN ({bids.length}) · HOOGSTE: {fmtISK(highestBid!)} ISK
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {[...bids].sort((a, b) => b.amount - a.amount).slice(0, 5).map(b => (
              <span key={b.bid_id} style={{ fontSize: '0.62rem', background: 'rgba(240,192,64,0.08)', border: '1px solid rgba(240,192,64,0.25)', borderRadius: 2, padding: '0.15rem 0.4rem', color: 'var(--gold)' }}>
                {fmtISK(b.amount)} ISK
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Items */}
      {items && items.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          {items.map(item => (
            <div key={item.record_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <EveImage category="types" id={item.type_id} variation="icon" size={32} px={18} style={{ flexShrink: 0, opacity: item.is_included ? 1 : 0.5 }} />
              <span style={{ fontSize: '0.7rem', color: item.is_included ? 'var(--text)' : 'var(--text-dim)', flex: 1 }}>
                {item.typeName}
                {!item.is_included && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginLeft: '0.3rem' }}>(gevraagd)</span>}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                ×{item.quantity.toLocaleString('nl')}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Geen items</div>
      )}
    </div>
  )
}

async function openContract(id: number, token: string) {
  const ok = await openContractWindow(id, token)
  if (!ok) alert('Kon het contract niet openen. Log één keer opnieuw in (voor de nieuwe rechten) en zorg dat EVE draait.')
}

export default function Contracts() {
  const { activeTokens: tokens } = useAuth()
  const [contracts, setContracts]   = useState<ResolvedContract[]>([])
  const [loading, setLoading]       = useState(true)
  const [filter, setFilter]         = useState<'all' | 'outstanding' | 'finished' | 'other'>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | 'item_exchange' | 'auction' | 'courier'>('all')
  const [search, setSearch]         = useState('')
  const [expanded, setExpanded]     = useState<Set<number>>(new Set())
  usePageLoading(loading)
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setContracts([])

    async function load() {
      const all: (Contract & { charId: number; accessToken: string })[] = []
      await Promise.all(tokens.map(async t => {
        const cs = await getContracts(t.characterId, t.accessToken).catch(() => [] as Contract[])
        all.push(...cs.map(c => ({ ...c, charId: t.characterId, accessToken: t.accessToken })))
      }))
      if (myId !== fetchId.current) return

      const issuerIds   = all.map(c => c.issuer_id)
      const assigneeIds = all.map(c => c.assignee_id).filter((id): id is number => Boolean(id))
      const acceptorIds = all.map(c => c.acceptor_id).filter((id): id is number => Boolean(id))
      const locationIds = all.flatMap(c => [c.start_location_id, c.end_location_id]).filter((id): id is number => Boolean(id))
      const nameIds     = [...new Set([...issuerIds, ...assigneeIds, ...acceptorIds, ...locationIds])]
      const nameMap     = await resolveNames(nameIds)
      if (myId !== fetchId.current) return

      const structureIds = [...new Set(locationIds.filter(id => id > 2_147_483_647))]
      const structureNames = new Map<number, string>()
      await Promise.all(structureIds.map(async id => {
        const name = await getStructureName(id, tokens)
        if (name) structureNames.set(id, name)
      }))
      if (myId !== fetchId.current) return

      setContracts(
        all.map(c => ({
          ...c,
          issuerName:        nameMap.get(c.issuer_id) ?? `#${c.issuer_id}`,
          assigneeName:      c.assignee_id   ? nameMap.get(c.assignee_id)   ?? `#${c.assignee_id}`   : undefined,
          acceptorName:      c.acceptor_id   ? nameMap.get(c.acceptor_id)   ?? `#${c.acceptor_id}`   : undefined,
          startLocationName: c.start_location_id ? nameMap.get(c.start_location_id) ?? structureNames.get(c.start_location_id) ?? `#${c.start_location_id}` : undefined,
          endLocationName:   c.end_location_id   ? nameMap.get(c.end_location_id)   ?? structureNames.get(c.end_location_id)   ?? `#${c.end_location_id}`   : undefined,
        }))
        .sort((a, b) => {
          const aActive = a.status === 'outstanding' ? 0 : 1
          const bActive = b.status === 'outstanding' ? 0 : 1
          if (aActive !== bActive) return aActive - bActive
          return new Date(b.date_issued).getTime() - new Date(a.date_issued).getTime()
        })
      )
      setLoading(false)
    }
    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const filtered = contracts.filter(c => {
    if (filter === 'outstanding' && c.status !== 'outstanding') return false
    if (filter === 'finished'    && !['finished', 'finished_issuer', 'finished_contractor'].includes(c.status)) return false
    if (filter === 'other'       && ['outstanding', 'finished', 'finished_issuer', 'finished_contractor'].includes(c.status)) return false
    if (typeFilter !== 'all'     && c.type !== typeFilter) return false
    const term = search.toLowerCase()
    if (term && ![c.title, c.issuerName, c.assigneeName, c.startLocationName, c.endLocationName].some(v => v?.toLowerCase().includes(term))) return false
    return true
  })

  const outstanding   = contracts.filter(c => c.status === 'outstanding')
  const totalValue    = outstanding.filter(c => c.price > 0).reduce((s, c) => s + c.price, 0)
  const courierCount  = outstanding.filter(c => c.type === 'courier').length
  const auctionCount  = outstanding.filter(c => c.type === 'auction').length

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <Layout header={
      <PageHeader
        title="Contracts"
        sub={loading ? 'Laden...' : `${contracts.length} totaal · ${outstanding.length} actief`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {(['all', 'outstanding', 'finished', 'other'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                background: filter === f ? 'rgba(0,180,216,0.15)' : 'none',
                border: `1px solid ${filter === f ? 'var(--blue)' : 'var(--border)'}`,
                color: filter === f ? 'var(--blue)' : 'var(--text-dim)',
                borderRadius: 2, fontSize: '0.62rem', fontWeight: 700, padding: '0.2rem 0.45rem', cursor: 'pointer',
              }}>
                {f === 'all' ? 'ALLES' : f === 'outstanding' ? 'ACTIEF' : f === 'finished' ? 'KLAAR' : 'OVERIG'}
              </button>
            ))}
            <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>|</span>
            {(['all', 'item_exchange', 'auction', 'courier'] as const).map(t => (
              <button key={t} onClick={() => setTypeFilter(t)} style={{
                background: typeFilter === t ? `${TYPE_COLOR[t] ?? 'rgba(0,180,216,0.15)'}22` : 'none',
                border: `1px solid ${typeFilter === t ? (TYPE_COLOR[t] ?? 'var(--blue)') : 'var(--border)'}`,
                color: typeFilter === t ? (TYPE_COLOR[t] ?? 'var(--blue)') : 'var(--text-dim)',
                borderRadius: 2, fontSize: '0.62rem', fontWeight: 700, padding: '0.2rem 0.45rem', cursor: 'pointer',
              }}>
                {t === 'all' ? 'TYPE' : TYPE_ICON[t]} {t === 'all' ? 'ALLES' : t === 'item_exchange' ? 'ITEM' : t === 'auction' ? 'VEILING' : 'KOERIER'}
              </button>
            ))}
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Zoeken..."
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.28rem 0.6rem', color: 'var(--text)', fontSize: '0.72rem', outline: 'none', width: 150 }}
            />
          </div>
        }
      />
    }>
      {/* Stat cards */}
      {!loading && contracts.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <StatCard label="ACTIEF"      value={`${outstanding.length}`}        color="var(--blue)" />
          <StatCard label="TOTALE WAARDE" value={totalValue > 0 ? `${fmtISK(totalValue)} ISK` : '—'} color="var(--gold)" />
          <StatCard label="KOERIERS"    value={`${courierCount}`}              color="#3ecf6e" />
          <StatCard label="VEILINGEN"   value={`${auctionCount}`}              color="var(--gold)" />
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Contracts laden...</div>}
      {!loading && filtered.length === 0 && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen contracts gevonden</div>}

      {!loading && filtered.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          {filtered.map((c, i) => {
            const isExpanded = expanded.has(c.contract_id)
            const tl = timeLeft(c.date_expired)
            const hasItems = ['item_exchange', 'auction'].includes(c.type)
            const isCourier = c.type === 'courier'

            return (
              <div key={c.contract_id} style={{ borderTop: i > 0 ? '1px solid rgba(28,28,53,0.6)' : undefined }}>
                {/* Hoofdrij */}
                <div
                  onClick={() => hasItems && toggleExpand(c.contract_id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '26px 1fr 130px 100px 80px 70px',
                    gap: '0.5rem',
                    alignItems: 'center',
                    padding: '0.55rem 1rem',
                    cursor: hasItems ? 'pointer' : 'default',
                    background: isExpanded ? 'rgba(0,180,216,0.04)' : i % 2 === 1 ? 'rgba(15,15,34,0.3)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (hasItems) (e.currentTarget as HTMLElement).style.background = 'rgba(0,180,216,0.04)' }}
                  onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLElement).style.background = i % 2 === 1 ? 'rgba(15,15,34,0.3)' : 'transparent' }}
                >
                  {/* Type icon */}
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', color: TYPE_COLOR[c.type] ?? 'var(--text-dim)' }}>
                    {TYPE_ICON[c.type]}
                  </div>

                  {/* Info */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.15rem' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.title || <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>geen titel</span>}
                      </span>
                      {c.for_corporation && (
                        <span style={{ fontSize: '0.55rem', fontWeight: 700, color: 'var(--blue)', background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.3)', borderRadius: 2, padding: '0.05rem 0.25rem', flexShrink: 0 }}>CORP</span>
                      )}
                      <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', flexShrink: 0 }}>{AVAIL_LABEL[c.availability] ?? c.availability}</span>
                      <button onClick={e => { e.stopPropagation(); openContract(c.contract_id, c.accessToken) }} title="Open contract in de EVE-client"
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.78rem', padding: 0, lineHeight: 1, flexShrink: 0 }}>⧉</button>
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.issuerName}
                      {c.assigneeName && <span> → {c.assigneeName}</span>}
                      {c.acceptorName && c.status !== 'outstanding' && <span style={{ color: 'var(--green)' }}> ✓ {c.acceptorName}</span>}
                    </div>
                    {isCourier && (c.startLocationName || c.endLocationName) && (
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.1rem' }}>
                        {c.startLocationName ?? '?'} → {c.endLocationName ?? '?'}
                        {c.days_to_complete != null && <span style={{ marginLeft: '0.4rem' }}>({c.days_to_complete}d)</span>}
                      </div>
                    )}
                  </div>

                  {/* Prijs/beloning/collateral */}
                  <div style={{ textAlign: 'right', fontSize: '0.72rem', fontVariantNumeric: 'tabular-nums' }}>
                    {c.price > 0 && <div style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmtISK(c.price)} ISK</div>}
                    {c.reward > 0 && <div style={{ color: 'var(--green)', fontSize: '0.65rem' }}>+{fmtISK(c.reward)} beloning</div>}
                    {c.collateral != null && c.collateral > 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.62rem' }}>◎ {fmtISK(c.collateral)}</div>}
                    {c.buyout != null && c.buyout > 0 && <div style={{ color: 'var(--gold)', fontSize: '0.62rem' }}>Buyout: {fmtISK(c.buyout)}</div>}
                    {c.volume != null && c.volume > 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.6rem' }}>{c.volume.toLocaleString('nl')} m³</div>}
                  </div>

                  {/* Status */}
                  <div style={{ textAlign: 'center' }}>
                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: STATUS_COLOR[c.status] ?? 'var(--text-dim)' }}>
                      {STATUS_LABEL[c.status] ?? c.status}
                    </span>
                  </div>

                  {/* Verloopt */}
                  <div style={{ textAlign: 'right', fontSize: '0.65rem', color: tl.color, fontVariantNumeric: 'tabular-nums' }}>
                    {tl.label}
                  </div>

                  {/* Expand indicator */}
                  <div style={{ textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                    {hasItems ? (isExpanded ? '▲' : '▼') : ''}
                  </div>
                </div>

                {/* Uitklapbaar items paneel */}
                {isExpanded && hasItems && (
                  <ItemsPanel
                    charId={c.charId}
                    contractId={c.contract_id}
                    token={c.accessToken}
                    type={c.type}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </Layout>
  )
}
