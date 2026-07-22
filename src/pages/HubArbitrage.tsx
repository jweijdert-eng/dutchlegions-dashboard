import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { openMarketWindow } from '../api/esi'
import EveImage from '../components/EveImage'
import Layout, { PageHeader } from '../components/Layout'
import { CATS } from './GapScanner'

// Hub-to-hub arbitrage: koop een item in de goedkoopste hub, versleep het en
// verkoop het in de duurste. De data komt van api/hubarbitrage.php: dat vergelijkt
// de laagste verkoopprijs per item in Jita, Amarr, Dodixie, Rens en Hek.
//
// Belangrijkste maat is ISK per m³: je vrachtschip heeft beperkte cargo, dus wat
// levert een kans op per kubieke meter die je moet verslepen?

// Standaard: alleen Ships aan (die zijn waardevol en handelen goed).
const DEFAULT_CATS: Record<string, boolean> = Object.fromEntries(CATS.map(c => [c.key, c.key === 'ships']))

const HUBS = ['Jita', 'Amarr', 'Dodixie', 'Rens', 'Hek']

type SortKey = 'profit' | 'margin' | 'perm3'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'profit', label: 'Winst/stuk' },
  { key: 'perm3',  label: 'ISK per m³' },
  { key: 'margin', label: 'Marge %' },
]

const LS_KEY = 'hubarb.v1'
function loadSettings(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}

