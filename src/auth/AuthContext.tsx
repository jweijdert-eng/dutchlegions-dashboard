import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { refreshAccessToken, type TokenData } from './sso'

interface AuthContextValue {
  tokens: TokenData[]
  activeTokens: TokenData[]
  selectedCharId: number | null
  setSelectedCharId: (id: number | null) => void
  mainCharId: number | null
  setMainCharId: (id: number | null) => void
  addToken: (token: TokenData) => void
  removeToken: (characterId: number) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const STORAGE_KEY = 'eve_tokens'
const MAIN_KEY    = 'eve_main_char'

function loadTokens(): TokenData[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as TokenData[] }
  catch { return [] }
}

function loadMainCharId(): number | null {
  const v = localStorage.getItem(MAIN_KEY)
  return v ? Number(v) : null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens]                 = useState<TokenData[]>(loadTokens)
  const [mainCharId, setMainCharIdState]    = useState<number | null>(loadMainCharId)
  const [selectedCharId, setSelectedCharId] = useState<number | null>(loadMainCharId)
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const setMainCharId = useCallback((id: number | null) => {
    setMainCharIdState(id)
    if (id !== null) {
      localStorage.setItem(MAIN_KEY, String(id))
      setSelectedCharId(id)
    } else {
      localStorage.removeItem(MAIN_KEY)
    }
  }, [])

  // If selected char is removed, reset to all; also clear main if removed
  useEffect(() => {
    if (selectedCharId && !tokens.find(t => t.characterId === selectedCharId)) {
      setSelectedCharId(null)
    }
    if (mainCharId && !tokens.find(t => t.characterId === mainCharId)) {
      setMainCharIdState(null)
      localStorage.removeItem(MAIN_KEY)
    }
  }, [tokens, selectedCharId, mainCharId])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens))
  }, [tokens])

  async function doRefresh() {
    const now = Date.now()
    const current = tokensRef.current
    const needsRefresh = current.filter(t => t.expiresAt - now < 5 * 60 * 1000)
    if (needsRefresh.length === 0) return
    const refreshed = await Promise.all(
      needsRefresh.map(t => refreshAccessToken(t).catch(() => t))
    )
    setTokens(prev =>
      prev.map(t => refreshed.find(r => r.characterId === t.characterId) ?? t)
    )
  }

  // Refresh direct bij laden (verlopen tokens na page reload)
  useEffect(() => { doRefresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => { doRefresh() }, 60_000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat: update last_seen elke 5 minuten zolang de gebruiker op de site zit
  useEffect(() => {
    function sendHeartbeat() {
      for (const t of tokensRef.current) {
        fetch('/api/checkin.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ characterId: t.characterId, name: t.characterName }),
        }).catch(() => {})
      }
    }
    const id = setInterval(sendHeartbeat, 5 * 60_000)
    return () => clearInterval(id)
  }, [])

  const addToken = useCallback((token: TokenData) => {
    setTokens(prev => [...prev.filter(t => t.characterId !== token.characterId), token])
    // Register member in database
    fetch('/api/checkin.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: token.characterId, name: token.characterName }),
    }).catch(() => { /* ignore */ })
  }, [])

  const removeToken = useCallback((characterId: number) => {
    setTokens(prev => prev.filter(t => t.characterId !== characterId))
  }, [])

  const activeTokens = selectedCharId
    ? tokens.filter(t => t.characterId === selectedCharId)
    : tokens

  return (
    <AuthContext.Provider value={{ tokens, activeTokens, selectedCharId, setSelectedCharId, mainCharId, setMainCharId, addToken, removeToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
