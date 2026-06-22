import { useEffect, useRef, useState } from 'react'
import { useSiteConfig } from './useSiteConfig'
import { DEFAULT_INTEL_CHANNELS } from '../utils/intelChannels'
import { extractShips, SHIP_TYPE_IDS, isShipName, loadShipNames } from '../utils/intelShips'

// Leest dezelfde EVE-chatlogs als de Intel-pagina (via de Chatlogs-map die daar
// gekoppeld is, opgeslagen in IndexedDB) en levert per systeem de meest recente
// intel-melding. Voor de fleet-kaart: rode markers met schip-/pilot-aantal.
// Werkt alleen op Chrome/Edge (File System Access API) en als de map al gekoppeld is.

export interface SystemIntel {
  id: string                                      // uniek per chatregel (dedup)
  system: string                                  // hoofdletters, zoals op de kaart
  threat: 'clear' | 'threat' | 'unknown'
  time: number                                    // ms van deze melding
  count: number                                   // gemeld aantal (pilots/schepen), 0 = onbekend
  message: string
  reporter: string                                // wie het meldde
  ships: { typeId: number; name: string }[]       // herkende scheepstypes in de melding
  enemies?: EnemyEntity[]                          // gemelde vijand (uit de melding geresolved)
}

// Eén systeem met zijn recente meldingen (nieuwste eerst), voor de in-game-stijl lijst.
export interface SystemIntelGroup {
  system: string
  threat: 'clear' | 'threat' | 'unknown'          // van de nieuwste melding
  time: number                                    // nieuwste melding
  count: number                                   // van de nieuwste melding
  entries: SystemIntel[]
}

export interface EnemyEntity {
  kind: 'character' | 'corporation' | 'alliance'
  id: number; name: string
  corpId?: number; allianceId?: number            // lazy resolved
  corpTicker?: string; allianceTicker?: string; allianceName?: string
}

// Globale caches per id (ticker/naam veranderen nauwelijks).
const _corpInfo = new Map<number, { ticker?: string; allianceId?: number }>()
const _allyInfo = new Map<number, { ticker?: string; name?: string }>()
async function corpInfo(id: number) {
  if (!_corpInfo.has(id)) {
    try { const r = await fetch(`https://esi.evetech.net/latest/corporations/${id}/?datasource=tranquility`).then(x => (x.ok ? x.json() : null)); _corpInfo.set(id, { ticker: r?.ticker, allianceId: r?.alliance_id }) }
    catch { _corpInfo.set(id, {}) }
  }
  return _corpInfo.get(id)!
}
async function allyInfo(id: number) {
  if (!_allyInfo.has(id)) {
    try { const r = await fetch(`https://esi.evetech.net/latest/alliances/${id}/?datasource=tranquility`).then(x => (x.ok ? x.json() : null)); _allyInfo.set(id, { ticker: r?.ticker, name: r?.name }) }
    catch { _allyInfo.set(id, {}) }
  }
  return _allyInfo.get(id)!
}

// Cache: melding-tekst → gemelde vijanden. Buiten de component → sessie-breed.
const _enemyCache = new Map<string, EnemyEntity[] | null>()   // null = bezig

// Kandidaat-namen uit een melding halen (1–3 woorden), zonder schip-/intel-jargon.
const STOP = new Set([
  ...Object.keys(SHIP_TYPE_IDS),
  'nv', 'nvt', 'clr', 'clear', 'safe', 'neut', 'neuts', 'cyno', 'red', 'reds', 'hostile', 'hostiles',
  'gate', 'station', 'dock', 'docked', 'undock', 'jump', 'jumped', 'spike', 'local', 'blue', 'blues',
  'gang', 'fleet', 'roam', 'roaming', 'bubble', 'bubbles', 'camp', 'camped', 'camping', 'gatecamp', 'inbound', 'system',
  'tackled', 'pointed', 'scrammed', 'dead', 'pod', 'podded', 'kill', 'killed', 'warpin', 'warp', 'align', 'aligned',
  'sitting', 'holding', 'staging', 'incoming', 'inc', 'coming', 'caps', 'subcaps', 'logi', 'dps', 'tackle',
])
function enemyCandidates(message: string): string[] {
  const words = message.replace(/https?:\/\/\S+/g, ' ').split(/[^A-Za-z0-9'-]+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= 3 && i + len <= words.length; len++) {
      const seq = words.slice(i, i + len)
      if (len === 1 && (STOP.has(seq[0].toLowerCase()) || seq[0].length < 3 || /^\d+$/.test(seq[0]))) continue
      const s = seq.join(' ')
      if (s.length < 3) continue
      if (isShipName(s)) continue                 // scheepsnaam (Retribution/Jackdaw/Keres/…) → geen enemy
      out.add(s)
    }
  }
  return [...out].slice(0, 50)
}

