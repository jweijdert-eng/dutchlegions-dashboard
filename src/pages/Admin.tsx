import { useEffect, useRef, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'
import { useLayoutMode } from '../context/LayoutModeContext'
import { getCharacterInfo, getCorporation, getAlliance } from '../api/esi'
import EveImage from '../components/EveImage'
import { fetchSiteConfig, applyAccent, type CorpLink, type JumpBridge } from '../hooks/useSiteConfig'
import { useMemberSettings, setMemberSettings } from '../utils/memberSettings'
import { DEFAULT_INTEL_CHANNELS, type IntelChannel } from '../utils/intelChannels'

const ADMIN_CHAR_ID = 1831618559
const ROLE_COLOR: Record<string, string> = { admin: '#e05555', recruiter: 'var(--blue)', member: 'var(--text-dim)' }

const ACCENTS = [
  { hex: '#00b4d8', name: 'Blauw' },  { hex: '#22d3ee', name: 'Cyaan' },
  { hex: '#14b8a6', name: 'Teal' },   { hex: '#3ecf6e', name: 'Groen' },
  { hex: '#84cc16', name: 'Lime' },   { hex: '#f0c040', name: 'Goud' },
  { hex: '#f97316', name: 'Oranje' }, { hex: '#e05555', name: 'Rood' },
  { hex: '#f472b6', name: 'Roze' },   { hex: '#ec4899', name: 'Magenta' },
  { hex: '#a78bfa', name: 'Paars' },  { hex: '#6366f1', name: 'Indigo' },
]

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
  allowed?: number
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

type MotdType = 'info' | 'warning' | 'success' | 'event'
const MOTD_TYPES: { key: MotdType; label: string; icon: string; rgb: string }[] = [
  { key: 'info',    label: 'Info',          icon: '📢',  rgb: '0,180,216' },
  { key: 'warning', label: 'Waarschuwing',  icon: '⚠️', rgb: '240,192,64' },
  { key: 'success', label: 'Succes',        icon: '✓',   rgb: '62,207,110' },
  { key: 'event',   label: 'Event',         icon: '📅',  rgb: '167,139,250' },
]

interface SettingMeta { label: string; desc: string; icon: string; group: 'access' | 'features'; danger?: boolean }
const SETTING_META: Record<SettingKey, SettingMeta> = {
  maintenance_mode: { label: 'Onderhoudsmodus',                 desc: 'Sluit de site af voor members — alleen admins hebben toegang.', icon: '🛠️', group: 'access', danger: true },
  require_corp:     { label: 'Alleen Dutch Legions corp',       desc: 'Alleen leden van de corporatie kunnen inloggen.',               icon: '🪪', group: 'access' },
  require_alliance: { label: 'Alleen Insidious alliance',       desc: 'Alleen leden van de alliantie kunnen inloggen.',                icon: '🤝', group: 'access' },
  local_chat:       { label: 'Local Chat zichtbaar voor members', desc: 'Toont het Local Chat-menu-item in de zijbalk voor members.',  icon: '💬', group: 'features' },
}
const SETTING_GROUPS: { key: 'access' | 'features'; label: string }[] = [
  { key: 'access',   label: 'Toegang & beveiliging' },
  { key: 'features', label: 'Functies' },
]

const PAGE_LABELS: Record<string, string> = {
  '/': 'Dashboard', '/overview': 'Overzicht', '/character': 'Character', '/wallet': 'Wallet',
  '/market': 'Market', '/kills': 'Kills', '/fleet': 'Fleet', '/ratting': 'Ratting', '/hauling': 'Hauling',
  '/industry': 'Industry', '/mining': 'Mining', '/planets': 'Planets', '/mail': 'Mail',
  '/fittings': 'Fittings', '/skills': 'Skills', '/blueprints': 'Blueprints', '/contracts': 'Contracts',
  '/buildvsbuy': 'Build vs Buy', '/assets': 'Assets', '/notes': 'Notities', '/local': 'Local Chat', '/admin': 'Admin',
}

function fmtDT(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? String(s) : d.toLocaleString('nl', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
// Relatieve "X geleden" voor de laatst-gezien-weergave in de ledenlijst.
function fmtAgo(s: string | null | undefined): string {
  if (!s) return 'nooit'
  const ms = Date.now() - new Date(s).getTime()
  if (isNaN(ms)) return '—'
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'net nu'
  if (min < 60) return `${min}m geleden`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}u geleden`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d geleden`
  const mo = Math.floor(d / 30)
  return mo < 12 ? `${mo}mnd geleden` : `${Math.floor(mo / 12)}j geleden`
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

function Toggle({ on, onClick, rgb = '0,180,216' }: { on: boolean; onClick: () => void; rgb?: string }) {
  return (
    <div
      onClick={onClick}
      role="switch"
      aria-checked={on}
      style={{
        width: 40, height: 22, borderRadius: 11, cursor: 'pointer', flexShrink: 0,
        background: on ? `rgb(${rgb})` : 'var(--border)',
        boxShadow: on ? `0 0 10px -2px rgba(${rgb},0.7)` : 'none',
        position: 'relative', transition: 'background 0.2s, box-shadow 0.2s',
      }}
    >
      <div style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
    </div>
  )
}

export default function Admin() {
  const { tokens } = useAuth()
  const { previewMode, setPreviewMode } = useLayoutMode()
  const adminToken = tokens.find(t => t.characterId === ADMIN_CHAR_ID)
  const [tab, setTab] = useState<'stats' | 'members' | 'settings' | 'sde' | 'chat'>('stats')
  const [chatThreads, setChatThreads] = useState<{ thread: string; name: string; last_at: string; staff_unread: number; last_msg: string | null }[]>([])
  const member = useMemberSettings()
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [threadMsgs, setThreadMsgs] = useState<{ id: number; sender: string; staff_name?: string; message: string; created_at: string }[]>([])
  const [replyText, setReplyText] = useState('')
  const activeThreadRef = useRef<string | null>(null)
  activeThreadRef.current = activeThread
  const [activity, setActivity] = useState<ActivityData | null>(null)
  const [pageStats, setPageStats] = useState<{ page: string; views: number; users: number }[]>([])
  const [members, setMembers] = useState<SiteMember[]>([])
  const [roles, setRoles] = useState<Record<number, string>>({})   // character_id → rol
  const [allowName, setAllowName] = useState('')
  const [allowMsg, setAllowMsg] = useState('')
  const [allowedOrgs, setAllowedOrgs] = useState<{ org_id: number; type: string; name: string }[]>([])
  const [orgName, setOrgName] = useState('')
  const [orgMsg, setOrgMsg] = useState('')
  const [orgs, setOrgs] = useState<Record<number, MemberOrg>>({})
  const [detailMember, setDetailMember] = useState<SiteMember | null>(null)
  const [detail, setDetail] = useState<MemberDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [settings, setSettings] = useState<Record<SettingKey, boolean>>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)
  const [motdText, setMotdText] = useState('')
  const [motdEnabled, setMotdEnabled] = useState(false)
  const [motdType, setMotdType] = useState<MotdType>('info')
  const [motdUntil, setMotdUntil] = useState('')
  const [motdLink, setMotdLink] = useState('')
  const [motdSaved, setMotdSaved] = useState(false)
  const [accent, setAccent] = useState('')
  const [links, setLinks] = useState<CorpLink[]>([])
  const [bridges, setBridges] = useState<JumpBridge[]>([])
  const [bridgePaste, setBridgePaste] = useState('')
  const [bridgesOpen, setBridgesOpen] = useState(false)
  const [intelChannels, setIntelChannels] = useState<IntelChannel[]>([])
  const [intelOpen, setIntelOpen] = useState(false)
  const [cfgSaved, setCfgSaved] = useState(false)
  const [bpCount, setBpCount] = useState<number | null | undefined>(undefined) // undefined=laden, null=fout
  const [sdeVer, setSdeVer] = useState<{ build: number | null; releaseDate: string | null; latest: number | null } | null>(null)
  const [hasPat, setHasPat] = useState(false)
  const [patInput, setPatInput] = useState('')
  const [showPatField, setShowPatField] = useState(false)
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updatePct, setUpdatePct] = useState(0)
  const [updateStart, setUpdateStart] = useState(0)

  useEffect(() => {
    if (tab === 'stats') fetchActivity()
    if (tab === 'members') fetchMembers()
    if (tab === 'settings') { fetchSettings(); fetchMotd(); loadSiteConfig() }
    if (tab === 'sde') fetchBpInfo()
  }, [tab])

  // Recruiter-chat: poll gesprekken (+ open thread) zolang de chat-tab actief is
  useEffect(() => {
    if (tab !== 'chat' || !adminToken) return
    fetchChatThreads()
    const id = setInterval(() => {
      fetchChatThreads()
      if (activeThreadRef.current) refreshThreadMsgs(activeThreadRef.current)
    }, 5000)
    return () => clearInterval(id)
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchChatThreads() {
    if (!adminToken) return
    try { const r = await fetch(`/api/pmchat.php?action=threads&adminCharId=${adminToken.characterId}`, { cache: 'no-cache' }); const j = await r.json(); if (Array.isArray(j)) setChatThreads(j) }
    catch { /* ignore */ }
  }

  async function refreshThreadMsgs(thread: string) {
    if (!adminToken) return
    try { const r = await fetch(`/api/pmchat.php?action=messages&thread=${thread}&adminCharId=${adminToken.characterId}`, { cache: 'no-cache' }); const j = await r.json(); if (Array.isArray(j)) setThreadMsgs(j) }
    catch { /* ignore */ }
  }

  async function openThread(thread: string) {
    setActiveThread(thread)
    setChatThreads(prev => prev.map(t => t.thread === thread ? { ...t, staff_unread: 0 } : t))
    await refreshThreadMsgs(thread)
  }

  async function sendReply() {
    if (!adminToken || !activeThread) return
    const msg = replyText.trim()
    if (!msg) return
    setReplyText('')
    await fetch('/api/pmchat.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reply', adminCharId: adminToken.characterId, staff_name: adminToken.characterName, thread: activeThread, message: msg }),
    }).catch(() => {})
    refreshThreadMsgs(activeThread)
  }

  async function deleteThread(thread: string) {
    if (!adminToken || !confirm('Dit gesprek definitief verwijderen?')) return
    await fetch('/api/pmchat.php', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminCharId: adminToken.characterId, thread }),
    }).catch(() => {})
    if (activeThread === thread) { setActiveThread(null); setThreadMsgs([]) }
    fetchChatThreads()
  }

  async function fetchMotd() {
    try {
      const d = await fetch('/api/motd.php', { cache: 'no-cache' }).then(r => r.json())
      setMotdText(d.text ?? '')
      setMotdEnabled(!!d.enabled)
      setMotdType(d.type ?? 'info')
      setMotdUntil(d.until ?? '')
      setMotdLink(d.link ?? '')
    } catch { /* ignore */ }
  }

  async function saveMotd() {
    if (!adminToken) return
    await fetch('/api/motd.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: adminToken.characterId, text: motdText, enabled: motdEnabled, type: motdType, until: motdUntil, link: motdLink }),
    }).catch(() => {})
    setMotdSaved(true); setTimeout(() => setMotdSaved(false), 2000)
  }

  async function loadSiteConfig() {
    try {
      const d = await fetch('/api/siteconfig.php', { cache: 'no-cache' }).then(r => r.json())
      setAccent(d.accent ?? '')
      setLinks(Array.isArray(d.links) ? d.links : [])
      setBridges(Array.isArray(d.bridges) ? d.bridges.filter((b: unknown) => Array.isArray(b) && b.length === 2) : [])
      setIntelChannels(Array.isArray(d.intelChannels) ? d.intelChannels.filter((c: IntelChannel) => c?.prefix?.trim()) : [])
    } catch { /* ignore */ }
  }

  // Sla alleen de meegegeven onderdelen op (partial). De server werkt enkel de
  // aanwezige keys bij, zodat een accent-/links-save nooit de bridges/intel wist.
  async function saveSiteConfig(patch: Partial<{ accent: string; links: CorpLink[]; bridges: JumpBridge[]; intelChannels: IntelChannel[] }>) {
    if (!adminToken) return
    const body: Record<string, unknown> = { characterId: adminToken.characterId }
    if (patch.accent !== undefined) body.accent = patch.accent
    if (patch.links !== undefined) body.links = patch.links.filter(l => l.label.trim() && /^https?:\/\//i.test(l.url.trim()))
    if (patch.bridges !== undefined) body.bridges = patch.bridges.filter(b => b[0]?.trim() && b[1]?.trim())
    if (patch.intelChannels !== undefined) body.intelChannels = patch.intelChannels.filter(c => c.prefix.trim()).map(c => ({ prefix: c.prefix.trim(), label: c.label.trim() }))
    await fetch('/api/siteconfig.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
    if (patch.accent !== undefined) applyAccent(patch.accent)   // direct site-breed toepassen
    fetchSiteConfig(true)          // module-cache verversen voor de rest van de app
    setCfgSaved(true); setTimeout(() => setCfgSaved(false), 2000)
  }

  function pickAccent(hex: string) {
    setAccent(hex)
    applyAccent(hex)               // live preview
    saveSiteConfig({ accent: hex })
  }

  // Bulk-plak: één bridge per regel. Scheider tussen de twee systemen mag »/›/→/↔/->/|/,/;/tab
  // of gewoon een spatie; een trailing " - Ansiblex Jump Gate" wordt weggeknipt.
  function parseBridgePaste(text: string): JumpBridge[] {
    const seen = new Set<string>()
    const out: JumpBridge[] = []
    for (let line of text.split(/\r?\n/)) {
      line = line.trim().replace(/\s*[-–—]\s*ansiblex.*$/i, '').trim()
      if (!line) continue
      let parts = line.split(/\s*(?:»|›|→|↔|<->|->|=>|\||\t|,|;)\s*/).filter(Boolean)
      if (parts.length < 2) parts = line.split(/\s+/).filter(Boolean)   // val terug op spatie
      if (parts.length < 2) continue
      const a = parts[0].trim().toUpperCase(), b = parts[1].trim().toUpperCase()
      if (!a || !b || a === b) continue
      const key = [a, b].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key); out.push([a, b])
    }
    return out
  }

  // Verwerk de plaktekst → voeg toe aan de bestaande lijst (deduped) en sla op.
  function applyBridgePaste() {
    const parsed = parseBridgePaste(bridgePaste)
    if (!parsed.length) return
    const seen = new Set(bridges.map(b => [b[0].toUpperCase(), b[1].toUpperCase()].sort().join('|')))
    const merged = [...bridges]
    for (const p of parsed) {
      const key = [p[0], p[1]].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key); merged.push(p)
    }
    setBridges(merged)
    setBridgePaste('')
    saveSiteConfig({ bridges: merged })
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
    fetch('/api/sde-trigger.php').then(r => (r.ok ? r.json() : null)).then(d => setHasPat(!!d?.hasPat)).catch(() => {})
  }

  async function savePat() {
    if (!adminToken || !patInput.trim()) return
    await fetch('/api/sde-trigger.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: adminToken.characterId, action: 'save', pat: patInput.trim() }),
    }).catch(() => {})
    setHasPat(true); setShowPatField(false); setPatInput('')
  }

  async function runUpdate() {
    if (!adminToken || updating) return
    if (!hasPat) { setShowPatField(true); return }
    setTriggerMsg(null)
    const r = await fetch('/api/sde-trigger.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: adminToken.characterId, action: 'run' }),
    }).then(r => r.json()).catch(() => ({ error: 'netwerkfout' }))
    if (r.ok) {
      setUpdateStart(Date.now()); setUpdatePct(3); setUpdating(true)
    } else {
      setTriggerMsg(`Mislukt: ${r.error ?? ''}`); setTimeout(() => setTriggerMsg(null), 6000)
    }
  }

  // Poll de workflow-status terwijl de update loopt (voedt de laadbalk)
  useEffect(() => {
    if (!updating || !adminToken) return
    let alive = true
    const tick = async () => {
      if (!alive) return
      const elapsed = (Date.now() - updateStart) / 1000
      setUpdatePct(p => Math.min(95, Math.max(p, Math.round((elapsed / 130) * 100))))
      const r = await fetch('/api/sde-trigger.php', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: adminToken.characterId, action: 'status' }),
      }).then(res => res.json()).catch(() => null)
      if (!alive) return
      const fresh = r?.created_at && new Date(r.created_at).getTime() >= updateStart - 20000
      if (fresh && r.status === 'completed') {
        setUpdating(false); setUpdatePct(100)
        setTriggerMsg(r.conclusion === 'success' ? '✓ Klaar! Ververs de pagina voor de nieuwe data.' : `CI mislukt (${r.conclusion ?? '?'})`)
        if (r.conclusion === 'success') fetchBpInfo()
      } else if (elapsed > 360) {
        setUpdating(false); setTriggerMsg('Time-out — check GitHub Actions.')
      }
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating, updateStart, adminToken])

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
      fetchAllowedOrgs()
      fetchRoles()
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function fetchRoles() {
    if (!adminToken) return
    try {
      const r = await fetch(`/api/roles.php?token=${encodeURIComponent(adminToken.accessToken)}`)
      const j = await r.json()
      const map: Record<number, string> = {}
      for (const x of j?.roles ?? []) map[Number(x.character_id)] = x.role
      setRoles(map)
    } catch { /* ignore */ }
  }

  async function setMemberRole(m: SiteMember, role: string) {
    if (!adminToken) return
    setRoles(prev => { const n = { ...prev }; if (role === 'member') delete n[m.character_id]; else n[m.character_id] = role; return n })
    await fetch(`/api/roles.php?token=${encodeURIComponent(adminToken.accessToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: m.character_id, name: m.name, role }),
    }).catch(() => {})
  }

  async function refreshMembers() {
    try {
      const r = await fetch('/api/members.php')
      const list = await r.json() as SiteMember[]
      setMembers(list)
      fetchMemberOrgs(list)
    } catch { /* ignore */ }
  }

  async function fetchAllowedOrgs() {
    try { const r = await fetch('/api/access_orgs.php'); setAllowedOrgs(await r.json()) } catch { /* ignore */ }
  }

  // Hele corp/alliance op de allowlist zetten (op naam)
  async function addOrgByName() {
    if (!adminToken) return
    const name = orgName.trim()
    if (!name) return
    setOrgMsg('Zoeken…')
    try {
      const r = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([name]),
      })
      const j = await r.json().catch(() => null)
      const corp = j?.corporations?.[0]
      const ally = j?.alliances?.[0]
      const pick = corp ? { id: corp.id, name: corp.name, type: 'corp' }
                 : ally ? { id: ally.id, name: ally.name, type: 'alliance' } : null
      if (!pick) { setOrgMsg(`Geen corp of alliance gevonden voor "${name}".`); return }
      await fetch('/api/access_orgs.php', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminCharId: adminToken.characterId, action: 'add', orgId: pick.id, orgType: pick.type, name: pick.name }),
      })
      setOrgMsg(`${pick.name} (${pick.type}) toegevoegd aan de allowlist.`)
      setOrgName('')
      fetchAllowedOrgs()
    } catch { setOrgMsg('Er ging iets mis bij het toevoegen.') }
  }

  async function removeOrg(orgId: number) {
    if (!adminToken) return
    setAllowedOrgs(prev => prev.filter(o => o.org_id !== orgId))
    await fetch('/api/access_orgs.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminCharId: adminToken.characterId, action: 'remove', orgId }),
    }).catch(() => {})
    fetchAllowedOrgs()
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

  // Allowlist: laat een character (alt/vriend) de corp/alliance-eis omzeilen
  async function toggleAllow(member: SiteMember) {
    if (!adminToken || member.character_id === ADMIN_CHAR_ID) return
    const action = member.allowed === 1 ? 'disallow' : 'allow'
    setMembers(prev => prev.map(m => m.character_id === member.character_id ? { ...m, allowed: member.allowed === 1 ? 0 : 1 } : m))
    await fetch('/api/members.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminCharId: adminToken.characterId, characterId: member.character_id, action }),
    }).catch(() => {})
    await refreshMembers()
  }

  // Allowlist: voeg een character toe op naam (ook als die nog nooit heeft ingelogd)
  async function addAllowByName() {
    if (!adminToken) return
    const name = allowName.trim()
    if (!name) return
    setAllowMsg('Zoeken…')
    try {
      const r = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([name]),
      })
      const j = await r.json().catch(() => null)
      const c = j?.characters?.[0]
      if (!c) { setAllowMsg(`Character "${name}" niet gevonden.`); return }
      await fetch('/api/members.php', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminCharId: adminToken.characterId, characterId: c.id, name: c.name, action: 'allow' }),
      })
      setAllowMsg(`${c.name} op de allowlist gezet.`)
      setAllowName('')
      await refreshMembers()
    } catch { setAllowMsg('Er ging iets mis bij het toevoegen.') }
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
          <button style={TAB_STYLE(tab === 'chat')}     onClick={() => setTab('chat')}>Recruiter Chat</button>
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
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 480px', maxWidth: 580 }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.75rem', letterSpacing: '0.08em' }}>
              {members.length} LEDEN — automatisch bijgewerkt bij inloggen
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              <input
                value={allowName}
                onChange={e => { setAllowName(e.target.value); setAllowMsg('') }}
                onKeyDown={e => { if (e.key === 'Enter') addAllowByName() }}
                placeholder="Character-naam op allowlist zetten…"
                style={{ flex: '1 1 220px', minWidth: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
              />
              <button
                onClick={addAllowByName}
                style={{ padding: '0.4rem 0.8rem', fontSize: '0.72rem', fontWeight: 600, border: '1px solid rgba(240,192,64,0.4)', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--gold)' }}
              >
                + Allowlist
              </button>
            </div>
            {allowMsg && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>{allowMsg}</div>}

            <div style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '0.7rem 0.8rem', marginBottom: '1rem', background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>
                TOEGESTANE CORPS / ALLIANCES — iedereen hieruit mag inloggen
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={orgName}
                  onChange={e => { setOrgName(e.target.value); setOrgMsg('') }}
                  onKeyDown={e => { if (e.key === 'Enter') addOrgByName() }}
                  placeholder="Corp- of alliance-naam…"
                  style={{ flex: '1 1 220px', minWidth: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
                />
                <button
                  onClick={addOrgByName}
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.72rem', fontWeight: 600, border: '1px solid rgba(0,180,216,0.4)', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--blue)' }}
                >
                  + Toevoegen
                </button>
              </div>
              {orgMsg && <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>{orgMsg}</div>}
              {allowedOrgs.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
                  {allowedOrgs.map(o => (
                    <span key={o.org_id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: 12, padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}>
                      <img src={`https://images.evetech.net/${o.type === 'alliance' ? 'alliances' : 'corporations'}/${o.org_id}/logo?size=32`} width={16} height={16} style={{ borderRadius: 2 }} />
                      {o.name || `#${o.org_id}`}
                      <span style={{ color: 'var(--text-dim)', fontSize: '0.58rem' }}>{o.type === 'alliance' ? 'alliance' : 'corp'}</span>
                      <button onClick={() => removeOrg(o.org_id)} title="Verwijderen" style={{ background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: '0.75rem', padding: 0, lineHeight: 1 }}>✕</button>
                    </span>
                  ))}
                </div>
              )}
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
                  const isOwner = m.character_id === ADMIN_CHAR_ID
                  const memRole = isOwner ? 'admin' : (roles[m.character_id] ?? 'member')
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
                      {memRole !== 'member' && (
                        <span title={isOwner ? 'Eigenaar — altijd admin' : `Rol: ${memRole}`} style={{ fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.12rem 0.4rem', borderRadius: 3, color: ROLE_COLOR[memRole] ?? 'var(--gold)', border: `1px solid ${ROLE_COLOR[memRole] ?? 'var(--gold)'}`, whiteSpace: 'nowrap' }}>
                          {isOwner ? '👑 owner' : memRole}
                        </span>
                      )}
                      {blocked && (
                        <span style={{ fontSize: '0.6rem', color: 'var(--red)', fontWeight: 700, letterSpacing: '0.06em' }}>GEBLOKKEERD</span>
                      )}
                      {!blocked && m.allowed === 1 && (
                        <span title="Op de allowlist — mag inloggen ongeacht corp/alliance" style={{ fontSize: '0.6rem', color: 'var(--gold)', fontWeight: 700, letterSpacing: '0.06em' }}>✓ ALLOWLIST</span>
                      )}
                      {!blocked && (
                        <span title={m.last_seen ? `Laatst gezien: ${fmtDT(m.last_seen)}` : 'Nog nooit ingelogd'}
                          style={{ fontSize: '0.65rem', fontWeight: 600, color: online ? 'var(--green)' : 'var(--text-dim)', whiteSpace: 'nowrap', textAlign: 'right', minWidth: 78 }}>
                          {online ? '● Online' : fmtAgo(m.last_seen)}
                        </span>
                      )}
                      {m.character_id !== ADMIN_CHAR_ID && (
                        <>
                          <select
                            value={memRole}
                            onClick={e => e.stopPropagation()}
                            onChange={e => { e.stopPropagation(); setMemberRole(m, e.target.value) }}
                            title="Rol toewijzen"
                            style={{ padding: '0.2rem 0.3rem', fontSize: '0.65rem', fontWeight: 600, borderRadius: 3, cursor: 'pointer', background: 'var(--surface)', border: `1px solid ${ROLE_COLOR[memRole] ?? 'var(--border)'}`, color: ROLE_COLOR[memRole] ?? 'var(--text)' }}
                          >
                            <option value="member">Member</option>
                            <option value="recruiter">Recruiter</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button
                            onClick={e => { e.stopPropagation(); toggleAllow(m) }}
                            title={m.allowed === 1 ? 'Van allowlist halen' : 'Op allowlist zetten (mag inloggen ongeacht corp/alliance)'}
                            style={{
                              padding: '0.2rem 0.5rem', fontSize: '0.65rem', fontWeight: 600,
                              border: `1px solid ${m.allowed === 1 ? 'rgba(240,192,64,0.4)' : 'rgba(255,255,255,0.15)'}`,
                              borderRadius: 3, cursor: 'pointer', background: 'transparent',
                              color: m.allowed === 1 ? 'var(--gold)' : 'var(--text-dim)',
                            }}
                          >
                            {m.allowed === 1 ? 'Allowlist ✓' : 'Toegang'}
                          </button>
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

          {/* Corp / alliance-tellingen */}
          {members.length > 0 && (() => {
            const corpMap = new Map<number, { name: string; count: number }>()
            const allyMap = new Map<number, { name: string; count: number }>()
            let unknown = 0
            for (const m of members) {
              const o = orgs[m.character_id]
              if (!o) { unknown++; continue }
              if (o.corpId) { const c = corpMap.get(o.corpId) ?? { name: o.corpName, count: 0 }; c.count++; corpMap.set(o.corpId, c) }
              if (o.allianceId) { const a = allyMap.get(o.allianceId) ?? { name: o.allianceName ?? 'Alliance', count: 0 }; a.count++; allyMap.set(o.allianceId, a) }
            }
            const corps  = [...corpMap.entries()].sort((a, b) => b[1].count - a[1].count)
            const allies = [...allyMap.entries()].sort((a, b) => b[1].count - a[1].count)
            const row = (cat: 'corporations' | 'alliances', id: number, name: string, count: number) => (
              <div key={`${cat}-${id}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.6rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <EveImage category={cat} id={id} variation="logo" size={32} px={20} style={{ borderRadius: 2, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--blue)' }}>{count}</span>
              </div>
            )
            return (
              <div style={{ flex: '0 0 250px', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', background: 'var(--surface)' }}>
                <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--gold)', padding: '0.5rem 0.6rem', borderBottom: '1px solid var(--border)', background: 'rgba(240,192,64,0.06)' }}>
                  PER ALLIANCE ({allies.length})
                </div>
                {allies.length ? allies.map(([id, v]) => row('alliances', id, v.name, v.count))
                  : <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', padding: '0.5rem 0.6rem' }}>—</div>}
                <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--blue)', padding: '0.5rem 0.6rem', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'rgba(0,180,216,0.06)' }}>
                  PER CORP ({corps.length})
                </div>
                {corps.length ? corps.map(([id, v]) => row('corporations', id, v.name, v.count))
                  : <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', padding: '0.5rem 0.6rem' }}>—</div>}
                {unknown > 0 && (
                  <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', borderTop: '1px solid var(--border)' }}>
                    {unknown} nog niet geladen…
                  </div>
                )}
              </div>
            )
          })()}
          </div>
        )}

        {/* Site Instellingen */}
        {tab === 'settings' && !loading && (() => {
          const motdStyle = MOTD_TYPES.find(t => t.key === motdType) ?? MOTD_TYPES[0]
          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 520 }}>
            {/* Mededeling / MOTD */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem 1.1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.7rem' }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>📢 Mededeling (MOTD)</div>
                  <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>Banner bovenaan voor alle members.</div>
                </div>
                <Toggle on={motdEnabled} onClick={() => setMotdEnabled(v => !v)} rgb={motdStyle.rgb} />
              </div>

              {/* Type-kiezer (kleur van de banner) */}
              <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                {MOTD_TYPES.map(t => {
                  const active = motdType === t.key
                  return (
                    <button key={t.key} onClick={() => setMotdType(t.key)} style={{
                      display: 'flex', alignItems: 'center', gap: '0.3rem',
                      padding: '0.25rem 0.6rem', borderRadius: 20, cursor: 'pointer', fontSize: '0.68rem', fontWeight: 600,
                      background: active ? `rgba(${t.rgb},0.18)` : 'transparent',
                      border: `1px solid ${active ? `rgb(${t.rgb})` : 'var(--border)'}`,
                      color: active ? `rgb(${t.rgb})` : 'var(--text-dim)',
                    }}>
                      <span>{t.icon}</span>{t.label}
                    </button>
                  )
                })}
              </div>

              <textarea
                value={motdText}
                onChange={e => setMotdText(e.target.value)}
                placeholder="Bijv. 'Strat-op vanavond 20:00 EVE. Wees op tijd!'"
                rows={3}
                style={{ width: '100%', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.78rem', padding: '0.55rem', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
              />

              {/* Live preview van de banner */}
              {motdText.trim() && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem',
                  padding: '0.5rem 0.75rem', borderRadius: 3, fontSize: '0.74rem',
                  background: `linear-gradient(90deg, rgba(${motdStyle.rgb},0.16), rgba(${motdStyle.rgb},0.05))`,
                  border: `1px solid rgba(${motdStyle.rgb},0.4)`,
                }}>
                  <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em', flexShrink: 0 }}>VOORBEELD</span>
                  <span>{motdStyle.icon}</span>
                  <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{motdText}</span>
                </div>
              )}

              {/* Verloopt op + link */}
              <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
                <label style={{ flex: '1 1 150px', fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.08em' }}>
                  VERLOOPT OP (optioneel)
                  <input
                    type="datetime-local"
                    value={motdUntil}
                    onChange={e => setMotdUntil(e.target.value)}
                    style={{ display: 'block', width: '100%', marginTop: '0.25rem', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                </label>
                <label style={{ flex: '1 1 180px', fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.08em' }}>
                  LINK (optioneel, 'Bekijk →')
                  <input
                    type="url"
                    value={motdLink}
                    onChange={e => setMotdLink(e.target.value)}
                    placeholder="https://discord.gg/..."
                    style={{ display: 'block', width: '100%', marginTop: '0.25rem', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.65rem' }}>
                <span style={{ fontSize: '0.62rem', color: motdSaved ? 'var(--green)' : 'var(--text-dim)' }}>
                  {motdSaved ? '✓ Opgeslagen' : motdUntil ? `Verloopt ${new Date(motdUntil).toLocaleString('nl', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : motdEnabled ? 'Zichtbaar voor alle members' : 'Verborgen'}
                </span>
                <button
                  onClick={saveMotd}
                  style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.95rem', cursor: 'pointer' }}
                >Opslaan</button>
              </div>
            </div>

            {/* Thema / accentkleur */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem 1.1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>🎨 Accentkleur</span>
                <span style={{ fontSize: '0.66rem', fontFamily: 'monospace', color: 'var(--text-dim)' }}>{(accent || '#00b4d8').toUpperCase()}</span>
              </div>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginBottom: '0.7rem' }}>De accentkleur van de hele site (voor iedereen). Kies een preset of een eigen kleur.</div>
              <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {ACCENTS.map(a => {
                  const active = (accent || '#00b4d8').toLowerCase() === a.hex
                  return (
                    <button key={a.hex} onClick={() => pickAccent(a.hex)} title={a.name} style={{
                      width: 30, height: 30, borderRadius: '50%', cursor: 'pointer', background: a.hex,
                      border: active ? '2px solid #fff' : '2px solid transparent',
                      boxShadow: active ? `0 0 10px -1px ${a.hex}` : 'none', transition: 'box-shadow 0.15s',
                    }} />
                  )
                })}
                {/* Eigen kleur via native color-picker */}
                <label title="Eigen kleur" style={{
                  width: 30, height: 30, borderRadius: '50%', cursor: 'pointer', position: 'relative', overflow: 'hidden',
                  border: '2px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)',
                }}>
                  <span style={{ fontSize: '0.85rem', color: '#fff', textShadow: '0 0 3px #000', lineHeight: 1 }}>+</span>
                  <input type="color" value={accent || '#00b4d8'} onChange={e => pickAccent(e.target.value)}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', border: 'none', padding: 0 }} />
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.7rem' }}>
                <button onClick={() => pickAccent('')} style={{
                  background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)',
                  fontSize: '0.66rem', padding: '0.25rem 0.6rem', cursor: 'pointer',
                }}>↺ Standaard (blauw)</button>
                {cfgSaved && <span style={{ fontSize: '0.62rem', color: 'var(--green)' }}>✓ Opgeslagen</span>}
              </div>
            </div>

            {/* Handige links */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem 1.1rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.2rem' }}>🔗 Handige links (zijbalk)</div>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginBottom: '0.7rem' }}>Corp-links onderaan de zijbalk voor members (Discord, forum, SRP…). Leeg = standaardlinks.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {links.map((l, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      value={l.label}
                      onChange={e => setLinks(ls => ls.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      placeholder="Naam"
                      style={{ width: 120, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none' }}
                    />
                    <input
                      value={l.url}
                      onChange={e => setLinks(ls => ls.map((x, j) => j === i ? { ...x, url: e.target.value } : x))}
                      placeholder="https://..."
                      style={{ flex: 1, minWidth: 0, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none' }}
                    />
                    <button onClick={() => setLinks(ls => ls.filter((_, j) => j !== i))} title="Verwijderen"
                      style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--red)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '0.25rem 0.5rem' }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.65rem' }}>
                <button
                  onClick={() => setLinks(ls => ls.length < 12 ? [...ls, { label: '', url: '' }] : ls)}
                  style={{ background: 'transparent', border: '1px dashed var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.7rem', padding: '0.3rem 0.7rem', cursor: 'pointer' }}
                >+ Link toevoegen</button>
                <button
                  onClick={() => saveSiteConfig({ links })}
                  style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.95rem', cursor: 'pointer' }}
                >Opslaan</button>
              </div>
            </div>

            {/* Jump bridges (fleet-kaart) */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem 1.1rem' }}>
              <div onClick={() => setBridgesOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>🌉 Jump bridges (fleet-kaart) <span style={{ fontSize: '0.66rem', fontWeight: 400, color: 'var(--text-dim)' }}>({bridges.length})</span></div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{bridgesOpen ? '▲' : '▼'}</span>
              </div>
              {bridgesOpen && (<>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginTop: '0.5rem', marginBottom: '0.7rem' }}>Ansiblex-verbindingen staan niet in de SDE — voer ze hier in als paar systeem-namen (bv. <code>BKG-Q2</code> ↔ <code>9F-7PZ</code>). Ze worden op de fleet-kaart als blauwe lijn getekend.</div>

              {/* Bulk-plakken: alle bridges in één keer */}
              <div style={{ marginBottom: '0.8rem' }}>
                <textarea
                  value={bridgePaste}
                  onChange={e => setBridgePaste(e.target.value)}
                  rows={4}
                  placeholder={'Plak hier alle bridges — één per regel, bv.:\nBKG-Q2 » 9F-7PZ\n9F-7PZ » C-LP3N\nof: BKG-Q2, 9F-7PZ'}
                  style={{ width: '100%', boxSizing: 'border-box', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', fontFamily: 'monospace', padding: '0.45rem 0.6rem', outline: 'none', resize: 'vertical' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.35rem' }}>
                  <button
                    onClick={applyBridgePaste}
                    disabled={!bridgePaste.trim()}
                    style={{ background: 'rgba(62,207,110,0.12)', border: '1px solid var(--green)', borderRadius: 3, color: 'var(--green)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.95rem', cursor: bridgePaste.trim() ? 'pointer' : 'not-allowed', opacity: bridgePaste.trim() ? 1 : 0.5 }}
                  >Inlezen & toevoegen</button>
                  {bridgePaste.trim() && <span style={{ fontSize: '0.64rem', color: 'var(--text-dim)' }}>{parseBridgePaste(bridgePaste).length} bridge(s) herkend</span>}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {bridges.map((b, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      value={b[0]}
                      onChange={e => setBridges(bs => bs.map((x, j) => j === i ? [e.target.value, x[1]] : x))}
                      placeholder="Systeem A"
                      style={{ width: 130, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none' }}
                    />
                    <span style={{ color: 'var(--text-dim)' }}>↔</span>
                    <input
                      value={b[1]}
                      onChange={e => setBridges(bs => bs.map((x, j) => j === i ? [x[0], e.target.value] : x))}
                      placeholder="Systeem B"
                      style={{ width: 130, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none' }}
                    />
                    <button onClick={() => setBridges(bs => bs.filter((_, j) => j !== i))} title="Verwijderen"
                      style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--red)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '0.25rem 0.5rem' }}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.65rem' }}>
                <button
                  onClick={() => setBridges(bs => bs.length < 100 ? [...bs, ['', '']] : bs)}
                  style={{ background: 'transparent', border: '1px dashed var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.7rem', padding: '0.3rem 0.7rem', cursor: 'pointer' }}
                >+ Bridge toevoegen</button>
                <button
                  onClick={() => saveSiteConfig({ bridges })}
                  style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.95rem', cursor: 'pointer' }}
                >Opslaan</button>
              </div>
              </>)}
            </div>

            {/* Intel-kanalen (Intel-pagina + fleet-kaart) */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem 1.1rem' }}>
              <div onClick={() => setIntelOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>📡 Intel-kanalen <span style={{ fontSize: '0.66rem', fontWeight: 400, color: 'var(--text-dim)' }}>({intelChannels.length})</span></div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>{intelOpen ? '▲' : '▼'}</span>
              </div>
              {intelOpen && (<>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginTop: '0.5rem', marginBottom: '0.7rem' }}>
                De chat-kanalen die de Intel-pagina én de fleet-kaart uitlezen. <code>Prefix</code> = begin van de chatlog-bestandsnaam (bv. <code>wc.Dek+Fa+PB</code>), <code>label</code> is voor de weergave. Leeg = standaard ({DEFAULT_INTEL_CHANNELS.map(c => c.label).join(', ')}).
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {intelChannels.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      value={c.prefix}
                      onChange={e => setIntelChannels(cs => cs.map((x, j) => j === i ? { ...x, prefix: e.target.value } : x))}
                      placeholder="wc.Dek+Fa+PB"
                      style={{ flex: 1, minWidth: 0, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', fontFamily: 'monospace', padding: '0.35rem 0.5rem', outline: 'none' }}
                    />
                    <input
                      value={c.label}
                      onChange={e => setIntelChannels(cs => cs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      placeholder="Label (weergave)"
                      style={{ width: 150, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none' }}
                    />
                    <button onClick={() => setIntelChannels(cs => cs.filter((_, j) => j !== i))} title="Verwijderen"
                      style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--red)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '0.25rem 0.5rem' }}>×</button>
                  </div>
                ))}
                {intelChannels.length === 0 && (
                  <div style={{ fontSize: '0.64rem', color: 'var(--text-dim)' }}>Geen eigen kanalen — de standaardkanalen worden gebruikt.</div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.65rem' }}>
                <button
                  onClick={() => setIntelChannels(cs => cs.length < 30 ? [...cs, { prefix: '', label: '' }] : cs)}
                  style={{ background: 'transparent', border: '1px dashed var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.7rem', padding: '0.3rem 0.7rem', cursor: 'pointer' }}
                >+ Kanaal toevoegen</button>
                {intelChannels.length === 0 && (
                  <button
                    onClick={() => setIntelChannels(DEFAULT_INTEL_CHANNELS.map(c => ({ ...c })))}
                    style={{ background: 'transparent', border: '1px dashed var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.7rem', padding: '0.3rem 0.7rem', cursor: 'pointer' }}
                  >Standaardkanalen invullen</button>
                )}
                <button
                  onClick={() => saveSiteConfig({ intelChannels })}
                  style={{ marginLeft: 'auto', background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.95rem', cursor: 'pointer' }}
                >Opslaan</button>
              </div>
              </>)}
            </div>

            {/* Toggle-secties */}
            {SETTING_GROUPS.map(group => (
              <div key={group.key}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.15em', margin: '0 0 0.5rem 0.25rem' }}>
                  {group.label.toUpperCase()}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {(Object.keys(SETTING_META) as SettingKey[]).filter(k => SETTING_META[k].group === group.key).map(key => {
                    const meta = SETTING_META[key]
                    const on = settings[key] ?? false
                    const danger = meta.danger && on
                    const rgb = meta.danger ? '224,85,85' : '0,180,216'
                    return (
                      <div key={key} style={{
                        display: 'flex', alignItems: 'center', gap: '0.75rem',
                        background: danger ? 'rgba(224,85,85,0.06)' : 'var(--surface)',
                        border: `1px solid ${danger ? 'rgba(224,85,85,0.4)' : 'var(--border)'}`,
                        borderRadius: 6, padding: '0.7rem 1rem',
                      }}>
                        <span style={{ fontSize: '1.1rem', flexShrink: 0, width: 24, textAlign: 'center' }}>{meta.icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: danger ? 'var(--red)' : 'var(--text)' }}>{meta.label}</div>
                          <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>{meta.desc}</div>
                        </div>
                        <Toggle on={on} onClick={() => toggleSetting(key)} rgb={rgb} />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}

            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
              Wijzigingen worden direct opgeslagen in de database.
            </div>
          </div>
          )
        })()}

        {/* Recruiter Chat — privé 1-op-1 gesprekken vanaf de login-pagina */}
        {tab === 'chat' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em' }}>
                {chatThreads.length} GESPREK{chatThreads.length === 1 ? '' : 'KEN'} — privéchats van bezoekers op de login-pagina
              </div>
              <button
                onClick={() => { const v = !member.notifRecruiter; if (v && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); setMemberSettings({ notifRecruiter: v }) }}
                title="Desktop-melding wanneer een bezoeker een nieuw bericht stuurt (per browser)"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600,
                  border: `1px solid ${member.notifRecruiter ? 'var(--green)' : 'var(--border)'}`, borderRadius: 3, padding: '0.3rem 0.7rem',
                  background: member.notifRecruiter ? 'rgba(62,207,110,0.1)' : 'transparent',
                  color: member.notifRecruiter ? 'var(--green)' : 'var(--text-dim)',
                }}>
                {member.notifRecruiter ? '🔔 Meldingen aan' : '🔕 Meldingen uit'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* Gesprekkenlijst */}
              <div style={{ flex: '0 0 240px', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', maxHeight: 460, overflowY: 'auto' }}>
                {chatThreads.length === 0 ? (
                  <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem', padding: '1rem' }}>Nog geen gesprekken.</div>
                ) : chatThreads.map(t => (
                  <div key={t.thread} onClick={() => openThread(t.thread)} style={{
                    padding: '0.55rem 0.7rem', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.06)',
                    background: activeThread === t.thread ? 'rgba(0,180,216,0.1)' : 'transparent',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.78rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name || 'Bezoeker'}</span>
                      {t.staff_unread > 0 && <span style={{ background: 'var(--red)', color: '#fff', fontSize: '0.55rem', fontWeight: 700, borderRadius: 8, padding: '0 5px', minWidth: 16, textAlign: 'center' }}>{t.staff_unread}</span>}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.1rem' }}>{t.last_msg || ''}</div>
                  </div>
                ))}
              </div>

              {/* Gesprek */}
              <div style={{ flex: '1 1 320px', minWidth: 0, border: '1px solid var(--border)', borderRadius: 4, display: 'flex', flexDirection: 'column', height: 460 }}>
                {!activeThread ? (
                  <div style={{ margin: 'auto', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Kies een gesprek links.</div>
                ) : (
                  <>
                    <div style={{ padding: '0.5rem 0.8rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.8rem', flex: 1 }}>{chatThreads.find(t => t.thread === activeThread)?.name || 'Bezoeker'}</span>
                      <button onClick={() => deleteThread(activeThread)} style={{ padding: '0.15rem 0.5rem', fontSize: '0.65rem', fontWeight: 600, border: '1px solid rgba(224,85,85,0.3)', borderRadius: 3, cursor: 'pointer', background: 'transparent', color: 'var(--red)' }}>Verwijder</button>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: '0.7rem 0.8rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {threadMsgs.map(m => {
                        const staff = m.sender === 'staff'
                        return (
                          <div key={m.id} style={{ display: 'flex', justifyContent: staff ? 'flex-end' : 'flex-start' }}>
                            <div style={{
                              maxWidth: '78%', padding: '0.4rem 0.6rem', borderRadius: 8, fontSize: '0.76rem', lineHeight: 1.4, wordBreak: 'break-word',
                              background: staff ? 'rgba(0,180,216,0.18)' : 'rgba(255,255,255,0.06)',
                              border: `1px solid ${staff ? 'rgba(0,180,216,0.3)' : 'rgba(255,255,255,0.08)'}`,
                            }}>
                              {staff && m.staff_name && <div style={{ fontSize: '0.58rem', fontWeight: 700, color: 'var(--blue)', marginBottom: '0.1rem' }}>{m.staff_name}</div>}
                              <span style={{ color: 'var(--text)' }}>{m.message}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div style={{ padding: '0.6rem 0.8rem', borderTop: '1px solid var(--border)', display: 'flex', gap: '0.4rem' }}>
                      <input value={replyText} maxLength={280} placeholder="Antwoord…"
                        onChange={e => setReplyText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') sendReply() }}
                        style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 4, padding: '0.45rem 0.6rem', fontSize: '0.75rem', outline: 'none' }} />
                      <button onClick={sendReply} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.5)', color: '#00d4ff', borderRadius: 4, padding: '0 0.8rem', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>➤</button>
                    </div>
                  </>
                )}
              </div>
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

              <div style={{ marginTop: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <button
                  onClick={runUpdate}
                  disabled={updating}
                  style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.8rem', cursor: updating ? 'default' : 'pointer', opacity: updating ? 0.6 : 1 }}
                >{updating ? '⏳ Bezig…' : '↻ Nu bijwerken'}</button>
                {!hasPat && (
                  <button onClick={() => setShowPatField(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '0.65rem', cursor: 'pointer', textDecoration: 'underline' }}>
                    GitHub-token instellen
                  </button>
                )}
                {triggerMsg && (
                  <span style={{ fontSize: '0.65rem', color: triggerMsg.startsWith('✓') ? 'var(--green)' : 'var(--red)' }}>{triggerMsg}</span>
                )}
              </div>

              {(updating || updatePct === 100) && (
                <div style={{ marginTop: '0.55rem' }}>
                  <div style={{ height: 6, background: 'rgba(0,180,216,0.12)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${updatePct}%`, background: updatePct === 100 ? 'linear-gradient(90deg,#1a5c38,#3ecf6e)' : 'linear-gradient(90deg, var(--blue), #7dd3fc)', borderRadius: 3, transition: 'width 0.6s ease' }} />
                  </div>
                  {updating && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>Bouwen + deployen… ({updatePct}%)</div>}
                </div>
              )}

              {showPatField && (
                <div style={{ marginTop: '0.6rem' }}>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <input
                      type="password" value={patInput} onChange={e => setPatInput(e.target.value)}
                      placeholder="GitHub fine-grained PAT (Actions: read+write)"
                      style={{ flex: 1, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.7rem', padding: '0.35rem 0.55rem', outline: 'none' }}
                    />
                    <button onClick={savePat} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.7rem', fontWeight: 600, padding: '0.35rem 0.7rem', cursor: 'pointer' }}>Opslaan</button>
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.3rem', lineHeight: 1.5 }}>
                    Maak op github.com een fine-grained token voor deze repo met <strong>Actions: Read and write</strong>. Wordt veilig in de database bewaard (niet in de code).
                  </div>
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
