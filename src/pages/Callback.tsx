import { useEffect, useRef, useState } from 'react'
import { exchangeCode } from '../auth/sso'
import { useAuth } from '../auth/AuthContext'

export default function Callback() {
  const { addToken } = useAuth()
  const [error, setError] = useState('')
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return
    done.current = true

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')

    if (!code || !state) {
      setError('Geen auth code ontvangen van EVE SSO.')
      return
    }

    exchangeCode(code, state)
      .then(async (token) => {
        // Admin mag altijd
        if (token.characterId !== 1831618559) {
          const memberInfo = await fetch(`/api/members.php?characterId=${token.characterId}`).then(r => r.json()).catch(() => null)
          if (memberInfo?.blocked) throw new Error('Je bent geblokkeerd van dit dashboard.')

          const settings = await fetch('/api/settings.php').then(r => r.json()).catch(() => ({}))
          // Allowlist (alts/vrienden) omzeilt de corp/alliance-eis
          if ((settings.require_corp || settings.require_alliance) && !memberInfo?.allowed) {
            const info = await fetch(`https://esi.evetech.net/latest/characters/${token.characterId}/`)
              .then(r => r.json()).catch(() => null)
            const inCorp     = settings.require_corp     && info?.corporation_id === 98652891
            const inAlliance = settings.require_alliance && info?.alliance_id    === 99013537
            // Allowlist van hele corps/alliances
            let inOrgAllow = false
            if (!inCorp && !inAlliance) {
              const orgs = await fetch('/api/access_orgs.php').then(r => r.json()).catch(() => [])
              inOrgAllow = Array.isArray(orgs) && orgs.some((o: { org_id: number; type: string }) =>
                (o.type === 'corp' && o.org_id === info?.corporation_id) ||
                (o.type === 'alliance' && o.org_id === info?.alliance_id))
            }
            if (!inCorp && !inAlliance && !inOrgAllow) {
              const who = [
                settings.require_corp     ? 'Dutch Legions corp' : null,
                settings.require_alliance ? 'Insidious alliance' : null,
              ].filter(Boolean).join(' of ')
              throw new Error(`Toegang geweigerd. Alleen ${who} leden (of characters/corps op de allowlist) mogen inloggen.`)
            }
          }
        }
        addToken(token)
        window.location.replace('/')
      })
      .catch((e: Error) => setError(e.message))
  }, [addToken])

  if (error) {
    return (
      <div style={{ minHeight: '100vh', background: '#05050e', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'url(/bg.png)', backgroundSize: 'cover', backgroundPosition: 'center', filter: 'brightness(0.4) saturate(1.1)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 35%, rgba(5,5,14,0.88) 100%)' }} />
        <div style={{
          position: 'relative', zIndex: 10, width: '100%', maxWidth: 430, textAlign: 'center',
          background: 'linear-gradient(160deg, rgba(11,11,26,0.95) 0%, rgba(5,5,14,0.97) 100%)',
          border: '1px solid rgba(224,85,85,0.35)', borderRadius: 14, padding: '2.4rem 2rem',
          boxShadow: '0 10px 60px rgba(0,0,0,0.8), 0 0 50px rgba(224,85,85,0.07), inset 0 1px 0 rgba(255,255,255,0.05)',
          backdropFilter: 'blur(12px)',
        }}>
          <img src="https://images.evetech.net/corporations/98652891/logo?size=128" width={56} height={56}
            style={{ borderRadius: 10, marginBottom: '1.1rem', opacity: 0.95, boxShadow: '0 0 18px rgba(0,0,0,0.5)' }} alt="" />
          <div style={{ fontSize: '1.8rem', lineHeight: 1, marginBottom: '0.6rem' }}>🔒</div>
          <div style={{ color: '#ff7676', fontSize: '1.1rem', fontWeight: 800, letterSpacing: '0.04em', marginBottom: '0.7rem' }}>Inloggen mislukt</div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', lineHeight: 1.65, marginBottom: '1.7rem' }}>{error}</div>
          <a href="/login" style={{
            display: 'inline-block', background: 'rgba(0,180,216,0.15)', border: '1px solid var(--blue)', color: 'var(--blue)',
            fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.04em', padding: '0.55rem 1.5rem', borderRadius: 8, textDecoration: 'none',
          }}>↻ Probeer opnieuw</a>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', letterSpacing: '0.1em' }}>
        Inloggen...
      </div>
    </div>
  )
}
