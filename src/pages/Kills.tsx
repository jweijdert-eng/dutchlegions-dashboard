import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { getKillmailDetail, resolveNames, getCharacterInfo, getCorporation } from '../api/esi'
import { getKills, getLosses, getCorpKills, getCorpLosses } from '../api/zkillboard'
import Layout, { PageHeader } from '../components/Layout'
import KillsTable, { type KillEntry } from '../components/KillsTable'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
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

function toRaw(list: { killmail_id: number; zkb: { hash: string; totalValue: number; solo: boolean } }[], type: 'kill' | 'loss'): RawEntry[] {
  return list.map(k => ({ killmail_id: k.killmail_id, killmail_hash: k.zkb.hash, isk: k.zkb.totalValue, type, solo: k.zkb.solo }))
}

// ── Klein component voor een gerangschikte balk-rij (schepen/piloten/systemen) ──
function RankRow({ rank, typeId, name, count, isk, max, color, nameNode }: {
  rank: number; typeId?: number; name: string; count: number; isk: number; max: number; color: string; nameNode?: React.ReactNode
}) {
  const pct = max > 0 ? (count / max) * 100 : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ width: 16, fontSize: '0.62rem', color: rank < 3 ? 'var(--gold)' : 'var(--text-dim)', fontWeight: 700, textAlign: 'right', flexShrink: 0 }}>{rank + 1}</span>
      {typeId != null && <EveImage category="types" id={typeId} variation="icon" size={32} px={22} style={{ flexShrink: 0, borderRadius: 2 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameNode ?? name}</span>
          <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)', flexShrink: 0 }}>{count}× · {fmtISK(isk)}</span>
        </div>
        <div style={{ height: 3, background: 'rgba(255,255,255,0.05)', borderRadius: 2, marginTop: '0.2rem' }}>
          <div style={{ height: '100%', width: `${Math.max(3, pct)}%`, background: color, borderRadius: 2 }} />
        </div>
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.85rem 1rem' }}>
      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.15em', marginBottom: '0.6rem' }}>{title}</div>
      {children}
    </div>
  )
}

