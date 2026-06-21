import { useCallback, useEffect, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import { usePageLoading } from '../hooks/usePageLoading'

const ADMIN_CHAR_ID = 1831618559

interface Recruit {
  character_id: number
  name: string
  data: string | null
  status: string
  notes: string | null
  created_at: string
  updated_at: string
}

const STAGES = [
  { key: 'new',      label: 'Nieuw',        color: 'var(--blue)' },
  { key: 'contact',  label: 'In gesprek',   color: 'var(--gold)' },
  { key: 'accepted', label: 'Geaccepteerd', color: '#3ecf6e' },
  { key: 'rejected', label: 'Afgewezen',    color: 'var(--red)' },
] as const
const STAGE_KEYS = STAGES.map(s => s.key) as readonly string[]
const stageOf = (s: string) => (STAGE_KEYS.includes(s) ? s : 'new')

function fmtDate(s: string) {
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function RecruitFunnel() {
  const { tokens, mainCharId } = useAuth()
  const token = tokens.find(t => t.characterId === ADMIN_CHAR_ID)?.accessToken
    ?? tokens.find(t => t.characterId === mainCharId)?.accessToken
    ?? tokens[0]?.accessToken ?? ''

  const [recruits, setRecruits] = useState<Recruit[]>([])
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [err, setErr] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!token) { setLoading(false); setErr('Geen geldig token.'); return }
    try {
      const r = await fetch(`/api/recruit_list.php?token=${encodeURIComponent(token)}`)
      const j = await r.json()
      if (Array.isArray(j)) { setRecruits(j); setErr('') }
      else setErr(j?.error === 'forbidden' ? 'Geen recruiter-rechten op dit account.' : 'Kon de lijst niet laden.')
    } catch { setErr('Netwerkfout bij laden.') }
    finally { setLoading(false) }
  }, [token])

  useEffect(() => { load() }, [load])

  const setStatus = async (id: number, status: string) => {
    setRecruits(prev => prev.map(r => r.character_id === id ? { ...r, status } : r))
    await fetch(`/api/recruit_list.php?token=${encodeURIComponent(token)}&id=${id}&status=${status}`).catch(() => {})
  }
  const remove = async (id: number) => {
    if (!confirm('Deze aanmelding verwijderen?')) return
    setRecruits(prev => prev.filter(r => r.character_id !== id))
    await fetch(`/api/recruit_list.php?token=${encodeURIComponent(token)}&delete=${id}`).catch(() => {})
  }
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setNote = (id: number, notes: string) => {
    setRecruits(prev => prev.map(r => r.character_id === id ? { ...r, notes } : r))
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => {
      fetch(`/api/recruit_list.php?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, notes }),
      }).catch(() => {})
    }, 600)
  }

  const byStage = (key: string) => recruits.filter(r => stageOf(r.status) === key)
  const parseData = (d: string | null): [string, string][] => {
    try {
      const o = JSON.parse(d ?? '{}')
      return Object.entries(o).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => [k, String(v)])
    } catch { return [] }
  }

  return (
    <Layout header={<PageHeader title="Recruitment-funnel" sub={loading ? 'Laden…' : `${recruits.length} aanmelding${recruits.length !== 1 ? 'en' : ''}`} />}>
      {err && <div style={{ ...card, color: 'var(--red)', marginBottom: '1rem' }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '0.75rem', alignItems: 'start' }}>
        {STAGES.map(stage => {
          const items = byStage(stage.key)
          return (
            <div key={stage.key} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '0.5rem 0.75rem', borderBottom: `2px solid ${stage.color}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em', color: stage.color, textTransform: 'uppercase' }}>{stage.label}</span>
                <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>{items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6, minHeight: 40 }}>
                {items.length === 0 && <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', padding: '0.4rem', textAlign: 'center' }}>—</div>}
                {items.map(r => {
                  const idx = STAGE_KEYS.indexOf(stageOf(r.status))
                  const open = expanded === r.character_id
                  return (
                    <div key={r.character_id} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.45rem 0.55rem' }}>
                      <div onClick={() => setExpanded(open ? null : r.character_id)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <img src={`https://images.evetech.net/characters/${r.character_id}/portrait?size=32`} width={28} height={28} style={{ borderRadius: '50%', flexShrink: 0 }} alt="" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.74rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || `#${r.character_id}`}</div>
                          <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>aangemeld {fmtDate(r.created_at)}{r.notes ? ' · 📝' : ''}</div>
                        </div>
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
                      </div>

                      {open && (
                        <div style={{ marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                          {parseData(r.data).slice(0, 12).map(([k, v]) => (
                            <div key={k} style={{ fontSize: '0.62rem', display: 'flex', gap: 6, padding: '1px 0' }}>
                              <span style={{ color: 'var(--text-dim)', flexShrink: 0, minWidth: 70 }}>{k}</span>
                              <span style={{ color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
                            </div>
                          ))}
                          <textarea value={r.notes ?? ''} onChange={e => setNote(r.character_id, e.target.value)} placeholder="Recruiter-notitie…" rows={2}
                            style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 3, color: '#fff', fontSize: '0.66rem', padding: '0.35rem 0.45rem', resize: 'vertical' }} />
                          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                            <a href={`https://zkillboard.com/character/${r.character_id}/`} target="_blank" rel="noreferrer" style={miniBtn}>zKill ↗</a>
                            <button onClick={() => remove(r.character_id)} style={{ ...miniBtn, color: 'var(--red)', marginLeft: 'auto' }}>🗑</button>
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        <button disabled={idx <= 0} onClick={() => setStatus(r.character_id, STAGE_KEYS[idx - 1])} title="Vorige fase" style={{ ...moveBtn, opacity: idx <= 0 ? 0.3 : 1 }}>◀</button>
                        <button onClick={() => setStatus(r.character_id, 'accepted')} style={{ ...moveBtn, flex: 1, color: '#3ecf6e', borderColor: 'rgba(62,207,110,0.4)' }}>✓</button>
                        <button onClick={() => setStatus(r.character_id, 'rejected')} style={{ ...moveBtn, flex: 1, color: 'var(--red)', borderColor: 'rgba(224,85,85,0.4)' }}>✕</button>
                        <button disabled={idx >= STAGE_KEYS.length - 1} onClick={() => setStatus(r.character_id, STAGE_KEYS[idx + 1])} title="Volgende fase" style={{ ...moveBtn, opacity: idx >= STAGE_KEYS.length - 1 ? 0.3 : 1 }}>▶</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {!loading && recruits.length === 0 && !err && (
        <div style={{ ...card, marginTop: '1rem', color: 'var(--text-dim)' }}>Nog geen aanmeldingen. Ze verschijnen hier zodra iemand zich via de recruiting-pagina aanmeldt.</div>
      )}
    </Layout>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem' }
const moveBtn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.66rem', padding: '0.2rem 0.3rem', lineHeight: 1 }
const miniBtn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.6rem', padding: '0.2rem 0.45rem', textDecoration: 'none' }
