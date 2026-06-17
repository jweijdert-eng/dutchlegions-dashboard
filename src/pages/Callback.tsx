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
            if (!inCorp && !inAlliance) {
              const who = [
                settings.require_corp     ? 'Dutch Legions corp' : null,
                settings.require_alliance ? 'Insidious alliance' : null,
              ].filter(Boolean).join(' of ')
              throw new Error(`Toegang geweigerd. Alleen ${who} leden (of characters op de allowlist) mogen inloggen.`)
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
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <div style={{ color: 'var(--red)', fontSize: '0.85rem', marginBottom: '1rem' }}>Inloggen mislukt</div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem', marginBottom: '1.5rem' }}>{error}</div>
          <a href="/login" style={{ color: 'var(--blue)', fontSize: '0.75rem' }}>Probeer opnieuw</a>
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
