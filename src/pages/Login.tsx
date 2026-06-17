import { useEffect, useRef, useState } from 'react'
import { startLogin } from '../auth/sso'

interface GuestMsg { id: number; name: string; message: string; created_at: string }

// Stabiele kleur per naam
function nameColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h}, 70%, 65%)`
}

function GuestChat() {
  const [messages, setMessages] = useState<GuestMsg[]>([])
  const [name, setName] = useState(() => localStorage.getItem('guest_chat_name') ?? '')
  const [nameInput, setNameInput] = useState('')
  const [text, setText] = useState('')
  const lastId = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  function appendNew(rows: GuestMsg[]) {
    if (!rows.length) return
    setMessages(prev => {
      const seen = new Set(prev.map(m => m.id))
      const merged = [...prev, ...rows.filter(r => !seen.has(r.id))]
      return merged.slice(-100)
    })
    lastId.current = Math.max(lastId.current, ...rows.map(r => r.id))
  }

  useEffect(() => {
    let alive = true
    fetch('/api/guestchat.php').then(r => r.json()).then((rows: GuestMsg[]) => { if (alive && Array.isArray(rows)) appendNew(rows) }).catch(() => {})
    const id = setInterval(() => {
      fetch(`/api/guestchat.php?after_id=${lastId.current}`).then(r => r.json())
        .then((rows: GuestMsg[]) => { if (alive && Array.isArray(rows)) appendNew(rows) }).catch(() => {})
    }, 4000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [messages])

  function saveName() {
    const n = nameInput.trim().slice(0, 64)
    if (!n) return
    localStorage.setItem('guest_chat_name', n)
    setName(n)
  }

  async function send() {
    const msg = text.trim()
    if (!msg || !name) return
    setText('')
    try {
      const r = await fetch('/api/guestchat.php', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message: msg }),
      })
      const j = await r.json().catch(() => null)
      // direct ophalen zodat het bericht meteen verschijnt
      fetch(`/api/guestchat.php?after_id=${lastId.current}`).then(r => r.json())
        .then((rows: GuestMsg[]) => { if (Array.isArray(rows)) appendNew(rows) }).catch(() => {})
      if (j?.error === 'te snel') setText(msg)
    } catch { /* ignore */ }
  }

  const panel: React.CSSProperties = {
    background: 'linear-gradient(160deg, rgba(11,11,26,0.92) 0%, rgba(5,5,14,0.96) 100%)',
    border: '1px solid rgba(0,180,216,0.2)', borderRadius: 6,
    boxShadow: '0 8px 60px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(12px)', width: 320, maxWidth: '100%',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  }
  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
    color: 'var(--text)', borderRadius: 4, padding: '0.45rem 0.6rem', fontSize: '0.72rem', outline: 'none',
  }

  return (
    <div style={panel}>
      <div style={{ padding: '0.6rem 0.85rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 8px var(--green)' }} />
        <span style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.12em', color: '#fff', textTransform: 'uppercase' }}>Live Chat</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.58rem', color: 'var(--text-dim)' }}>publiek</span>
      </div>

      <div ref={bodyRef} style={{ height: 230, overflowY: 'auto', padding: '0.6rem 0.85rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {messages.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', margin: 'auto', textAlign: 'center' }}>Nog geen berichten.<br />Zeg hallo 👋</div>
        ) : messages.map(m => (
          <div key={m.id} style={{ fontSize: '0.72rem', lineHeight: 1.4, wordBreak: 'break-word' }}>
            <span style={{ color: nameColor(m.name), fontWeight: 700 }}>{m.name}</span>
            <span style={{ color: 'var(--text-dim)' }}>: </span>
            <span style={{ color: 'var(--text)' }}>{m.message}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '0.6rem 0.85rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {!name ? (
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input style={inputStyle} value={nameInput} maxLength={64} placeholder="Je naam…"
              onChange={e => setNameInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveName() }} />
            <button onClick={saveName} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.5)', color: '#00d4ff', borderRadius: 4, padding: '0 0.7rem', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}>OK</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input style={inputStyle} value={text} maxLength={280} placeholder={`Bericht als ${name}…`}
              onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />
            <button onClick={send} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.5)', color: '#00d4ff', borderRadius: 4, padding: '0 0.7rem', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}>➤</button>
          </div>
        )}
        {name && (
          <div style={{ marginTop: '0.35rem', fontSize: '0.56rem', color: 'var(--text-dim)' }}>
            Je chat als <span style={{ color: nameColor(name) }}>{name}</span> · <button onClick={() => { localStorage.removeItem('guest_chat_name'); setName('') }} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.56rem', padding: 0 }}>wijzig</button>
          </div>
        )}
      </div>
    </div>
  )
}

const CORP_ID     = 98652891
const ALLIANCE_ID = 99013537
const CORP_LOGO     = `https://images.evetech.net/corporations/${CORP_ID}/logo?size=256`
const ALLIANCE_LOGO = `https://images.evetech.net/alliances/${ALLIANCE_ID}/logo?size=256`


