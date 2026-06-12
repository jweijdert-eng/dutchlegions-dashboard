import { useEffect, useRef, useState, useCallback } from 'react'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'
import { useEsiStandings, type EsiStanding } from '../hooks/useEsiStandings'
import { getStandings, setStanding, type Standing } from '../utils/localStandings'

interface ChatMsg {
  type: 'message'
  time: string
  sender: string
  message: string
}

interface StatusMsg {
  type: 'status'
  file: string | null
}

type WsMsg = ChatMsg | StatusMsg

const TD: React.CSSProperties = { padding: '0.28rem 0.6rem', verticalAlign: 'top' }

const COLORS = [
  'var(--blue)', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#4ade80',
]

function hashColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return COLORS[Math.abs(hash) % COLORS.length]
}

function effectiveStanding(name: string, ownNames: string[], esi: EsiStanding, manual: Record<string, Standing>): EsiStanding | 'own' {
  if (ownNames.some(n => n.toLowerCase() === name.toLowerCase())) return 'own'
  return manual[name] ?? esi
}

function standingColor(s: EsiStanding | 'own', fallback: string): string {
  if (s === 'own')    return 'var(--gold)'
  if (s === 'friend') return 'var(--green)'
  if (s === 'enemy')  return 'var(--red)'
  return fallback
}

function rowBg(s: EsiStanding | 'own', isMention: boolean, alt: boolean): string {
  if (s === 'enemy')  return 'rgba(224,85,85,0.09)'
  if (s === 'friend') return 'rgba(62,207,110,0.07)'
  if (isMention)      return 'rgba(240,192,64,0.06)'
  return alt ? 'rgba(15,15,34,0.35)' : 'transparent'
}

interface ContextMenu { x: number; y: number; name: string }