// Resolve de in de melding genoemde vijand → character/corp/alliance (gebatcht, gecached).
async function resolveEnemies(message: string) {
  if (_enemyCache.has(message)) return
  _enemyCache.set(message, null)
  const cands = enemyCandidates(message)
  if (!cands.length) { _enemyCache.set(message, []); return }
  try {
    const res = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cands),
    })
    const data = res.ok ? await res.json() : {}
    let enemies: EnemyEntity[] = []
    for (const a of data.alliances ?? [])    enemies.push({ kind: 'alliance',    id: a.id, name: a.name })
    for (const c of data.corporations ?? []) enemies.push({ kind: 'corporation', id: c.id, name: c.name })
    for (const ch of data.characters ?? [])  enemies.push({ kind: 'character',   id: ch.id, name: ch.name })

    // ESI /universe/ids/ matcht FUZZY (prefix): ["Rogue"] geeft ook "R O G U E" en
    // "Rogues Gallery". Alleen entiteiten houden waarvan de naam exact een kandidaat is.
    const candSet = new Set(cands.map(c => c.toLowerCase()))
    enemies = enemies.filter(e => candSet.has(e.name.toLowerCase()))

    // Dedup: een kortere naam die een aaneengesloten deel-frase is van een langere
    // match weglaten ("Sella" valt weg als "SeLLa 4" ook matcht). Langste eerst.
    const words = (s: string) => s.toLowerCase().split(/\s+/)
    const subPhrase = (a: string[], b: string[]) => {
      if (a.length >= b.length) return false
      for (let i = 0; i + a.length <= b.length; i++) {
        let ok = true
        for (let j = 0; j < a.length; j++) if (a[j] !== b[i + j]) { ok = false; break }
        if (ok) return true
      }
      return false
    }
    enemies.sort((x, y) => words(y.name).length - words(x.name).length)
    const kept: EnemyEntity[] = []
    for (const en of enemies) if (!kept.some(k => subPhrase(words(en.name), words(k.name)))) kept.push(en)
    enemies = kept

    // Elke entiteit verrijken met corp/alliance-id + tickers + alliance-naam.
    await Promise.all(enemies.map(async en => {
      try {
        if (en.kind === 'character') {
          const r = await fetch(`https://esi.evetech.net/latest/characters/${en.id}/?datasource=tranquility`).then(x => (x.ok ? x.json() : null))
          en.corpId = r?.corporation_id; en.allianceId = r?.alliance_id
        } else if (en.kind === 'corporation') {
          en.corpId = en.id; en.allianceId = (await corpInfo(en.id)).allianceId
        } else {
          en.allianceId = en.id
        }
        if (en.corpId) en.corpTicker = (await corpInfo(en.corpId)).ticker
        if (en.allianceId) { const ai = await allyInfo(en.allianceId); en.allianceTicker = ai.ticker; en.allianceName = ai.name }
      } catch { /* laat leeg */ }
    }))
    _enemyCache.set(message, enemies.slice(0, 8))
  } catch { _enemyCache.set(message, []) }
}

const MAX_AGE = 5 * 60 * 1000                     // ouder dan 5 min → van de kaart af

