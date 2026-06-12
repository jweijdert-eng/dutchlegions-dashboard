import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getSkillQueue, getSkillsInfo, resolveNames, type SkillQueueEntry } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { usePageLoading } from '../hooks/usePageLoading'

const ROMAN = ['I', 'II', 'III', 'IV', 'V']
function roman(n: number) { return ROMAN[n - 1] ?? String(n) }

function timeLeft(d: string | undefined): string {
  if (!d) return '—'
  const diff = new Date(d).getTime() - Date.now()
  if (diff <= 0) return 'Klaar'
  const days = Math.floor(diff / 86400000)
  const h    = Math.floor((diff % 86400000) / 3600000)
  const m    = Math.floor((diff % 3600000) / 60000)
  if (days > 0) return `${days}d ${h}u`
  if (h > 0)    return `${h}u ${m}m`
  return `${m}m`
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function fmtSP(sp: number) {
  if (sp >= 1e6) return `${(sp / 1e6).toFixed(1)}M SP`
  if (sp >= 1e3) return `${(sp / 1e3).toFixed(0)}K SP`
  return `${sp} SP`
}

interface CharQueue {
  charId: number
  charName: string
  queue: (SkillQueueEntry & { skillName: string })[]
  totalSP: number | null
}

export default function Skills() {
  const { activeTokens: tokens } = useAuth()
  const [queues, setQueues]   = useState<CharQueue[]>([])
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const tick = useAutoRefresh()
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true)

    async function load() {
      const rawQueues = await Promise.all(
        tokens.map(async t => ({
          charId:   t.characterId,
          charName: t.characterName,
          queue:    await getSkillQueue(t.characterId, t.accessToken).catch(() => [] as SkillQueueEntry[]),
          spInfo:   await getSkillsInfo(t.characterId, t.accessToken).catch(() => null),
        }))
      )

      if (myId !== fetchId.current) return

      const allSkillIds = [...new Set(rawQueues.flatMap(c => c.queue.map(s => s.skill_id)))]
      const nameMap = await resolveNames(allSkillIds)

      if (myId !== fetchId.current) return

      const resolved: CharQueue[] = rawQueues.map(c => ({
        charId:   c.charId,
        charName: c.charName,
        totalSP:  c.spInfo?.total_sp ?? null,
        queue:    c.queue
          .sort((a, b) => a.queue_position - b.queue_position)
          .map(s => ({ ...s, skillName: nameMap.get(s.skill_id) ?? `Skill ${s.skill_id}` })),
      }))

      setQueues(resolved)
      setLoading(false)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(','), tick])

  const totalTraining = queues.filter(c => c.queue.length > 0).length

  return (
    <Layout header={
      <PageHeader
        title="Skills"
        sub={loading ? 'Laden...' : `${totalTraining} character${totalTraining !== 1 ? 's' : ''} aan het trainen`}
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Skill queues laden...
        </div>
      )}

      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: '0.75rem' }}>
          {queues.map(c => {
            const current = c.queue[0]
            const rest    = c.queue.slice(1)
            const last    = c.queue[c.queue.length - 1]

            // Progress of current skill
            let pct = 0
            if (current?.start_date && current?.finish_date) {
              const start = new Date(current.start_date).getTime()
              const end   = new Date(current.finish_date).getTime()
              pct = Math.min(100, Math.max(0, (Date.now() - start) / (end - start) * 100))
            }

            return (
              <div key={c.charId} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                {/* Character header */}
                <div style={{ padding: '0.75rem 1rem', background: 'var(--surface2)', display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid var(--border)' }}>
                  <img
                    src={`https://images.evetech.net/characters/${c.charId}/portrait?size=32`}
                    alt=""
                    style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--border)', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>{c.charName}</span>
                      {c.totalSP !== null && (
                        <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--gold)' }}>{fmtSP(c.totalSP)}</span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                      {c.queue.length} skills · klaar {timeLeft(last?.finish_date)}
                    </div>
                  </div>
                </div>

                {c.queue.length === 0 ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
                    Geen training actief
                  </div>
                ) : (
                  <>
                    {/* Currently training */}
                    <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.55rem', color: current.finish_date ? 'var(--text-dim)' : 'var(--gold)', fontWeight: 700, letterSpacing: '0.15em', marginBottom: '0.5rem' }}>
                        {current.finish_date ? 'NU AAN HET TRAINEN' : 'TRAINING GEPAUZEERD'}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.45rem' }}>
                        <div>
                          <span style={{ fontSize: '0.92rem', fontWeight: 700 }}>{current.skillName}</span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--blue)', fontWeight: 700, marginLeft: '0.4rem' }}>
                            {roman(current.finished_level)}
                          </span>
                        </div>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-dim)' }}>
                          {timeLeft(current.finish_date)}
                        </span>
                      </div>
                      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--blue)', borderRadius: 3, transition: 'width 1s' }} />
                      </div>
                      <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                        {pct.toFixed(1)}% · klaar {current.finish_date ? fmtDate(current.finish_date) : '—'}
                      </div>
                    </div>

                    {/* Queue */}
                    {rest.length > 0 && (
                      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                        {rest.map((s, i) => (
                          <div
                            key={s.queue_position}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '0.5rem',
                              padding: '0.35rem 1rem',
                              background: i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent',
                              borderBottom: '1px solid rgba(28,28,53,0.4)',
                            }}
                          >
                            <span style={{ fontSize: '0.58rem', color: 'var(--border)', width: 16, textAlign: 'right', flexShrink: 0 }}>
                              {s.queue_position + 1}
                            </span>
                            <span style={{ fontSize: '0.72rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.skillName}
                            </span>
                            <span style={{ fontSize: '0.65rem', color: 'var(--blue)', fontWeight: 700, flexShrink: 0 }}>
                              {roman(s.finished_level)}
                            </span>
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', flexShrink: 0, minWidth: 52, textAlign: 'right' }}>
                              {timeLeft(s.finish_date)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Layout>
  )
}
