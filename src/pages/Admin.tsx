import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'
import { useLayoutMode } from '../context/LayoutModeContext'
import { getCharacterInfo, getCorporation, getAlliance } from '../api/esi'
import EveImage from '../components/EveImage'

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

interface MemberOrg {
  corpId: number
  corpName: string
  allianceId?: number
  allianceName?: string
  allianceTicker?: string
}

interface MemberDetail {
  character_id: number
  name: string
  last_seen: string
  blocked: number
  total_logins: number
  first_login: string | null
  last_login: string | null
  recent_logins: string[]
  birthday?: string
  secStatus?: number
}

type SettingKey = 'maintenance_mode' | 'require_corp' | 'require_alliance' | 'local_chat'

const SETTING_LABELS: Record<SettingKey, string> = {
  maintenance_mode: 'Onderhoudsmodus',
  require_corp:     'Alleen Dutch Legions corp',
  require_alliance: 'Alleen Insidious alliance',
  local_chat:       'Local Chat zichtbaar voor members',
}

const PAGE_LABELS: Record<string, string> = {
  '/': 'Dashboard', '/overview': 'Overzicht', '/character': 'Character', '/wallet': 'Wallet',
  '/market': 'Market', '/kills': 'Kills', '/ratting': 'Ratting', '/hauling': 'Hauling',
  '/industry': 'Industry', '/mining': 'Mining', '/planets': 'Planets', '/mail': 'Mail',
  '/fittings': 'Fittings', '/skills': 'Skills', '/blueprints': 'Blueprints', '/contracts': 'Contracts',
  '/buildvsbuy': 'Build vs Buy', '/assets': 'Assets', '/notes': 'Notities', '/local': 'Local Chat', '/admin': 'Admin',
}

