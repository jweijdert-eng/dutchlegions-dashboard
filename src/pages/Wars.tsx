import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { useAuth } from '../auth/AuthContext'
import { usePageLoading } from '../hooks/usePageLoading'
import { getWarIds, getWar, getWarKillmails, getKillmailDetail, getCharacterInfo, resolveNames, type War, type WarParty, type WarAlly, type Killmail } from '../api/esi'

const PAGE = 60

function fmtDate(s?: string) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' })
}
function fmtISK(v: number) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + ' mrd'
  if (v >= 1e6) return (v / 1e6).toFixed(0) + ' mln'
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'k'
  return Math.round(v).toString()
}
const partyId = (p: WarParty | WarAlly) => p.alliance_id ?? p.corporation_id ?? 0
const partyCat = (p: WarParty | WarAlly): 'alliances' | 'corporations' => p.alliance_id ? 'alliances' : 'corporations'

type WarState = 'upcoming' | 'active' | 'finished'
function warState(w: War): WarState {
  if (w.finished && new Date(w.finished) <= new Date()) return 'finished'
  if (!w.started || new Date(w.started) > new Date()) return 'upcoming'
  return 'active'
}
const STATE_LABEL: Record<WarState, string> = { upcoming: 'Aangekondigd', active: 'Actief', finished: 'Beëindigd' }
const STATE_COLOR: Record<WarState, string> = { upcoming: 'var(--gold)', active: '#e05555', finished: 'var(--text-dim)' }

