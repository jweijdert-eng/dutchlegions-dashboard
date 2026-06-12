import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'

interface Props {
  kills: number
  losses: number
  killValue: number
  lossValue: number
  loading?: boolean
}

function fmt(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`
  return `${(v / 1e3).toFixed(0)}K`
}

export default function KillsChart({ kills, losses, killValue, lossValue, loading }: Props) {
  const total = kills + losses
  const eff = total > 0 ? Math.round((kills / total) * 100) : 0
  const data = [
    { name: 'Kills',  value: kills  || 1, color: kills  > 0 ? '#3ecf6e' : '#1c1c35' },
    { name: 'Losses', value: losses || 0, color: losses > 0 ? '#e05555' : 'transparent' },
  ]

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>KILLS / LOSSES</div>
        {!loading && total > 0 && <div style={{ fontSize: '0.68rem', color: 'var(--green)', fontWeight: 600 }}>{eff}% eff.</div>}
        {loading && <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>Laden...</div>}
      </div>

      {/* Donut chart — full width, responsive */}
      <div style={{ flex: 1, minHeight: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} innerRadius="45%" outerRadius="65%" dataKey="value" strokeWidth={0} startAngle={90} endAngle={-270}>
              {data.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
            <Tooltip
              contentStyle={{ background: '#0b0b1a', border: '1px solid #1c1c35', borderRadius: 3, fontSize: 11 }}
              formatter={(v: number, name: string) => [name === 'Kills' ? kills : losses, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
        <div style={{ background: 'rgba(62,207,110,0.06)', border: '1px solid rgba(62,207,110,0.15)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: '#3ecf6e', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>KILLS</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{kills}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{fmt(killValue)} ISK</div>
        </div>
        <div style={{ background: 'rgba(224,85,85,0.06)', border: '1px solid rgba(224,85,85,0.15)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: '#e05555', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>LOSSES</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{losses}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{fmt(lossValue)} ISK</div>
        </div>
      </div>
    </div>
  )
}
