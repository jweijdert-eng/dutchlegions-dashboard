import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import type { WalletJournalEntry } from '../api/esi'

interface Props {
  journal: WalletJournalEntry[]
  loading?: boolean
}

function buildChartData(journal: WalletJournalEntry[]) {
  // Journal is newest-first; first entry per date = end-of-day balance
  const byDate = new Map<string, number>()
  for (const e of journal) {
    const date = e.date.slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, e.balance)
  }
  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, balance]) => ({ date: date.slice(5), balance }))
}

function fmt(v: number) {
  const n   = Number(v)
  const abs = Math.abs(n)
  const neg = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(0)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}

export default function WalletChart({ journal, loading }: Props) {
  const data = buildChartData(journal)
  const first = data[0]?.balance ?? 0
  const last = data[data.length - 1]?.balance ?? 0
  const delta = last - first
  const positive = delta >= 0

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>
          WALLET — {data.length} DAGEN
        </div>
        {!loading && data.length > 1 && (
          <div style={{ fontSize: '0.72rem', color: positive ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
            {positive ? '+' : ''}{fmt(delta)}
          </div>
        )}
        {loading && <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Laden...</div>}
      </div>
      {data.length > 0 ? (
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00b4d8" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00b4d8" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1c1c35" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#4a4a6a', fontSize: 9 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tickFormatter={fmt} tick={{ fill: '#4a4a6a', fontSize: 9 }} tickLine={false} axisLine={false} width={44} />
            <Tooltip
              contentStyle={{ background: '#0b0b1a', border: '1px solid #1c1c35', borderRadius: 3, fontSize: 11 }}
              labelStyle={{ color: '#4a4a6a' }}
              formatter={(v: number) => [fmt(v), 'Wallet']}
            />
            <Area type="monotone" dataKey="balance" stroke="#00b4d8" strokeWidth={1.5} fill="url(#wg)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.72rem' }}>
          {loading ? 'Data ophalen...' : 'Geen wallet data'}
        </div>
      )}
    </div>
  )
}
