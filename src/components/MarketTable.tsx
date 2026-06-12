export interface ResolvedOrder {
  name: string
  isBuy: boolean
  qty: number
  price: number
  location: string
  expires: string
}

interface Props {
  orders: ResolvedOrder[]
  loading?: boolean
}

const TH: React.CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700,
  letterSpacing: '0.12em', padding: '0.35rem 0.6rem', textAlign: 'left',
}
const TD: React.CSSProperties = {
  fontSize: '0.72rem', color: 'var(--text)',
  padding: '0.38rem 0.6rem', borderTop: '1px solid rgba(28,28,53,0.5)',
}

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return v.toFixed(2)
}

export default function MarketTable({ orders, loading }: Props) {
  const buyCount  = orders.filter(o => o.isBuy).length
  const sellCount = orders.filter(o => !o.isBuy).length

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ padding: '0.7rem 0.875rem 0.4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>MARKET ORDERS</span>
        <span style={{ fontSize: '0.65rem', color: 'var(--blue)', fontWeight: 600 }}>
          {loading ? 'Laden...' : `${orders.length} actief · ${buyCount} buy · ${sellCount} sell`}
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderTop: '1px solid var(--border)' }}>
            {['Item', 'Type', 'Qty', 'Prijs', 'Locatie', 'Verloopt'].map(h => (
              <th key={h} style={TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && !loading && (
            <tr><td colSpan={6} style={{ ...TD, color: 'var(--text-dim)', textAlign: 'center', padding: '1rem' }}>Geen actieve orders</td></tr>
          )}
          {orders.map((o, i) => (
            <tr key={i} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent' }}>
              <td style={{ ...TD, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</td>
              <td style={{ ...TD, color: o.isBuy ? 'var(--gold)' : 'var(--green)', fontWeight: 700, fontSize: '0.62rem', letterSpacing: '0.05em' }}>
                {o.isBuy ? 'BUY' : 'SELL'}
              </td>
              <td style={{ ...TD, color: 'var(--text-dim)' }}>{o.qty.toLocaleString('nl-NL')}</td>
              <td style={TD}>{fmtISK(o.price)}</td>
              <td style={{ ...TD, color: 'var(--text-dim)', fontSize: '0.65rem', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.location}</td>
              <td style={{ ...TD, color: 'var(--text-dim)' }}>{o.expires}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
