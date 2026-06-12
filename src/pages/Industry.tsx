import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getIndustryJobs, getStructureName, getTypesMeta, resolveNames, type IndustryJob } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import Location from '../components/Location'
import { usePageLoading } from '../hooks/usePageLoading'

const META_BADGE: Record<number, { label: string; color: string }> = {
  2:  { label: 'T2',      color: '#00b4d8' },
  3:  { label: 'Story',   color: '#a78bfa' },
  4:  { label: 'Faction', color: '#f0c040' },
  5:  { label: 'Officer', color: '#f97316' },
  6:  { label: 'DS',      color: '#e05555' },
  14: { label: 'T3',      color: '#3ecf6e' },
  15: { label: 'T3D',     color: '#3ecf6e' },
}

function MetaBadge({ metaId }: { metaId?: number }) {
  if (!metaId || !META_BADGE[metaId]) return null
  const { label, color } = META_BADGE[metaId]
  return (
    <span style={{
      display: 'inline-block', padding: '0.05rem 0.28rem',
      borderRadius: 2, fontSize: '0.54rem', fontWeight: 800, lineHeight: 1.5,
      background: `${color}22`, border: `1px solid ${color}55`, color,
      letterSpacing: '0.03em', flexShrink: 0,
    }}>
      {label}
    </span>
  )
}

const ACTIVITY: Record<number, { label: string; color: string }> = {
  1: { label: 'Fabricage',    color: '#00b4d8' },
  3: { label: 'TE Research',  color: '#f0c040' },
  4: { label: 'ME Research',  color: '#f0c040' },
  5: { label: 'Kopiëren',     color: '#a78bfa' },
  8: { label: 'Uitvinding',   color: '#f97316' },
  9: { label: 'Reacties',     color: '#3ecf6e' },
}

interface ResolvedJob {
  jobId: number
  blueprintName: string
  productName: string
  productTypeId: number
  blueprintTypeId: number
  activity: { label: string; color: string }
  runs: number
  status: IndustryJob['status']
  startDate: Date
  endDate: Date
  location: string
  locationId: number
  cost: number
}

function timeRemaining(end: Date): string {
  const diff = end.getTime() - Date.now()
  if (diff <= 0) return 'Klaar'
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (d > 0) return `${d}d ${h}u`
  if (h > 0) return `${h}u ${m}m`
  return `${m}m`
}

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${v.toFixed(0)}`
}

function ProgressBar({ start, end, status }: { start: Date; end: Date; status: string }) {
  const total = end.getTime() - start.getTime()
  const elapsed = Date.now() - start.getTime()
  const pct = status === 'ready' ? 100 : Math.min(100, Math.max(0, (elapsed / total) * 100))
  const color = status === 'ready' ? '#3ecf6e' : status === 'paused' ? '#f0c040' : '#00b4d8'
  return (
    <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', minWidth: 80 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 1s linear' }} />
    </div>
  )
}

function GanttTimeline({ jobs }: { jobs: ResolvedJob[] }) {
  const now = Date.now()
  const minStart = Math.min(...jobs.map(j => j.startDate.getTime()))
  const maxEnd   = Math.max(...jobs.map(j => j.endDate.getTime()))
  const range    = maxEnd - minStart || 1
  const nowPct   = Math.min(100, Math.max(0, (now - minStart) / range * 100))
  const multiDay = range > 24 * 3600 * 1000

  function fmtAxis(t: number) {
    const d = new Date(t)
    return multiDay
      ? d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div style={{ padding: '0.875rem 1rem 0.6rem', borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.12)' }}>
      <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.15em', marginBottom: '0.6rem' }}>TIJDLIJN</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {jobs.map(j => {
          const left    = (j.startDate.getTime() - minStart) / range * 100
          const width   = Math.max(0.5, (j.endDate.getTime() - j.startDate.getTime()) / range * 100)
          const elapsed = j.status === 'paused' ? 0
            : Math.min(100, Math.max(0, (now - j.startDate.getTime()) / (j.endDate.getTime() - j.startDate.getTime()) * 100))
          return (
            <div key={j.jobId} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 140, flexShrink: 0, fontSize: '0.62rem', color: 'var(--text-dim)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {j.productName}
              </div>
              <div style={{ flex: 1, position: 'relative', height: 16, background: 'rgba(255,255,255,0.03)', borderRadius: 2 }}>
                <div title={`${j.productName} ×${j.runs} · ${j.activity.label} · ${timeRemaining(j.endDate)}`} style={{
                  position: 'absolute', top: 0, height: '100%',
                  left: `${left}%`, width: `${width}%`,
                  background: `${j.activity.color}18`,
                  border: `1px solid ${j.activity.color}55`,
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <div style={{ height: '100%', width: `${elapsed}%`, background: `${j.activity.color}45`, borderRadius: 1, transition: 'width 1s linear' }} />
                </div>
                {nowPct > 0 && nowPct < 100 && (
                  <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${nowPct}%`, width: 1, background: 'rgba(255,255,255,0.2)', pointerEvents: 'none' }} />
                )}
              </div>
              <div style={{ width: 52, flexShrink: 0, fontSize: '0.6rem', color: j.activity.color, fontWeight: 700, textAlign: 'right' }}>
                {timeRemaining(j.endDate)}
              </div>
            </div>
          )
        })}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.1rem' }}>
          <div style={{ width: 140, flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', fontSize: '0.54rem', color: 'var(--border)' }}>
            <span>{fmtAxis(minStart)}</span>
            <span>{fmtAxis(maxEnd)}</span>
          </div>
          <div style={{ width: 52, flexShrink: 0 }} />
        </div>
      </div>
    </div>
  )
}