export default function Wars() {
  const { tokens, mainCharId } = useAuth()
  const charId = mainCharId ?? tokens[0]?.characterId ?? 0

  const [wars, setWars] = useState<War[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [mine, setMine] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [filter, setFilter] = useState<'all' | 'active' | 'mine'>('all')
  usePageLoading(loading)

  // Killmails per oorlog (lazy bij uitklappen)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [kmByWar, setKmByWar] = useState<Map<number, Killmail[]>>(new Map())
  const [kmLoading, setKmLoading] = useState<Set<number>>(new Set())

  // Eigen corp/alliance bepalen → om betrokken oorlogen te markeren
  useEffect(() => {
    if (!charId) return
    getCharacterInfo(charId).then(ci => {
      const s = new Set<number>([ci.corporation_id])
      if (ci.alliance_id) s.add(ci.alliance_id)
      setMine(s)
    }).catch(() => {})
  }, [charId])

  const ingest = useCallback(async (ids: number[], append: boolean) => {
    const details = (await Promise.all(ids.map(id => getWar(id).catch(() => null)))).filter((w): w is War => !!w)
    const partyIds = new Set<number>()
    for (const w of details) {
      partyIds.add(partyId(w.aggressor)); partyIds.add(partyId(w.defender))
      for (const a of w.allies ?? []) partyIds.add(partyId(a))
    }
    const nm = await resolveNames([...partyIds].filter(Boolean)).catch(() => new Map<number, string>())
    setNames(prev => new Map([...prev, ...nm]))
    setWars(prev => append ? [...prev, ...details] : details)
  }, [])

  useEffect(() => {
    setLoading(true)
    getWarIds().then(ids => ingest(ids.slice(0, PAGE), false)).catch(() => {}).finally(() => setLoading(false))
  }, [ingest])

  const loadMore = async () => {
    const last = wars[wars.length - 1]?.id
    if (!last) return
    setLoadingMore(true)
    try {
      const ids = await getWarIds(last).catch(() => [] as number[])
      await ingest(ids.filter(i => i < last).slice(0, PAGE), true)
    } finally { setLoadingMore(false) }
  }

  const involvesMine = useCallback((w: War) => {
    if (mine.size === 0) return false
    if (mine.has(partyId(w.aggressor)) || mine.has(partyId(w.defender))) return true
    return (w.allies ?? []).some(a => mine.has(partyId(a)))
  }, [mine])

  const shown = useMemo(() => wars.filter(w =>
    filter === 'all' ? true : filter === 'active' ? warState(w) !== 'finished' : involvesMine(w),
  ), [wars, filter, involvesMine])

  const mineCount = useMemo(() => wars.filter(involvesMine).length, [wars, involvesMine])
  const nameOf = (id: number) => names.get(id) ?? `#${id}`

  const loadKills = useCallback(async (warId: number) => {
    setKmLoading(prev => new Set(prev).add(warId))
    try {
      const refs = await getWarKillmails(warId).catch(() => [] as { killmail_id: number; killmail_hash: string }[])
      const kms = (await Promise.all(refs.slice(0, 25).map(r => getKillmailDetail(r.killmail_id, r.killmail_hash))))
        .filter((k): k is Killmail => !!k)
        .sort((a, b) => b.killmail_time.localeCompare(a.killmail_time))
      const ids = new Set<number>()
      for (const k of kms) {
        ids.add(k.victim.ship_type_id)
        if (k.victim.character_id) ids.add(k.victim.character_id)
        const fb = k.attackers.find(a => a.final_blow)
        if (fb?.character_id) ids.add(fb.character_id)
        else if (fb?.corporation_id) ids.add(fb.corporation_id)
      }
      const nm = await resolveNames([...ids].filter(Boolean)).catch(() => new Map<number, string>())
      setNames(prev => new Map([...prev, ...nm]))
      setKmByWar(prev => new Map(prev).set(warId, kms))
    } finally {
      setKmLoading(prev => { const n = new Set(prev); n.delete(warId); return n })
    }
  }, [])

  const toggleWar = (warId: number) => {
    setExpanded(prev => {
      const n = new Set(prev)
      if (n.has(warId)) n.delete(warId)
      else { n.add(warId); if (!kmByWar.has(warId)) loadKills(warId) }
      return n
    })
  }

  const fmtTime = (s: string) => new Date(s).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  const Party = ({ p, big }: { p: WarParty | WarAlly; big?: boolean }) => {
    const id = partyId(p)
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <EveImage category={partyCat(p)} id={id} variation="logo" size={64} px={big ? 36 : 28} style={{ borderRadius: 3, flexShrink: 0 }} />
        <span style={{ fontSize: big ? '0.82rem' : '0.76rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(id)}</span>
      </div>
    )
  }

  return (
    <Layout header={<PageHeader title="Wars" />}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {([['all', `Alle (${wars.length})`], ['active', 'Actief'], ['mine', `Mijn corp (${mineCount})`]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            ...pill, padding: '4px 12px',
            background: filter === k ? 'rgba(0,180,216,0.18)' : 'rgba(255,255,255,0.05)',
            borderColor: filter === k ? 'var(--blue)' : 'var(--text-dim)',
            color: filter === k ? '#fff' : 'var(--text)',
          }}>{lbl}</button>
        ))}
        <span style={{ fontSize: '0.64rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>Nieuwste war-declaraties uit EVE; jouw corp/alliance is gemarkeerd.</span>
      </div>

      {!loading && shown.length === 0 && (
        <div style={{ ...card, color: 'var(--text-dim)' }}>
          {filter === 'mine' ? 'Geen recente oorlogen met jouw corp/alliance gevonden.' : 'Geen oorlogen gevonden.'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map(w => {
          const st = warState(w)
          const involved = involvesMine(w)
          return (
            <div key={w.id} style={{
              ...card,
              borderColor: involved ? 'var(--red)' : 'var(--border)',
              boxShadow: involved ? '0 0 0 1px rgba(224,85,85,0.4)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ ...pill, color: STATE_COLOR[st], borderColor: STATE_COLOR[st], cursor: 'default' }}>{STATE_LABEL[st]}</span>
                {w.mutual && <span style={{ ...pill, color: 'var(--gold)', borderColor: 'var(--gold)', cursor: 'default' }}>wederzijds</span>}
                {involved && <span style={{ ...pill, color: '#fff', background: 'var(--red)', borderColor: 'var(--red)', cursor: 'default' }}>⚔ betrokken</span>}
                <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                  Aangekondigd {fmtDate(w.declared)}{w.finished ? ` · eindigt ${fmtDate(w.finished)}` : ''}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Party p={w.aggressor} big />
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: 2 }}>aanvaller · {w.aggressor.ships_killed} kills · {fmtISK(w.aggressor.isk_destroyed)} ISK</div>
                </div>
                <span style={{ fontSize: '1rem', color: 'var(--red)', flexShrink: 0 }}>⚔</span>
                <div style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}><Party p={w.defender} big /></div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: 2 }}>verdediger · {w.defender.ships_killed} kills · {fmtISK(w.defender.isk_destroyed)} ISK</div>
                </div>
              </div>

              {(w.allies?.length ?? 0) > 0 && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>bondgenoten:</span>
                  {w.allies!.slice(0, 8).map(a => <EveImage key={partyId(a)} category={partyCat(a)} id={partyId(a)} variation="logo" size={32} px={18} style={{ borderRadius: 2 }} />)}
                  {w.allies!.length > 8 && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>+{w.allies!.length - 8}</span>}
                </div>
              )}

              {/* Killmails (lazy) */}
              {(() => {
                const kills = w.aggressor.ships_killed + w.defender.ships_killed
                const open = expanded.has(w.id)
                return (
                  <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                    <button onClick={() => kills > 0 && toggleWar(w.id)} disabled={kills === 0}
                      style={{ ...pill, cursor: kills > 0 ? 'pointer' : 'default', color: kills > 0 ? 'var(--text)' : 'var(--text-dim)', borderColor: 'var(--text-dim)', background: kills > 0 ? 'rgba(255,255,255,0.05)' : 'transparent' }}>
                      {kills > 0 ? (open ? '▾' : '▸') : '—'} {kills} killmail{kills !== 1 ? 's' : ''}
                    </button>
                    {open && (
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {kmLoading.has(w.id) && <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', padding: '2px 4px' }}>⏳ killmails laden…</div>}
                        {!kmLoading.has(w.id) && (kmByWar.get(w.id) ?? []).length === 0 && <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', padding: '2px 4px' }}>Geen killmails opgehaald.</div>}
                        {(kmByWar.get(w.id) ?? []).map(k => {
                          const fb = k.attackers.find(a => a.final_blow)
                          const fbId = fb?.character_id ?? fb?.corporation_id ?? 0
                          return (
                            <a key={k.killmail_id} href={`https://zkillboard.com/kill/${k.killmail_id}/`} target="_blank" rel="noreferrer"
                              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', textDecoration: 'none', fontSize: '0.66rem', color: 'var(--text-dim)', borderRadius: 3 }}>
                              <span style={{ width: 80, flexShrink: 0 }}>{fmtTime(k.killmail_time)}</span>
                              <EveImage category="types" id={k.victim.ship_type_id} variation="icon" size={32} px={20} style={{ borderRadius: 2, flexShrink: 0 }} />
                              <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {nameOf(k.victim.ship_type_id)}{k.victim.character_id ? ` · ${nameOf(k.victim.character_id)}` : ''}
                              </span>
                              <span style={{ flexShrink: 0 }}>← {fbId ? nameOf(fbId) : '—'} ↗</span>
                            </a>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>

      {!loading && filter !== 'mine' && wars.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: '1rem' }}>
          <button onClick={loadMore} disabled={loadingMore} style={{ ...pill, padding: '6px 16px', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', borderColor: 'var(--text-dim)' }}>
            {loadingMore ? '⏳ laden…' : '↓ Meer laden'}
          </button>
        </div>
      )}
    </Layout>
  )
}

const card: React.CSSProperties = { background: 'var(--panel, rgba(11,11,26,0.6))', border: '1px solid var(--border)', borderRadius: 6, padding: '0.85rem' }
const pill: React.CSSProperties = { padding: '3px 9px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 12, fontSize: '0.62rem', cursor: 'pointer', whiteSpace: 'nowrap' }
