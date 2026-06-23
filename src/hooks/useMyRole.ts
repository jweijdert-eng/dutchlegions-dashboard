import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'

export type Role = 'guest' | 'member' | 'recruiter' | 'admin'

// Rol van het ingelogde (hoofd)account, via roles.php. Owner krijgt server-side altijd 'admin'.
export function useMyRole(): Role {
  const { tokens, mainCharId } = useAuth()
  const tok = tokens.find(t => t.characterId === mainCharId) ?? tokens[0]
  const [role, setRole] = useState<Role>('member')

  useEffect(() => {
    if (!tok) { setRole('guest'); return }
    let cancelled = false
    fetch(`/api/roles.php?token=${encodeURIComponent(tok.accessToken)}`)
      .then(r => r.json())
      .then(j => { if (!cancelled && typeof j?.me === 'string') setRole(j.me as Role) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tok?.accessToken])

  return role
}