// LET OP: "nv"/"nvt" = No Visual (hostile niet zichtbaar, maar nog steeds intel!) → NIET clear.
// Alleen expliciete clear-meldingen verbergen de marker.
const CLEAR_RE  = /\b(clr|clear|safe)\b/i
const THREAT_RE = /\b(\d{1,3}\+?|carrier|carriers|dread|dreads|super|supers|titan|titans|fax|faxes|cyno|rorqual|recon|recons|battleship|battleships|bs|bc|bcs|logi|logis|bomber|bombers|hic|hics|dic|dics|blops|sabre|flycatcher|heretic|eris|proteus|tengu|loki|legion|rapier|arazu|huginn|curse|pilgrim|stiletto|crow|malediction|interceptor|interdictor|bubble|bubbles|spike|neut|neuts)\b/i
// Nullsec-systeemcode: 1–4 alfanumeriek, koppelteken, 1–4 alfanumeriek (bv. 6-AOLS,
// BKG-Q2, J9-5MQ, 1DH-SX, 9-4RP2). Mag met een cijfer beginnen; moet een letter bevatten
// (anders is "5-10" e.d. ook een match). Global → we zoeken de eerste geldige code.
const SYSTEM_RE = /\b([A-Z0-9]{1,4}-[A-Z0-9]{1,4})\b/g
function findSystem(message: string): string | null {
  for (const m of message.matchAll(SYSTEM_RE)) if (/[A-Z]/.test(m[1])) return m[1].toUpperCase()
  return null
}
const COUNT_RE  = /\b(\d{1,3})\+?\b/              // eerste getal in het bericht = gemeld aantal

export const INTEL_SUPPORTED = typeof window !== 'undefined' && !!(window as { showDirectoryPicker?: unknown }).showDirectoryPicker

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

async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('dir', 'readonly')
    const req = tx.objectStore('dir').get('chatlogs')
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null)
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

type PermHandle = FileSystemDirectoryHandle & {
  queryPermission:   (d: object) => Promise<string>
  requestPermission: (d: object) => Promise<string>
}

// EVE-bestandsnaam: "<Kanaalnaam>_YYYYMMDD_HHMMSS_<id>.txt".
const CHAN_RE = /^(.*)_\d{8}_\d{6}_\d+\.txt$/

async function scanDir(dir: FileSystemDirectoryHandle, prefixes: string[]):
  Promise<{ matched: FileSystemFileHandle[]; channels: Set<string> }> {
  const matched: FileSystemFileHandle[] = []
  const channels = new Set<string>()
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file' || !name.endsWith('.txt')) continue
    const cm = CHAN_RE.exec(name)
    if (cm) channels.add(cm[1])                       // alle aanwezige kanaalnamen verzamelen
    if (prefixes.some(ch => name.startsWith(ch + '_'))) matched.push(handle as FileSystemFileHandle)
  }
  return { matched, channels }
}

function parseLine(line: string): Omit<SystemIntel, never> | null {
  const m = line.match(/^\[ (\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) \] ([^>]+) > (.+)$/)
  if (!m) return null
  const [, rawTime, rawReporter, rawMsg] = m
  const reporter = rawReporter.trim()
  const message  = rawMsg.trim()
  if (reporter === 'EVE System') return null

  const system = findSystem(message)
  if (!system) return null                         // zonder (echt) systeem geen kaart-marker

  const [datePart, timePart] = rawTime.split(' ')
  const time = new Date(`${datePart.replace(/\./g, '-')}T${timePart}Z`).getTime()

  // Systeemcodes uit de melding strippen vóór tellen/threat — veel null-systemen beginnen
  // met een cijfer (5-P1Y2, 9-F7PZ), anders telt 'ie dat cijfer als "aantal".
  const rest = message.replace(SYSTEM_RE, ' ')
  const isClear  = CLEAR_RE.test(message)
  const isThreat = !isClear && THREAT_RE.test(rest)
  const count    = Number(COUNT_RE.exec(rest)?.[1] ?? 0)

  return {
    id: `${reporter}|${rawTime}|${message}`,
    system,
    threat: isClear ? 'clear' : isThreat ? 'threat' : 'unknown',
    time, count, message, reporter,
    ships: extractShips(message),
  }
}

