import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'
import { useLayoutMode } from '../context/LayoutModeContext'

const ADMIN_CHAR_ID = 1831618559

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

type SettingKey = 'maintenance_mode' | 'require_corp' | 'require_alliance'

const SETTING_LABELS: Record<SettingKey, string> = {
  maintenance_mode: 'Onderhoudsmodus',
  require_corp:     'Alleen Dutch Legions corp',
  require_alliance: 'Alleen Insidious alliance',
}

const DEFAULT_SETTINGS: Record<SettingKey, boolean> = {
  maintenance_mode: false,
  require_corp:     false,
  require_alliance: false,
}

export default function Admin() {
  const { tokens } = useAuth()
  const { previewMode, setPreviewMode } = useLayoutMode()
  const adminToken = tokens.find(t => t.characterId === ADMIN_CHAR_ID)
  const [tab, setTab] = useState<'stats' | 'members' | 'settings'>('stats')
  const [activity, setActivity] = useState<ActivityData | null>(null)
  const [members, setMembers] = useState<SiteMember[]>([])
  const [settings, setSettings] = useState<Record<SettingKey, boolean>>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (tab === 'stats') fetchActivity()
    if (tab === 'members') fetchMembers()
    if (tab === 'settings') fetchSettings()
  }, [tab])

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
      setMembers(await r.json())
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function refreshMembers() {
    try {
      const r = await fetch('/api/members.php')
      setMembers(await r.json())
    } catch { /* ignore */ }
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
          <div style={{ maxWidth: 500 }}>
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
                        <div style={{
                          position: 'absolute', bottom: 0, right: 0,
                          width: 9, height: 9, borderRadius: '50%',
                          background: blocked ? 'var(--red)' : online ? 'var(--green)' : 'var(--border)',
                          border: '1.5px solid var(--surface)',
                        }} />
                      </div>
                      <span style={{ flex: 1 }}>{m.name}</span>
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

      </div>
    </Layout>
  )
}
