import { useEffect, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'
import { useLayoutMode } from '../context/LayoutModeContext'
import { LOCAL } from '../components/Sidebar'
import { getCharacterInfo, getCorporation, getAlliance } from '../api/esi'
import EveImage from '../components/EveImage'

const ADMIN_CHAR_ID = 1831618559

function fmtMB(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(0)} MB` }

interface SdeStatus {
  loaded: boolean
  fsdFiles: number
  version: { installed: number | null; installedReleaseDate: string | null; latest: number | null; latestReleaseDate: string | null; updateAvailable: boolean }
  download: { active: boolean; step: string; downloaded: number; total: number; extracted: number; error: string | null }
}

interface ActivityData {
  total: number
  today: number
  week: number
  month: number
  daily: { day: string; count: number }[]
}

interface SiteMember {
  character_id: number
  name: string
  last_seen: string
  blocked: number
}

interface MemberOrg {
  corpId: number
  corpName: string
  allianceId?: number
  allianceName?: string
  allianceTicker?: string
}

type SettingKey = 'maintenance_mode' | 'require_corp' | 'require_alliance' | 'local_chat'

const SETTING_LABELS: Record<SettingKey, string> = {
  maintenance_mode: 'Onderhoudsmodus',
  require_corp:     'Alleen Dutch Legions corp',
  require_alliance: 'Alleen Insidious alliance',
  local_chat:       'Local Chat zichtbaar voor members',
}

const DEFAULT_SETTINGS: Record<SettingKey, boolean> = {
  maintenance_mode: false,
  require_corp:     false,
  require_alliance: false,
  local_chat:       true,
}

export default function Admin() {
  const { tokens } = useAuth()
  const { previewMode, setPreviewMode } = useLayoutMode()
  const adminToken = tokens.find(t => t.characterId === ADMIN_CHAR_ID)
  const [tab, setTab] = useState<'stats' | 'members' | 'settings' | 'sde'>('stats')
  const [activity, setActivity] = useState<ActivityData | null>(null)
  const [members, setMembers] = useState<SiteMember[]>([])
  const [orgs, setOrgs] = useState<Record<number, MemberOrg>>({})
  const [settings, setSettings] = useState<Record<SettingKey, boolean>>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)
  const [sde, setSde] = useState<SdeStatus | null>(null)
  const [sdeServerUp, setSdeServerUp] = useState(false)
  const sdeRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (tab === 'stats') fetchActivity()
    if (tab === 'members') fetchMembers()
    if (tab === 'settings') fetchSettings()
    if (tab === 'sde') {
      pollSde()
      sdeRef.current = setInterval(pollSde, 3000)
    } else {
      if (sdeRef.current) { clearInterval(sdeRef.current); sdeRef.current = null }
    }
    return () => { if (sdeRef.current) { clearInterval(sdeRef.current); sdeRef.current = null } }
  }, [tab])

  async function pollSde() {
    try {
      const r = await fetch(`${LOCAL}/sde-status`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { setSde(await r.json()); setSdeServerUp(true) }
    } catch { setSdeServerUp(false) }
  }

  async function startSdeDownload() {
    await fetch(`${LOCAL}/sde-download`, { method: 'POST' }).catch(() => null)
  }

  async function fetchActivity() {
    setLoading(true)
    try {
      const r = await fetch('/api/activity.php')
      setActivity(await r.json())
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function fetchMembers() {
    setLoading(true)
    try {
      const r = await fetch('/api/members.php')
      const list = await r.json() as SiteMember[]
      setMembers(list)
      fetchMemberOrgs(list)
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function refreshMembers() {
    try {
      const r = await fetch('/api/members.php')
      const list = await r.json() as SiteMember[]
      setMembers(list)
      fetchMemberOrgs(list)
    } catch { /* ignore */ }
  }

  // Corp/alliance per member ophalen via publieke ESI (geen token nodig)
  async function fetchMemberOrgs(list: SiteMember[]) {
    const infos = await Promise.all(list.map(async m => {
      const info = await getCharacterInfo(m.character_id).catch(() => null)
      return { charId: m.character_id, corpId: info?.corporation_id ?? null, allianceId: info?.alliance_id ?? null }
    }))
    const corpIds = [...new Set(infos.map(i => i.corpId).filter((x): x is number => x != null))]
    const allyIds = [...new Set(infos.map(i => i.allianceId).filter((x): x is number => x != null))]
    const [corpMap, allyMap] = await Promise.all([
      Promise.all(corpIds.map(async id => [id, await getCorporation(id).catch(() => null)] as const)).then(e => new Map(e)),
      Promise.all(allyIds.map(async id => [id, await getAlliance(id).catch(() => null)] as const)).then(e => new Map(e)),
    ])
    const result: Record<number, MemberOrg> = {}
    for (const i of infos) {
      if (i.corpId == null) continue
      const ally = i.allianceId != null ? allyMap.get(i.allianceId) : null
      result[i.charId] = {
        corpId: i.corpId,
        corpName: corpMap.get(i.corpId)?.name ?? `Corp ${i.corpId}`,
        allianceId: i.allianceId ?? undefined,
        allianceName: ally?.name,
        allianceTicker: ally?.ticker,
      }
    }
    setOrgs(result)
  }

  async function deleteMember(charId: number) {
    if (!adminToken || charId === ADMIN_CHAR_ID) return
    setMembers(prev => prev.filter(m => m.character_id !== charId))
    await fetch('/api/members.php', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminCharId: adminToken.characterId, characterId: charId }),
    }).catch(() => {})
    await refreshMembers()
  }

  async function toggleBlock(member: SiteMember) {
    if (!adminToken || member.character_id === ADMIN_CHAR_ID) return
    const action = member.blocked === 1 ? 'unblock' : 'block'
    setMembers(prev => prev.map(m => m.character_id === member.character_id ? { ...m, blocked: member.blocked === 1 ? 0 : 1 } : m))
    await fetch('/api/members.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminCharId: adminToken.characterId, characterId: member.character_id, action }),
    }).catch(() => {})
    await refreshMembers()
  }

  async function fetchSettings() {
    setLoading(true)
    try {
      const r = await fetch('/api/settings.php')
      const data = await r.json()
      setSettings({ ...DEFAULT_SETTINGS, ...data })
    } catch { /* ignore */ }
    setLoading(false)
  }

  function isOnline(lastSeen: string) {
    return Date.now() - new Date(lastSeen).getTime() < 30 * 60 * 1000
  }

  async function toggleSetting(key: SettingKey) {
    if (!adminToken) return
    const next = { ...settings, [key]: !settings[key] }
    setSettings(next)
    try {
      await fetch('/api/settings.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: adminToken.characterId, settings: next }),
      })
    } catch { /* ignore */ }
  }

  const TAB_STYLE = (active: boolean): React.CSSProperties => ({
    padding: '0.5rem 1.2rem',
    fontSize: '0.75rem',
    fontWeight: 700,
    letterSpacing: '0.1em',
    cursor: 'pointer',
    border: 'none',
    borderBottom: active ? '2px solid var(--blue)' : '2px solid transparent',
    background: 'transparent',
    color: active ? 'var(--blue)' : 'var(--text-dim)',
    transition: 'color 0.15s',
  })

  return (
    <Layout header={
      <PageHeader title="Admin" right={
        <button
          onClick={() => setPreviewMode(!previewMode)}
          style={{
            padding: '0.3rem 0.75rem', borderRadius: 3, fontSize: '0.72rem',
            fontWeight: 600, cursor: 'pointer', letterSpacing: '0.04em',
            background: previewMode ? 'rgba(240,192,64,0.15)' : 'rgba(0,180,216,0.07)',
            border: `1px solid ${previewMode ? 'var(--gold)' : 'rgba(0,180,216,0.2)'}`,
            color: previewMode ? 'var(--gold)' : 'var(--blue)',
          }}
        >
          {previewMode ? '← Terug naar Admin' : '👁 Bekijk als member'}
        </button>
      } />
    }>
      <div style={{ padding: '1.5rem', maxWidth: 900 }}>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem' }}>
          <button style={TAB_STYLE(tab === 'stats')}    onClick={() => setTab('stats')}>Statistieken</button>
          <button style={TAB_STYLE(tab === 'members')}  onClick={() => setTab('members')}>Member Beheer</button>
          <button style={TAB_STYLE(tab === 'settings')} onClick={() => setTab('settings')}>Site Instellingen</button>
          <button style={TAB_STYLE(tab === 'sde')}      onClick={() => setTab('sde')}>SDE</button>
        </div>

        {loading && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>Laden...</div>
        )}

        {/* Statistieken */}
        {tab === 'stats' && !loading && activity && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
              {[
                { label: 'TOTAAL MEMBERS', value: activity.total, color: 'var(--text)' },
                { label: 'ACTIEF VANDAAG', value: activity.today, color: 'var(--blue)' },
                { label: 'ACTIEF DEZE WEEK', value: activity.week, color: 'var(--blue)' },
                { label: 'ACTIEF DEZE MAAND', value: activity.month, color: 'var(--blue)' },
              ].map(c => (
                <div key={c.label} style={{
                  background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
                  borderRadius: 4, padding: '1rem',
                }}>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginBottom: '0.5rem', letterSpacing: '0.1em' }}>{c.label}</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 700, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '0.75rem' }}>LOGINS PER DAG — LAATSTE 30 DAGEN</div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '1rem' }}>
              {activity.daily.length === 0 ? (
                <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center', padding: '2rem 0' }}>Nog geen logindata beschikbaar.</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={activity.daily} margin={{ top: 4, right: 0, left: -20, bottom: 0 }}>
                    <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickFormatter={d => d.slice(5)} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.75rem' }}
                      labelStyle={{ color: 'var(--text-dim)' }}
                      formatter={(v: number) => [v, 'logins']}
                    />
                    <Bar dataKey="count" fill="var(--blue)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* Member Beheer */}
        {tab === 'members' && !loading && (
          <div style={{ maxWidth: 580 }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.75rem', letterSpacing: '0.08em' }}>
              {members.length} LEDEN — automatisch bijgewerkt bij inloggen
            </div>
            {members.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
                Nog niemand ingelogd op de dashboard.
              </div>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                {members.map((m, i) => {
                  const online = isOnline(m.last_seen)
                  const blocked = !!m.blocked
                  const org = orgs[m.character_id]
                  return (
                    <div key={m.character_id} style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '0.65rem 1rem',
                      background: i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                      borderBottom: i < members.length - 1 ? '1px solid rgba(255,255,255,0.1)' : 'none',
                      fontSize: '0.8rem',
                      opacity: blocked ? 0.55 : 1,
                    }}>
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <img
                          src={`https://images.evetech.net/characters/${m.character_id}/portrait?size=64`}
                          width={32} height={32}
                          style={{ borderRadius: '50%', display: 'block', filter: blocked ? 'grayscale(1)' : 'none' }}
                        />
                        {org?.corpId && (
                          <EveImage category="corporations" id={org.corpId} variation="logo" size={32} px={14}
                            style={{ position: 'absolute', top: -2, right: -2, borderRadius: 2, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
                        )}
                        <div style={{
                          position: 'absolute', bottom: 0, right: 0,
                          width: 9, height: 9, borderRadius: '50%',
                          background: blocked ? 'var(--red)' : online ? 'var(--green)' : 'var(--border)',
                          border: '1.5px solid var(--surface)',
                        }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                        {org && (
                          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {org.corpName}
                            {org.allianceName && <span style={{ color: 'var(--gold)' }}> · {org.allianceName}</span>}
                          </div>
                        )}
                      </div>
                      {blocked && (
                        <span style={{ fontSize: '0.6rem', color: 'var(--red)', fontWeight: 700, letterSpacing: '0.06em' }}>GEBLOKKEERD</span>
                      )}
                      {!blocked && (
                        <span style={{ fontSize: '0.65rem', fontWeight: 600, color: online ? 'var(--green)' : 'var(--text-dim)' }}>
                          {online ? 'Online' : 'Offline'}
                        </span>
                      )}
                      {m.character_id !== ADMIN_CHAR_ID && (
                        <>
                          <button
                            onClick={() => toggleBlock(m)}
                            title={blocked ? 'Deblokkeren' : 'Blokkeren'}
                            style={{
                              padding: '0.2rem 0.5rem', fontSize: '0.65rem', fontWeight: 600,
                              border: `1px solid ${blocked ? 'rgba(0,180,216,0.3)' : 'rgba(224,85,85,0.3)'}`,
                              borderRadius: 3, cursor: 'pointer', background: 'transparent',
                              color: blocked ? 'var(--blue)' : 'var(--red)',
                            }}
                          >
                            {blocked ? 'Deblokkeer' : 'Blokkeer'}
                          </button>
                          <button
                            onClick={() => deleteMember(m.character_id)}
                            title="Verwijder"
                            style={{
                              padding: '0.2rem 0.5rem', fontSize: '0.65rem', fontWeight: 600,
                              border: '1px solid rgba(224,85,85,0.3)', borderRadius: 3, cursor: 'pointer',
                              background: 'transparent', color: 'var(--red)',
                            }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Site Instellingen */}
        {tab === 'settings' && !loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 400 }}>
            {(Object.keys(settings) as SettingKey[]).map(key => (
              <div key={key} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '0.85rem 1rem',
              }}>
                <span style={{ fontSize: '0.8rem' }}>{SETTING_LABELS[key]}</span>
                <div
                  onClick={() => toggleSetting(key)}
                  style={{
                    width: 40, height: 22, borderRadius: 11, cursor: 'pointer',
                    background: settings[key] ? 'var(--blue)' : 'var(--border)',
                    position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute', top: 3,
                    left: settings[key] ? 21 : 3,
                    width: 16, height: 16, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.2s',
                  }} />
                </div>
              </div>
            ))}
            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
              Instellingen worden opgeslagen in de database.
            </div>
          </div>
        )}

        {/* SDE */}
        {tab === 'sde' && (() => {
          const dl = sde?.download
          const isUpdate = sde?.version?.updateAvailable
          const accentColor = !sdeServerUp ? 'var(--border)' : dl?.active ? 'var(--blue)' : isUpdate ? 'var(--gold)' : sde?.loaded ? 'var(--green)' : 'var(--blue)'
          const versionLabel = !sdeServerUp ? null
            : dl?.active ? null
            : sde?.version?.installed ? `Build #${sde.version.installed}`
            : sde?.loaded ? `${sde.fsdFiles} bestanden`
            : null
          return (
            <div style={{ maxWidth: 420 }}>
              <div style={{
                background: 'rgba(255,255,255,0.04)', border: `1px solid var(--border)`,
                borderLeft: `3px solid ${accentColor}`, borderRadius: 4, padding: '1.25rem 1.5rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <span style={{ fontSize: '0.7rem', color: accentColor, letterSpacing: '0.15em', fontWeight: 700 }}>STATIC DATA EXPORT</span>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: accentColor }}>
                    {!sdeServerUp ? 'Server offline' : dl?.active ? (dl.extracted > 0 ? `${dl.extracted} bestanden` : dl.step) : sde?.loaded ? '✓ Geladen' : 'Niet geladen'}
                  </span>
                </div>

                {versionLabel && !dl?.active && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: isUpdate ? 'var(--gold)' : 'var(--text)' }}>{versionLabel}</span>
                      {isUpdate && <span style={{ fontSize: '0.62rem', background: 'rgba(240,192,64,0.15)', border: '1px solid rgba(240,192,64,0.4)', color: 'var(--gold)', borderRadius: 2, padding: '0.05rem 0.35rem', fontWeight: 700 }}>update beschikbaar</span>}
                    </div>
                    {sde?.version?.installedReleaseDate && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                        {new Date(sde.version.installedReleaseDate).toLocaleString('nl', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                  </div>
                )}

                {dl?.active && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ height: 6, background: 'rgba(0,180,216,0.15)', borderRadius: 3, overflow: 'hidden', marginBottom: '0.4rem' }}>
                      <div style={{ height: '100%', borderRadius: 3, background: 'linear-gradient(90deg, var(--blue), #7dd3fc)', width: dl.total > 0 ? `${Math.round(dl.downloaded / dl.total * 100)}%` : '60%', transition: 'width 0.5s' }} />
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--blue)', fontWeight: 600 }}>
                      {dl.total > 0 ? `${fmtMB(dl.downloaded)} / ${fmtMB(dl.total)}` : dl.step}
                    </div>
                  </div>
                )}

                {dl?.error && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--red)', marginBottom: '0.75rem', background: 'rgba(224,85,85,0.08)', borderRadius: 3, padding: '0.4rem 0.6rem' }}>
                    {dl.error}
                  </div>
                )}

                {!dl?.active && sdeServerUp && (!sde?.loaded || isUpdate) && (
                  <button onClick={startSdeDownload} style={{ display: 'block', width: '100%', textAlign: 'center', cursor: 'pointer', background: isUpdate ? 'rgba(240,192,64,0.12)' : 'rgba(0,180,216,0.1)', border: `1px solid ${isUpdate ? 'rgba(240,192,64,0.45)' : 'rgba(0,180,216,0.35)'}`, color: isUpdate ? 'var(--gold)' : 'var(--blue)', borderRadius: 3, fontSize: '0.75rem', fontWeight: 700, padding: '0.5rem' }}>
                    {isUpdate ? '↻ Bijwerken' : '↓ SDE installeren'}
                  </button>
                )}

                {!sdeServerUp && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
                    Start de lokale server: <code style={{ color: 'var(--blue)' }}>cd local-chat-server &amp;&amp; node server.js</code>
                  </div>
                )}
              </div>
            </div>
          )
        })()}

      </div>
    </Layout>
  )
}
