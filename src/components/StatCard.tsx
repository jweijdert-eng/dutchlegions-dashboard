interface StatCardProps {
  title: string
  value: string
  sub: string
  delta?: string
  deltaPositive?: boolean
  accentColor?: string
  valueColor?: string
}

export default function StatCard({ title, value, sub, delta, deltaPositive, accentColor = 'var(--blue)', valueColor }: StatCardProps) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 3,
      padding: '0.875rem 1rem',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accentColor, opacity: 0.8 }} />

      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.5rem' }}>
        {title}
      </div>
      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: valueColor ?? 'var(--text)', lineHeight: 1.1, marginBottom: '0.3rem' }}>
        {value}
      </div>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
        {sub}
      </div>
      {delta && (
        <div style={{
          fontSize: '0.66rem',
          color: deltaPositive === undefined ? 'var(--text-dim)' : deltaPositive ? 'var(--green)' : 'var(--red)',
          marginTop: '0.4rem',
          fontWeight: 600,
        }}>
          {delta}
        </div>
      )}
    </div>
  )
}