export default function LocalChat() {
  const { tokens, mainCharId } = useAuth()
  const ownNames    = tokens.map(t => t.characterName)
  const activeToken = tokens.find(t => t.characterId === mainCharId) ?? tokens[0]

  const [messages,     setMessages]     = useState<ChatMsg[]>([])
  const [connStatus,   setConnStatus]   = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [file,         setFile]         = useState<string | null>(null)
  const [search,       setSearch]       = useState('')
  const [onlyMentions, setOnlyMentions] = useState(false)
  const [manuals,      setManuals]      = useState<Record<string, Standing>>(getStandings)
  const [contextMenu,  setContextMenu]  = useState<ContextMenu | null>(null)
  const [filter,       setFilter]       = useState<EsiStanding | null>(null)

  const bottomRef    = useRef<HTMLDivElement>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const userScrolled = useRef(false)
  const listRef      = useRef<HTMLDivElement>(null)
  const seenSenders  = useRef<Map<string, number>>(new Map())
  const notifiedRef  = useRef(false)

  const getEsiStanding = useEsiStandings(activeToken)

  useEffect(() => {
    let alive = true
    function connect() {
      if (!alive) return
      setConnStatus('connecting')
      const ws = new WebSocket('ws://localhost:8765')
      wsRef.current = ws
      ws.onopen  = () => setConnStatus('connected')
      ws.onclose = () => { setConnStatus('disconnected'); if (alive) setTimeout(connect, 3000) }
      ws.onerror = () => ws.close()
      ws.onmessage = e => {
        const msg = JSON.parse(e.data as string) as WsMsg
        if (msg.type === 'status') {
          setFile(msg.file)
        } else {
          seenSenders.current.set(msg.sender, (seenSenders.current.get(msg.sender) ?? 0) + 1)
          const isMention = ownNames.some(n =>
            msg.message.toLowerCase().includes(n.toLowerCase()) ||
            msg.sender.toLowerCase() === n.toLowerCase()
          )
          if (isMention && Notification.permission === 'granted') {
            new Notification(`Local: ${msg.sender}`, { body: msg.message, icon: '/favicon.ico' })
          }
          setMessages(prev => [...prev.slice(-999), msg])
        }
      }
    }

    if (Notification.permission === 'default' && !notifiedRef.current) {
      notifiedRef.current = true
      Notification.requestPermission()
    }
    connect()
    return () => { alive = false; wsRef.current?.close() }
  }, [])

useEffect(() => {
    if (!userScrolled.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    userScrolled.current = el.scrollHeight - el.scrollTop - el.clientHeight > 80
  }

  const closeMenu = useCallback(() => setContextMenu(null), [])
  useEffect(() => {
    if (!contextMenu) return
    window.addEventListener('mousedown', closeMenu)
    return () => window.removeEventListener('mousedown', closeMenu)
  }, [contextMenu, closeMenu])

  function openMenu(e: React.MouseEvent, name: string) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, name })
  }

  function applyManual(name: string, standing: Standing | null) {
    setStanding(name, standing)
    setManuals(getStandings())
    setContextMenu(null)
  }

  const displayed = messages.filter(m => {
    const esi      = getEsiStanding(m.sender)
    const standing = effectiveStanding(m.sender, ownNames, esi, manuals)
    if (filter && standing !== filter) return false
    if (onlyMentions && !ownNames.some(n =>
      m.message.toLowerCase().includes(n.toLowerCase()) ||
      m.sender.toLowerCase() === n.toLowerCase()
    )) return false
    if (search) {
      const q = search.toLowerCase()
      if (!m.sender.toLowerCase().includes(q) && !m.message.toLowerCase().includes(q)) return false
    }
    return true
  })

  function highlight(text: string): React.ReactNode {
    if (!search) return text
    const idx = text.toLowerCase().indexOf(search.toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{ background: 'rgba(240,192,64,0.3)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>
          {text.slice(idx, idx + search.length)}
        </mark>
        {text.slice(idx + search.length)}
      </>
    )
  }

  const statusColor = connStatus === 'connected' ? 'var(--green)' : connStatus === 'connecting' ? 'var(--gold)' : 'var(--red)'
  const statusLabel = connStatus === 'connected' ? '● Verbonden' : connStatus === 'connecting' ? '● Verbinden...' : '● Verbroken'
  const uniqueSenders = seenSenders.current.size

  return (
    <>
      <Layout header={
        <PageHeader
          title="Local Chat"
          sub={file ?? 'Geen logbestand gevonden'}
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              {uniqueSenders > 0 && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{uniqueSenders} spelers</span>
              )}
              {messages.length > 0 && (
                <button
                  onClick={() => { setMessages([]); seenSenders.current.clear(); userScrolled.current = false }}
                  style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
                >Wissen</button>
              )}
              <span style={{ fontSize: '0.68rem', fontWeight: 600, color: statusColor }}>{statusLabel}</span>
            </div>
          }
        />
      }>
        {connStatus === 'disconnected' && (
          <div style={{ background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.3)', borderRadius: 3, padding: '0.75rem 1rem', marginBottom: '0.75rem', fontSize: '0.75rem', color: 'var(--red)', lineHeight: 1.6 }}>
            Geen verbinding. Start de lokale server:<br />
            <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0.15rem 0.4rem', borderRadius: 2, fontSize: '0.72rem' }}>
              localserver/start.bat
            </code>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
          <input
            type="text"
            placeholder="Zoek speler of bericht..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.6rem', outline: 'none' }}
          />
          <button
            onClick={() => setOnlyMentions(m => !m)}
            style={{
              padding: '0.3rem 0.6rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              background: onlyMentions ? 'rgba(240,192,64,0.12)' : 'transparent',
              border: `1px solid ${onlyMentions ? 'var(--gold)' : 'var(--border)'}`,
              color: onlyMentions ? 'var(--gold)' : 'var(--text-dim)',
            }}
          >@ Mentions</button>
          <button
            onClick={() => setFilter(f => f === 'friend' ? null : 'friend')}
            style={{
              padding: '0.3rem 0.6rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              background: filter === 'friend' ? 'rgba(62,207,110,0.12)' : 'transparent',
              border: `1px solid ${filter === 'friend' ? 'var(--green)' : 'var(--border)'}`,
              color: filter === 'friend' ? 'var(--green)' : 'var(--text-dim)',
            }}
          >▲ Vrienden</button>
          <button
            onClick={() => setFilter(f => f === 'enemy' ? null : 'enemy')}
            style={{
              padding: '0.3rem 0.6rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              background: filter === 'enemy' ? 'rgba(224,85,85,0.12)' : 'transparent',
              border: `1px solid ${filter === 'enemy' ? 'var(--red)' : 'var(--border)'}`,
              color: filter === 'enemy' ? 'var(--red)' : 'var(--text-dim)',
            }}
          >▼ Vijanden</button>
          {(search || onlyMentions || filter) && (
            <button
              onClick={() => { setSearch(''); setOnlyMentions(false); setFilter(null) }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '0.68rem', cursor: 'pointer' }}
            >✕</button>
          )}
        </div>

        <div
          ref={listRef}
          onScroll={onScroll}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflowY: 'auto', height: 'calc(100vh - 175px)' }}
        >
          {displayed.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem', padding: '3rem' }}>
              {connStatus === 'connected'
                ? (search || onlyMentions || filter ? 'Geen resultaten' : 'Wachtend op berichten in Local...')
                : 'Geen verbinding'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {displayed.map((m, i) => {
                  const esi      = getEsiStanding(m.sender)
                  const standing = effectiveStanding(m.sender, ownNames, esi, manuals)
                  const count    = seenSenders.current.get(m.sender) ?? 1
                  const isMention = standing !== 'own' && ownNames.some(n => m.message.toLowerCase().includes(n.toLowerCase()))
                  const bg       = rowBg(standing, isMention, i % 2 === 1)
                  const color    = standingColor(standing, hashColor(m.sender))

                  return (
                    <tr key={i} style={{ background: bg }}>
                      <td style={{ ...TD, width: 72, color: 'var(--text-dim)', fontSize: '0.63rem', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                        {m.time.slice(11)}
                      </td>
                      <td style={{ ...TD, width: 170, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170, borderLeft: standing === 'enemy' ? '2px solid var(--red)' : standing === 'friend' ? '2px solid var(--green)' : isMention ? '2px solid var(--gold)' : '2px solid transparent' }}>
                        <span
                          onContextMenu={e => standing !== 'own' && openMenu(e, m.sender)}
                          title={standing !== 'own' ? 'Rechtermuisknop voor handmatige override' : undefined}
                          style={{ fontWeight: 600, fontSize: '0.72rem', color, cursor: standing !== 'own' ? 'context-menu' : 'default' }}
                        >
                          {standing === 'friend' && <span style={{ marginRight: '0.2rem', fontSize: '0.55rem' }}>▲</span>}
                          {standing === 'enemy'  && <span style={{ marginRight: '0.2rem', fontSize: '0.55rem' }}>▼</span>}
                          {highlight(m.sender)}
                          {manuals[m.sender] && <span style={{ fontSize: '0.5rem', marginLeft: '0.2rem', opacity: 0.5 }}>✎</span>}
                        </span>
                        {count > 2 && standing !== 'own' && (
                          <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginLeft: '0.3rem' }}>×{count}</span>
                        )}
                      </td>
                      <td style={{ ...TD, fontSize: '0.75rem', color: isMention ? 'var(--gold)' : 'var(--text)', wordBreak: 'break-word' }}>
                        {highlight(m.message)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <div ref={bottomRef} />
        </div>
      </Layout>

      {contextMenu && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 1000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: '0 4px 16px rgba(0,0,0,0.5)', minWidth: 190, overflow: 'hidden' }}
        >
          <div style={{ padding: '0.35rem 0.65rem', fontSize: '0.6rem', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)', letterSpacing: '0.1em' }}>
            {contextMenu.name} — handmatige override
          </div>
          {(['friend', 'enemy', null] as (Standing | null)[]).map(s => {
            const current = manuals[contextMenu.name]
            const active  = current === s || (s === null && current === undefined)
            const label   = s === 'friend' ? '▲ Altijd vriend' : s === 'enemy' ? '▼ Altijd vijand' : '— ESI standing gebruiken'
            const color   = s === 'friend' ? 'var(--green)' : s === 'enemy' ? 'var(--red)' : 'var(--text-dim)'
            return (
              <div
                key={String(s)}
                onClick={() => applyManual(contextMenu.name, s)}
                style={{
                  padding: '0.45rem 0.65rem', fontSize: '0.72rem', cursor: 'pointer',
                  color: active ? color : 'var(--text)',
                  background: active ? (s === 'friend' ? 'rgba(62,207,110,0.1)' : s === 'enemy' ? 'rgba(224,85,85,0.1)' : 'rgba(255,255,255,0.04)') : 'transparent',
                  fontWeight: active ? 700 : 400,
                  borderBottom: s !== null ? '1px solid rgba(28,28,53,0.5)' : 'none',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)' }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                {label}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