export type IntelStatus = 'unsupported' | 'idle' | 'denied' | 'live'

export interface IntelDebug { files: number; entries: number; available: string[] }   // diagnose: gematchte bestanden, geparste meldingen, en álle aanwezige kanaalnamen

export interface IntelResult {
  systems: Record<string, SystemIntelGroup>
  status: IntelStatus
  connect: () => Promise<void>
  chooseFolder: () => Promise<void>
  debug: IntelDebug
}

const MAX_ENTRIES = 10                            // max meldingen per systeem in de lijst

// EVE-chatlogs zijn doorgaans UTF-16LE (met BOM). file.text() decodeert als UTF-8
// → onleesbaar. We bepalen de codering uit de BOM (kop) en lezen daarna alleen de
// STAART (recente regels zitten achteraan; window is toch 5 min) → veel snellere load.
const TAIL_BYTES = 512 * 1024
async function decodeFile(file: File): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
  let enc: 'utf-16le' | 'utf-16be' | 'utf-8' = 'utf-8'
  if (head[0] === 0xFF && head[1] === 0xFE) enc = 'utf-16le'
  else if (head[0] === 0xFE && head[1] === 0xFF) enc = 'utf-16be'
  let start = file.size > TAIL_BYTES ? file.size - TAIL_BYTES : 0
  if (enc !== 'utf-8' && start % 2 !== 0) start++           // even uitlijnen voor UTF-16
  const buf = await file.slice(start).arrayBuffer()
  return new TextDecoder(enc).decode(buf)                   // 1e (deel)regel wordt door parseLine genegeerd
}

