// Gedeeld door de tabbladen van het Handelscentrum: stijl, de gegevensvorm en
// kleine bouwsteentjes.
import type { MarketOrder, PublicMarketOrder } from '../../api/esi'
import type { TokenData } from '../../auth/sso'
import type { Fees, Kost, Tx, OpenLot, Verkoop, ZonderKoop } from '../../utils/handel'

export interface EigenOrder extends MarketOrder { charId: number; region_id?: number }

export interface OrderStatus {
  order: EigenOrder; isBuy: boolean; waarde: number; dagenOver: number
  /** null = orderboek onbekend (bijv. citadel zonder markt-toegang) */
  overboden: boolean | null; boven: number; voorstel: number | null; beste: number | null
}

export interface PositieLive {
  typeId: number; locationId: number; qty: number; buyPrice: number; bron: 'wallet' | 'handmatig'
  sell: number | null; prijsVan: 'hier' | 'jita' | null
  kosten: number; nu: number | null; pnl: number | null
  inOrder: number; vrij: number; pnlVrij: number | null
}

/** Alles wat de pagina ophaalt en uitrekent, in één pakket voor de tabbladen. */
export interface Gegevens {
  tokens: TokenData[]
  chars: Map<number, string>
  orders: EigenOrder[]
  status: OrderStatus[]
  posities: PositieLive[]
  txs: Tx[]
  kosten: Kost[]
  verkocht: Verkoop[]
  zonderKoop: ZonderKoop[]
  open: OpenLot[]
  boeken: Map<string, PublicMarketOrder[]>     // `${locationId}:${typeId}`
  namen: Map<number, string>                    // type → naam
  plekken: Map<number, string>                  // station/citadel → naam
  wallet: number | null
  fee: Fees
  hub: string                                   // filter: 'alle', 'jita', …, 'overig'
  sinds: number | null                          // sinds wanneer we handel bewaren
}

export const CARD: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.9rem 1rem' }
export const KOP: React.CSSProperties = { fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.6rem' }
export const LABEL: React.CSSProperties = { fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem', textTransform: 'uppercase' }
export const RIJ: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.6rem', padding: '0.35rem 0', borderTop: '1px solid var(--border)' }
export const ITEMBTN: React.CSSProperties = { background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
export const DOF: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }
export const KNOP: React.CSSProperties = { padding: '0.4rem 0.8rem', borderRadius: 2, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.72rem' }
export const INPUT: React.CSSProperties = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none' }
export const TH: React.CSSProperties = { textAlign: 'right', padding: '0.35rem 0.6rem', color: 'var(--text-dim)', fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
export const TD: React.CSSProperties = { textAlign: 'right', padding: '0.35rem 0.6rem', fontSize: '0.76rem', whiteSpace: 'nowrap' }

export function Tegel({ label, waarde, sub, kleurWaarde }: { label: string; waarde: string; sub?: React.ReactNode; kleurWaarde?: string }) {
  return (
    <div style={CARD}>
      <div style={LABEL}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: kleurWaarde ?? 'var(--text)' }}>{waarde}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{sub}</div>}
    </div>
  )
}

/** Een item als knop: klik opent het item-detail. */
export function ItemKnop({ id, namen, onItem, plek }: { id: number; namen: Map<number, string>; onItem: (typeId: number, locationId?: number) => void; plek?: number }) {
  return (
    <button style={ITEMBTN} onClick={() => onItem(id, plek)} title="Details bekijken">
      {namen.get(id) ?? `#${id}`}
    </button>
  )
}

export function KnopGroep<T extends string>({ waarde, opties, onKies }: { waarde: T; opties: Array<{ key: T; label: string }>; onKies: (k: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
      {opties.map(o => (
        <button key={o.key} onClick={() => onKies(o.key)} style={{
          ...KNOP, padding: '0.25rem 0.6rem', fontWeight: 600,
          background: waarde === o.key ? 'var(--blue)' : 'var(--surface2)',
          color: waarde === o.key ? '#0a0a12' : 'var(--text)',
          borderColor: waarde === o.key ? 'var(--blue)' : 'var(--border)',
        }}>{o.label}</button>
      ))}
    </div>
  )
}
