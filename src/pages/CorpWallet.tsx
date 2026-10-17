import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { startLogin } from '../auth/sso'
import { tokenScopes } from '../api/esi'
import { CORP_DIVISIONS_SCOPE, CORP_WALLET_SCOPE, loadCorpJournal, loadCorpWallets, type CorpJournalEntry, type CorpWalletData } from '../api/corpWallet'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'
import './CorpWallet.css'

const isk = (value: number) => value.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const datum = (value: string) => new Date(value).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })
const reden = (value: string) => value.replace(/_/g, ' ')
const cel = { padding: '.6rem .75rem', textAlign: 'left' as const, fontSize: '.78rem' }

interface WalletState { key: string; wallets: CorpWalletData[]; notices: string[]; time: number }
interface JournalState { key: string; entries: CorpJournalEntry[]; page: number; pages: number }

export default function CorpWallet() {
  // Alle gekoppelde characters, niet alleen het geselecteerde: de wallet-rol zit vaak op een alt
  // (bv. de CEO van een eigen corp), terwijl je main bovenaan geselecteerd staat.
  const { tokens } = useAuth()
  // Character + toestemming, niet het token zelf: dat wordt elke ~20 minuten ververst.
  const tokenKey = tokens.map(t => `${t.characterId}:${tokenScopes(t.accessToken).includes(CORP_WALLET_SCOPE) ? 1 : 0}`).join('|')
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const [state, setState] = useState<WalletState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [corpId, setCorpId] = useState<number | null>(null)
  const [divisionId, setDivisionId] = useState(1)
  const [journal, setJournal] = useState<JournalState | null>(null)
  const [journalLoading, setJournalLoading] = useState(false)
  const [journalError, setJournalError] = useState('')
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all')
  const [search, setSearch] = useState('')
  usePageLoading(loading || journalLoading)

  // Een character erbij of eraf (of een ingetrokken toestemming) verbergt de vorige corpgegevens meteen.
  const wallets = state?.key === tokenKey ? state.wallets : []
  const wallet = wallets.find(w => w.id === corpId) ?? wallets[0]
  const division = wallet?.divisions.find(d => d.division === divisionId) ?? wallet?.divisions[0]
  const journalKey = wallet && division ? `${tokenKey}:${wallet.id}:${division.division}:${state?.time}` : ''
  const visibleJournal = journal?.key === journalKey ? journal : null
  const hasScope = tokens.some(t => tokenScopes(t.accessToken).includes(CORP_WALLET_SCOPE))

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    // Ook bij ingetrokken EVE-rechten geen oude saldi zichtbaar houden.
    setState(null)
    loadCorpWallets(tokensRef.current, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ ...result, key: tokenKey, time: Date.now() })
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Ophalen mislukt.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [tokenKey, refresh])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setRefresh(n => n + 1)
    }, 5 * 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    if (!wallet || !division) { setJournalLoading(false); return () => controller.abort() }
    setJournalLoading(true)
    setJournalError('')
    const requestedPage = page
    loadCorpJournal(wallet, tokensRef.current, division.division, requestedPage, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setJournal(old => {
        const previous = requestedPage > 1 && old?.key === journalKey ? old.entries : []
        const unique = new Map([...previous, ...result.entries].map(entry => [entry.id, entry]))
        return { key: journalKey, entries: [...unique.values()].sort((a, b) => b.date.localeCompare(a.date)), page: requestedPage, pages: result.pages }
      })
    }).catch(e => {
      if (!controller.signal.aborted) setJournalError(e instanceof Error ? e.message : 'Journaal ophalen mislukt.')
    }).finally(() => { if (!controller.signal.aborted) setJournalLoading(false) })
    return () => controller.abort()
  }, [journalKey, page])

  // Een nieuwe scan/corp/selectie begint steeds bij de nieuwste journaalregels.
  useEffect(() => { setPage(1) }, [journalKey])

  async function connect() {
    try { await startLogin([CORP_WALLET_SCOPE, CORP_DIVISIONS_SCOPE], '/corp-wallet') }
    catch (e) { setError(e instanceof Error ? e.message : 'Inloggen mislukt.') }
  }

  const entries = visibleJournal?.entries ?? []
  const filtered = entries.filter(e => (filter === 'all' || (filter === 'income' ? (e.amount ?? 0) > 0 : (e.amount ?? 0) < 0))
    && `${e.description} ${e.reason ?? ''} ${reden(e.ref_type)}`.toLowerCase().includes(search.trim().toLowerCase()))
  const income = entries.reduce((sum, e) => sum + Math.max(0, e.amount ?? 0), 0)
  const expense = entries.reduce((sum, e) => sum + Math.min(0, e.amount ?? 0), 0)

  return <Layout header={<PageHeader title="Corp wallet"
    sub="Corporatiesaldo, divisies en journaal"
    right={<button className="corp-wallet-btn" disabled={loading || journalLoading} onClick={() => { setPage(1); setRefresh(n => n + 1) }}>↻ Verversen</button>} />}>
    <div className="corp-wallet">
    <p style={{ color: 'var(--text-dim)', fontSize: '.8rem', marginTop: 0 }}>
      Je ziet de wallets waarvoor een van je gekoppelde characters in EVE leesrechten heeft. Automatisch bijgewerkt om de vijf minuten.
    </p>
    {error && <div className="card" role="alert" style={{ padding: '1rem', color: 'var(--red)', marginBottom: '.75rem' }}>{error}</div>}
    {state?.key === tokenKey && state.notices.map(notice => <div className="card" role="alert" key={notice} style={{ padding: '1rem', color: 'var(--gold)', marginBottom: '.75rem' }}>{notice}</div>)}
    {!loading && (!hasScope || !wallet) && <div className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
      <strong>Corp wallet koppelen</strong>
      <p style={{ fontSize: '.82rem', color: 'var(--text-dim)' }}>
        Log opnieuw in met het character dat de corp wallet mag lezen en geef toestemming voor de corp wallet.
        EVE controleert de corporationrol (zoals Accountant of Director). Divisienamen zijn alleen beschikbaar met Director-rechten.
      </p>
      <button className="corp-wallet-btn" onClick={() => void connect()}>Toestemming geven via EVE</button>
    </div>}
    {loading && <div className="card" style={{ padding: '1rem' }}>Corp wallets ophalen…</div>}
    {wallet && <>
      <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label>Corporation <select aria-label="Corporation" value={wallet.id} onChange={e => { setCorpId(Number(e.target.value)); setDivisionId(1); setPage(1) }}>
          {wallets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select></label>
        <span style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Via {wallet.via} · bijgewerkt {new Date(state!.time).toLocaleTimeString('nl-NL')}</span>
      </div>
      <div className="card" style={{ padding: '1rem', marginBottom: '.75rem', borderTop: '2px solid var(--blue)' }}>
        <div style={{ color: 'var(--text-dim)', fontSize: '.75rem' }}>Totaal corp-saldo · {wallet.name}</div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: '.3rem' }} data-testid="corp-total">{isk(wallet.divisions.reduce((sum, d) => sum + d.balance, 0))} ISK</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.65rem', marginBottom: '1rem' }}>
        {wallet.divisions.map(d => <button className="card" key={d.division} aria-pressed={division?.division === d.division}
          onClick={() => { setDivisionId(d.division); setPage(1) }} style={{ padding: '.85rem', textAlign: 'left', color: 'var(--text)', cursor: 'pointer',
            borderColor: division?.division === d.division ? 'var(--blue)' : 'var(--border)' }}>
          <div style={{ color: 'var(--text-dim)', fontSize: '.75rem' }}>{d.name}</div>
          <div style={{ fontWeight: 600, marginTop: '.35rem' }}>{isk(d.balance)} ISK</div>
        </button>)}
      </div>
      {division && <section className="card" style={{ padding: '1rem' }}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Journaal · {division.name}</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: '.78rem' }}>EVE levert maximaal 30 dagen geschiedenis. In de geladen regels: inkomsten {isk(income)} ISK · uitgaven {isk(expense)} ISK.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginBottom: '.8rem' }}>
          {(['all', 'income', 'expense'] as const).map(f => <button className="corp-wallet-btn" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'Alles' : f === 'income' ? 'Inkomsten' : 'Uitgaven'}</button>)}
          <input aria-label="Zoek in journaal" placeholder="Zoek omschrijving of type…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {journalError && <div role="alert" style={{ color: 'var(--red)', marginBottom: '.75rem' }}>{journalError} Gebruik Verversen om opnieuw te proberen.</div>}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Datum', 'Type', 'Omschrijving', 'Bedrag (ISK)', 'Saldo (ISK)'].map(label => <th key={label} style={cel}>{label}</th>)}</tr></thead>
            <tbody>
              {filtered.map(e => <tr key={e.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...cel, whiteSpace: 'nowrap' }}>{datum(e.date)}</td>
                <td style={cel}>{reden(e.ref_type)}</td>
                <td style={cel}>{e.description || e.reason || '—'}</td>
                <td style={{ ...cel, whiteSpace: 'nowrap', color: e.amount == null ? 'var(--text-dim)' : e.amount >= 0 ? 'var(--green)' : 'var(--red)' }}>{e.amount == null ? '—' : `${e.amount > 0 ? '+' : ''}${isk(e.amount)}`}</td>
                <td style={{ ...cel, whiteSpace: 'nowrap' }}>{e.balance == null ? '—' : isk(e.balance)}</td>
              </tr>)}
              {journalLoading && <tr><td colSpan={5} style={cel}>Journaal ophalen…</td></tr>}
              {!journalLoading && !journalError && !filtered.length && <tr><td colSpan={5} style={cel}>{entries.length ? 'Geen regels die aan je filters voldoen.' : 'Geen journaalregels in deze divisie.'}</td></tr>}
            </tbody>
          </table>
        </div>
        {visibleJournal && <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '.8rem', fontSize: '.78rem' }}>
          <span>{filtered.length} getoond · {entries.length} geladen</span>
          {visibleJournal.page < visibleJournal.pages && <button className="corp-wallet-btn" disabled={journalLoading} onClick={() => setPage(visibleJournal.page + 1)}>Meer laden</button>}
        </div>}
      </section>}
    </>}
    </div>
  </Layout>
}
