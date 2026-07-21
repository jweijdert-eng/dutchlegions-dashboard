import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import { useMyRole } from '../hooks/useMyRole'
import { getContracts, getStructureName, resolveNames, type Contract } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'

function fmtISK(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(0)}K`
  return `${abs.toFixed(0)}`
}

function fmtDT(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('nl-NL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Duur tussen accepteren en opleveren, compact.
function fmtDur(fromIso?: string, toIso?: string) {
  if (!fromIso || !toIso) return '—'
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (!isFinite(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d) return `${d}d ${h % 24}u`
  if (h) return `${h}u ${m % 60}m`
  return `${m}m`
}

interface Haul extends Contract {
  charName: string
  startName: string
  endName: string
}

// "Jita IV - Moon 4 - Caldari Navy Assembly Plant" → "Jita IV"; structures: "Systeem - Naam" → "Systeem"
function shortLoc(name: string) {
  return name.split(' - ')[0]
}

const FINISHED = ['finished', 'finished_contractor', 'finished_issuer']

export default function Hauling() {
  const { activeTokens: tokens } = useAuth()
  const [hauls, setHauls]     = useState<Haul[]>([])
  const [loading, setLoading] = useState(true)
  const [demo, setDemo]       = useState(false)
  const isAdmin = useMyRole() === 'admin'
  usePageLoading(loading)
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setHauls([])

    async function load() {
      const myIds = new Set(tokens.map(t => t.characterId))
      const all: Array<Contract & { charName: string }> = []
      await Promise.all(tokens.map(async t => {
        const cs = await getContracts(t.characterId, t.accessToken).catch(() => [] as Contract[])
        for (const c of cs) {
          // Couriers die ík heb geaccepteerd (beloning is voor mij); dedupe over characters
          if (c.type !== 'courier') continue
          if (!c.acceptor_id || !myIds.has(c.acceptor_id)) continue
          if (all.some(x => x.contract_id === c.contract_id)) continue
          all.push({ ...c, charName: tokens.find(tk => tk.characterId === c.acceptor_id)?.characterName ?? `#${c.acceptor_id}` })
        }
      }))
      if (myId !== fetchId.current) return

      const locationIds = [...new Set(all.flatMap(c => [c.start_location_id, c.end_location_id]).filter((id): id is number => Boolean(id)))]
      const nameMap = await resolveNames(locationIds)
      if (myId !== fetchId.current) return

      const structureIds = locationIds.filter(id => id > 2_147_483_647)
      const structureNames = new Map<number, string>()
      await Promise.all(structureIds.map(async id => {
        const name = await getStructureName(id, tokens)
        if (name) structureNames.set(id, name)
      }))
      if (myId !== fetchId.current) return

      const locName = (id?: number) => id ? nameMap.get(id) ?? structureNames.get(id) ?? `#${id}` : '?'
      setHauls(
        all.map(c => ({ ...c, startName: locName(c.start_location_id), endName: locName(c.end_location_id) }))
          .sort((a, b) => (b.date_completed ?? b.date_issued).localeCompare(a.date_completed ?? a.date_issued))
      )
      setLoading(false)
    }
    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  // Demo-voorbeeld: 1 voltooid + 1 onderweg sample-contract (raakt echte data niet).
  const demoHauls = useMemo<Haul[]>(() => {
    if (!demo) return []
    const now = Date.now()
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
    const base = { type: 'courier' as const, availability: 'personal' as const, issuer_id: 0, acceptor_id: 0, for_corporation: false, price: 0 }
    return [
      { ...base, contract_id: -1, status: 'finished', reward: 45_000_000, collateral: 800_000_000, volume: 15000,
        date_issued: iso(4 * 3600e3), date_expired: iso(-7 * 24 * 3600e3), date_accepted: iso(3 * 3600e3), date_completed: iso(12 * 60e3),
        start_location_id: 0, end_location_id: 0, charName: 'DEMO',
        startName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', endName: 'Amarr VIII - Emperor Family Academy' } as Haul,
      { ...base, contract_id: -2, status: 'in_progress', reward: 30_000_000, collateral: 500_000_000, volume: 9000,
        date_issued: iso(2 * 3600e3), date_expired: iso(-7 * 24 * 3600e3), date_accepted: iso(90 * 60e3),
        start_location_id: 0, end_location_id: 0, charName: 'DEMO',
        startName: 'Amarr VIII - Emperor Family Academy', endName: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant' } as Haul,
    ]
  }, [demo])

  const shown = (demo && isAdmin) ? hauls.concat(demoHauls) : hauls
  const completed  = shown.filter(c => FINISHED.includes(c.status) && c.date_completed)
  const inProgress = shown.filter(c => c.status === 'in_progress')
  const failed     = shown.filter(c => c.status === 'failed')

  const totalReward    = completed.reduce((s, c) => s + c.reward, 0)
  const totalVolume    = completed.reduce((s, c) => s + (c.volume ?? 0), 0)
  const lostCollateral = failed.reduce((s, c) => s + (c.collateral ?? 0), 0)

  // Verdiensten per dag (datum van oplevering)
  const byDay = new Map<string, number>()
  for (const c of completed) byDay.set(c.date_completed!.slice(0, 10), (byDay.get(c.date_completed!.slice(0, 10)) ?? 0) + c.reward)
  const dailyData = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, reward]) => ({ day, reward: Math.round(reward / 1e5) / 10 }))

  const activeDays = byDay.size
  const avgPerDay  = activeDays > 0 ? totalReward / activeDays : 0

  return (
    <Layout header={<PageHeader title="Hauling" sub={loading ? 'Laden...' : `${fmtISK(totalReward)} ISK verdiend (laatste ~30 dagen)`} />}>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { label: 'TOTAAL VERDIEND', value: fmtISK(totalReward), color: 'var(--green)', sub: `${completed.length} hauls voltooid` },
          { label: 'GEM. PER DAG',    value: fmtISK(avgPerDay),   color: 'var(--gold)',  sub: `over ${activeDays} actieve dagen` },
          { label: 'VOLUME GEHAULD',  value: `${Math.round(totalVolume).toLocaleString('nl')} m³`, color: 'var(--blue)', sub: totalVolume > 0 ? `${fmtISK(totalReward / totalVolume)} ISK/m³` : '—' },
          { label: 'ONDERWEG',        value: String(inProgress.length), color: 'var(--text)', sub: failed.length > 0 ? `${failed.length} gefaald (−${fmtISK(lostCollateral)} collateral)` : 'lopende contracten' },
        ].map(c => (
          <div key={c.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: c.color, opacity: 0.6 }} />
            <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.4rem' }}>{c.label}</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: c.color }}>{loading ? '—' : c.value}</div>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{loading ? '' : c.sub}</div>
          </div>
        ))}
      </div>

      {/* Demo-voorbeeld — alleen voor de admin */}
      {isAdmin && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
          <button onClick={() => setDemo(d => !d)} style={{ padding: '0.3rem 0.7rem', borderRadius: 2, border: '1px solid var(--border)', background: demo ? 'rgba(0,180,216,0.12)' : 'transparent', color: demo ? 'var(--blue)' : 'var(--text-dim)', cursor: 'pointer', fontSize: '0.68rem' }}>
            {demo ? '✕ Voorbeeld verbergen' : '👁 Voorbeeld tonen'} <span title="Alleen zichtbaar voor admin" style={{ opacity: 0.7 }}>🔒</span>
          </button>
        </div>
      )}

      {/* Verdiensten per dag */}
      {!loading && dailyData.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem', marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.75rem' }}>HAUL VERDIENSTEN PER DAG (M ISK)</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyData} margin={{ top: 4, right: 0, left: -10, bottom: 0 }}>
              <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickFormatter={d => d.slice(5)} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} />
              <Tooltip
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.75rem' }}
                formatter={(v: number) => [`${v}M ISK`, 'Beloning']}
              />
              <Bar dataKey="reward" fill="#3ecf6e99" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Onderweg */}
      {!loading && inProgress.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden', marginBottom: '0.75rem' }}>
          <div style={{ padding: '0.7rem 0.875rem 0.4rem', borderBottom: '1px solid var(--border)', fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>
            ONDERWEG — {inProgress.length} CONTRACTEN ({fmtISK(inProgress.reduce((s, c) => s + c.reward, 0))} ISK te verdienen)
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {inProgress.map((c, i) => (
                <tr key={c.contract_id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent' }}>
                  <td style={{ fontSize: '0.7rem', padding: '0.4rem 0.875rem', whiteSpace: 'nowrap' }} title={`${c.startName} → ${c.endName}`}>
                    {shortLoc(c.startName)} <span style={{ color: 'var(--blue)' }}>→</span> {shortLoc(c.endName)}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', whiteSpace: 'nowrap' }}>{Math.round(c.volume ?? 0).toLocaleString('nl')} m³</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', whiteSpace: 'nowrap' }}>
                    {c.charName}{c.contract_id < 0 && <span style={{ marginLeft: '0.3rem', fontSize: '0.55rem', fontWeight: 800, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 2, padding: '0 0.25rem' }}>DEMO</span>}
                  </td>
                  <td style={{ fontSize: '0.66rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', whiteSpace: 'nowrap' }} title="Geaccepteerd op">✔ {fmtDT(c.date_accepted)}</td>
                  <td style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--green)', padding: '0.4rem 0.875rem', textAlign: 'right', whiteSpace: 'nowrap' }}>+{fmtISK(c.reward)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Voltooide hauls */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ padding: '0.7rem 0.875rem 0.4rem', borderBottom: '1px solid var(--border)', fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>
          VOLTOOIDE HAULS — {completed.length}
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--surface2)', zIndex: 1 }}>
              <tr>
                {['Geaccepteerd', 'Opgeleverd', 'Duur', 'Route', 'Volume', 'Character', 'Beloning'].map((h, i) => (
                  <th key={h} style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', padding: '0.35rem 0.875rem', textAlign: i === 6 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Laden...</td></tr>}
              {!loading && completed.length === 0 && <tr><td colSpan={7} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen voltooide courier-contracten gevonden (ESI toont ~30 dagen terug).</td></tr>}
              {completed.map((c, i) => (
                <tr key={c.contract_id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent' }}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>{fmtDT(c.date_accepted)}</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>{fmtDT(c.date_completed)}</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }} title="Tijd tussen accepteren en opleveren">{fmtDur(c.date_accepted, c.date_completed)}</td>
                  <td style={{ fontSize: '0.7rem', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }} title={`${c.startName} → ${c.endName}`}>
                    {shortLoc(c.startName)} <span style={{ color: 'var(--blue)' }}>→</span> {shortLoc(c.endName)}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>{Math.round(c.volume ?? 0).toLocaleString('nl')} m³</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>
                    {c.charName}{c.contract_id < 0 && <span style={{ marginLeft: '0.3rem', fontSize: '0.55rem', fontWeight: 800, color: 'var(--gold)', border: '1px solid var(--gold)', borderRadius: 2, padding: '0 0.25rem' }}>DEMO</span>}
                  </td>
                  <td style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--green)', padding: '0.35rem 0.875rem', textAlign: 'right', whiteSpace: 'nowrap' }}>+{fmtISK(c.reward)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  )
}
