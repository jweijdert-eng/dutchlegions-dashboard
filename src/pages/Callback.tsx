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
      .then((token) => {
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
