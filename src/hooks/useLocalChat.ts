import { useCallback, useEffect, useRef, useState } from 'react'

// Leest EVE Local-chat rechtstreeks in de browser via de File System Access API.
// Geen lokale server nodig: het lid kiest één keer zijn Chatlogs-map, de handle
// wordt in IndexedDB bewaard zodat het daarna automatisch gaat.

export interface ChatMsg {
  type: 'message'
  time: string
  sender: string
  message: string
}

export type LocalChatStatus =
  | 'unsupported'   // browser zonder File System Access API
  | 'idle'          // nog geen map gekozen
  | 'needs-permission' // map bekend, maar toestemming opnieuw nodig (user-gesture)
  | 'watching'      // actief aan het volgen
  | 'no-file'       // map gekozen maar geen Local_*.txt gevonden

export interface LocalChatState {
  messages: ChatMsg[]
  status: LocalChatStatus
  fileName: string | null
  error: string | null
  supported: boolean             // map-picker (File System Access API directory)
  supportedFile: boolean         // los-bestand live-picker (showOpenFilePicker) — werkt o.a. in Opera
  manual: boolean                // huidige data komt uit een handmatig gekozen bestand (snapshot)
  connect: () => Promise<void>   // opent picker of herstelt toestemming (user-gesture vereist)
  pickFolder: () => Promise<void> // forceer altijd de map-picker
  pickFile: () => Promise<void>   // kies één logbestand, wél live (poll op de handle)
  loadFiles: (files: FileList | File[]) => Promise<void> // fallback: handmatig bestand(en) kiezen (alle browsers)
  clear: () => void
}

const MAX_MESSAGES = 1000
// Zelfde patroon als de Python-server: [ 2024.01.12 14:30:00 ] Naam > Bericht
const MSG_RE = /^\[ (\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}) \] (.+?) > (.+)$/
const POLL_MS = 1500
const RESCAN_EVERY = 7 // elke ~10s opnieuw naar het nieuwste bestand zoeken (sessie-rollover)

// ── IndexedDB: bewaar de directory-handle zodat de map maar één keer hoeft ──
const IDB_NAME = 'eve-dashboard'
const IDB_STORE = 'fs-handles'
const IDB_KEY = 'chatlogs-dir'

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGetHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIdb()
    return await new Promise((resolve) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function idbSetHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* negeren */
  }
}

// ── EVE-logs zijn UTF-16LE met BOM; combat-logs zijn UTF-8. Detecteer en decodeer. ──
function decodeEveLog(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2))
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3))
  // Geen BOM: heuristiek — veel NUL-bytes wijst op UTF-16LE
  let nul = 0
  const sample = Math.min(b.length, 512)
  for (let i = 0; i < sample; i++) if (b[i] === 0) nul++
  if (sample > 0 && nul / sample > 0.2) return new TextDecoder('utf-16le').decode(b)
  return new TextDecoder('utf-8').decode(b)
}

function parseChat(text: string): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = MSG_RE.exec(raw.trim())
    if (m) {
      // 2024.01.12 14:30:00 -> 2024-01-12T14:30:00 (zelfde als Python-server)
      const time = m[1].replace('.', '-').replace('.', '-').replace(' ', 'T')
      out.push({ type: 'message', time, sender: m[2], message: m[3] })
    }
  }
  return out.length > MAX_MESSAGES ? out.slice(-MAX_MESSAGES) : out
}

async function findLatestLocalFile(dir: FileSystemDirectoryHandle): Promise<FileSystemFileHandle | null> {
  let latest: FileSystemFileHandle | null = null
  let latestM = -1
  // dir.values() is een async-iterator; typing ontbreekt soms in de TS-lib.
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === 'file' && /^Local_.*\.txt$/i.test(entry.name)) {
      const fh = entry as FileSystemFileHandle
      const f = await fh.getFile()
      if (f.lastModified > latestM) {
        latestM = f.lastModified
        latest = fh
      }
    }
  }
  return latest
}