export default function Login() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin() {
    setLoading(true)
    setError('')
    try {
      await startLogin()
    } catch (e) {
      setError((e as Error).message)
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
      background: '#05050e',
    }}>

      {/* Background image */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'url(/bg.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'brightness(0.55) saturate(1.1)',
      }} />


      {/* Edge vignette */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, transparent 40%, rgba(5,5,14,0.7) 100%)',
      }} />

      {/* Login + live chat */}
      <div style={{ position: 'relative', zIndex: 10, display: 'flex', gap: '1.75rem', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', width: '100%', padding: '2rem 1.5rem' }}>
      <div style={{ textAlign: 'center', width: '100%', maxWidth: 420 }}>

        {/* Logos */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.5rem',
          marginBottom: '1.5rem',
        }}>
          {[{ src: ALLIANCE_LOGO, alt: 'Alliance Logo' }, { src: CORP_LOGO, alt: 'Corporation Logo' }].map(logo => (
            <div key={logo.alt} style={{ position: 'relative' }}>
                <img src={logo.src} alt={logo.alt} width={80} height={80}
                style={{
                  borderRadius: '50%',
                  display: 'block',
                }}
              />
            </div>
          ))}
        </div>

        {/* Title */}
        <div style={{
          fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.22em',
          color: '#fff', marginBottom: '0.25rem', textTransform: 'uppercase',
          textShadow: '0 0 30px rgba(0,180,216,0.5)',
        }}>
          Dutch Legions
        </div>
        <div style={{
          fontSize: '0.65rem', color: 'var(--blue)', letterSpacing: '0.35em',
          textTransform: 'uppercase', marginBottom: '0.4rem',
          textShadow: '0 0 12px rgba(0,180,216,0.6)',
        }}>
          Dashboard
        </div>
        <div style={{
          fontSize: '0.6rem', color: 'var(--blue)', letterSpacing: '0.35em',
          textTransform: 'uppercase', marginBottom: '2.5rem',
          textShadow: '0 0 12px rgba(0,180,216,0.6)',
        }}>
          Persoonlijke Tracker
        </div>

        {/* Card */}
        <div style={{
          background: 'linear-gradient(160deg, rgba(11,11,26,0.92) 0%, rgba(5,5,14,0.96) 100%)',
          border: '1px solid rgba(0,180,216,0.2)',
          borderRadius: 6,
          padding: '2rem 2rem 1.75rem',
          boxShadow: '0 8px 60px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)',
          backdropFilter: 'blur(12px)',
        }}>
          <div style={{
            fontSize: '0.72rem', color: 'var(--text-dim)', marginBottom: '1.75rem', lineHeight: 1.7,
          }}>
            Log in met je EVE Online account via de officiële SSO.<br />
            Er worden nooit wachtwoorden opgeslagen.
          </div>

          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: '100%',
              background: loading
                ? 'rgba(0,180,216,0.04)'
                : 'linear-gradient(135deg, rgba(0,180,216,0.18) 0%, rgba(0,180,216,0.08) 100%)',
              border: '1px solid ' + (loading ? 'rgba(0,180,216,0.3)' : 'rgba(0,180,216,0.7)'),
              color: loading ? 'var(--text-dim)' : '#00d4ff',
              padding: '0.9rem 1.5rem',
              borderRadius: 4,
              cursor: loading ? 'default' : 'pointer',
              fontSize: '0.78rem',
              fontWeight: 700,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              transition: 'all 0.2s',
              boxShadow: loading ? 'none' : '0 0 20px rgba(0,180,216,0.2)',
            }}
            onMouseEnter={e => {
              if (!loading) {
                const b = e.currentTarget as HTMLButtonElement
                b.style.boxShadow = '0 0 32px rgba(0,180,216,0.4)'
                b.style.background = 'linear-gradient(135deg, rgba(0,180,216,0.28) 0%, rgba(0,180,216,0.14) 100%)'
              }
            }}
            onMouseLeave={e => {
              if (!loading) {
                const b = e.currentTarget as HTMLButtonElement
                b.style.boxShadow = '0 0 20px rgba(0,180,216,0.2)'
                b.style.background = 'linear-gradient(135deg, rgba(0,180,216,0.18) 0%, rgba(0,180,216,0.08) 100%)'
              }
            }}
          >
            {loading ? '▶ Doorsturen...' : '▶ Inloggen met EVE Online'}
          </button>

          {error && (
            <div style={{
              marginTop: '1rem', color: 'var(--red)', fontSize: '0.7rem', lineHeight: 1.5,
              background: 'rgba(224,85,85,0.07)', border: '1px solid rgba(224,85,85,0.25)',
              borderRadius: 3, padding: '0.6rem 0.75rem',
            }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ marginTop: '1.25rem', fontSize: '0.6rem', color: 'rgba(150,155,180,0.3)', letterSpacing: '0.04em' }}>
          EVE SSO OAuth2 PKCE · Geen client secret vereist
        </div>
      </div>

      <GuestChat />
      </div>

      <style>{`
        @keyframes twinkle {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
      `}</style>
    </div>
  )
}

const STARS = Array.from({ length: 120 }, (_, i) => ({
  x: (i * 137.508) % 100,
  y: (i * 97.31) % 100,
  size: i % 7 === 0 ? 2.5 : i % 3 === 0 ? 1.5 : 1,
  opacity: 0.1 + (i % 8) * 0.06,
  r: i % 4 === 0 ? 200 : 210,
  g: i % 5 === 0 ? 200 : 220,
  dur: 2 + (i % 6) * 0.9,
  delay: (i % 11) * 0.35,
}))
