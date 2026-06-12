import { useState } from 'react'
import { startLogin } from '../auth/sso'

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
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Star field */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {STARS.map((s, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: s.x + '%',
            top: s.y + '%',
            width: s.size + 'px',
            height: s.size + 'px',
            borderRadius: '50%',
            background: 'rgba(200,210,255,' + s.opacity + ')',
            animation: `twinkle ${s.dur}s ease-in-out infinite`,
            animationDelay: s.delay + 's',
          }} />
        ))}
      </div>

      {/* Glow accent top */}
      <div style={{
        position: 'absolute',
        top: -200,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 600,
        height: 400,
        background: 'radial-gradient(ellipse at center, rgba(0,180,216,0.07) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', width: '100%', maxWidth: 420, padding: '0 1.5rem' }}>

        {/* Logos */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.5rem',
          marginBottom: '1.5rem',
        }}>
          <div style={{ position: 'relative' }}>
            <div style={{
              position: 'absolute',
              inset: -12,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(240,192,64,0.12) 0%, transparent 70%)',
            }} />
            <img
              src={ALLIANCE_LOGO}
              alt="Alliance Logo"
              width={80}
              height={80}
              style={{
                borderRadius: '50%',
                border: '2px solid rgba(240,192,64,0.4)',
                display: 'block',
                boxShadow: '0 0 28px rgba(240,192,64,0.2), 0 0 8px rgba(240,192,64,0.1)',
              }}
            />
          </div>

          <div style={{ width: 1, height: 60, background: 'var(--border)' }} />

          <div style={{ position: 'relative' }}>
            <div style={{
              position: 'absolute',
              inset: -12,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(0,180,216,0.15) 0%, transparent 70%)',
            }} />
            <img
              src={CORP_LOGO}
              alt="Corporation Logo"
              width={80}
              height={80}
              style={{
                borderRadius: '50%',
                border: '2px solid rgba(0,180,216,0.4)',
                display: 'block',
                boxShadow: '0 0 28px rgba(0,180,216,0.2), 0 0 8px rgba(0,180,216,0.1)',
              }}
            />
          </div>
        </div>

        {/* Title */}
        <div style={{
          fontSize: '1.4rem',
          fontWeight: 700,
          letterSpacing: '0.2em',
          color: 'var(--text)',
          marginBottom: '0.3rem',
          textTransform: 'uppercase',
        }}>
          Dutch Legions
        </div>
        <div style={{
          fontSize: '0.65rem',
          color: 'var(--blue)',
          letterSpacing: '0.3em',
          textTransform: 'uppercase',
          marginBottom: '2.5rem',
        }}>
          Dashboard
        </div>

        {/* Card */}
        <div style={{
          background: 'linear-gradient(160deg, rgba(11,11,26,0.95) 0%, rgba(5,5,14,0.98) 100%)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '2rem 2rem 1.75rem',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{
            fontSize: '0.72rem',
            color: 'var(--text-dim)',
            marginBottom: '1.75rem',
            lineHeight: 1.7,
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
                : 'linear-gradient(135deg, rgba(0,180,216,0.15) 0%, rgba(0,180,216,0.08) 100%)',
              border: '1px solid ' + (loading ? 'rgba(0,180,216,0.3)' : 'var(--blue)'),
              color: loading ? 'var(--text-dim)' : 'var(--blue)',
              padding: '0.85rem 1.5rem',
              borderRadius: 4,
              cursor: loading ? 'default' : 'pointer',
              fontSize: '0.78rem',
              fontWeight: 700,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              transition: 'all 0.2s',
              boxShadow: loading ? 'none' : '0 0 16px rgba(0,180,216,0.15)',
            }}
            onMouseEnter={e => {
              if (!loading) {
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 24px rgba(0,180,216,0.3)'
                ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(0,180,216,0.9)'
              }
            }}
            onMouseLeave={e => {
              if (!loading) {
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 16px rgba(0,180,216,0.15)'
                ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--blue)'
              }
            }}
          >
            {loading ? '▶ Doorsturen...' : '▶ Inloggen met EVE Online'}
          </button>

          {error && (
            <div style={{
              marginTop: '1rem',
              color: 'var(--red)',
              fontSize: '0.7rem',
              lineHeight: 1.5,
              background: 'rgba(224,85,85,0.07)',
              border: '1px solid rgba(224,85,85,0.25)',
              borderRadius: 3,
              padding: '0.6rem 0.75rem',
            }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ marginTop: '1.25rem', fontSize: '0.6rem', color: 'rgba(150,155,180,0.4)', letterSpacing: '0.04em' }}>
          EVE SSO OAuth2 PKCE · Geen client secret vereist
        </div>
      </div>

      <style>{`
        @keyframes twinkle {
          0%, 100% { opacity: var(--op); }
          50% { opacity: calc(var(--op) * 0.3); }
        }
      `}</style>
    </div>
  )
}

const STARS = Array.from({ length: 80 }, (_, i) => ({
  x: (i * 137.508) % 100,
  y: (i * 97.31) % 100,
  size: i % 5 === 0 ? 2 : i % 3 === 0 ? 1.5 : 1,
  opacity: 0.15 + (i % 7) * 0.07,
  dur: 2.5 + (i % 5) * 0.8,
  delay: (i % 9) * 0.4,
}))
