import { useEffect, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { fetchDscanItems, type DscanGroup } from '../utils/dscan'
import { useSiteConfig } from '../hooks/useSiteConfig'
import { DEFAULT_INTEL_CHANNELS } from '../utils/intelChannels'
import { useMemberSettings, setMemberSettings } from '../utils/memberSettings'

interface IntelEntry {
  id: string
  time: Date
  reporter: string
  message: string
  system: string | null
  threat: 'clear' | 'threat' | 'unknown'
  channel: string
  ships: { typeId: number; name: string }[]
  dscanUrl: string | null
  isNew?: boolean
}

const DSCAN_RE = /https?:\/\/dscan\.info\/v\/[a-f0-9]+/i

const CLEAR_RE  = /\b(nv|nvt|clr|clear|safe)\b/i
const THREAT_RE = /\b(\d{1,3}\+?|carrier|carriers|dread|dreads|super|supers|titan|titans|fax|faxes|cyno|rorqual|recon|recons|battleship|battleships|bs|bc|bcs|logi|logis|bomber|bombers|hic|hics|dic|dics|blops|sabre|flycatcher|heretic|eris|proteus|tengu|loki|legion|rapier|arazu|huginn|curse|pilgrim|stiletto|crow|malediction|interceptor|interdictor|bubble|bubbles|spike|neut|neuts)\b/i
const SYSTEM_RE = /\b([A-Z][A-Z0-9-]{2,}[A-Z0-9]|[A-Z][A-Z0-9]{2}-[A-Z][A-Z0-9]{1,2})\b/

const SHIP_TYPE_IDS: Record<string, number> = {
  // Interdictors
  sabre: 22456, flycatcher: 12038, heretic: 12034, eris: 12032,
  // Heavy Interdictors
  phobos: 12017, devoter: 12015, onyx: 12021, broadsword: 12019,
  // Interceptors
  stiletto: 11978, crow: 11176, malediction: 11178, ares: 11202,
  // Recons
  rapier: 11969, huginn: 12013, arazu: 11959, lachesis: 11957,
  curse: 11961, pilgrim: 11963,
  // T3 Cruisers
  tengu: 29984, proteus: 29988, loki: 29990, legion: 29986,
  // Carriers (generic → Thanatos)
  thanatos: 23919, chimera: 23917, nidhoggur: 23915, archon: 23921,
  carrier: 23919, carriers: 23919,
  // Dreads (generic → Naglfar)
  naglfar: 19720, moros: 19726, phoenix: 19722, revelation: 19724,
  dread: 19720, dreads: 19720,
  // Supercarriers
  hel: 23913, nyx: 23911, aeon: 23757, wyvern: 3514,
  super: 23913, supers: 23913,
  // Titans (generic → Avatar)
  avatar: 671, titan: 671, titans: 671,
  // Rorqual
  rorqual: 28352,
  // BLOPS (generic → Redeemer)
  redeemer: 28710, sin: 28665, widow: 28846, panther: 28659,
  blops: 28710,
  // Bombers (generic → Nemesis)
  nemesis: 12023, manticore: 12032, hound: 12034, purifier: 12038,
  bomber: 12023, bombers: 12023,
}

const SHIP_PATTERN = `\\b(${Object.keys(SHIP_TYPE_IDS).sort((a, b) => b.length - a.length).join('|')})s?\\b`

function extractShips(msg: string): { typeId: number; name: string }[] {
  const re      = new RegExp(SHIP_PATTERN, 'gi')
  const results: { typeId: number; name: string }[] = []
  const seen    = new Set<number>()
  let match: RegExpExecArray | null
  while ((match = re.exec(msg)) !== null) {
    const w      = match[1].toLowerCase()
    const typeId = SHIP_TYPE_IDS[w] ?? SHIP_TYPE_IDS[w.replace(/s$/, '')] ?? null
    if (!typeId || seen.has(typeId)) continue
    seen.add(typeId)
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
    results.push({ typeId, name })
  }
  return results
}

// How long (ms) before entries fade
const STALE_1 = 10 * 60 * 1000  // 10m → 70% opacity
const STALE_2 = 20 * 60 * 1000  // 20m → 35% opacity

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: object) => Promise<FileSystemDirectoryHandle>
  }
}

