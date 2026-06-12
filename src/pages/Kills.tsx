import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getKillmailDetail, resolveNames } from '../api/esi'
import { getKills, getLosses } from '../api/zkillboard'
import Layout, { PageHeader } from '../components/Layout'
import KillsTable, { type KillEntry } from '../components/KillsTable'
import { usePageLoading } from '../hooks/usePageLoading'

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`
  return `${(v / 1e3).toFixed(0)}K`
}

interface RawEntry {
  killmail_id: number
  killmail_hash: string
  isk: number
  type: 'kill' | 'loss'
  solo: boolean
}

async function fetchAndResolve(rawEntries: RawEntry[]): Promise<KillEntry[]> {
  const details = await Promise.all(
    rawEntries.map(async k => ({ ...k, km: await getKillmailDetail(k.killmail_id, k.killmail_hash) }))
  )

  const finalBlowers = details.map(d => d.km?.attackers.find(a => a.final_blow))
  const shipIds     = [...new Set(details.map(d => d.km?.victim.ship_type_id).filter(Boolean) as number[])]
  const systemIds   = [...new Set(details.map(d => d.km?.solar_system_id).filter(Boolean) as number[])]
  const charIds     = [...new Set([
    ...details.map(d => d.km?.victim.character_id),
    ...finalBlowers.map(a => a?.character_id),
  ].filter(Boolean) as number[])]
  const corpIds     = [...new Set([
    ...details.map(d => d.km?.victim.corporation_id),
    ...finalBlowers.map(a => a?.corporation_id),
  ].filter(Boolean) as number[])]
  const allianceIds = [...new Set([
    ...details.map(d => d.km?.victim.alliance_id),
    ...finalBlowers.map(a => a?.alliance_id),
  ].filter(Boolean) as number[])]

  const nameMap = await resolveNames([...shipIds, ...systemIds, ...charIds, ...corpIds, ...allianceIds])

  return details.map((d, i) => {
    const fb = finalBlowers[i]
    return {
      id:                    d.killmail_id,
      ship:                  nameMap.get(d.km?.victim.ship_type_id ?? 0) ?? 'Unknown',
      shipTypeId:            d.km?.victim.ship_type_id ?? 0,
      victimCharId:          d.km?.victim.character_id,
      victimCharName:        d.km?.victim.character_id ? nameMap.get(d.km.victim.character_id) : undefined,
      victimCorpId:          d.km?.victim.corporation_id,
      victimCorpName:        d.km?.victim.corporation_id ? nameMap.get(d.km.victim.corporation_id) : undefined,
      victimAllianceId:      d.km?.victim.alliance_id,
      victimAllianceName:    d.km?.victim.alliance_id ? nameMap.get(d.km.victim.alliance_id) : undefined,
      finalBlowCharId:       fb?.character_id,
      finalBlowCharName:     fb?.character_id ? nameMap.get(fb.character_id) : undefined,
      finalBlowCorpId:       fb?.corporation_id,
      finalBlowCorpName:     fb?.corporation_id ? nameMap.get(fb.corporation_id) : undefined,
      finalBlowAllianceId:   fb?.alliance_id,
      finalBlowAllianceName: fb?.alliance_id ? nameMap.get(fb.alliance_id) : undefined,
      type:                  d.type,
      solo:                  d.solo,
      isk:                   d.isk,
      system:                nameMap.get(d.km?.solar_system_id ?? 0) ?? '—',
      systemId:              d.km?.solar_system_id,
      time:                  d.km ? new Date(d.km.killmail_time) : null,
    }
  })
}

export default function Kills() {
  const { activeTokens: tokens } = useAuth()
  const [entries, setEntries]     = useState<KillEntry[]>([])
  const [loading, setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage]           = useState(1)
  const [hasMore, setHasMore]     = useState(true)
  usePageLoading(loading)
  const [filter, setFilter]       = useState<'all' | 'kill' | 'loss' | 'solo'>('all')
  const [refreshKey, setRefreshKey] = useState(0)
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true)
    setEntries([])
    setPage(1)
    setHasMore(true)

    async function load() {
      const results = await Promise.all(tokens.map(async t => {
        const [zkKills, zkLosses] = await Promise.allSettled([
          getKills(t.characterId, 1), getLosses(t.characterId, 1),
        ])
        return { zkKills, zkLosses }
      }))

      if (myId !== fetchId.current) return

      let anyFull = false
      const raw: RawEntry[] = []
      for (const { zkKills, zkLosses } of results) {
        if (zkKills.status === 'fulfilled') {
          if (zkKills.value.length >= 200) anyFull = true
          zkKills.value.forEach(k => raw.push({ killmail_id: k.killmail_id, killmail_hash: k.zkb.hash, isk: k.zkb.totalValue, type: 'kill', solo: k.zkb.solo }))
        }
        if (zkLosses.status === 'fulfilled') {
          if (zkLosses.value.length >= 200) anyFull = true
          zkLosses.value.forEach(k => raw.push({ killmail_id: k.killmail_id, killmail_hash: k.zkb.hash, isk: k.zkb.totalValue, type: 'loss', solo: k.zkb.solo }))
        }
      }

      const seen = new Set<number>()
      const deduped = raw
        .sort((a, b) => b.killmail_id - a.killmail_id)
        .filter(k => { if (seen.has(k.killmail_id)) return false; seen.add(k.killmail_id); return true })

      setHasMore(anyFull)

      const resolved = await fetchAndResolve(deduped)
      if (myId !== fetchId.current) return

      setEntries(resolved.sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0)))
      setLoading(false)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(','), refreshKey])

  useEffect(() => {
    const id = setInterval(() => setRefreshKey(k => k + 1), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  async function loadMore() {
    if (loadingMore || tokens.length === 0) return
    const nextPage = page + 1
    setLoadingMore(true)

    const results = await Promise.all(tokens.map(async t => {
      const [zkKills, zkLosses] = await Promise.allSettled([
        getKills(t.characterId, nextPage), getLosses(t.characterId, nextPage),
      ])
      return { zkKills, zkLosses }
    }))

    let anyFull = false
    const existingIds = new Set(entries.map(e => e.id))
    const raw: RawEntry[] = []
    for (const { zkKills, zkLosses } of results) {
      if (zkKills.status === 'fulfilled') {
        if (zkKills.value.length >= 200) anyFull = true
        zkKills.value.forEach(k => raw.push({ killmail_id: k.killmail_id, killmail_hash: k.zkb.hash, isk: k.zkb.totalValue, type: 'kill', solo: k.zkb.solo }))
      }
      if (zkLosses.status === 'fulfilled') {
        if (zkLosses.value.length >= 200) anyFull = true
        zkLosses.value.forEach(k => raw.push({ killmail_id: k.killmail_id, killmail_hash: k.zkb.hash, isk: k.zkb.totalValue, type: 'loss', solo: k.zkb.solo }))
      }
    }

    const seen = new Set<number>()
    const deduped = raw
      .sort((a, b) => b.killmail_id - a.killmail_id)
      .filter(k => {
        if (seen.has(k.killmail_id) || existingIds.has(k.killmail_id)) return false
        seen.add(k.killmail_id)
        return true
      })

    setHasMore(anyFull)

    if (deduped.length > 0) {
      const resolved = await fetchAndResolve(deduped)
      setEntries(prev =>
        [...prev, ...resolved].sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0))
      )
    }

    setPage(nextPage)
    setLoadingMore(false)
  }

  const kills   = entries.filter(e => e.type === 'kill')
  const losses  = entries.filter(e => e.type === 'loss')
  const killISK = kills.reduce((s, e) => s + e.isk, 0)
  const lossISK = losses.reduce((s, e) => s + e.isk, 0)
  const total   = kills.length + losses.length
  const eff     = total > 0 ? Math.round(killISK / (killISK + lossISK) * 100) : 0
  const filtered = filter === 'solo' ? entries.filter(e => e.solo)
                 : filter === 'all'  ? entries
                 : entries.filter(e => e.type === filter)

  const btnStyle = (active: boolean, color = 'var(--blue)') => ({
    padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
    background: active ? `rgba(0,180,216,0.15)` : 'transparent',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    color: active ? color : 'var(--text-dim)',
  } as const)

  return (
    <Layout header={
      <PageHeader
        title="Kills & Losses"
        sub={loading ? 'Laden...' : `${kills.length}K · ${losses.length}L · ${eff}% ISK efficiëntie`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <button onClick={() => setFilter('all')}  style={btnStyle(filter === 'all')}>Alles</button>
            <button onClick={() => setFilter('kill')} style={btnStyle(filter === 'kill', 'var(--green)')}>Kills</button>
            <button onClick={() => setFilter('loss')} style={btnStyle(filter === 'loss', 'var(--red)')}>Losses</button>
            <button onClick={() => setFilter('solo')} style={btnStyle(filter === 'solo', 'var(--gold)')}>Solo</button>
            <button onClick={() => setRefreshKey(k => k + 1)} disabled={loading} title="Vernieuwen" style={{
              padding: '0.3rem 0.55rem', borderRadius: 2, fontSize: '0.75rem', cursor: loading ? 'default' : 'pointer',
              background: 'transparent', border: '1px solid var(--border)',
              color: loading ? 'var(--text-dim)' : 'var(--text)',
            }}>↻</button>
          </div>
        }
      />
    }>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { label: 'KILLS',         value: String(kills.length),        color: 'var(--green)' },
          { label: 'LOSSES',        value: String(losses.length),       color: 'var(--red)'   },
          { label: 'ISK DESTROYED', value: `${fmtISK(killISK)} ISK`,   color: 'var(--green)' },
          { label: 'ISK VERLOREN',  value: `${fmtISK(lossISK)} ISK`,   color: 'var(--red)'   },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem' }}>
            <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.4rem' }}>{label}</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color }}>{loading ? '...' : value}</div>
          </div>
        ))}
      </div>

      <KillsTable
        entries={filtered}
        characterId={tokens[0]?.characterId}
        loading={loading && entries.length === 0}
      />

      {/* Meer laden */}
      {!loading && hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem 0 0.5rem' }}>
          <button
            onClick={loadMore}
            disabled={loadingMore}
            style={{
              padding: '0.5rem 1.5rem',
              borderRadius: 3,
              fontSize: '0.72rem',
              fontWeight: 600,
              cursor: loadingMore ? 'default' : 'pointer',
              background: 'rgba(0,180,216,0.08)',
              border: '1px solid rgba(0,180,216,0.35)',
              color: loadingMore ? 'var(--text-dim)' : 'var(--blue)',
            }}
          >
            {loadingMore ? `Laden... (pagina ${page + 1})` : `Meer laden (pagina ${page + 1})`}
          </button>
        </div>
      )}
    </Layout>
  )
}
