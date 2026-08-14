import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useEsiStandings } from '../hooks/useEsiStandings'
import { getStandings, setStanding, type Standing } from '../utils/localStandings'
import { effectiveStanding, standingColor, rowBg, isVriendelijk, standingTeken } from '../utils/standingView'
import { useLocalChat } from '../hooks/useLocalChat'
import { useMemberSettings, setMemberSettings } from '../utils/memberSettings'
import { useTranslate } from '../utils/translate'

const COLORS = [
  'var(--blue)', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#4ade80',
]

function hashColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return COLORS[Math.abs(hash) % COLORS.length]
}

interface ContextMenu { x: number; y: number; name: string }

export default function LocalChatWidget() {
  const { tokens, mainCharId } = useAuth()
  const ownNames   = tokens.map(t => t.characterName)
  const activeToken = tokens.find(t => t.characterId === mainCharId) ?? tokens[0]
  const navigate   = useNavigate()

  const { messages, status } = useLocalChat()
  const member = useMemberSettings()
  const [manuals,     setManuals]     = useState<Record<string, Standing>>(getStandings)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)

  const getEsiStanding = useEsiStandings(activeToken)
  const tr = useTranslate(member.translate, member.translateLang)

  const closeMenu = useCallback(() => setContextMenu(null), [])
  useEffect(() => {
    if (!contextMenu) return
    window.addEventListener('mousedown', closeMenu)
    return () => window.removeEventListener('mousedown', closeMenu)
  }, [contextMenu, closeMenu])

  function openMenu(e: React.MouseEvent, name: string) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, name })
  }

  function applyManual(name: string, standing: Standing | null) {
    setStanding(name, standing)
    setManuals(getStandings())
    setContextMenu(null)
  }

  const recent = messages.slice(-60).reverse()
  const statusColor = status === 'watching' ? 'var(--green)' : status === 'no-file' ? 'var(--gold)' : 'var(--red)'
  const statusLabel =
    status === 'watching'         ? '● Live'
    : status === 'no-file'        ? '● Geen logbestand'
    : status === 'unsupported'    ? '● Niet ondersteund'
    : status === 'needs-permission' ? '● Toegang nodig'
    : '● Niet ingesteld'

  return (
    <>
      <div
        onClick={() => navigate('/local')}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.55rem 0.875rem', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.15em' }}>LOCAL CHAT</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={e => { e.stopPropagation(); if (!member.translate) setMemberSettings({ translate: true }); else setMemberSettings({ translateLang: member.translateLang === 'en' ? 'nl' : 'en' }) }}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMemberSettings({ translate: false }) }}
              title="Vertalen aan/uit (klik = taal wisselen, rechtsklik = uit)"
              style={{ background: member.translate ? 'rgba(0,180,216,0.15)' : 'transparent', border: `1px solid ${member.translate ? 'var(--blue)' : 'var(--border)'}`, borderRadius: 2, color: member.translate ? 'var(--blue)' : 'var(--text-dim)', fontSize: '0.58rem', fontWeight: 700, padding: '0.1rem 0.35rem', cursor: 'pointer' }}
            >🌐 {member.translate ? member.translateLang.toUpperCase() : ''}</button>
            <span style={{ fontSize: '0.68rem', fontWeight: 600, color: statusColor }}>{statusLabel}</span>
          </div>
        </div>

        <div style={{ padding: '0.625rem 0.875rem', height: 'calc(100vh - 550px)', overflowY: 'auto', fontSize: '0.68rem', lineHeight: 1.5 }}>
          {status !== 'watching' ? (
            <div style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '1rem 0' }}>
              {status === 'unsupported' ? 'Klik om je logbestand handmatig te laden'
                : status === 'no-file' ? 'Geen logbestand gevonden'
                : 'Klik om Local in te stellen'}
            </div>
          ) : recent.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '1rem 0' }}>Wachtend op berichten...</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {recent.map((m, i) => {
                const esi      = getEsiStanding(m.sender)
                const standing = effectiveStanding(m.sender, ownNames, esi, manuals)
                const isMention = standing !== 'own' && ownNames.some(n => m.message.toLowerCase().includes(n.toLowerCase()))
                const bg       = rowBg(standing, isMention, i % 2 === 0)
                const color    = standingColor(standing, hashColor(m.sender))
                const border   = standing === 'enemy' ? '2px solid var(--red)' : standing === 'alliance' ? '2px solid #7fe0ff' : isVriendelijk(standing) ? '2px solid var(--green)' : isMention ? '2px solid var(--gold)' : 'none'

                return (
                  <div key={i} style={{ background: bg, padding: '0.25rem 0.4rem', borderRadius: 2, borderLeft: border, paddingLeft: border !== 'none' ? '0.3rem' : '0.4rem' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'baseline' }}>
                      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', flexShrink: 0 }}>{m.time.slice(11)}</span>
                      <span
                        onContextMenu={e => standing !== 'own' && openMenu(e, m.sender)}
                        onClick={e => e.stopPropagation()}
                        title={standing !== 'own' ? 'Rechtermuisknop voor handmatige override' : undefined}
                        style={{ fontWeight: 600, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0, cursor: standing !== 'own' ? 'context-menu' : 'default' }}
                      >
                        {standingTeken(standing) && (
                          <span style={{ marginRight: '0.2rem', fontSize: '0.55rem' }}>{standingTeken(standing)}</span>
                        )}
                        {m.sender}
                        {manuals[m.sender] && <span style={{ fontSize: '0.5rem', marginLeft: '0.2rem', opacity: 0.6 }}>✎</span>}
                      </span>
                      <span style={{ color: isMention ? 'var(--gold)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tr(m.message)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 1000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: '0 4px 16px rgba(0,0,0,0.5)', minWidth: 170, overflow: 'hidden' }}
        >
          <div style={{ padding: '0.35rem 0.65rem', fontSize: '0.6rem', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)', letterSpacing: '0.1em' }}>
            {contextMenu.name}
            <span style={{ marginLeft: '0.4rem', opacity: 0.5 }}>— override</span>
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