const SUPPORTED = typeof window !== 'undefined' && !!window.showDirectoryPicker

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('eve-intel', 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('dir')) db.createObjectStore('dir')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function saveDirHandle(handle: FileSystemDirectoryHandle) {
  const db = await openIDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('dir', 'readwrite')
    tx.objectStore('dir').put(handle, 'chatlogs')
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('dir', 'readonly')
    const req = tx.objectStore('dir').get('chatlogs')
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null)
    req.onerror   = () => reject(req.error)
  })
}

type PermHandle = FileSystemDirectoryHandle & {
  queryPermission:   (d: object) => Promise<string>
  requestPermission: (d: object) => Promise<string>
}

async function findAllFiles(
  dir: FileSystemDirectoryHandle,
  channelNames: string[]
): Promise<Map<string, Array<{ name: string; handle: FileSystemFileHandle }>>> {
  const result = new Map<string, Array<{ name: string; handle: FileSystemFileHandle }>>(
    channelNames.map(ch => [ch, []])
  )
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file' || !name.endsWith('.txt')) continue
    for (const ch of channelNames) {
      if (!name.startsWith(ch + '_')) continue
      result.get(ch)!.push({ name, handle: handle as FileSystemFileHandle })
    }
  }
  for (const arr of result.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
  return result
}

function parseLine(line: string, channel: string): IntelEntry | null {
  // EVE zet vóór ÉLKE regel een BOM-teken (U+FEFF); zonder dat te strippen matcht
  // de regex hieronder niets meer. Zie ook useIntelSystems.ts.
  const m = line.replace(/^[﻿\s]+/, '')
    .match(/^\[ (\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) \] ([^>]+) > (.+)$/)
  if (!m) return null
  const [, rawTime, rawReporter, rawMsg] = m
  const reporter = rawReporter.trim()
  const message  = rawMsg.trim()
  if (reporter === 'EVE System') return null

  const [datePart, timePart] = rawTime.split(' ')
  const time = new Date(`${datePart.replace(/\./g, '-')}T${timePart}Z`)

  const sysMatch = SYSTEM_RE.exec(message)
  const system   = sysMatch ? sysMatch[1].toUpperCase() : null

  const isClear  = CLEAR_RE.test(message)
  const isThreat = !isClear && THREAT_RE.test(message)

  return {
    id: `${channel}|${rawTime}|${reporter}|${message}`,
    time, reporter, message, system, channel,
    ships: extractShips(message),
    dscanUrl: DSCAN_RE.exec(message)?.[0] ?? null,
    threat: isClear ? 'clear' : isThreat ? 'threat' : 'unknown',
    isNew: true,
  }
}

function renderMsg(rest: string, dscanUrl: string | null) {
  if (!dscanUrl) return rest
  const i = rest.indexOf(dscanUrl)
  if (i === -1) return rest
  const before = rest.slice(0, i).trimEnd()
  const after  = rest.slice(i + dscanUrl.length).trimStart()
  return (
    <>
      {before}{before ? ' ' : ''}
      <a
        href={dscanUrl} target="_blank" rel="noreferrer"
        onClick={ev => ev.stopPropagation()}
        title={dscanUrl}
        style={{ color: 'var(--blue)', textDecoration: 'none', fontSize: '1rem', verticalAlign: 'middle' }}
      >◎</a>
      {after ? ' ' : ''}{after}
    </>
  )
}

