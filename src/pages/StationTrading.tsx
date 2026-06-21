import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { useAuth } from '../auth/AuthContext'
import { getTransactions, type WalletTransaction } from '../api/esi'
import { usePageLoading } from '../hooks/usePageLoading'

function fmtISK(v: number) {
  const a = Math.abs(v), s = v < 0 ? '-' : ''
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)} mrd`
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)} mln`
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}k`
  return `${s}${Math.round(a)}`
}

interface ItemPnL {
  typeId: number; soldQty: number; revenue: number; cost: number
  grossProfit: number; netProfit: number; margin: number; openQty: number; trades: number
}

// FIFO: match verkopen tegen eerdere aankopen per item → gerealiseerde winst.
function computePnL(txs: WalletTransaction[], taxPct: number, brokerPct: number): ItemPnL[] {
  const byType = new Map<number, WalletTransaction[]>()
  for (const t of txs) { const a = byType.get(t.type_id) ?? []; a.push(t); byType.set(t.type_id, a) }
  const out: ItemPnL[] = []
  for (const [typeId, list] of byType) {
    list.sort((a, b) => +new Date(a.date) - +new Date(b.date))
    const lots: { qty: number; price: number }[] = []  // openstaande aankoop-lots (FIFO)
    let soldQty = 0, revenue = 0, cost = 0, trades = 0
    for (const t of list) {
      trades++
      if (t.is_buy) {
        lots.push({ qty: t.quantity, price: t.unit_price })
      } else {
        let remaining = t.quantity
        revenue += t.quantity * t.unit_price
        while (remaining > 0 && lots.length) {
          const lot = lots[0]
          const take = Math.min(remaining, lot.qty)
          cost += take * lot.price
          soldQty += take
          lot.qty -= take; remaining -= take
          if (lot.qty <= 0) lots.shift()
        }
        // remaining > 0 → verkocht zonder bekende aankoop in venster: alleen omzet, geen kostenbasis
        if (remaining > 0) soldQty += remaining
      }
    }
    if (soldQty === 0 && revenue === 0) continue
    const gross = revenue - cost
    const fees = revenue * (taxPct / 100) + (revenue + cost) * (brokerPct / 100)
    const net = gross - fees
    const openQty = lots.reduce((a, l) => a + l.qty, 0)
    out.push({ typeId, soldQty, revenue, cost, grossProfit: gross, netProfit: net, margin: revenue > 0 ? (net / revenue) * 100 : 0, openQty, trades })
  }
  return out.sort((a, b) => b.netProfit - a.netProfit)
}

export default function StationTrading() {
  const { tokens } = useAuth()
  const [txs, setTxs] = useState<WalletTransaction[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [tax, setTax] = useState(4.5)
  const [broker, setBroker] = useState(3.0)

  useEffect(() => {
    if (!tokens.length) { setLoading(false); return }
    Promise.all([
      Promise.all(tokens.map(t => getTransactions(t.characterId, t.accessToken).catch(() => [] as WalletTransaction[]))).then(r => r.flat()),
      fetch('/type-names.json').then(r => r.json()).catch(() => ({})),
    ]).then(([t, nm]) => { setTxs(t); setNames(nm); setLoading(false) })
  }, [tokens])

  const rows = useMemo(() => computePnL(txs, tax, broker), [txs, tax, broker])
  const totals = useMemo(() => rows.reduce((a, r) => ({
    net: a.net + r.netProfit, gross: a.gross + r.grossProfit, rev: a.rev + r.revenue,
  }), { net: 0, gross: 0, rev: 0 }), [rows])
  const dateRange = useMemo(() => {
    if (!txs.length) return ''
    const ds = txs.map(t => +new Date(t.date)).sort((a, b) => a - b)
    const f = (n: number) => new Date(n).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })
    return `${f(ds[0])} – ${f(ds[ds.length - 1])}`
  }, [txs])
  const nameOf = (id: number) => names[String(id)] ?? `Type ${id}`

  return (
    <Layout header={<PageHeader title="Station-trading P&L" sub={loading ? 'Transacties laden…' : `${txs.length} transacties · ${dateRange}`} />}>
      {/* Samenvatting */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
        <Stat label="Netto winst (gerealiseerd)" value={fmtISK(totals.net)} color={totals.net >= 0 ? '#3ecf6e' : 'var(--red)'} big />
        <Stat label="Bruto winst" value={fmtISK(totals.gross)} color="var(--text)" />
        <Stat label="Omzet (verkopen)" value={fmtISK(totals.rev)} color="var(--text)" />
        <Stat label="Verhandelde items" value={String(rows.length)} color="var(--text)" />
      </div>

      {/* Fee-instellingen */}
      <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Sales tax %
          <input type="number" step={0.1} min={0} value={tax} onChange={e => setTax(Math.max(0, parseFloat(e.target.value) || 0))} style={numInput} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Broker fee %
          <input type="number" step={0.1} min={0} value={broker} onChange={e => setBroker(Math.max(0, parseFloat(e.target.value) || 0))} style={numInput} /></label>
        <span style={{ fontSize: '0.6rem' }}>tax op verkopen, broker op koop+verkoop — pas aan naar je skills/standings.</span>
      </div>

      {!loading && !tokens.length && <div style={card}>Geen account ingelogd.</div>}
      {!loading && tokens.length > 0 && rows.length === 0 && <div style={card}>Geen koop/verkoop-transacties gevonden in het venster (~laatste 30 dagen).</div>}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ ...rowWrap, fontSize: '0.56rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.08em', borderBottom: '1px solid var(--border)' }}>
            <span style={{ width: 26, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 130 }}>ITEM</span>
            <span style={{ width: 64, textAlign: 'right' }}>VERKOCHT</span>
            <span style={{ width: 92, textAlign: 'right' }}>OMZET</span>
            <span style={{ width: 92, textAlign: 'right' }}>INKOOP</span>
            <span style={{ width: 92, textAlign: 'right' }}>NETTO</span>
            <span style={{ width: 54, textAlign: 'right' }}>MARGE</span>
            <span style={{ width: 56, textAlign: 'right' }}>OPEN</span>
          </div>
          {rows.map(r => (
            <div key={r.typeId} style={{ ...rowWrap, borderBottom: '1px solid var(--border)' }}>
              <EveImage category="types" id={r.typeId} variation="icon" size={32} px={22} style={{ borderRadius: 3, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 130, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(r.typeId)}</span>
              <span style={{ width: 64, textAlign: 'right', color: 'var(--text-dim)' }}>{r.soldQty.toLocaleString('nl-NL')}</span>
              <span style={{ width: 92, textAlign: 'right', color: 'var(--text-dim)' }}>{fmtISK(r.revenue)}</span>
              <span style={{ width: 92, textAlign: 'right', color: 'var(--text-dim)' }}>{fmtISK(r.cost)}</span>
              <span style={{ width: 92, textAlign: 'right', fontWeight: 700, color: r.netProfit >= 0 ? '#3ecf6e' : 'var(--red)' }}>{fmtISK(r.netProfit)}</span>
              <span style={{ width: 54, textAlign: 'right', color: r.margin >= 15 ? '#3ecf6e' : r.margin >= 5 ? 'var(--gold)' : 'var(--text-dim)' }}>{r.margin.toFixed(0)}%</span>
              <span style={{ width: 56, textAlign: 'right', color: 'var(--text-dim)', fontSize: '0.66rem' }} title="nog niet verkochte voorraad uit dit venster">{r.openQty > 0 ? r.openQty.toLocaleString('nl-NL') : '—'}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Gerealiseerde winst via FIFO: verkopen worden gematcht tegen eerdere aankopen in het transactie-venster. Verkopen zonder bekende aankoop (item al vóór het venster gekocht) tellen mee in omzet maar niet in de kostenbasis — winst kan dan onderschat zijn. "Open" = ingekochte voorraad die nog niet verkocht is.
      </div>
    </Layout>
  )
}

function Stat({ label, value, color, big }: { label: string; value: string; color: string; big?: boolean }) {
  return (
    <div style={card}>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: big ? '1.5rem' : '1.1rem', fontWeight: 800, color }}>{value}</div>
    </div>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.7rem 0.9rem' }
const rowWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.4rem 0.5rem', fontSize: '0.74rem' }
const numInput: React.CSSProperties = { width: 60, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', padding: '0.25rem 0.4rem', fontSize: '0.72rem' }