// ── stijl (zelfde look als de Gap Scanner) ──
const INPUT: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none',
}
const LABEL: React.CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem',
}
const TH: React.CSSProperties = {
  textAlign: 'right', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { textAlign: 'right', padding: '0.4rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }

function fmtISK(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toLocaleString('nl-NL', { maximumFractionDigits: 0 })
}

interface RawRow { t: number; bh: string; bp: number; sh: string; sp: number; ss: number }

export default function HubArbitrage() {
  const { tokens, activeTokens } = useAuth()
  const [msg, setMsg] = useState<string | null>(null)

  const [bundles, setBundles] = useState<{
    typeInfo: Record<string, [number, number, number]>   // [groupId, volume, portionSize]
    groups: Record<string, [string, number]>             // [groupName, categoryId]
    names: Record<string, string>
  } | null>(null)

  const [cats, setCats] = useState<Record<string, boolean>>(
    () => ({ ...DEFAULT_CATS, ...(loadSettings().cats as Record<string, boolean> | undefined) }))
  const [minMargin, setMinMargin] = useState(() => (loadSettings().minMargin as number) ?? 15)
  const [minValue,  setMinValue]  = useState(() => (loadSettings().minValue as number) ?? 1_000_000)
  const [feePct,    setFeePct]    = useState(() => (loadSettings().feePct as number) ?? 8)
  const [buyHub,    setBuyHub]    = useState(() => (loadSettings().buyHub as string) ?? 'alle')
  const [sellHub,   setSellHub]   = useState(() => (loadSettings().sellHub as string) ?? 'alle')
  const [sortKey,   setSortKey]   = useState<SortKey>(() => (loadSettings().sortKey as SortKey) ?? 'perm3')

  const [raw, setRaw] = useState<RawRow[]>([])
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)

  // Bundels laden (namen, volume, categorie per item).
  useEffect(() => {
    Promise.all([
      fetch('/type-info.json').then(r => r.json()),
      fetch('/groups.json').then(r => r.json()),
      fetch('/type-names.json').then(r => r.json()),
    ]).then(([typeInfo, groups, names]) => setBundles({ typeInfo, groups, names }))
      .catch(() => setErr('Kon de SDE-bundel niet laden.'))
  }, [])

  // Instellingen onthouden.
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(
        { cats, minMargin, minValue, feePct, buyHub, sellHub, sortKey }))
    } catch { /* niet erg */ }
  }, [cats, minMargin, minValue, feePct, buyHub, sellHub, sortKey])

  // Type-ids voor de gekozen categorieën.
  const typeSet = useMemo(() => {
    const set = new Set<number>()
    if (!bundles) return set
    const active = CATS.filter(c => cats[c.key])
    if (active.length === 0) return set
    for (const [id, t] of Object.entries(bundles.typeInfo)) {
      const g = bundles.groups[String(t[0])]
      if (!g) continue
      const [groupName, categoryId] = g
      if (active.some(c => c.test(groupName, categoryId))) set.add(Number(id))
    }
    return set
  }, [bundles, cats])

  // Scan: stuur de type-ids naar de server; die geeft de kansen terug. Duurt het
  // ophalen te lang (pending > 0), dan bellen we nog een keer tot alles binnen is.
  const scan = async () => {
    const types = [...typeSet]
    if (!types.length) return
    setLoading(true); setErr(null); setScanned(true)
    try {
      let pend = 1, guard = 0
      while (pend > 0 && guard < 15) {
        const res = await fetch('/api/hubarbitrage.php', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ types }),
        })
        const data = await res.json() as { ok?: boolean; rows?: RawRow[]; pending?: number }
        if (!res.ok || !data.ok) { setErr('Ophalen mislukt.'); break }
        setRaw(data.rows ?? [])          // elke ronde geeft de volledige stand tot nu toe
        pend = data.pending ?? 0
        setPending(pend)
        guard++
      }
    } catch {
      setErr('Scan mislukt — server niet bereikbaar?')
    } finally {
      setLoading(false); setPending(0)
    }
  }

  // Rauwe kansen → winst na fees, marge, m³ en ISK/m³; daarna filteren + sorteren.
  const rows = useMemo(() => {
    if (!bundles) return []
    const fee = feePct / 100
    return raw
      .map(r => {
        const vol = bundles.typeInfo[String(r.t)]?.[1] ?? 0     // m³ per stuk
        const grp = bundles.groups[String(bundles.typeInfo[String(r.t)]?.[0])]
        const profit = r.sp * (1 - fee) - r.bp                  // winst per stuk
        const margin = r.bp > 0 ? (profit / r.bp) * 100 : 0
        const perM3  = vol > 0 ? profit / vol : 0
        return {
          ...r,
          name: bundles.names[String(r.t)] ?? `#${r.t}`,
          groupName: grp?.[0] ?? '',
          vol, profit, margin, perM3,
        }
      })
      .filter(r => r.profit > 0 && r.margin >= minMargin && r.bp >= minValue)
      .filter(r => buyHub === 'alle' || r.bh === buyHub)
      .filter(r => sellHub === 'alle' || r.sh === sellHub)
      .sort((a, b) => {
        switch (sortKey) {
          case 'margin': return b.margin - a.margin
          case 'profit': return b.profit - a.profit
          default:       return b.perM3 - a.perM3
        }
      })
  }, [raw, bundles, feePct, minMargin, minValue, buyHub, sellHub, sortKey])

  const openInEve = async (typeId: number) => {
    const t = activeTokens[0] ?? tokens[0]
    if (!t) { setMsg('Log in / selecteer een character om items in-game te openen.'); return }
    setMsg(null)
    const ok = await openMarketWindow(typeId, t.accessToken)
    if (!ok) setMsg('Kon het marktvenster niet openen — draait de EVE-client, en is het actieve character ingelogd?')
  }

  return (
    <Layout header={<PageHeader title="🔀 Hub-arbitrage"
      sub="Koop in de goedkoopste hub, versleep en verkoop in de duurste. Let op ISK per m³ — je cargo is beperkt." />}>
      <div style={{ width: '100%' }}>

      {/* Categorieën */}
      <div style={{ marginBottom: '0.7rem' }}>
        <div style={LABEL}>CATEGORIEËN</div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {CATS.filter(c => !c.parent).map(c => (
            <button key={c.key} onClick={() => setCats(s => ({ ...s, [c.key]: !s[c.key] }))}
              style={{
                ...INPUT, cursor: 'pointer', fontWeight: 600,
                background: cats[c.key] ? 'var(--blue)' : 'var(--surface2)',
                color: cats[c.key] ? '#0a0a12' : 'var(--text)',
                borderColor: cats[c.key] ? 'var(--blue)' : 'var(--border)',
              }}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Filters + scan */}
      <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
        <div>
          <div style={LABEL}>MIN. MARGE %</div>
          <input type="number" value={minMargin} min={0} onChange={e => setMinMargin(+e.target.value)} style={{ ...INPUT, width: 90 }} />
        </div>
        <div>
          <div style={LABEL}>MIN. KOOPPRIJS</div>
          <input type="number" value={minValue} min={0} step={1_000_000} onChange={e => setMinValue(+e.target.value)} style={{ ...INPUT, width: 120 }} />
        </div>
        <div>
          <div style={LABEL}>VERKOOP-FEES %</div>
          <input type="number" value={feePct} min={0} step={0.5} onChange={e => setFeePct(+e.target.value)} style={{ ...INPUT, width: 90 }} />
        </div>
        <div>
          <div style={LABEL} title="Alleen kansen die je in deze hub koopt">KOOP-HUB</div>
          <select value={buyHub} onChange={e => setBuyHub(e.target.value)} style={{ ...INPUT, width: 100 }}>
            <option value="alle">alle</option>
            {HUBS.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
        <div>
          <div style={LABEL} title="Alleen kansen die je in deze hub verkoopt (bv. waar je woont)">VERKOOP-HUB</div>
          <select value={sellHub} onChange={e => setSellHub(e.target.value)} style={{ ...INPUT, width: 100 }}>
            <option value="alle">alle</option>
            {HUBS.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
        <button onClick={scan} disabled={loading || typeSet.size === 0} style={{
          ...INPUT, cursor: loading ? 'wait' : 'pointer', fontWeight: 700,
          background: 'var(--blue)', color: '#0a0a12', borderColor: 'var(--blue)', padding: '0.4rem 1rem',
        }}>
          {loading ? (pending ? `Prijzen laden… (${pending})` : 'Scannen…') : scanned ? 'Opnieuw scannen' : 'Scan hubs'}
        </button>
        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
          {typeSet.size > 0 ? `${typeSet.size.toLocaleString('nl-NL')} items in scope` : 'kies een categorie'}
        </div>
      </div>

      {err && <div style={{ color: '#ff5c6c', fontSize: '0.72rem', marginBottom: '0.6rem' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--blue)', fontSize: '0.72rem', marginBottom: '0.6rem' }}>{msg}</div>}

      {scanned && !loading && (
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>SORTEER</span>
          {SORTS.map(s => (
            <button key={s.key} onClick={() => setSortKey(s.key)} style={{
              ...INPUT, cursor: 'pointer', fontWeight: 600, padding: '0.2rem 0.6rem',
              background: sortKey === s.key ? 'var(--blue)' : 'var(--surface2)',
              color: sortKey === s.key ? '#0a0a12' : 'var(--text)',
              borderColor: sortKey === s.key ? 'var(--blue)' : 'var(--border)',
            }}>{s.label}</button>
          ))}
          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginLeft: '0.4rem' }}>
            {rows.length} kans{rows.length === 1 ? '' : 'en'}
          </span>
        </div>
      )}

      {scanned && !loading && rows.length === 0 && !err && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>
          Geen kansen die aan je filters voldoen. Zet de min. marge lager, kies een andere categorie,
          of scan opnieuw.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th>
                <th style={{ ...TH, textAlign: 'left' }}>Koop in</th>
                <th style={TH}>Koopprijs</th>
                <th style={{ ...TH, textAlign: 'left' }}>Verkoop in</th>
                <th style={TH}>Verkoopprijs</th>
                <th style={TH}>Marge</th>
                <th style={TH}>Winst/stuk</th>
                <th style={TH} title="Volume per stuk">m³</th>
                <th style={TH} title="Winst per kubieke meter cargo — het belangrijkst voor haulers">ISK/m³</th>
                <th style={TH} title="Aanbod-volume in de verkoop-hub (ruwe concurrentie-maat)">Aanbod</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map(r => (
                <tr key={r.t} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...TD, textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <EveImage category="types" id={r.t} variation="icon" size={32} px={28} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                        <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>{r.groupName}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ ...TD, textAlign: 'left', color: 'var(--blue)', fontWeight: 600 }}>{r.bh}</td>
                  <td style={TD}>{fmtISK(r.bp)}</td>
                  <td style={{ ...TD, textAlign: 'left', color: 'var(--gold)', fontWeight: 600 }}>{r.sh}</td>
                  <td style={TD}>{fmtISK(r.sp)}</td>
                  <td style={{ ...TD, color: '#4ade80', fontWeight: 700 }}>{r.margin.toFixed(0)}%</td>
                  <td style={{ ...TD, color: '#4ade80' }}>{fmtISK(r.profit)}</td>
                  <td style={{ ...TD, color: 'var(--text-dim)' }}>{r.vol.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}</td>
                  <td style={{ ...TD, color: '#4ade80', fontWeight: 700 }}>{fmtISK(r.perM3)}</td>
                  <td style={{ ...TD, color: 'var(--text-dim)' }}>{Math.round(r.ss).toLocaleString('nl-NL')}</td>
                  <td style={TD}>
                    <button onClick={() => openInEve(r.t)} title="Open in EVE" style={{ ...INPUT, cursor: 'pointer', padding: '0.15rem 0.4rem' }}>⧉</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ color: 'var(--text-dim)', fontSize: '0.72rem', marginTop: '0.8rem', maxWidth: 900 }}>
        Prijzen zijn de laagste verkooporders per hub (Fuzzwork, 1 uur gecached). Winst/stuk = verkoopprijs
        min de verkoop-fees, min de koopprijs; vrachtkosten zitten er niet in — daarom is <b>ISK/m³</b> de
        maat die telt: hoe meer winst per kubieke meter, hoe minder je hoeft te verslepen. <b>Aanbod</b> is
        het huidige verkoopvolume in de verkoop-hub (veel aanbod = meer concurrentie). Check altijd even
        in-game of de kans er nog is voordat je verscheept.
      </p>
      </div>
    </Layout>
  )
}