export default function Industry() {
  const { activeTokens: tokens, tokens: allTokens } = useAuth()
  const [jobs, setJobs]       = useState<ResolvedJob[]>([])
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [tab, setTab]         = useState<'active' | 'ready'>('active')
  const [metaMap, setMetaMap] = useState(new Map<number, number>())
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setJobs([])

    async function load() {
      const allJobs: IndustryJob[] = []
      await Promise.all(tokens.map(async t => {
        const j = await getIndustryJobs(t.characterId, t.accessToken).catch(() => [] as IndustryJob[])
        allJobs.push(...j)
      }))

      if (myId !== fetchId.current) return

      // Collect IDs to resolve
      const typeIds = [...new Set([
        ...allJobs.map(j => j.blueprint_type_id),
        ...allJobs.map(j => j.product_type_id).filter(Boolean) as number[],
      ])]
      const locationIds = [...new Set(allJobs.map(j => j.output_location_id))]
      const stationIds   = locationIds.filter(id => id < 1_000_000_000)
      const structureIds = locationIds.filter(id => id >= 1_000_000_000)

      const [nameMap, structureNames] = await Promise.all([
        resolveNames([...typeIds, ...stationIds]),
        Promise.all(structureIds.map(async id => {
          const name = await getStructureName(id, allTokens)
          return [id, name ?? `#${id}`] as [number, string]
        })),
      ])

      if (myId !== fetchId.current) return

      const locationNames = new Map<number, string>([
        ...stationIds.map(id => [id, nameMap.get(id) ?? `Station ${id}`] as [number, string]),
        ...structureNames,
      ])

      const resolved: ResolvedJob[] = allJobs.map(j => ({
        jobId:          j.job_id,
        blueprintName:  nameMap.get(j.blueprint_type_id) ?? `Blueprint ${j.blueprint_type_id}`,
        productName:    j.product_type_id ? (nameMap.get(j.product_type_id) ?? `Type ${j.product_type_id}`) : (nameMap.get(j.blueprint_type_id) ?? '—'),
        productTypeId:  j.product_type_id ?? j.blueprint_type_id,
        blueprintTypeId: j.blueprint_type_id,
        activity:       ACTIVITY[j.activity_id] ?? { label: `Activity ${j.activity_id}`, color: 'var(--text-dim)' },
        runs:           j.runs,
        status:         j.status,
        startDate:      new Date(j.start_date),
        endDate:        new Date(j.end_date),
        location:       locationNames.get(j.output_location_id) ?? '—',
        locationId:     j.output_location_id,
        cost:           j.cost,
      })).sort((a, b) => a.endDate.getTime() - b.endDate.getTime())

      setJobs(resolved)
      setLoading(false)

      const productIds = [...new Set(resolved.map(j => j.productTypeId))]
      const meta = await getTypesMeta(productIds)
      if (myId !== fetchId.current) return
      setMetaMap(meta)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const active = jobs.filter(j => j.status === 'active' || j.status === 'paused')
  const ready  = jobs.filter(j => j.status === 'ready')
  const shown  = tab === 'active' ? active : ready

  const btnStyle = (on: boolean) => ({
    padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
    background: on ? 'rgba(0,180,216,0.15)' : 'transparent',
    border: `1px solid ${on ? 'var(--blue)' : 'var(--border)'}`,
    color: on ? 'var(--blue)' : 'var(--text-dim)',
  } as const)

  return (
    <Layout header={
      <PageHeader
        title="Industry"
        sub={loading ? 'Laden...' : `${active.length} actief · ${ready.length} klaar`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button onClick={() => setTab('active')} style={btnStyle(tab === 'active')}>Actief ({active.length})</button>
            <button onClick={() => setTab('ready')}  style={btnStyle(tab === 'ready')}>Klaar ({ready.length})</button>
          </div>
        }
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Industry jobs laden...
        </div>
      )}

      {!loading && shown.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Geen {tab === 'active' ? 'actieve' : 'klare'} jobs
        </div>
      )}

      {!loading && active.length > 0 && tab === 'active' && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden', marginBottom: '0.75rem' }}>
          <GanttTimeline jobs={active} />
        </div>
      )}

      {!loading && shown.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                {['Item', 'Activiteit', 'Runs', 'Voortgang', 'Tijd', 'Kosten', 'Locatie'].map(h => (
                  <th key={h} style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', padding: '0.5rem 0.85rem', textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((j, i) => (
                <tr key={j.jobId} style={{ borderTop: '1px solid rgba(28,28,53,0.5)', background: i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent' }}>
                  <td style={{ padding: '0.6rem 0.85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <img
                        src={`https://images.evetech.net/types/${j.productTypeId}/icon?size=32`}
                        alt=""
                        style={{ width: 36, height: 36, borderRadius: 3, background: '#0b0b1a', flexShrink: 0 }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{j.productName}</span>
                        <MetaBadge metaId={metaMap.get(j.productTypeId)} />
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '0.6rem 0.85rem' }}>
                    <span style={{ fontSize: '0.68rem', fontWeight: 700, color: j.activity.color, letterSpacing: '0.04em' }}>
                      {j.activity.label}
                    </span>
                  </td>
                  <td style={{ padding: '0.6rem 0.85rem', fontSize: '0.78rem', fontWeight: 600 }}>
                    {j.runs.toLocaleString()}
                  </td>
                  <td style={{ padding: '0.6rem 0.85rem', minWidth: 120 }}>
                    <ProgressBar start={j.startDate} end={j.endDate} status={j.status} />
                  </td>
                  <td style={{ padding: '0.6rem 0.85rem', fontSize: '0.72rem', whiteSpace: 'nowrap', color: j.status === 'ready' ? 'var(--green)' : j.status === 'paused' ? 'var(--gold)' : 'var(--text)' }}>
                    {j.status === 'ready' ? 'Klaar' : j.status === 'paused' ? 'Gepauzeerd' : timeRemaining(j.endDate)}
                  </td>
                  <td style={{ padding: '0.6rem 0.85rem', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                    {fmtISK(j.cost)} ISK
                  </td>
                  <td style={{ padding: '0.6rem 0.85rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Location locationId={j.locationId} name={j.location} fontSize="0.68rem" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  )
}

