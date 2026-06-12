import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { WalletJournalEntry } from '../api/esi'

interface Props {
  journal: WalletJournalEntry[]
  loading?: boolean
}

function fmt(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${v.toFixed(0)}`
}

export default function RattingWidget({ journal, loading }: Props) {
  const byDate = new Map<string, { bounties: number; ess: number }>()

  for (const e of journal) {
    if (e.amount <= 0) continue
    const date = e.date.slice(0, 10)
    const cur = byDate.get(date) ?? { bounties: 0, ess: 0 }
    if (e.ref_type === 'bounty_prizes') byDate.set(date, { ...cur, bounties: cur.bounties + e.amount })
    if (e.ref_type === 'ess_escrow_transfer') byDate.set(date, { ...cur, ess: cur.ess + e.amount })
  }

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    const date = d.toISOString().slice(0, 10)
    const label = i === 6 ? 'Today' : d.toLocaleDateString('nl', { weekday: 'short' })
    const data = byDate.get(date) ?? { bounties: 0, ess: 0 }
    return { date, label, ...data }
  })

  const today = days[days.length - 1]
  const todayTotal = today.bounties + today.ess

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>RATTEN / ESS</div>
        {!loading && todayTotal > 0 && (
          <div style={{ fontSize: '0.68rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(todayTotal)} vandaag</div>
        )}
        {loading && <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Laden...</div>}
      </div>

      <div style={{ flex: 1, minHeight: 100 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} barSize={8} barGap={1} barCategoryGap="30%">
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#0b0b1a', border: '1px solid #1c1c35', borderRadius: 3, fontSize: 11 }}
              formatter={(v: number, name: string) => [`${fmt(v)} ISK`, name === 'bounties' ? 'Bounties' : 'ESS']}
            />
            <Bar dataKey="bounties" stackId="a" fill="#3ecf6e" radius={[0, 0, 0, 0]} />
            <Bar dataKey="ess"      stackId="a" fill="#f0c040" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
        <div style={{ background: 'rgba(62,207,110,0.06)', border: '1px solid rgba(62,207,110,0.15)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: '#3ecf6e', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>BOUNTIES</div>
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{fmt(today.bounties)}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>vandaag</div>
        </div>
        <div style={{ background: 'rgba(240,192,64,0.06)', border: '1px solid rgba(240,192,64,0.15)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: '#f0c040', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>ESS</div>
          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{fmt(today.ess)}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>vandaag</div>
        </div>
      </div>
    </div>
  )
}