export function useIntelSystems(active: boolean): IntelResult {
  const { intelChannels } = useSiteConfig()
  // Lege/witruimte-prefixes negeren; niets bruikbaars → terug naar de defaults.
  const cfg = intelChannels.map(c => c.prefix.trim()).filter(Boolean)
  const prefixes = cfg.length ? cfg : DEFAULT_INTEL_CHANNELS.map(c => c.prefix)
  const prefixKey = prefixes.join('|')                      // stabiele dep voor de effect

  const [intel, setIntel]   = useState<Record<string, SystemIntelGroup>>({})
  const [status, setStatus] = useState<IntelStatus>(INTEL_SUPPORTED ? 'idle' : 'unsupported')
  const [debug, setDebug]   = useState<IntelDebug>({ files: 0, entries: 0, available: [] })
  const bysystem  = useRef(new Map<string, Map<string, SystemIntel>>())  // system → (id → melding)
  const lastSize  = useRef(new Map<string, number>())
  const entryCount = useRef(0)                              // cumulatief geparste meldingen-met-systeem
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null)

  async function readOnce() {
    const handle = handleRef.current
    if (!handle) return
    await loadShipNames()                          // volledige scheepslijst klaar vóór het parsen
    const watch = prefixKey ? prefixKey.split('|') : []
    let filesMatched = 0
    let available: string[] = []
    try {
      const { matched: files, channels } = await scanDir(handle, watch)
      filesMatched = files.length
      available = [...channels].sort()
      for (const fh of files) {
        const file = await fh.getFile()
        const prev = lastSize.current.get(file.name) ?? 0
        if (file.size === prev) continue
        lastSize.current.set(file.name, file.size)
        const text = await decodeFile(file)
        for (const line of text.split('\n')) {
          const e = parseLine(line.trim())
          if (!e) continue
          entryCount.current++
          let inner = bysystem.current.get(e.system)
          if (!inner) { inner = new Map(); bysystem.current.set(e.system, inner) }
          if (!inner.has(e.id)) inner.set(e.id, e)   // dedup op regel-id
        }
      }
    } catch { setStatus('denied') }                 // map weg of permissie ingetrokken

    const cutoff = Date.now() - MAX_AGE
    const unresolved: string[] = []
    // Per vijand (character/corp/alliance) z'n NIEUWSTE locatie bijhouden → een naam
    // die elders opduikt verdwijnt automatisch van de oude plek. Ship-only/onbekende
    // meldingen blijven gewoon in hun eigen systeem staan.
    const enemyLatest = new Map<string, { entity: EnemyEntity; e: SystemIntel; system: string }>()
    const shipOnly: Array<{ system: string; e: SystemIntel }> = []
    for (const [sys, inner] of bysystem.current) {
      for (const [id, e] of inner) {
        if (e.time < cutoff) { inner.delete(id); continue }
        const enemies = _enemyCache.get(e.message)
        if (!_enemyCache.has(e.message)) unresolved.push(e.message)
        if (enemies && enemies.length) {
          for (const en of enemies) {
            const key = `${en.kind}:${en.id}`
            const cur = enemyLatest.get(key)
            if (!cur || e.time > cur.e.time) enemyLatest.set(key, { entity: en, e, system: sys })
          }
        } else {
          shipOnly.push({ system: sys, e })          // (nog) geen vijand-entiteit
        }
      }
      if (inner.size === 0) bysystem.current.delete(sys)
    }

    // Rijen per systeem opbouwen: vijand-rijen (op huidige locatie) + ship-only-rijen.
    const rows = new Map<string, SystemIntel[]>()
    const push = (sys: string, row: SystemIntel) => { const a = rows.get(sys); if (a) a.push(row); else rows.set(sys, [row]) }
    for (const { entity, e, system } of enemyLatest.values())
      push(system, { ...e, id: `${e.id}|${entity.kind}:${entity.id}`, enemies: [entity] })
    for (const { system, e } of shipOnly) push(system, e)

    const snap: Record<string, SystemIntelGroup> = {}
    for (const [sys, list] of rows) {
      const entries = list.sort((a, b) => b.time - a.time).slice(0, MAX_ENTRIES)
      const top = entries[0]
      snap[sys] = { system: sys, threat: top.threat, time: top.time, count: top.count, entries }
    }
    setIntel(snap)
    setDebug({ files: filesMatched, entries: entryCount.current, available })
    for (const msg of new Set(unresolved)) resolveEnemies(msg)   // vijand komt volgende poll mee
  }

  // Verbind (vereist een user-gesture): herverbind de opgeslagen map, of kies er één.
  async function connect() {
    if (!INTEL_SUPPORTED) return
    try {
      let h = await loadDirHandle()
      if (h) {
        const perm = await (h as PermHandle).requestPermission({ mode: 'read' })
        if (perm !== 'granted') h = null
      }
      if (!h) {
        h = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> })
          .showDirectoryPicker({ mode: 'read' })
        await saveDirHandle(h)
      }
      handleRef.current = h
      lastSize.current.clear()
      entryCount.current = 0
      bysystem.current.clear()
      setStatus('live')
      readOnce()
    } catch { /* geannuleerd */ }
  }

  // Forceer altijd de mapkiezer (om bewust de juiste Chatlogs-map te kiezen).
  async function chooseFolder() {
    if (!INTEL_SUPPORTED) return
    try {
      const h = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ mode: 'read' })
      await saveDirHandle(h)
      handleRef.current = h
      lastSize.current.clear()
      bysystem.current.clear()
      entryCount.current = 0
      setStatus('live')
      readOnce()
    } catch { /* geannuleerd */ }
  }

  useEffect(() => {
    if (!active || !INTEL_SUPPORTED) return
    let stop = false

    // Probeer stil te verbinden met een al-toegestane map (bv. via de Intel-pagina).
    loadDirHandle().then(async h => {
      if (stop) return
      if (!h) { setStatus('idle'); return }
      const perm = await (h as PermHandle).queryPermission({ mode: 'read' })
      if (perm === 'granted') { handleRef.current = h; setStatus('live'); readOnce() }
      else setStatus('denied')
    }).catch(() => {})

    const iv = setInterval(() => { if (!stop) readOnce() }, 1000)
    return () => { stop = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, prefixKey])

  return { systems: intel, status, connect, chooseFolder, debug }
}