type PermStatus = 'granted' | 'denied' | 'prompt'
async function queryPerm(handle: FileSystemDirectoryHandle): Promise<PermStatus> {
  const h = handle as unknown as { queryPermission(d: { mode: 'read' }): Promise<PermStatus> }
  try {
    return await h.queryPermission({ mode: 'read' })
  } catch {
    return 'prompt'
  }
}
async function requestPerm(handle: FileSystemDirectoryHandle): Promise<PermStatus> {
  const h = handle as unknown as { requestPermission(d: { mode: 'read' }): Promise<PermStatus> }
  try {
    return await h.requestPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

export function useLocalChat(): LocalChatState {
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  const supportedFile = typeof window !== 'undefined' && 'showOpenFilePicker' in window

  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [status, setStatus] = useState<LocalChatStatus>(supported ? 'idle' : 'unsupported')
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)  // data via handmatige bestand-keuze (geen live-watch)

  const dirRef = useRef<FileSystemDirectoryHandle | null>(null)
  const fileRef = useRef<FileSystemFileHandle | null>(null)
  const lastSizeRef = useRef(0)
  const tickRef = useRef(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopWatching = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
  }, [])

  const readCurrent = useCallback(async () => {
    const fh = fileRef.current
    if (!fh) return
    const f = await fh.getFile()
    if (f.size === lastSizeRef.current && lastSizeRef.current > 0) return
    lastSizeRef.current = f.size
    const text = decodeEveLog(await f.arrayBuffer())
    setMessages(parseChat(text))
    setError(null)
  }, [])

  const tick = useCallback(async () => {
    const dir = dirRef.current
    if (!dir) return
    try {
      // Periodiek opnieuw zoeken naar het nieuwste bestand (EVE rolt per sessie)
      if (tickRef.current % RESCAN_EVERY === 0) {
        const latest = await findLatestLocalFile(dir)
        if (!latest) {
          setStatus('no-file')
          setFileName(null)
          fileRef.current = null
          tickRef.current++
          return
        }
        if (latest.name !== fileRef.current?.name) {
          fileRef.current = latest
          lastSizeRef.current = 0
          setFileName(latest.name)
        }
        setStatus('watching')
      }
      tickRef.current++
      await readCurrent()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [readCurrent])

  const startWatching = useCallback(
    async (dir: FileSystemDirectoryHandle) => {
      setManual(false)
      dirRef.current = dir
      fileRef.current = null
      lastSizeRef.current = 0
      tickRef.current = 0
      stopWatching()
      await tick()
      intervalRef.current = setInterval(() => {
        tick().catch(() => {})
      }, POLL_MS)
    },
    [stopWatching, tick],
  )

  // Live volgen van één los gekozen bestand (showOpenFilePicker geeft een handle die
  // we herhaald mogen lezen → picks up appends, in tegenstelling tot een <input> File).
  const startWatchingFile = useCallback(
    async (handle: FileSystemFileHandle) => {
      setManual(false)
      dirRef.current = null
      fileRef.current = handle
      lastSizeRef.current = 0
      setFileName(handle.name)
      setStatus('watching')
      stopWatching()
      await readCurrent()
      intervalRef.current = setInterval(() => { readCurrent().catch(() => {}) }, POLL_MS)
    },
    [stopWatching, readCurrent],
  )

  const pickFile = useCallback(async () => {
    const w = window as unknown as { showOpenFilePicker?: (o?: object) => Promise<FileSystemFileHandle[]> }
    if (!w.showOpenFilePicker) { setError('Deze browser ondersteunt geen live bestand-keuze.'); return }
    try {
      const [handle] = await w.showOpenFilePicker({
        startIn: 'documents',
        types: [{ description: 'EVE chatlog', accept: { 'text/plain': ['.txt'] } }],
      })
      if (handle) { setError(null); await startWatchingFile(handle) }
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [startWatchingFile])

  const pickFolder = useCallback(async () => {
    if (!supported) return
    try {
      const picker = (window as unknown as {
        showDirectoryPicker(opts?: { id?: string; mode?: 'read'; startIn?: string }): Promise<FileSystemDirectoryHandle>
      }).showDirectoryPicker
      const dir = await picker({ id: 'eve-chatlogs', mode: 'read', startIn: 'documents' })
      await idbSetHandle(dir)
      setError(null)
      await startWatching(dir)
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [supported, startWatching])

  // connect: probeer eerst de opgeslagen map (na user-gesture toestemming herstellen), anders picker
  const connect = useCallback(async () => {
    if (!supported) return
    const stored = await idbGetHandle()
    if (stored) {
      const perm = (await queryPerm(stored)) === 'granted' ? 'granted' : await requestPerm(stored)
      if (perm === 'granted') {
        await startWatching(stored)
        return
      }
    }
    await pickFolder()
  }, [supported, startWatching, pickFolder])

  // Bij laden: stille poging op de opgeslagen map (zonder prompt). Lukt alleen
  // als toestemming nog 'granted' is; anders tonen we een knop (needs-permission).
  useEffect(() => {
    if (!supported) return
    let alive = true
    ;(async () => {
      const stored = await idbGetHandle()
      if (!alive) return
      if (!stored) {
        setStatus('idle')
        return
      }
      const perm = await queryPerm(stored)
      if (!alive) return
      if (perm === 'granted') {
        await startWatching(stored)
      } else {
        setStatus('needs-permission')
      }
    })()
    return () => {
      alive = false
      stopWatching()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported])

  // Fallback voor browsers zonder File System Access API (Firefox/Safari): laat het
  // lid zelf zijn Local_*.txt kiezen via een gewone <input type=file>. Geen live-watch
  // mogelijk — het nieuwste gekozen bestand wordt geparsed; opnieuw kiezen = verversen.
  const loadFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files)
    if (arr.length === 0) return
    // Kies bij voorkeur een Local_*.txt; anders het nieuwste .txt-bestand.
    const candidates = arr.filter(f => /^Local_.*\.txt$/i.test(f.name))
    const pool = candidates.length > 0 ? candidates : arr.filter(f => /\.txt$/i.test(f.name))
    if (pool.length === 0) {
      setError('Geen Local_*.txt gevonden in je selectie. Kies het juiste logbestand uit je Chatlogs-map.')
      setStatus('no-file')
      return
    }
    const file = pool.reduce((a, b) => (b.lastModified > a.lastModified ? b : a))
    try {
      stopWatching()        // eventuele FS-poll stoppen; fallback is een momentopname
      dirRef.current = null
      const text = decodeEveLog(await file.arrayBuffer())
      setMessages(parseChat(text))
      setFileName(file.name)
      setStatus('watching')
      setManual(true)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [stopWatching])

  const clear = useCallback(() => {
    setMessages([])
    lastSizeRef.current = 0
  }, [])

  return { messages, status, fileName, error, supported, supportedFile, manual, connect, pickFolder, pickFile, loadFiles, clear }
}
