import { useEffect, useRef, useState } from 'react'

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

// Zelfde kanalen als de Intel-pagina.
const WATCH_CHANNELS = ['wc.Dek+Fa+PB', 'wc.Vale+Tr+Ge', 'wc.Venal+Br+Te']
const MAX_AGE = 20 * 60 * 1000                    // ouder dan 20 min → van de kaart af

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

type PermHandle = FileSystemDirectoryHandle & { queryPermission: (d: object) => Promise<string> }

async function findFiles(dir: FileSystemDirectoryHandle): Promise<FileSystemFileHandle[]> {
  const out: FileSystemFileHandle[] = []
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file' || !name.endsWith('.txt')) continue
    if (WATCH_CHANNELS.some(ch => name.startsWith(ch + '_'))) out.push(handle as FileSystemFileHandle)
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

export function useIntelSystems(active: boolean): Record<string, SystemIntel> {
  const [intel, setIntel] = useState<Record<string, SystemIntel>>({})
  const latest   = useRef(new Map<string, SystemIntel>())   // system → meest recente melding
  const lastSize = useRef(new Map<string, number>())

  useEffect(() => {
    if (!active || !INTEL_SUPPORTED) return
    let stop = false
    let handle: FileSystemDirectoryHandle | null = null

    async function poll() {
      if (!handle || stop) return
      try {
        const files = await findFiles(handle)
        for (const fh of files) {
          const file = await fh.getFile()
          const prev = lastSize.current.get(file.name) ?? 0
          if (file.size === prev) continue
          lastSize.current.set(file.name, file.size)
          const text = await file.text()
          for (const line of text.split('\n')) {
            const e = parseLine(line.trim())
            if (!e) continue
            const cur = latest.current.get(e.system)
            if (!cur || e.time >= cur.time) latest.current.set(e.system, e)
          }
        }
      } catch { /* map weg of permissie ingetrokken */ }

      // Verlopen meldingen opruimen + snapshot naar de UI.
      const cutoff = Date.now() - MAX_AGE
      const snap: Record<string, SystemIntel> = {}
      for (const [sys, e] of latest.current) {
        if (e.time < cutoff) latest.current.delete(sys)
        else snap[sys] = e
      }
      if (!stop) setIntel(snap)
    }

    loadDirHandle().then(async h => {
      if (!h) return
      const perm = await (h as PermHandle).queryPermission({ mode: 'read' })
      if (perm !== 'granted') return                // koppelen/herverbinden gebeurt op de Intel-pagina
      handle = h
      poll()
    }).catch(() => {})

    const iv = setInterval(poll, 3000)
    return () => { stop = true; clearInterval(iv) }
  }, [active])

  return intel
}