export default function Kills() {
  const { activeTokens: tokens, mainCharId } = useAuth()
  const [searchParams] = useSearchParams()
  const scope: 'me' | 'corp' = searchParams.get('board') === 'corp' ? 'corp' : 'me'
  const [view, setView]     = useState<'list' | 'analyse'>('list')   // beide killboards standaard als lijst
  const [corp, setCorp]     = useState<{ id: number; name: string } | null>(null)
  const [entries, setEntries]     = useState<KillEntry[]>([])
  const [loading, setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage]           = useState(1)
  const [hasMore, setHasMore]     = useState(true)
  usePageLoading(loading)
  const [filter, setFilter]       = useState<'all' | 'kill' | 'loss' | 'solo'>('all')
  const [refreshKey, setRefreshKey] = useState(0)
  const fetchId = useRef(0)

  // Corp van het hoofdkarakter bepalen (voor de corp-killboard).
  useEffect(() => {
    const t = tokens.find(x => x.characterId === mainCharId) ?? tokens[0]
    if (!t) return
    getCharacterInfo(t.characterId).then(async info => {
      const c = await getCorporation(info.corporation_id).catch(() => null)
      setCorp({ id: info.corporation_id, name: c?.name ?? `Corp ${info.corporation_id}` })
    }).catch(() => {})
  }, [tokens.map(t => t.characterId).join(','), mainCharId])

  // Eén pagina ruwe killmails ophalen volgens de gekozen scope.
  async function fetchRawPage(pageNum: number): Promise<{ raw: RawEntry[]; anyFull: boolean }> {
    let anyFull = false
    const raw: RawEntry[] = []
    if (scope === 'corp') {
      if (!corp) return { raw, anyFull }
      const [k, l] = await Promise.allSettled([getCorpKills(corp.id, pageNum), getCorpLosses(corp.id, pageNum)])
      if (k.status === 'fulfilled') { if (k.value.length >= 200) anyFull = true; raw.push(...toRaw(k.value, 'kill')) }
      if (l.status === 'fulfilled') { if (l.value.length >= 200) anyFull = true; raw.push(...toRaw(l.value, 'loss')) }
    } else {
      const results = await Promise.all(tokens.map(async t => {
        const [k, l] = await Promise.allSettled([getKills(t.characterId, pageNum), getLosses(t.characterId, pageNum)])
        return { k, l }
      }))
      for (const { k, l } of results) {
        if (k.status === 'fulfilled') { if (k.value.length >= 200) anyFull = true; raw.push(...toRaw(k.value, 'kill')) }
        if (l.status === 'fulfilled') { if (l.value.length >= 200) anyFull = true; raw.push(...toRaw(l.value, 'loss')) }
      }
    }
    return { raw, anyFull }
  }

  useEffect(() => {
    if (tokens.length === 0) return
    if (scope === 'corp' && !corp) return   // wacht tot de corp bekend is
    const myId = ++fetchId.current
    setLoading(true); setEntries([]); setPage(1); setHasMore(true)

    async function load() {
      const { raw, anyFull } = await fetchRawPage(1)
      if (myId !== fetchId.current) return
      const seen = new Set<number>()
      const deduped = raw.sort((a, b) => b.killmail_id - a.killmail_id)
        .filter(k => { if (seen.has(k.killmail_id)) return false; seen.add(k.killmail_id); return true })
      setHasMore(anyFull)
      const resolved = await fetchAndResolve(deduped)
      if (myId !== fetchId.current) return
      setEntries(resolved.sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0)))
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(','), refreshKey, scope, corp?.id])

  useEffect(() => {
    const id = setInterval(() => setRefreshKey(k => k + 1), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  async function loadMore() {
    if (loadingMore || tokens.length === 0) return
    const nextPage = page + 1
    setLoadingMore(true)
    const { raw, anyFull } = await fetchRawPage(nextPage)
    const existingIds = new Set(entries.map(e => e.id))
    const seen = new Set<number>()
    const deduped = raw.sort((a, b) => b.killmail_id - a.killmail_id)
      .filter(k => { if (seen.has(k.killmail_id) || existingIds.has(k.killmail_id)) return false; seen.add(k.killmail_id); return true })
    setHasMore(anyFull)
    if (deduped.length > 0) {
      const resolved = await fetchAndResolve(deduped)
      setEntries(prev => [...prev, ...resolved].sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0)))
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

  // ── Analyse afgeleid van de geladen killmails ──
  const analysis = useMemo(() => {
    const k = entries.filter(e => e.type === 'kill')
    const l = entries.filter(e => e.type === 'loss')

    const pilotMap = new Map<number, { name: string; count: number; isk: number }>()
    for (const e of k) {
      if (!e.finalBlowCharId) continue
      const cur = pilotMap.get(e.finalBlowCharId) ?? { name: e.finalBlowCharName ?? `#${e.finalBlowCharId}`, count: 0, isk: 0 }
      cur.count++; cur.isk += e.isk; pilotMap.set(e.finalBlowCharId, cur)
    }
    const pilots = [...pilotMap.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count).slice(0, 8)

    const shipAgg = (list: KillEntry[]) => {
      const m = new Map<number, { name: string; count: number; isk: number }>()
      for (const e of list) { const cur = m.get(e.shipTypeId) ?? { name: e.ship, count: 0, isk: 0 }; cur.count++; cur.isk += e.isk; m.set(e.shipTypeId, cur) }
      return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.count - a.count).slice(0, 8)
    }
    const destroyed = shipAgg(k)
    const lost = shipAgg(l)

    const sysMap = new Map<string, { count: number; id?: number }>()
    for (const e of entries) { const cur = sysMap.get(e.system) ?? { count: 0, id: e.systemId }; cur.count++; sysMap.set(e.system, cur) }
    const systems = [...sysMap.entries()].filter(([n]) => n !== '—').map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count).slice(0, 8)

    const today = new Date()
    const daily = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - (13 - i))
      return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('nl', { day: 'numeric', month: 'short' }), kills: 0, losses: 0 }
    })
    const dmap = new Map(daily.map(d => [d.key, d]))
    for (const e of entries) {
      if (!e.time) continue
      const d = dmap.get(e.time.toISOString().slice(0, 10))
      if (d) { if (e.type === 'kill') d.kills++; else d.losses++ }
    }
    const week = Date.now() - 7 * 86400000
    const weekKills = k.filter(e => e.time && e.time.getTime() > week).length
    const weekLosses = l.filter(e => e.time && e.time.getTime() > week).length
    return { pilots, destroyed, lost, systems, daily, weekKills, weekLosses, solo: k.filter(e => e.solo).length }
  }, [entries])

  const btnStyle = (active: boolean, color = 'var(--blue)') => ({
    padding: '0.3rem 0.75rem', borderRadius: 2, fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
    background: active ? `rgba(0,180,216,0.15)` : 'transparent',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    color: active ? color : 'var(--text-dim)',
  } as const)

  const maxPilot = analysis.pilots[0]?.count ?? 1
  const maxDestroyed = analysis.destroyed[0]?.count ?? 1
  const maxLost = analysis.lost[0]?.count ?? 1
  const maxSys = analysis.systems[0]?.count ?? 1

  return (
    <Layout header={
      <PageHeader
        title={scope === 'corp' ? `Killboard — ${corp?.name ?? 'Corp'}` : 'Kills & Losses'}
        sub={loading ? 'Laden...' : `${kills.length}K · ${losses.length}L · ${eff}% ISK efficiëntie`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 2, overflow: 'hidden', marginRight: '0.2rem' }}>
              <button onClick={() => setView('analyse')} style={{ ...btnStyle(view === 'analyse', 'var(--gold)'), border: 'none', borderRadius: 0 }}>Analyse</button>
              <button onClick={() => setView('list')}    style={{ ...btnStyle(view === 'list'),    border: 'none', borderRadius: 0 }}>Lijst</button>
            </div>
            {view === 'list' && <>
              <button onClick={() => setFilter('all')}  style={btnStyle(filter === 'all')}>Alles</button>
              <button onClick={() => setFilter('kill')} style={btnStyle(filter === 'kill', 'var(--green)')}>Kills</button>
              <button onClick={() => setFilter('loss')} style={btnStyle(filter === 'loss', 'var(--red)')}>Losses</button>
              <button onClick={() => setFilter('solo')} style={btnStyle(filter === 'solo', 'var(--gold)')}>Solo</button>
            </>}
            <button onClick={() => setRefreshKey(k => k + 1)} disabled={loading} title="Vernieuwen" style={{
              padding: '0.3rem 0.55rem', borderRadius: 2, fontSize: '0.75rem', cursor: loading ? 'default' : 'pointer',
              background: 'transparent', border: '1px solid var(--border)', color: loading ? 'var(--text-dim)' : 'var(--text)',
            }}>↻</button>
          </div>
        }
      />
    }>
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
        {[
          { label: 'KILLS',         value: String(kills.length),     color: 'var(--green)', sub: `${analysis.weekKills} deze week` },
          { label: 'LOSSES',        value: String(losses.length),    color: 'var(--red)',   sub: `${analysis.weekLosses} deze week` },
          { label: 'ISK DESTROYED', value: `${fmtISK(killISK)} ISK`, color: 'var(--green)', sub: `${analysis.solo} solo kills` },
          { label: 'ISK VERLOREN',  value: `${fmtISK(lossISK)} ISK`, color: 'var(--red)',   sub: `${eff}% efficiëntie` },
        ].map(({ label, value, color, sub }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.875rem 1rem' }}>
            <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '0.4rem' }}>{label}</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color }}>{loading ? '...' : value}</div>
            {!loading && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{sub}</div>}
          </div>
        ))}
      </div>

      {view === 'analyse' ? (
        loading ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Killboard laden...</div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen killmails gevonden</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Activiteit + top piloten */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
              <Panel title="ACTIVITEIT (14 DAGEN)">
                <div style={{ height: 150 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.daily} barGap={1} barSize={9}>
                      <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} axisLine={false} tickLine={false} interval={1} />
                      <YAxis hide />
                      <Tooltip contentStyle={{ background: '#0b0b1a', border: '1px solid #1c1c35', borderRadius: 3, fontSize: 11 }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Bar dataKey="kills" name="Kills" radius={[2, 2, 0, 0]}>{analysis.daily.map((_, i) => <Cell key={i} fill="#3ecf6e" />)}</Bar>
                      <Bar dataKey="losses" name="Losses" radius={[2, 2, 0, 0]}>{analysis.daily.map((_, i) => <Cell key={i} fill="#e05555" />)}</Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title={scope === 'corp' ? 'TOP PILOTEN (FINAL BLOW)' : 'TOP PILOTEN'}>
                {analysis.pilots.length === 0 ? <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Geen data</div> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    {analysis.pilots.map((p, i) => (
                      <RankRow key={p.id} rank={i} name={p.name} count={p.count} isk={p.isk} max={maxPilot} color="var(--gold)"
                        nameNode={<span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <EveImage category="characters" id={p.id} variation="portrait" size={32} px={18} round style={{ flexShrink: 0 }} />{p.name}
                        </span>} />
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* Vernietigd / verloren schepen */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <Panel title="MEEST VERNIETIGD (VIJAND)">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  {analysis.destroyed.map((s, i) => (
                    <RankRow key={s.id} rank={i} typeId={s.id} name={s.name} count={s.count} isk={s.isk} max={maxDestroyed} color="var(--green)" />
                  ))}
                </div>
              </Panel>
              <Panel title="MEEST VERLOREN (WIJ)">
                {analysis.lost.length === 0 ? <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Geen verliezen 🎉</div> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    {analysis.lost.map((s, i) => (
                      <RankRow key={s.id} rank={i} typeId={s.id} name={s.name} count={s.count} isk={s.isk} max={maxLost} color="var(--red)" />
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* Hotspots */}
            <Panel title="HOTSPOTS (SYSTEMEN)">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.45rem 1.5rem' }}>
                {analysis.systems.map((s, i) => (
                  <RankRow key={s.name} rank={i} name={s.name} count={s.count} isk={0} max={maxSys} color="var(--blue)"
                    nameNode={s.id ? <SolarSystem name={s.name} systemId={s.id} fontSize="0.72rem" /> : s.name} />
                ))}
              </div>
            </Panel>
          </div>
        )
      ) : (
        <KillsTable entries={filtered} characterId={tokens[0]?.characterId} loading={loading && entries.length === 0} />
      )}

      {/* Meer laden */}
      {!loading && hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem 0 0.5rem' }}>
          <button onClick={loadMore} disabled={loadingMore} style={{
            padding: '0.5rem 1.5rem', borderRadius: 3, fontSize: '0.72rem', fontWeight: 600,
            cursor: loadingMore ? 'default' : 'pointer', background: 'rgba(0,180,216,0.08)',
            border: '1px solid rgba(0,180,216,0.35)', color: loadingMore ? 'var(--text-dim)' : 'var(--blue)',
          }}>
            {loadingMore ? `Laden... (pagina ${page + 1})` : `Meer laden (pagina ${page + 1})`}
          </button>
        </div>
      )}
    </Layout>
  )
}
