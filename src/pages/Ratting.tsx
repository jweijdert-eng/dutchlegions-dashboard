import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import { getWalletJournal, type WalletJournalEntry } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'

function fmtISK(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(0)}K`
  return `${abs.toFixed(0)}`
}

function dayKey(date: string) {
  return date.slice(0, 10)
}

interface DayData {
  day: string
  bounties: number
  ess: number
}

export default function Ratting() {
  const { activeTokens } = useAuth()
  const [journal, setJournal] = useState<WalletJournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)

  useEffect(() => {
    if (activeTokens.length === 0) return
    setLoading(true)

    async function load() {
      const journalResults = await Promise.allSettled(
        activeTokens.map(t => getWalletJournal(t.characterId, t.accessToken, 5))
      )

      const allJournal: WalletJournalEntry[] = []
      for (const r of journalResults) {
        if (r.status === 'fulfilled') allJournal.push(...r.value)
      }
      allJournal.sort((a, b) => b.date.localeCompare(a.date))
      setJournal(allJournal.filter(e => e.ref_type === 'bounty_prizes' || e.ref_type === 'ess_escrow_transfer'))

      setLoading(false)
    }
    load()
  }, [activeTokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const totalBounties = journal.filter(e => e.ref_type === 'bounty_prizes').reduce((s, e) => s + e.amount, 0)
  const totalESS      = journal.filter(e => e.ref_type === 'ess_escrow_transfer').reduce((s, e) => s + e.amount, 0)
  const total         = totalBounties + totalESS
  const sessions      = journal.filter(e => e.ref_type === 'bounty_prizes').length

  // Groepeer per dag
  const byDay = new Map<string, DayData>()
  for (const e of journal) {
    const d = dayKey(e.date)
    if (!byDay.has(d)) byDay.set(d, { day: d, bounties: 0, ess: 0 })
    if (e.ref_type === 'bounty_prizes') byDay.get(d)!.bounties += e.amount
    else byDay.get(d)!.ess += e.amount
  }
  const dailyData = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({ ...v, bounties: Math.round(v.bounties / 1e6), ess: Math.round(v.ess / 1e6) }))

  const activeDays = byDay.size
  const avgPerDay  = activeDays > 0 ? total / activeDays : 0

  return (
    <Layout header={<PageHeader title="Ratting" sub={loading ? 'Laden...' : `${fmtISK(total)} ISK totaal`} />}>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { label: 'TOTAAL BOUNTIES', value: fmtISK(totalBounties), color: 'var(--gold)',  sub: 'ISK' },
          { label: 'TOTAAL ESS',      value: fmtISK(totalESS),      color: 'var(--blue)',  sub: 'ISK' },
          { label: 'GEM. PER DAG',    value: fmtISK(avgPerDay),     color: 'var(--green)', sub: `over ${activeDays} dagen` },
          { label: 'BOUNTY BETALINGEN', value: sessions.toLocaleString('nl'), color: 'var(--text)', sub: 'entries in journal' },
        ].map(c => (
          <div key={c.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: c.color, opacity: 0.6 }} />
            <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.4rem' }}>{c.label}</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: c.color }}>{loading ? '—' : c.value}</div>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Dagelijkse grafiek */}
      {!loading && dailyData.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem', marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.75rem' }}>RATTING INKOMSTEN PER DAG (M ISK)</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyData} margin={{ top: 4, right: 0, left: -10, bottom: 0 }}>
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickFormatter={d => d.slice(5)} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} />
              <Tooltip
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.75rem' }}
                formatter={(v: number, name: string) => [`${v}M ISK`, name === 'bounties' ? 'Bounties' : 'ESS']}
                labelFormatter={l => l}
              />
              <Legend formatter={v => v === 'bounties' ? 'Bounties' : 'ESS'} wrapperStyle={{ fontSize: '0.7rem' }} />
              <Bar dataKey="bounties" stackId="a" fill="#f0c04099" radius={[0, 0, 0, 0]} />
              <Bar dataKey="ess"      stackId="a" fill="#00b4d899" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recente entries */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ padding: '0.7rem 0.875rem 0.4rem', borderBottom: '1px solid var(--border)', fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>
          RECENTE RATTING — {journal.length} ENTRIES
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface2)' }}>
              <tr>
                {['Datum', 'Type', 'Bedrag'].map(h => (
                  <th key={h} style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', padding: '0.35rem 0.6rem', textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={3} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Laden...</td></tr>}
              {!loading && journal.length === 0 && <tr><td colSpan={3} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen ratting data gevonden.</td></tr>}
              {journal.slice(0, 100).map((e, i) => (
                <tr key={e.id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent' }}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.6rem', whiteSpace: 'nowrap' }}>
                    {new Date(e.date).toLocaleString('nl-NL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td style={{ fontSize: '0.68rem', padding: '0.35rem 0.6rem', whiteSpace: 'nowrap', color: e.ref_type === 'ess_escrow_transfer' ? 'var(--blue)' : 'var(--gold)' }}>
                    {e.ref_type === 'ess_escrow_transfer' ? 'ESS' : 'Bounty'}
                  </td>
                  <td style={{ fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.6rem', whiteSpace: 'nowrap', color: 'var(--green)' }}>
                    +{fmtISK(e.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}
