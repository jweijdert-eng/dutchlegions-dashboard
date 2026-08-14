import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useAuth } from '../auth/AuthContext'
import Layout, { PageHeader } from '../components/Layout'
import { useEsiStandings } from '../hooks/useEsiStandings'
import { getStandings, setStanding, type Standing } from '../utils/localStandings'
import { effectiveStanding, standingColor, rowBg, isVriendelijk, standingTeken, standingUitleg } from '../utils/standingView'
import { useLocalChat } from '../hooks/useLocalChat'
import { useMemberSettings, setMemberSettings } from '../utils/memberSettings'
import { useTranslate } from '../utils/translate'
import TopKillersTicker from '../components/TopKillersTicker'

const TD: React.CSSProperties = { padding: '0.28rem 0.6rem', verticalAlign: 'top' }

const COLORS = [
  'var(--blue)', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#4ade80',
]

function hashColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return COLORS[Math.abs(hash) % COLORS.length]
}

interface ContextMenu { x: number; y: number; name: string }

export default function LocalChat() {
  const { tokens, mainCharId } = useAuth()
  const member      = useMemberSettings()
  const ownNames    = useMemo(() => tokens.map(t => t.characterName), [tokens])
  const activeToken = tokens.find(t => t.characterId === mainCharId) ?? tokens[0]

  const { messages, status, fileName: file, supported, supportedFile, manual, connect, pickFile, loadFiles, clear } = useLocalChat()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [search,       setSearch]       = useState('')
  const [onlyMentions, setOnlyMentions] = useState(false)
  const [manuals,      setManuals]      = useState<Record<string, Standing>>(getStandings)
  const [contextMenu,  setContextMenu]  = useState<ContextMenu | null>(null)
  const [filter,       setFilter]       = useState<'friend' | 'enemy' | null>(null)

  const userScrolled = useRef(false)
  const listRef      = useRef<HTMLDivElement>(null)
  const notifiedRef  = useRef(false)
  const lastSigRef   = useRef<string | null>(null)

  const getEsiStanding = useEsiStandings(activeToken)
  const tr = useTranslate(member.translate, member.translateLang)

  // Aantal berichten per speler — afgeleid van de huidige berichtenlijst
  const senderCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const msg of messages) m.set(msg.sender, (m.get(msg.sender) ?? 0) + 1)
    return m
  }, [messages])

  // Vraag éénmalig om notificatie-toestemming
  useEffect(() => {
    if (Notification.permission === 'default' && !notifiedRef.current) {
      notifiedRef.current = true
      Notification.requestPermission()
    }
  }, [])

  // Desktop-notificatie bij een nieuwe mention (alleen voor écht nieuwe berichten,
  // niet voor de history die al in het bestand stond bij openen)
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    const sig = `${last.time}|${last.sender}|${last.message}`
    if (lastSigRef.current === sig) return
    const wasInitial = lastSigRef.current === null
    lastSigRef.current = sig
    if (wasInitial) return
    const isMention = ownNames.some(n =>
      last.message.toLowerCase().includes(n.toLowerCase()) ||
      last.sender.toLowerCase() === n.toLowerCase()
    )
    if (isMention && member.notifications && Notification.permission === 'granted') {
      new Notification(`Local: ${last.sender}`, { body: last.message, icon: '/favicon.ico' })
    }
  }, [messages, ownNames, member.notifications])

