import { useState } from 'react'
import { startLogin } from '../auth/sso'

const CORP_ID     = 98652891
const ALLIANCE_ID = 99013537
const CORP_LOGO     = `https://images.evetech.net/corporations/${CORP_ID}/logo?size=256`
const ALLIANCE_LOGO = `https://images.evetech.net/alliances/${ALLIANCE_ID}/logo?size=256`

// EVE ship renders via official image API
const SHIPS = [
  { id: 17738, label: 'Machariel',  x: -8,  y: 55, size: 520, rotate: -15, opacity: 0.18, dur: 22 },
  { id: 11567, label: 'Avatar',     x: 62,  y: -5, size: 600, rotate: 12,  opacity: 0.13, dur: 30 },
  { id: 23913, label: 'Nyx',        x: 72,  y: 58, size: 440, rotate: -8,  opacity: 0.15, dur: 26 },
  { id: 638,   label: 'Raven',      x: 30,  y: 70, size: 320, rotate: 20,  opacity: 0.10, dur: 18 },
]

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
      background: '#05050e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
    }}>

      {/* Nebula gradients */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute', top: '-20%', left: '-10%',
          width: '70vw', height: '70vh',
          background: 'radial-gradient(ellipse, rgba(0,60,120,0.35) 0%, transparent 65%)',
          filter: 'blur(40px)',
        }} />
        <div style={{
          position: 'absolute', bottom: '-10%', right: '-5%',
          width: '60vw', height: '60vh',
          background: 'radial-gradient(ellipse, rgba(80,0,120,0.25) 0%, transparent 65%)',
          filter: 'blur(40px)',
        }} />
        <div style={{
          position: 'absolute', top: '40%', left: '40%',
          width: '40vw', height: '40vh',
          background: 'radial-gradient(ellipse, rgba(0,100,100,0.15) 0%, transparent 65%)',
          filter: 'blur(60px)',
        }} />
      </div>

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
            background: `rgba(${s.r},${s.g},255,${s.opacity})`,
            animation: `twinkle ${s.dur}s ease-in-out infinite`,
            animationDelay: s.delay + 's',
          }} />
        ))}
      </div>

      {/* EVE Ships */}
      {SHIPS.map(ship => (
        <div key={ship.id} style={{
          position: 'absolute',
          left: ship.x + '%',
          top: ship.y + '%',
          width: ship.size,
          height: ship.size,
          pointerEvents: 'none',
          animation: `drift${ship.id} ${ship.dur}s ease-in-out infinite`,
        }}>
          <img
            src={`https://images.evetech.net/types/${ship.id}/render?size=512`}
            alt={ship.label}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              opacity: ship.opacity,
              transform: `rotate(${ship.rotate}deg)`,
              filter: 'brightness(1.4) saturate(0.6) drop-shadow(0 0 20px rgba(0,150,255,0.3))',
              mixBlendMode: 'screen',
            }}
          />
        </div>
      ))}

      {/* Login card */}
      <div style={{ position: 'relative', zIndex: 10, textAlign: 'center', width: '100%', maxWidth: 420, padding: '0 1.5rem' }}>

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
              position: 'absolute', inset: -12, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(240,192,64,0.18) 0%, transparent 70%)',
            }} />
            <img src={ALLIANCE_LOGO} alt="Alliance Logo" width={80} height={80}
              style={{
                borderRadius: '50%',
                border: '2px solid rgba(240,192,64,0.5)',
                display: 'block',
                boxShadow: '0 0 32px rgba(240,192,64,0.3)',
              }}
            />
          </div>

          <div style={{ width: 1, height: 60, background: 'rgba(255,255,255,0.1)' }} />

          <div style={{ position: 'relative' }}>
            <div style={{
              position: 'absolute', inset: -12, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(0,180,216,0.18) 0%, transparent 70%)',
            }} />
            <img src={CORP_LOGO} alt="Corporation Logo" width={80} height={80}
              style={{
                borderRadius: '50%',
                border: '2px solid rgba(0,180,216,0.5)',
                display: 'block',
                boxShadow: '0 0 32px rgba(0,180,216,0.3)',
              }}
            />
          </div>
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
          textTransform: 'uppercase', marginBottom: '2.5rem',
          textShadow: '0 0 12px rgba(0,180,216,0.6)',
        }}>
          Dashboard
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

      <style>{`
        @keyframes twinkle {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
        ${SHIPS.map(s => `
          @keyframes drift${s.id} {
            0%   { transform: translate(0px, 0px); }
            33%  { transform: translate(${6 + (s.id % 8)}px, ${-(4 + (s.id % 6))}px); }
            66%  { transform: translate(${-(5 + (s.id % 5))}px, ${3 + (s.id % 7)}px); }
            100% { transform: translate(0px, 0px); }
          }
        `).join('')}
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
