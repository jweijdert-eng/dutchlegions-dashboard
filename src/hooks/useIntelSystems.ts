import { useEffect, useRef, useState } from 'react'
import { useSiteConfig } from './useSiteConfig'
import { DEFAULT_INTEL_CHANNELS } from '../utils/intelChannels'

// Leest dezelfde EVE-chatlogs als de Intel-pagina (via de Chatlogs-map die daar
// gekoppeld is, opgeslagen in IndexedDB) en levert per systeem de meest recente
// intel-melding. Voor de fleet-kaart: rode markers met schip-/pilot-aantal.
// Werkt alleen op Chrome/Edge (File System Access API) en als de map al gekoppeld is.

export interface SystemIntel {
  system: string                                  // hoofdletters, zoals op de kaart
  threat: 'clear' | 'threat' | 'unknown'
  time: number                                    // ms (laatste melding)
  count: number                                   // gemeld aantal (pilots/schepen), 0 = onbekend
  message: string
  reporter: string
}

const MAX_AGE = 45 * 60 * 1000                    // ouder dan 45 min → van de kaart af

const CLEAR_RE  = /\b(nv|nvt|clr|clear|safe)\b/i
const THREAT_RE = /\b(\d{1,3}\+?|carrier|carriers|dread|dreads|super|supers|titan|titans|fax|faxes|cyno|rorqual|recon|recons|battleship|battleships|bs|bc|bcs|logi|logis|bomber|bombers|hic|hics|dic|dics|blops|sabre|flycatcher|heretic|eris|proteus|tengu|loki|legion|rapier|arazu|huginn|curse|pilgrim|stiletto|crow|malediction|interceptor|interdictor|bubble|bubbles|spike|neut|neuts)\b/i
const SYSTEM_RE = /\b([A-Z][A-Z0-9-]{2,}[A-Z0-9]|[A-Z][A-Z0-9]{2}-[A-Z][A-Z0-9]{1,2})\b/
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

async function findFiles(dir: FileSystemDirectoryHandle, prefixes: string[]): Promise<FileSystemFileHandle[]> {
  const out: FileSystemFileHandle[] = []
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file' || !name.endsWith('.txt')) continue
    if (prefixes.some(ch => name.startsWith(ch + '_'))) out.push(handle as FileSystemFileHandle)
  }
  return out
}

function parseLine(line: string): Omit<SystemIntel, never> | null {
  const m = line.match(/^\[ (\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) \] ([^>]+) > (.+)$/)
  if (!m) return null
  const [, rawTime, rawReporter, rawMsg] = m
  const reporter = rawReporter.trim()
  const message  = rawMsg.trim()
  if (reporter === 'EVE System') return null

  const sysMatch = SYSTEM_RE.exec(message)
  if (!sysMatch) return null                       // zonder systeem geen kaart-marker

  const [datePart, timePart] = rawTime.split(' ')
  const time = new Date(`${datePart.replace(/\./g, '-')}T${timePart}Z`).getTime()

  const isClear  = CLEAR_RE.test(message)
  const isThreat = !isClear && THREAT_RE.test(message)
  const count    = Number(COUNT_RE.exec(message)?.[1] ?? 0)

  return {
    system: sysMatch[1].toUpperCase(),
    threat: isClear ? 'clear' : isThreat ? 'threat' : 'unknown',
    time, count, message, reporter,
  }
}

export type IntelStatus = 'unsupported' | 'idle' | 'denied' | 'live'

export interface IntelDebug { files: number; entries: number }   // diagnose: gematchte bestanden + geparste meldingen-met-systeem

export interface IntelResult {
  systems: Record<string, SystemIntel>
  status: IntelStatus
  connect: () => Promise<void>
  debug: IntelDebug
}

// EVE-chatlogs zijn doorgaans UTF-16LE (met BOM). file.text() decodeert als UTF-8
// → onleesbaar. Hier kijken we naar de BOM en decoderen we juist.
async function decodeFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength))
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf)
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf)
  return new TextDecoder('utf-8').decode(buf)
}

export function useIntelSystems(active: boolean): IntelResult {
  const { intelChannels } = useSiteConfig()
  const prefixes = (intelChannels.length ? intelChannels : DEFAULT_INTEL_CHANNELS).map(c => c.prefix)
  const prefixKey = prefixes.join('|')                      // stabiele dep voor de effect

  const [intel, setIntel]   = useState<Record<string, SystemIntel>>({})
  const [status, setStatus] = useState<IntelStatus>(INTEL_SUPPORTED ? 'idle' : 'unsupported')
  const [debug, setDebug]   = useState<IntelDebug>({ files: 0, entries: 0 })
  const latest    = useRef(new Map<string, SystemIntel>())  // system → meest recente melding
  const lastSize  = useRef(new Map<string, number>())
  const entryCount = useRef(0)                              // cumulatief geparste meldingen-met-systeem
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null)

  async function readOnce() {
    const handle = handleRef.current
    if (!handle) return
    const watch = prefixKey ? prefixKey.split('|') : []
    let filesMatched = 0
    try {
      const files = await findFiles(handle, watch)
      filesMatched = files.length
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
          const cur = latest.current.get(e.system)
          if (!cur || e.time >= cur.time) latest.current.set(e.system, e)
        }
      }
    } catch { setStatus('denied') }                 // map weg of permissie ingetrokken

    const cutoff = Date.now() - MAX_AGE             // verlopen meldingen opruimen
    const snap: Record<string, SystemIntel> = {}
    for (const [sys, e] of latest.current) {
      if (e.time < cutoff) latest.current.delete(sys)
      else snap[sys] = e
    }
    setIntel(snap)
    setDebug({ files: filesMatched, entries: entryCount.current })
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

  return { systems: intel, status, connect, debug }
}