function timeAgo(d: Date, _tick: number): string {
  const diff = Date.now() - d.getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m`
  return `${Math.floor(m / 60)}u`
}

function entryOpacity(d: Date): number {
  const age = Date.now() - d.getTime()
  if (age < STALE_1) return 1
  if (age < STALE_2) return 0.55
  return 0.28
}

function threatColor(t: IntelEntry['threat']) {
  if (t === 'clear')  return 'var(--green)'
  if (t === 'threat') return 'var(--red)'
  return 'var(--text-dim)'
}

function threatBg(t: IntelEntry['threat']) {
  if (t === 'clear')  return 'rgba(62,207,110,0.05)'
  if (t === 'threat') return 'rgba(224,85,85,0.08)'
  return 'transparent'
}

function threatIcon(t: IntelEntry['threat']) {
  if (t === 'clear')  return '✓'
  if (t === 'threat') return '!'
  return '·'
}

// Sound alert via Web Audio API
let _audioCtx: AudioContext | null = null
function playAlert() {
  try {
    if (!_audioCtx) _audioCtx = new AudioContext()
    const ctx = _audioCtx
    const freqs = [660, 880]
    freqs.forEach((freq, i) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.frequency.value = freq
      osc.type = 'sine'
      const t = ctx.currentTime + i * 0.18
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
      osc.start(t); osc.stop(t + 0.25)
    })
  } catch { /* user hasn't interacted yet */ }
}

function TabBtn({ label: _label, shortLabel, active, badge, highlight, lastEntry, tick, onClick }: {
  label: string; shortLabel: string; active: boolean; badge: number; highlight?: boolean
  lastEntry?: Date; tick: number; onClick: () => void
}) {
  const ago = lastEntry ? timeAgo(lastEntry, tick) : null
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        borderBottom: `2px solid ${active ? (highlight ? 'var(--gold)' : 'var(--blue)') : 'transparent'}`,
        color: active ? (highlight ? 'var(--gold)' : 'var(--blue)') : highlight ? 'rgba(240,192,64,0.6)' : 'var(--text-dim)',
        fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.05em',
        padding: '0.45rem 0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap',
      }}
    >
      {shortLabel}
      {ago && <span style={{ fontSize: '0.55rem', opacity: 0.6, fontWeight: 400 }}>{ago}</span>}
      {badge > 0 && (
        <span style={{ background: 'var(--red)', color: '#fff', fontSize: '0.55rem', fontWeight: 700, borderRadius: 8, padding: '0 5px', lineHeight: '16px', display: 'inline-block', minWidth: 16, textAlign: 'center' }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

interface ReporterInfo { corpId: number; corpName?: string; allianceId?: number; allianceName?: string }

export default function Intel() {
  const [dirHandle, setDirHandle]           = useState<FileSystemDirectoryHandle | null>(null)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [storedHandle, setStoredHandle]     = useState<FileSystemDirectoryHandle | null>(null)
  const [entries, setEntries]               = useState<IntelEntry[]>([])
  const [activeTab, setActiveTab]           = useState<string>(() => DEFAULT_INTEL_CHANNELS[0].prefix)
  const [filter, setFilter]                 = useState('')
  const [threatOnly, setThreatOnly]         = useState(false)
  const member  = useMemberSettings()
  const soundOn = member.sound
  const [tick, setTick]                     = useState(0)
  const [reporterInfo, setReporterInfo]     = useState(new Map<string, ReporterInfo>())
  const [dscanCache, setDscanCache]         = useState(new Map<string, DscanGroup[]>())
  const [dscanErrors, setDscanErrors]       = useState(new Set<string>())
  const fetchingDscans = useRef(new Set<string>())
  const seenIds          = useRef(new Set<string>())
  const lastSize         = useRef(new Map<string, number>())
  const filesByChannel   = useRef(new Map<string, Array<{ name: string; handle: FileSystemFileHandle }>>())
  const newIds           = useRef(new Set<string>())
  const activeTabRef     = useRef(activeTab)
  const resolvedReporters = useRef(new Set<string>())

  // Intel-kanalen uit de site-config (beheerd in de Admin); valt terug op de defaults.
  const { intelChannels } = useSiteConfig()
  const validChannels = intelChannels.filter(c => c.prefix.trim())
  const channels = validChannels.length ? validChannels : DEFAULT_INTEL_CHANNELS
  const WATCH_CHANNELS = channels.map(c => c.prefix)
  const PRIORITY = WATCH_CHANNELS[0]
  const chLabel = (p: string) => channels.find(c => c.prefix === p)?.label || p

  // Keep activeTabRef in sync
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])

  // Als de geconfigureerde kanalen veranderen en het actieve tabblad bestaat niet meer,
  // val terug op het eerste kanaal.
  useEffect(() => {
    if (activeTab !== 'all' && !WATCH_CHANNELS.includes(activeTab)) setActiveTab(PRIORITY)
  }, [activeTab, WATCH_CHANNELS.join('|'), PRIORITY])

  // Tick every 20s to update relative times and age dimming
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 20_000)
    return () => clearInterval(iv)
  }, [])

  // Auto-fetch dscan URLs found in entries
  useEffect(() => {
    const urls = [...new Set(entries.map(e => e.dscanUrl).filter((u): u is string => !!u))]
    const pending = urls.filter(u => !fetchingDscans.current.has(u) && !dscanCache.has(u))
    if (pending.length === 0) return
    pending.forEach(u => fetchingDscans.current.add(u))
    pending.forEach(url => {
      fetchDscanItems(url)
        .then(groups => setDscanCache(prev => new Map([...prev, [url, groups]])))
        .catch(() => setDscanErrors(prev => new Set([...prev, url])))
    })
  }, [entries])

  // Resolve reporter names → corp / alliance IDs
  useEffect(() => {
    const unknown = [...new Set(entries.map(e => e.reporter))].filter(r => !resolvedReporters.current.has(r))
    if (unknown.length === 0) return
    unknown.forEach(r => resolvedReporters.current.add(r))

    async function resolve() {
      // Batch in chunks of 100 (ESI limit 500 but keep it safe)
      for (let i = 0; i < unknown.length; i += 100) {
        const chunk = unknown.slice(i, i + 100)
        try {
          const idsRes = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunk),
          })
          if (!idsRes.ok) continue
          const idsData = await idsRes.json()
          const chars: { id: number; name: string }[] = idsData.characters ?? []

          const info = new Map<string, ReporterInfo>()
          await Promise.all(chars.map(async ({ id, name }) => {
            const r = await fetch(`https://esi.evetech.net/latest/characters/${id}/?datasource=tranquility`)
              .then(res => res.ok ? res.json() : null).catch(() => null)
            if (!r?.corporation_id) return
            const [corp, alliance] = await Promise.all([
              fetch(`https://esi.evetech.net/latest/corporations/${r.corporation_id}/?datasource=tranquility`)
                .then(res => res.ok ? res.json() : null).catch(() => null),
              r.alliance_id
                ? fetch(`https://esi.evetech.net/latest/alliances/${r.alliance_id}/?datasource=tranquility`)
                    .then(res => res.ok ? res.json() : null).catch(() => null)
                : null,
            ])
            info.set(name, {
              corpId: r.corporation_id, corpName: corp?.name,
              allianceId: r.alliance_id, allianceName: alliance?.name,
            })
          }))

          if (info.size > 0) setReporterInfo(prev => new Map([...prev, ...info]))
        } catch { /* ignore */ }
      }
    }
    resolve()
  }, [entries])

  // Clear "isNew" flash after 4s
  useEffect(() => {
    if (newIds.current.size === 0) return
    const ids = new Set(newIds.current)
    const t = setTimeout(() => {
      newIds.current.clear()
      setEntries(prev => prev.map(e => ids.has(e.id) ? { ...e, isNew: false } : e))
    }, 4000)
    return () => clearTimeout(t)
  }, [entries])

  // Restore from IDB
  useEffect(() => {
    loadDirHandle().then(async handle => {
      if (!handle) return
      const perm = await (handle as PermHandle).queryPermission({ mode: 'read' })
      if (perm === 'granted') setDirHandle(handle)
      else { setStoredHandle(handle); setNeedsPermission(true) }
    }).catch(() => {})
  }, [])

  async function reconnect() {
    if (!storedHandle) return
    const perm = await (storedHandle as PermHandle).requestPermission({ mode: 'read' })
    if (perm === 'granted') { setDirHandle(storedHandle); setNeedsPermission(false) }
  }

  async function pickFolder() {
    if (!window.showDirectoryPicker) return
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' } as object)
      await saveDirHandle(handle)
      seenIds.current.clear(); lastSize.current.clear(); filesByChannel.current.clear()
      setEntries([])
      setDirHandle(handle); setNeedsPermission(false)
    } catch { /* cancelled */ }
  }

  // Poll loop
  useEffect(() => {
    if (!dirHandle) return
    const RECENT_CUTOFF = 5 * 60 * 1000 // only alert/flash for entries < 5min old

    async function poll() {
      const fresh = await findAllFiles(dirHandle!, WATCH_CHANNELS).catch(() => new Map<string, Array<{ name: string; handle: FileSystemFileHandle }>>())
      for (const [ch, files] of fresh) {
        const existing = filesByChannel.current.get(ch) ?? []
        const existingNames = new Set(existing.map(f => f.name))
        const added = files.filter(f => !existingNames.has(f.name))
        if (added.length > 0) {
          filesByChannel.current.set(ch, [...existing, ...added].sort((a, b) => a.name.localeCompare(b.name)))
        }
      }

      const newEntries: IntelEntry[] = []
      for (const [ch, files] of filesByChannel.current) {
        for (const { name, handle } of files) {
          try {
            const file = await handle.getFile()
            const prev = lastSize.current.get(name) ?? 0
            if (file.size === prev) continue
            lastSize.current.set(name, file.size)
            const text = await file.text()
            for (const line of text.split('\n')) {
              const entry = parseLine(line.trim(), ch)
              if (!entry || seenIds.current.has(entry.id)) continue
              seenIds.current.add(entry.id)
              newEntries.push(entry)
            }
          } catch { /* ignore */ }
        }
      }

      if (newEntries.length > 0) {
        const now = Date.now()
        const currentTab = activeTabRef.current
        const recentThreats = newEntries.filter(e =>
          e.threat === 'threat' &&
          now - e.time.getTime() < RECENT_CUTOFF &&
          (currentTab === 'all' || e.channel === currentTab)
        )
        if (recentThreats.length > 0 && soundOn) playAlert()
        const flashIds = new Set(newEntries.filter(e => now - e.time.getTime() < RECENT_CUTOFF).map(e => e.id))
        newIds.current = flashIds
        setEntries(prev =>
          [...newEntries, ...prev]
            .sort((a, b) => b.time.getTime() - a.time.getTime())
            .slice(0, 2000)
        )
      }
    }

    seenIds.current.clear(); lastSize.current.clear(); filesByChannel.current.clear()
    resolvedReporters.current.clear()
    setEntries([]); setReporterInfo(new Map())
    poll()
    const iv = setInterval(poll, 1000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirHandle, soundOn, WATCH_CHANNELS.join('|')])

  const tabEntries = activeTab === 'all'
    ? entries
    : entries.filter(e => e.channel === activeTab)

  const visible = tabEntries.filter(e => {
    if (threatOnly && e.threat !== 'threat') return false
    if (!filter.trim()) return true
    const q = filter.toLowerCase()
    return e.message.toLowerCase().includes(q)
      || e.reporter.toLowerCase().includes(q)
      || (e.system ?? '').toLowerCase().includes(q)
  })

  const allThreats = entries.filter(e => e.threat === 'threat').length

  // Last entry time per channel
  function lastEntryFor(ch: string) {
    const arr = entries.filter(e => e.channel === ch)
    return arr.length > 0 ? arr[0].time : undefined
  }

  return (
    <Layout header={
      <PageHeader
        title="Intel"
        sub={dirHandle ? `live · ${entries.length} entries` : needsPermission ? 'Permissie vereist' : 'Geen map geselecteerd'}
        right={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              onClick={() => setMemberSettings({ sound: !soundOn })}
              title={soundOn ? 'Geluid aan' : 'Geluid uit'}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 3, color: soundOn ? 'var(--blue)' : 'var(--text-dim)', fontSize: '0.75rem', padding: '0.25rem 0.5rem', cursor: 'pointer' }}
            >
              {soundOn ? '🔔' : '🔕'}
            </button>
            <button onClick={pickFolder} disabled={!SUPPORTED} style={{
              background: dirHandle ? 'rgba(62,207,110,0.08)' : 'rgba(0,180,216,0.08)',
              border: `1px solid ${dirHandle ? 'rgba(62,207,110,0.3)' : 'rgba(0,180,216,0.3)'}`,
              color: dirHandle ? 'var(--green)' : 'var(--blue)',
              borderRadius: 3, fontSize: '0.7rem', padding: '0.3rem 0.75rem', cursor: 'pointer',
            }}>
              {dirHandle ? '⬡ Andere map' : '⬡ Open Chatlogs map'}
            </button>
          </div>
        }
      />
    }>
      {!SUPPORTED && (
        <div style={{ padding: '0.75rem 1rem', background: 'rgba(224,85,85,0.1)', border: '1px solid rgba(224,85,85,0.2)', borderRadius: 3, color: 'var(--red)', fontSize: '0.73rem', marginBottom: '0.75rem' }}>
          Niet beschikbaar in deze browser. Gebruik Chrome of Edge.
        </div>
      )}

      {needsPermission && !dirHandle && (
        <div style={{ marginBottom: '0.75rem', padding: '0.6rem 1rem', background: 'rgba(240,192,64,0.08)', border: '1px solid rgba(240,192,64,0.25)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.73rem', color: 'var(--gold)' }}>Chatlogs map herkend — klik om opnieuw te verbinden</span>
          <button onClick={reconnect} style={{ background: 'rgba(240,192,64,0.12)', border: '1px solid rgba(240,192,64,0.3)', color: 'var(--gold)', borderRadius: 3, fontSize: '0.7rem', padding: '0.25rem 0.75rem', cursor: 'pointer' }}>
            Herverbinden
          </button>
        </div>
      )}

      {!dirHandle && !needsPermission && SUPPORTED && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: '1rem' }}>
          <div style={{ fontSize: '2rem', color: 'var(--border)' }}>◈</div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Selecteer je EVE Chatlogs map</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--border)', textAlign: 'center' }}>
            <code style={{ color: 'var(--text-dim)' }}>Documents\EVE\logs\Chatlogs\</code><br />
            <span style={{ color: 'var(--border)' }}>Nieuwe log bestanden worden automatisch opgepakt</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {WATCH_CHANNELS.map(ch => (
              <div key={ch} style={{ fontSize: '0.65rem', color: ch === PRIORITY ? 'var(--gold)' : 'var(--text-dim)', background: 'var(--surface)', border: `1px solid ${ch === PRIORITY ? 'rgba(240,192,64,0.3)' : 'var(--border)'}`, borderRadius: 2, padding: '0.2rem 0.6rem' }}>
                {chLabel(ch)}{ch === PRIORITY ? ' ★' : ''}
              </div>
            ))}
          </div>
          <button onClick={pickFolder} style={{ background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.3)', color: 'var(--blue)', borderRadius: 3, fontSize: '0.8rem', padding: '0.5rem 1.25rem', cursor: 'pointer', marginTop: '0.5rem' }}>
            ⬡ Open Chatlogs map
          </button>
        </div>
      )}

      {dirHandle && (
        <>
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '0.75rem' }}>
            <TabBtn label="ALLES" shortLabel="ALLES" active={activeTab === 'all'} badge={allThreats} tick={tick} onClick={() => setActiveTab('all')} />
            {WATCH_CHANNELS.map(ch => (
              <TabBtn
                key={ch}
                label={ch}
                shortLabel={chLabel(ch)}
                active={activeTab === ch}
                badge={entries.filter(e => e.channel === ch && e.threat === 'threat').length}
                highlight={ch === PRIORITY}
                lastEntry={lastEntryFor(ch)}
                tick={tick}
                onClick={() => setActiveTab(ch)}
              />
            ))}
          </div>

          {/* Filter bar */}
          <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Filter op systeem, reporter of bericht..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.73rem', padding: '0.4rem 0.75rem', outline: 'none' }}
            />
            {filter && (
              <button onClick={() => setFilter('')} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
            )}
            <button
              onClick={() => setThreatOnly(v => !v)}
              style={{
                background: threatOnly ? 'rgba(224,85,85,0.15)' : 'none',
                border: `1px solid ${threatOnly ? 'rgba(224,85,85,0.5)' : 'var(--border)'}`,
                color: threatOnly ? 'var(--red)' : 'var(--text-dim)',
                borderRadius: 3, fontSize: '0.65rem', fontWeight: 700, padding: '0.35rem 0.7rem', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              ! Threats only
            </button>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{visible.length} regels</span>
          </div>

          {/* Feed */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {visible.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', padding: '2rem', textAlign: 'center' }}>
                {threatOnly ? 'Geen threats gevonden' : 'Wachten op intel...'}
              </div>
            )}
            {visible.map(e => {
              const opacity = entryOpacity(e.time)
              const rest = e.system ? e.message.slice(e.message.indexOf(e.system) + e.system.length).trim() : e.message
              return (
                <div key={e.id} style={{ opacity, transition: 'opacity 2s' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: activeTab === 'all'
                      ? '36px 16px auto 160px 90px 1fr'
                      : '36px 16px auto 160px 1fr',
                    alignItems: 'center', gap: '0.4rem',
                    padding: '0.3rem 0.75rem',
                    background: e.isNew && e.threat === 'threat'
                      ? 'rgba(224,85,85,0.14)'
                      : threatBg(e.threat),
                    borderLeft: `2px solid ${threatColor(e.threat)}`,
                    borderRadius: 2, fontSize: '0.73rem',
                    transition: 'background 1s',
                  }}
                >
                  <span style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', fontSize: '0.6rem', textAlign: 'right' }}>
                    {timeAgo(e.time, tick)}
                  </span>
                  <span style={{ color: threatColor(e.threat), fontWeight: 700, textAlign: 'center', fontSize: '0.8rem' }}>
                    {threatIcon(e.threat)}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, flexWrap: 'wrap', minWidth: 48 }}>
                    {e.ships.length > 0 ? (
                      e.ships.slice(0, 4).map(s => (
                        <span key={s.typeId} title={s.name}>
                          <EveImage category="types" id={s.typeId} variation="icon" size={64} px={e.ships.length === 1 ? 48 : 36} />
                        </span>
                      ))
                    ) : (
                      <span style={{ width: 48, height: 48, display: 'block' }} />
                    )}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', overflow: 'hidden', minWidth: 0 }}>
                    {(() => {
                      const info = reporterInfo.get(e.reporter)
                      return (<>
                        {info?.corpId && <span title={info.corpName}><EveImage category="corporations" id={info.corpId} variation="logo" size={64} px={36} style={{ borderRadius: 2, flexShrink: 0 }} /></span>}
                        {info?.allianceId && <span title={info.allianceName}><EveImage category="alliances" id={info.allianceId} variation="logo" size={64} px={36} style={{ borderRadius: 2, flexShrink: 0 }} /></span>}
                      </>)
                    })()}
                    <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.65rem' }}>
                      {e.reporter}
                    </span>
                  </span>
                  {activeTab === 'all' && (
                    <span style={{ fontSize: '0.56rem', color: e.channel === PRIORITY ? 'rgba(240,192,64,0.5)' : 'var(--border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chLabel(e.channel)}
                    </span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.system && (
                      <span style={{ color: e.threat === 'clear' ? 'var(--green)' : e.threat === 'threat' ? 'var(--red)' : 'var(--blue)', fontWeight: 700, marginRight: '0.4rem', fontSize: '0.75rem' }}>
                        {e.system}
                      </span>
                    )}
                    <span style={{ color: e.threat === 'threat' ? 'var(--text)' : 'var(--text-dim)' }}>{renderMsg(rest, e.dscanUrl)}</span>
                  </span>
                </div>

                {/* Inline DScan — loading */}
                {e.dscanUrl && !dscanCache.has(e.dscanUrl) && !dscanErrors.has(e.dscanUrl) && (
                  <div style={{ padding: '0.3rem 0.75rem', fontSize: '0.62rem', color: 'var(--text-dim)', borderLeft: '2px solid var(--border)' }}>
                    ◎ dscan laden...
                  </div>
                )}
                {/* Inline DScan — failed or empty */}
                {e.dscanUrl && dscanErrors.has(e.dscanUrl) && (
                  <div style={{ padding: '0.3rem 0.75rem', borderLeft: '2px solid var(--border)' }}>
                    <a href={e.dscanUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.62rem', color: 'var(--blue)', textDecoration: 'none' }}>
                      ◎ open dscan.info ↗
                    </a>
                  </div>
                )}
                {/* Inline DScan — results */}
                {e.dscanUrl && dscanCache.has(e.dscanUrl) && (dscanCache.get(e.dscanUrl)?.length ?? 0) > 0 && (
                  <div style={{ padding: '0.4rem 0.75rem', borderLeft: '2px solid rgba(0,180,216,0.3)', display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', background: 'rgba(0,180,216,0.03)' }}>
                    <a href={e.dscanUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.58rem', color: 'var(--blue)', fontWeight: 700, marginRight: '0.25rem', textDecoration: 'none' }}>◎ DSCAN ↗</a>
                    {dscanCache.get(e.dscanUrl)!.map(g => (
                      <span key={g.typeId ?? g.typeName} title={g.typeName} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'var(--surface2)', borderRadius: 3, padding: '0.15rem 0.4rem' }}>
                        {g.typeId && <EveImage category="types" id={g.typeId} variation="icon" size={32} px={18} />}
                        <span style={{ fontSize: '0.65rem' }}>{g.typeName}</span>
                        {g.count > 1 && <span style={{ fontSize: '0.58rem', color: g.count >= 5 ? 'var(--red)' : 'var(--gold)', fontWeight: 700 }}>×{g.count}</span>}
                      </span>
                    ))}
                  </div>
                )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Layout>
  )
}
