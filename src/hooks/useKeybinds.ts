import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const KEYS: Record<string, string> = {
  d: '/',
  c: '/character',
  w: '/wallet',
  m: '/market',
  k: '/kills',
  i: '/industry',
  n: '/notes',
  l: '/local',
  b: '/buildvsbuy',
  p: '/pichain',
}

export function useKeybinds() {
  const navigate = useNavigate()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const path = KEYS[e.key.toLowerCase()]
      if (path) navigate(path)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}
