import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'

const CORP_ID = 98652891
const ADMIN_CHAR_ID = 1831618559

interface ZkillStat {
  allTimeSum: number
  iskDestroyed: number
  iskLost: number
  shipsDestroyed: number
  shipsLost: number
  topLists: { type: string; data: { kills: number; characterName?: string; shipName?: string }[] }[]
}

interface SiteMember {
  character_id: number
  name: string
  last_seen: string
}

type SettingKey = 'maintenance_mode' | 'require_corp' | 'require_alliance' | 'show_wallet' | 'show_kills' | 'show_market'

const SETTING_LABELS: Record<SettingKey, string> = {
  maintenance_mode: 'Onderhoudsmodus',
  require_corp:     'Alleen Dutch Legions corp',
  require_alliance: 'Alleen Insidious alliance',
  show_wallet:      'Wallet zichtbaar',
  show_kills:       'Kills zichtbaar',
  show_market:      'Market zichtbaar',
}

const DEFAULT_SETTINGS: Record<SettingKey, boolean> = {
  maintenance_mode: false,
  require_corp:     false,
  require_alliance: false,
  show_wallet:      true,
  show_kills:       true,
  show_market:      true,
}

export default function Admin() {
  const { tokens } = useAuth()
  const adminToken = tokens.find(t => t.characterId === ADMIN_CHAR_ID)
  const [tab, setTab] = useState<'stats' | 'members' | 'settings'>('stats')
  const [stats, setStats] = useState<ZkillStat | null>(null)
  const [members, setMembers] = useState<SiteMember[]>([])
  const [settings, setSettings] = useState<Record<SettingKey, boolean>>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (tab === 'stats') fetchStats()
    if (tab === 'members') fetchMembers()
    if (tab === 'settings') fetchSettings()
  }, [tab])

  async function fetchStats() {
    setLoading(true)
    try {
      const r = await fetch(`https://zkillboard.com/api/stats/corporationID/${CORP_ID}/`)
      setStats(await r.json())
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

  const fmtISK = (v: number) => v >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(0)}M`

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
    <Layout header={<PageHeader title="Admin" />}>
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
        {tab === 'stats' && !loading && stats && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
              {[
                { label: 'Ships Destroyed', value: stats.shipsDestroyed?.toLocaleString() ?? '—', color: 'var(--green)' },
                { label: 'Ships Lost',      value: stats.shipsLost?.toLocaleString() ?? '—',      color: 'var(--red)' },
                { label: 'ISK Destroyed',   value: fmtISK(stats.iskDestroyed ?? 0),               color: 'var(--green)' },
                { label: 'ISK Lost',        value: fmtISK(stats.iskLost ?? 0),                    color: 'var(--red)' },
              ].map(c => (
                <div key={c.label} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 4, padding: '1rem',
                }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.4rem', letterSpacing: '0.08em' }}>{c.label}</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700, color: c.color }}>{c.value}</div>
                </div>
              ))}
            </div>

            {stats.topLists?.map(list => list.type === 'character' && list.data?.length > 0 && (
              <div key={list.type}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '0.75rem' }}>TOP PILOTS</div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                  {list.data.slice(0, 10).map((p, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.6rem 1rem',
                      borderBottom: i < 9 ? '1px solid var(--border)' : 'none',
                      fontSize: '0.8rem',
                    }}>
                      <span style={{ color: 'var(--text-dim)', marginRight: '0.75rem' }}>#{i + 1}</span>
                      <span style={{ flex: 1 }}>{p.characterName ?? '—'}</span>
                      <span style={{ color: 'var(--green)', fontWeight: 700 }}>{p.kills} kills</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
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
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                {members.map((m, i) => {
                  const online = isOnline(m.last_seen)
                  return (
                    <div key={m.character_id} style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '0.6rem 1rem',
                      borderBottom: i < members.length - 1 ? '1px solid var(--border)' : 'none',
                      fontSize: '0.8rem',
                    }}>
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <img
                          src={`https://images.evetech.net/characters/${m.character_id}/portrait?size=64`}
                          width={32} height={32}
                          style={{ borderRadius: '50%', display: 'block' }}
                        />
                        <div style={{
                          position: 'absolute', bottom: 0, right: 0,
                          width: 9, height: 9, borderRadius: '50%',
                          background: online ? 'var(--green)' : 'var(--border)',
                          border: '1.5px solid var(--surface)',
                        }} />
                      </div>
                      <span style={{ flex: 1 }}>{m.name}</span>
                      <span style={{
                        fontSize: '0.65rem', fontWeight: 600,
                        color: online ? 'var(--green)' : 'var(--text-dim)',
                      }}>
                        {online ? 'Online' : 'Offline'}
                      </span>
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