function fmtDT(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? String(s) : d.toLocaleString('nl', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function ageYears(birthday?: string): string {
  if (!birthday) return '—'
  const y = (Date.now() - new Date(birthday).getTime()) / (365.25 * 86400000)
  return isNaN(y) ? '—' : `${y.toFixed(1)} jr`
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
  const [pageStats, setPageStats] = useState<{ page: string; views: number; users: number }[]>([])
  const [members, setMembers] = useState<SiteMember[]>([])
  const [orgs, setOrgs] = useState<Record<number, MemberOrg>>({})
  const [detailMember, setDetailMember] = useState<SiteMember | null>(null)
  const [detail, setDetail] = useState<MemberDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [settings, setSettings] = useState<Record<SettingKey, boolean>>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)
  const [motdText, setMotdText] = useState('')
  const [motdEnabled, setMotdEnabled] = useState(false)
  const [motdSaved, setMotdSaved] = useState(false)
  const [bpCount, setBpCount] = useState<number | null | undefined>(undefined) // undefined=laden, null=fout
  const [sdeVer, setSdeVer] = useState<{ build: number | null; releaseDate: string | null; latest: number | null } | null>(null)

  useEffect(() => {
    if (tab === 'stats') fetchActivity()
    if (tab === 'members') fetchMembers()
    if (tab === 'settings') { fetchSettings(); fetchMotd() }
    if (tab === 'sde') fetchBpInfo()
  }, [tab])

  async function fetchMotd() {
    try {
      const d = await fetch('/api/motd.php', { cache: 'no-cache' }).then(r => r.json())
      setMotdText(d.text ?? '')
      setMotdEnabled(!!d.enabled)
    } catch { /* ignore */ }
  }

  async function saveMotd() {
    if (!adminToken) return
    await fetch('/api/motd.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: adminToken.characterId, text: motdText, enabled: motdEnabled }),
    }).catch(() => {})
    setMotdSaved(true); setTimeout(() => setMotdSaved(false), 2000)
  }

  async function fetchBpInfo() {
    try {
      const d = await fetch('/blueprints.json', { cache: 'no-cache' }).then(r => r.json()) as Record<string, unknown>
      setBpCount(Object.keys(d).length)
    } catch { setBpCount(null) }
    // Versie + live update-check
    const ver = await fetch('/sde-version.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null)
    let latest: number | null = null
    try {
      const txt = await fetch('https://developers.eveonline.com/static-data/tranquility/latest.jsonl').then(r => r.text())
      latest = JSON.parse(txt.trim().split('\n')[0]).buildNumber ?? null
    } catch { /* CORS/offline — geen live check */ }
    setSdeVer({ build: ver?.build ?? null, releaseDate: ver?.releaseDate ?? null, latest })
  }

  async function fetchActivity() {
    setLoading(true)
    try {
      const [act, pv] = await Promise.all([
        fetch('/api/activity.php').then(r => r.json()),
        fetch('/api/pageview.php').then(r => (r.ok ? r.json() : [])).catch(() => []),
      ])
      setActivity(act)
      setPageStats(Array.isArray(pv) ? pv : [])
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

  async function openDetail(m: SiteMember) {
    setDetailMember(m); setDetail(null); setDetailLoading(true)
    const [d, info] = await Promise.all([
      fetch(`/api/member.php?characterId=${m.character_id}`).then(r => r.ok ? r.json() : null).catch(() => null),
      getCharacterInfo(m.character_id).catch(() => null),
    ])
    setDetail(d ? { ...d, birthday: info?.birthday, secStatus: info?.security_status } : null)
    setDetailLoading(false)
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

            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.1em', margin: '1.5rem 0 0.75rem' }}>MEEST BEZOCHTE PAGINA'S — LAATSTE 30 DAGEN</div>
            <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '1rem' }}>
              {pageStats.length === 0 ? (
                <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center', padding: '1.5rem 0' }}>Nog geen paginadata verzameld.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  {pageStats.slice(0, 15).map(p => {
                    const max = pageStats[0].views || 1
                    return (
                      <div key={p.page} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span style={{ width: 92, fontSize: '0.68rem', color: 'var(--text)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {PAGE_LABELS[p.page] ?? p.page}
                        </span>
                        <div style={{ flex: 1, height: 14, background: 'rgba(255,255,255,0.04)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.max(2, (p.views / max) * 100)}%`, background: 'linear-gradient(90deg, var(--blue), #7dd3fc)', borderRadius: 2 }} />
                        </div>
                        <span style={{ width: 78, fontSize: '0.62rem', color: 'var(--text-dim)', textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                          {p.views} · {p.users}×👤
                        </span>
                      </div>
                    )
                  })}
                </div>
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
                    <div key={m.character_id}
                      onClick={() => openDetail(m)}
                      title="Klik voor details"
                      style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '0.65rem 1rem', cursor: 'pointer',
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
                            onClick={e => { e.stopPropagation(); toggleBlock(m) }}
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
                            onClick={e => { e.stopPropagation(); deleteMember(m.character_id) }}
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
            {/* Mededeling / MOTD */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.85rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>📢 Mededeling (banner voor members)</span>
                <div
                  onClick={() => setMotdEnabled(v => !v)}
                  title={motdEnabled ? 'Zichtbaar' : 'Verborgen'}
                  style={{ width: 40, height: 22, borderRadius: 11, cursor: 'pointer', background: motdEnabled ? 'var(--gold)' : 'var(--border)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}
                >
                  <div style={{ position: 'absolute', top: 3, left: motdEnabled ? 21 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                </div>
              </div>
              <textarea
                value={motdText}
                onChange={e => setMotdText(e.target.value)}
                placeholder="Bijv. 'Strat-op vanavond 20:00 EVE. Wees op tijd!'"
                rows={3}
                style={{ width: '100%', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.78rem', padding: '0.55rem', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem' }}>
                <span style={{ fontSize: '0.62rem', color: motdSaved ? 'var(--green)' : 'var(--text-dim)' }}>
                  {motdSaved ? '✓ Opgeslagen' : motdEnabled ? 'Zichtbaar voor alle members' : 'Verborgen'}
                </span>
                <button
                  onClick={saveMotd}
                  style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.3rem 0.85rem', cursor: 'pointer' }}
                >Opslaan</button>
              </div>
            </div>

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

        {/* SDE — blueprint-data wordt nu met de site meegeleverd (geen lokale server) */}
        {tab === 'sde' && (
          <div style={{ maxWidth: 460 }}>
            <div style={{
              background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
              borderLeft: `3px solid ${bpCount ? 'var(--green)' : bpCount === null ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 4, padding: '1.25rem 1.5rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', letterSpacing: '0.15em', fontWeight: 700 }}>STATIC DATA EXPORT</span>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: bpCount ? 'var(--green)' : bpCount === null ? 'var(--red)' : 'var(--text-dim)' }}>
                  {bpCount === undefined ? 'Laden…' : bpCount === null ? 'Niet gevonden' : '✓ Geladen'}
                </span>
              </div>

              {sdeVer?.build != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                    SDE build <strong style={{ color: 'var(--text)' }}>#{sdeVer.build}</strong>
                    {sdeVer.releaseDate && ` · ${new Date(sdeVer.releaseDate).toLocaleDateString('nl', { day: '2-digit', month: 'short', year: 'numeric' })}`}
                  </span>
                  {sdeVer.latest != null && sdeVer.latest > sdeVer.build ? (
                    <span style={{ fontSize: '0.62rem', background: 'rgba(240,192,64,0.15)', border: '1px solid rgba(240,192,64,0.4)', color: 'var(--gold)', borderRadius: 2, padding: '0.05rem 0.4rem', fontWeight: 700 }}>
                      update beschikbaar (#{sdeVer.latest})
                    </span>
                  ) : sdeVer.latest != null ? (
                    <span style={{ fontSize: '0.62rem', color: 'var(--green)', fontWeight: 600 }}>✓ actueel</span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* Member-detail modal */}
      {detailMember && (() => {
        const m = detailMember
        const org = orgs[m.character_id]
        const Stat = ({ label, value, color }: { label: string; value: string; color?: string }) => (
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.5rem 0.65rem' }}>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: '0.2rem' }}>{label}</div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
          </div>
        )
        return (
          <div onClick={() => setDetailMember(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }}>
              <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <img src={`https://images.evetech.net/characters/${m.character_id}/portrait?size=64`} width={48} height={48} style={{ borderRadius: '50%', display: 'block' }} />
                  {org?.corpId && (
                    <EveImage category="corporations" id={org.corpId} variation="logo" size={32} px={18}
                      style={{ position: 'absolute', bottom: -2, right: -2, borderRadius: 2, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                  {org && (
                    <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {org.corpName}{org.allianceName && <span style={{ color: 'var(--gold)' }}> · {org.allianceName}</span>}
                    </div>
                  )}
                </div>
                <button onClick={() => setDetailMember(null)} aria-label="Sluiten" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1, flexShrink: 0 }}>×</button>
              </div>

              <div style={{ padding: '1rem 1.25rem' }}>
                {detailLoading && <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>Laden…</div>}
                {!detailLoading && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                      <Stat label="STATUS" value={m.blocked ? 'Geblokkeerd' : isOnline(m.last_seen) ? 'Online' : 'Offline'} color={m.blocked ? 'var(--red)' : isOnline(m.last_seen) ? 'var(--green)' : 'var(--text-dim)'} />
                      <Stat label="TOTAAL LOGINS" value={String(detail?.total_logins ?? 0)} />
                      <Stat label="LAATST GEZIEN" value={fmtDT(m.last_seen)} />
                      <Stat label="EERSTE LOGIN" value={fmtDT(detail?.first_login)} />
                      <Stat label="SECURITY" value={detail?.secStatus != null ? detail.secStatus.toFixed(2) : '—'} color={detail?.secStatus != null ? (detail.secStatus >= 0 ? 'var(--green)' : 'var(--red)') : undefined} />
                      <Stat label="CHAR-LEEFTIJD" value={ageYears(detail?.birthday)} />
                    </div>

                    {detail?.recent_logins && detail.recent_logins.length > 0 && (
                      <div style={{ marginTop: '1rem' }}>
                        <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: '0.4rem' }}>RECENTE LOGINS</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {detail.recent_logins.slice(0, 14).map((t, i) => (
                            <span key={i} style={{ fontSize: '0.6rem', background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.2)', color: 'var(--blue)', borderRadius: 2, padding: '0.1rem 0.35rem', whiteSpace: 'nowrap' }}>
                              {new Date(t).toLocaleDateString('nl', { day: '2-digit', month: 'short' })}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                      <a href={`https://zkillboard.com/character/${m.character_id}/`} target="_blank" rel="noreferrer" style={{ fontSize: '0.68rem', color: 'var(--blue)', textDecoration: 'none', border: '1px solid rgba(0,180,216,0.25)', borderRadius: 3, padding: '0.3rem 0.6rem' }}>zKillboard ↗</a>
                      <a href={`https://evewho.com/character/${m.character_id}`} target="_blank" rel="noreferrer" style={{ fontSize: '0.68rem', color: 'var(--blue)', textDecoration: 'none', border: '1px solid rgba(0,180,216,0.25)', borderRadius: 3, padding: '0.3rem 0.6rem' }}>EVE Who ↗</a>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </Layout>
  )
}
