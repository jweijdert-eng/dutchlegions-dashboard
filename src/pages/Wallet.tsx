import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getWallet, getWalletJournal, type WalletJournalEntry } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import WalletChart from '../components/WalletChart'
import { usePageLoading } from '../hooks/usePageLoading'

function fmtISK(v: number) {
  const n   = Number(v)
  const abs = Math.abs(n)
  const neg = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}

function fmtDate(d: string) {
  return new Date(d).toLocaleString('nl-NL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const REF_LABELS: Record<string, string> = {
  bounty_prizes:          'Bounty',
  market_transaction:     'Market',
  contract_reward:        'Contract',
  agent_mission_reward:   'Mission',
  player_trading:         'Trade',
  industry_job_tax:       'Industry',
  structure_gate_jump:    'Gate Jump',
  brokers_fee:            'Broker Fee',
  transaction_tax:        'Tax',
  ess_escrow_transfer:    'ESS',
  planetary_import_tax:   'PI Import',
  planetary_export_tax:   'PI Export',
}

function refLabel(type: string) {
  return REF_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const INCOME_COLORS: Record<string, string> = {
  bounty_prizes:        '#f0c040',
  market_transaction:   '#00b4d8',
  contract_reward:      '#a78bfa',
  agent_mission_reward: '#3ecf6e',
  player_trading:       '#00b4d8',
  ess_escrow_transfer:  '#f97316',
  contract_price:       '#a78bfa',
}

function IncomeBreakdown({ journal }: { journal: WalletJournalEntry[] }) {
  const byType = new Map<string, number>()
  for (const e of journal) {
    if (e.amount > 0) byType.set(e.ref_type, (byType.get(e.ref_type) ?? 0) + e.amount)
  }
  const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7)
  if (sorted.length === 0) return null
  const max = sorted[0][1]
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem', marginBottom: '0.75rem' }}>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.65rem' }}>INKOMSTEN PER CATEGORIE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.38rem' }}>
        {sorted.map(([type, amount]) => {
          const color = INCOME_COLORS[type] ?? '#3ecf6e'
          return (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <div style={{ width: 120, flexShrink: 0, fontSize: '0.63rem', color: 'var(--text-dim)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {refLabel(type)}
              </div>
              <div style={{ flex: 1, height: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${(amount / max) * 100}%`,
                  background: `linear-gradient(90deg, ${color}70, ${color}30)`,
                  borderRadius: 2,
                }} />
              </div>
              <div style={{ width: 80, flexShrink: 0, fontSize: '0.65rem', fontWeight: 600, color, textAlign: 'right' }}>
                +{fmtISK(amount)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface WalletState {
  balance: number
  journal: WalletJournalEntry[]
  loading: boolean
}

export default function Wallet() {
  const { activeTokens: tokens } = useAuth()
  const [state, setState] = useState<WalletState>({ balance: 0, journal: [], loading: true })
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all')
  usePageLoading(state.loading)

  useEffect(() => {
    if (tokens.length === 0) return
    setState({ balance: 0, journal: [], loading: true })

    async function load() {
      const results = await Promise.allSettled(
        tokens.map(t => Promise.all([
          getWallet(t.characterId, t.accessToken),
          getWalletJournal(t.characterId, t.accessToken, 10),
        ]))
      )
      let totalBalance = 0
      const allJournal: WalletJournalEntry[] = []
      for (const r of results) {
        if (r.status === 'fulfilled') {
          totalBalance += r.value[0]
          allJournal.push(...r.value[1])
        }
      }
      allJournal.sort((a, b) => b.date.localeCompare(a.date))
      setState({ balance: totalBalance, journal: allJournal, loading: false })
    }
    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const { balance, journal, loading } = state

  const filtered = journal.filter(e => {
    if (filter === 'income')  return e.amount > 0
    if (filter === 'expense') return e.amount < 0
    return true
  })

  const totalIncome  = journal.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0)
  const totalExpense = journal.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0)

  const btnStyle = (active: boolean) => ({
    padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
    background: active ? 'rgba(0,180,216,0.15)' : 'transparent',
    border: `1px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
    color: active ? 'var(--blue)' : 'var(--text-dim)',
  } as const)

  return (
    <Layout header={
      <PageHeader
        title="Wallet"
        sub={loading ? 'Laden...' : `${fmtISK(balance)} ISK`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {(['all', 'income', 'expense'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={btnStyle(filter === f)}>
                {f === 'all' ? 'Alles' : f === 'income' ? 'Inkomsten' : 'Uitgaven'}
              </button>
            ))}
          </div>
        }
      />
    }>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { label: 'HUIDIG SALDO', value: fmtISK(balance), color: balance < 0 ? 'var(--red)' : 'var(--text)' },
          { label: 'TOTAAL INKOMSTEN', value: `+${fmtISK(totalIncome)}`, color: 'var(--green)' },
          { label: 'TOTAAL UITGAVEN',  value: fmtISK(totalExpense), color: 'var(--red)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--blue)', opacity: 0.6 }} />
            <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.4rem' }}>{label}</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>ISK</div>
          </div>
        ))}
      </div>

      {/* Income breakdown */}
      {!loading && <IncomeBreakdown journal={journal} />}

      {/* Chart */}
      <div style={{ marginBottom: '0.75rem' }}>
        <WalletChart journal={journal} loading={loading} />
      </div>

      {/* Journal table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ padding: '0.7rem 0.875rem 0.4rem', borderBottom: '1px solid var(--border)', fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>
          WALLET JOURNAL — {filtered.length} ENTRIES
        </div>
        <div style={{ maxHeight: 500, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface2)' }}>
              <tr>
                {['Datum', 'Type', 'Omschrijving', 'Bedrag', 'Saldo'].map(h => (
                  <th key={h} style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', padding: '0.35rem 0.6rem', textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Laden...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen entries</td></tr>
              )}
              {filtered.map((e, i) => (
                <tr key={e.id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent' }}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.6rem', whiteSpace: 'nowrap' }}>{fmtDate(e.date)}</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--blue)', padding: '0.35rem 0.6rem', whiteSpace: 'nowrap' }}>{refLabel(e.ref_type)}</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.6rem', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.description || '—'}
                  </td>
                  <td style={{ fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.6rem', whiteSpace: 'nowrap', color: e.amount >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {e.amount >= 0 ? '+' : ''}{fmtISK(e.amount)}
                  </td>
                  <td style={{ fontSize: '0.72rem', padding: '0.35rem 0.6rem', whiteSpace: 'nowrap', color: e.balance < 0 ? 'var(--red)' : 'var(--text)' }}>
                    {fmtISK(e.balance)}
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

