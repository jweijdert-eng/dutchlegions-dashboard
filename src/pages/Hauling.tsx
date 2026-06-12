import { useEffect, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
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

  const completed  = hauls.filter(c => FINISHED.includes(c.status) && c.date_completed)
  const inProgress = hauls.filter(c => c.status === 'in_progress')
  const failed     = hauls.filter(c => c.status === 'failed')

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
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', whiteSpace: 'nowrap' }}>{c.charName}</td>
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
                {['Opgeleverd', 'Route', 'Volume', 'Character', 'Beloning'].map((h, i) => (
                  <th key={h} style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', padding: '0.35rem 0.875rem', textAlign: i === 4 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Laden...</td></tr>}
              {!loading && completed.length === 0 && <tr><td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen voltooide courier-contracten gevonden (ESI toont ~30 dagen terug).</td></tr>}
              {completed.map((c, i) => (
                <tr key={c.contract_id} style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent' }}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>
                    {new Date(c.date_completed!).toLocaleString('nl-NL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td style={{ fontSize: '0.7rem', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }} title={`${c.startName} → ${c.endName}`}>
                    {shortLoc(c.startName)} <span style={{ color: 'var(--blue)' }}>→</span> {shortLoc(c.endName)}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>{Math.round(c.volume ?? 0).toLocaleString('nl')} m³</td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--text-dim)', padding: '0.35rem 0.875rem', whiteSpace: 'nowrap' }}>{c.charName}</td>
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
