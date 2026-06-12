import { useState, useEffect, useRef, useCallback } from 'react'
import { parseCombatLog, type CombatEvent } from '../utils/combatLogParser'

export interface LogFileInfo {
  name: string
  size: number
  mtime: number
}

export interface CombatLogState {
  events: CombatEvent[]
  fileName: string | null
  lastUpdated: Date | null
  isLive: boolean
  error: string | null
  serverAvailable: boolean
  logFiles: LogFileInfo[]
  openFile: () => Promise<void>
  selectFile: (name: string) => Promise<void>
  toggleLive: () => void
  clearEvents: () => void
}

async function fetchLog(file?: string): Promise<{ text: string; name: string; size: number }> {
  const url = file ? `/api/eve-log?file=${encodeURIComponent(file)}` : '/api/eve-log'
  const res = await fetch(url)
  if (!res.ok) throw new Error(await res.text())
  const text = await res.text()
  const name = res.headers.get('X-Log-File') ?? file ?? 'unknown'
  const size = parseInt(res.headers.get('X-Log-Size') ?? '0', 10)
  return { text, name, size }
}

async function fetchLogList(): Promise<LogFileInfo[]> {
  const res = await fetch('/api/eve-log/list')
  if (!res.ok) return []
  return res.json() as Promise<LogFileInfo[]>
}

export function useCombatLog(): CombatLogState {
  const [events, setEvents]             = useState<CombatEvent[]>([])
  const [fileName, setFileName]         = useState<string | null>(null)
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null)
  const [isLive, setIsLive]             = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [serverAvailable, setServerAvailable] = useState(false)
  const [logFiles, setLogFiles]         = useState<LogFileInfo[]>([])

  const activeFileRef  = useRef<string | null>(null)       // current file (API mode)
  const handleRef      = useRef<FileSystemFileHandle | null>(null) // File System API fallback
  const lastSizeRef    = useRef(0)
  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null)

  // Check if the dev server API is available and auto-load the latest file
  useEffect(() => {
    fetchLogList().then(files => {
      if (files.length === 0) return
      setServerAvailable(true)
      setLogFiles(files)
      // Auto-load the most recent file
      selectFileFromServer(files[0].name)
    }).catch(() => {
      setServerAvailable(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadFromServer = useCallback(async (file?: string) => {
    try {
      const { text, name, size } = await fetchLog(file)
      if (size === lastSizeRef.current && lastSizeRef.current > 0) return
      lastSizeRef.current = size
      setEvents(parseCombatLog(text))
      setFileName(name)
      setLastUpdated(new Date())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  function selectFileFromServer(name: string) {
    activeFileRef.current = name
    handleRef.current = null
    lastSizeRef.current = 0
    loadFromServer(name).catch(() => {})
  }

  const selectFile = useCallback(async (name: string) => {
    setIsLive(false)
    selectFileFromServer(name)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadFromServer])

  const openFile = useCallback(async () => {
    // Try File System Access API (works without dev server)
    if ('showOpenFilePicker' in window) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'EVE Log Files', accept: { 'text/plain': ['.txt', '.log'] } }],
          multiple: false,
        } as OpenFilePickerOptions)
        handleRef.current = handle
        activeFileRef.current = null
        setFileName(handle.name)
        lastSizeRef.current = 0
        setIsLive(false)
        const file = await handle.getFile()
        const text = await file.text()
        lastSizeRef.current = file.size
        setEvents(parseCombatLog(text))
        setLastUpdated(new Date())
        setError(null)
        return
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    // Fallback: plain <input>
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.log'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      setFileName(f.name)
      const text = await f.text()
      setEvents(parseCombatLog(text))
      setLastUpdated(new Date())
      lastSizeRef.current = text.length
      setError(null)
    }
    input.click()
  }, [])

  const toggleLive = useCallback(() => setIsLive(v => !v), [])

  const clearEvents = useCallback(() => {
    setEvents([])
    setLastUpdated(null)
    lastSizeRef.current = 0
    setIsLive(false)
  }, [])

  // Live polling
  useEffect(() => {
    if (!isLive) return
    const poll = async () => {
      if (activeFileRef.current !== null) {
        await loadFromServer(activeFileRef.current)
      } else if (handleRef.current) {
        try {
          const file = await handleRef.current.getFile()
          if (file.size === lastSizeRef.current) return
          lastSizeRef.current = file.size
          const text = await file.text()
          setEvents(parseCombatLog(text))
          setLastUpdated(new Date())
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    intervalRef.current = setInterval(() => { poll().catch(() => {}) }, 2000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isLive, loadFromServer])

  return { events, fileName, lastUpdated, isLive, error, serverAvailable, logFiles, openFile, selectFile, toggleLive, clearEvents }
}