useEffect(() => {
    // Nieuwste bovenaan: spring naar boven bij een nieuw bericht, tenzij de gebruiker
    // naar beneden heeft gescrold om oudere berichten te lezen.
    if (!userScrolled.current && listRef.current) listRef.current.scrollTop = 0
  }, [messages])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    userScrolled.current = el.scrollTop > 80
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
    if (filter === 'friend' && !isVriendelijk(standing)) return false
    if (filter === 'enemy' && standing !== 'enemy') return false
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

  // Handmatig geladen bestand = momentopname, geen live-feed (ongeacht de browser).
  const manualMode = manual && status === 'watching'
  const statusColor = manualMode ? 'var(--gold)' : status === 'watching' ? 'var(--green)' : status === 'no-file' ? 'var(--gold)' : 'var(--red)'
  const statusLabel =
    manualMode                    ? '● Handmatig (snapshot)'
    : status === 'watching'       ? '● Live'
    : status === 'no-file'        ? '● Geen logbestand'
    : status === 'unsupported'    ? '● Niet ondersteund'
    : status === 'needs-permission' ? '● Toegang nodig'
    : '● Niet verbonden'
  const uniqueSenders = senderCounts.size

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
                  onClick={() => { clear(); userScrolled.current = false }}
                  style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
                >Wissen</button>
              )}
              <span style={{ fontSize: '0.68rem', fontWeight: 600, color: statusColor }}>{statusLabel}</span>
            </div>
          }
        />
      }>
        {/* Verborgen bestand-kiezer voor de fallback (werkt in alle browsers) */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt"
          multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) loadFiles(e.target.files).catch(() => {}); e.target.value = '' }}
        />

        {!supported && (
          <div style={{ background: 'rgba(240,192,64,0.07)', border: '1px solid rgba(240,192,64,0.3)', borderRadius: 3, padding: '0.85rem 1rem', marginBottom: '0.75rem', fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.6 }}>
            <div style={{ marginBottom: '0.55rem' }}>
              <strong style={{ color: 'var(--gold)' }}>Map-keuze werkt niet in deze browser.</strong>
              {supportedFile
                ? ' Kies in plaats daarvan één logbestand — dat ververst wél automatisch (live):'
                : ' Automatisch meelezen werkt in Chrome/Edge/Opera. In Firefox/Safari kun je je logbestand handmatig laden:'}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {supportedFile && (
                <button
                  onClick={() => { pickFile().catch(() => {}) }}
                  style={{ padding: '0.4rem 0.85rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: 'rgba(62,207,110,0.1)', border: '1px solid var(--green)', color: 'var(--green)' }}
                >Kies logbestand (live)</button>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{ padding: '0.4rem 0.85rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
              >{messages.length > 0 ? '↻ Ververs (snapshot)' : 'Handmatig (snapshot)'}</button>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0.1rem 0.35rem', borderRadius: 2 }}>Documents\EVE\logs\Chatlogs\Local_*.txt</code>
              </span>
            </div>
          </div>
        )}

        {(status === 'idle' || status === 'needs-permission') && (
          <div style={{ background: 'rgba(0,180,216,0.06)', border: '1px solid rgba(0,180,216,0.3)', borderRadius: 3, padding: '0.85rem 1rem', marginBottom: '0.75rem', fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.6 }}>
            <div style={{ marginBottom: '0.55rem' }}>
              {status === 'needs-permission'
                ? 'Geef opnieuw toegang tot je EVE Chatlogs-map om Local live te volgen.'
                : 'Kies éénmalig je EVE Chatlogs-map. Daarna wordt de map onthouden en gaat het automatisch — geen server of installatie nodig.'}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => { connect().catch(() => {}) }}
                style={{ padding: '0.4rem 0.85rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', color: 'var(--blue)' }}
              >{status === 'needs-permission' ? 'Toegang opnieuw geven' : 'Kies Chatlogs-map (live)'}</button>
              {supportedFile && (
                <>
                  <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>of</span>
                  <button
                    onClick={() => { pickFile().catch(() => {}) }}
                    style={{ padding: '0.4rem 0.85rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: 'rgba(62,207,110,0.1)', border: '1px solid var(--green)', color: 'var(--green)' }}
                  >Kies losbestand (live) — werkt in Opera</button>
                </>
              )}
              <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>of</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{ padding: '0.4rem 0.85rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
              >Handmatig (snapshot)</button>
            </div>
            <div style={{ marginTop: '0.55rem', fontSize: '0.65rem', color: 'var(--text-dim)', lineHeight: 1.7 }}>
              Locatie: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0.1rem 0.35rem', borderRadius: 2 }}>Documents\EVE\logs\Chatlogs\Local_*.txt</code><br />
              Werkt de <strong>map-keuze</strong> niet (bv. in Opera)? Kies dan <strong style={{ color: 'var(--green)' }}>één logbestand (live)</strong> — dat ververst automatisch. Handmatig = momentopname (zelf verversen).
            </div>
          </div>
        )}

        {status === 'no-file' && (
          <div style={{ background: 'rgba(240,192,64,0.08)', border: '1px solid rgba(240,192,64,0.3)', borderRadius: 3, padding: '0.75rem 1rem', marginBottom: '0.75rem', fontSize: '0.75rem', color: 'var(--gold)', lineHeight: 1.6 }}>
            Geen <code>Local_*.txt</code> in de gekozen map gevonden. Zorg dat in EVE het loggen van chat aanstaat en dat je het Local-kanaal open hebt gehad.
          </div>
        )}

        <TopKillersTicker />

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
          {/* Vertalen aan/uit + doeltaal */}
          <button
            onClick={() => setMemberSettings({ translate: !member.translate })}
            title="Local-berichten vertalen"
            style={{
              padding: '0.3rem 0.6rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              background: member.translate ? 'rgba(0,180,216,0.12)' : 'transparent',
              border: `1px solid ${member.translate ? 'var(--blue)' : 'var(--border)'}`,
              color: member.translate ? 'var(--blue)' : 'var(--text-dim)',
            }}
          >🌐 Vertaal</button>
          {member.translate && (
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 2, overflow: 'hidden' }}>
              {(['en', 'nl'] as const).map(l => (
                <button key={l} onClick={() => setMemberSettings({ translateLang: l })} style={{
                  padding: '0.3rem 0.5rem', fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer', border: 'none',
                  background: member.translateLang === l ? 'rgba(0,180,216,0.15)' : 'transparent',
                  color: member.translateLang === l ? 'var(--blue)' : 'var(--text-dim)',
                }}>{l.toUpperCase()}</button>
              ))}
            </div>
          )}
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
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflowY: 'auto', height: 'calc(100vh - 213px)' }}
        >
          {displayed.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem', padding: '3rem' }}>
              {status === 'watching'
                ? (search || onlyMentions || filter ? 'Geen resultaten' : manualMode ? 'Logbestand geladen, maar geen berichten gevonden' : 'Wachtend op berichten in Local...')
                : status === 'no-file' ? 'Geen logbestand in de gekozen map'
                : status === 'unsupported' ? 'Kies hierboven je Local-logbestand om de chat te bekijken'
                : 'Nog geen Chatlogs-map gekozen'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {displayed.slice().reverse().map((m, i) => {
                  const esi      = getEsiStanding(m.sender)
                  const standing = effectiveStanding(m.sender, ownNames, esi, manuals)
                  const count    = senderCounts.get(m.sender) ?? 1
                  const isMention = standing !== 'own' && ownNames.some(n => m.message.toLowerCase().includes(n.toLowerCase()))
                  const bg       = rowBg(standing, isMention, i % 2 === 1)
                  const color    = standingColor(standing, hashColor(m.sender))

                  return (
                    <tr key={i} style={{ background: bg }}>
                      <td style={{ ...TD, width: 72, color: 'var(--text-dim)', fontSize: '0.63rem', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                        {m.time.slice(11)}
                      </td>
                      <td style={{ ...TD, width: 170, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170, borderLeft: standing === 'enemy' ? '2px solid var(--red)' : (standing === 'friend' || standing === 'own') ? '2px solid var(--green)' : isMention ? '2px solid var(--gold)' : '2px solid transparent' }}>
                        <span
                          onContextMenu={e => standing !== 'own' && openMenu(e, m.sender)}
                          title={`${standingUitleg(standing)}${standing !== 'own' ? ' — rechtermuisknop voor handmatige override' : ''}`}
                          style={{ fontWeight: 600, fontSize: '0.72rem', color, cursor: standing !== 'own' ? 'context-menu' : 'default' }}
                        >
                          {standingTeken(standing) && (
                            <span style={{ marginRight: '0.2rem', fontSize: '0.55rem' }}>{standingTeken(standing)}</span>
                          )}
                          {highlight(m.sender)}
                          {manuals[m.sender] && <span style={{ fontSize: '0.5rem', marginLeft: '0.2rem', opacity: 0.5 }}>✎</span>}
                        </span>
                        {count > 2 && standing !== 'own' && (
                          <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginLeft: '0.3rem' }}>×{count}</span>
                        )}
                      </td>
                      <td style={{ ...TD, fontSize: '0.75rem', color: isMention ? 'var(--gold)' : 'var(--text)', wordBreak: 'break-word' }}>
                        {highlight(tr(m.message))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
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
