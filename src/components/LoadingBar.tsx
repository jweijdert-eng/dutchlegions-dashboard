import { useEffect, useState } from 'react'
import { useLoadingContext } from '../context/LoadingContext'

type Phase = 'hidden' | 'running' | 'finishing'

export default function LoadingBar() {
  const { isLoading } = useLoadingContext()
  const [phase, setPhase] = useState<Phase>('hidden')

  useEffect(() => {
    if (isLoading) {
      setPhase('running')
    } else if (phase === 'running') {
      setPhase('finishing')
      const t = setTimeout(() => setPhase('hidden'), 500)
      return () => clearTimeout(t)
    }
  }, [isLoading])

  if (phase === 'hidden') return null

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0,
      height: 2, zIndex: 1000, overflow: 'hidden',
      background: 'rgba(0,180,216,0.12)',
      pointerEvents: 'none',
    }}>
      {phase === 'running' ? (
        <div style={{
          position: 'absolute', top: 0, height: '100%',
          width: '45%',
          background: 'linear-gradient(90deg, transparent, var(--blue), transparent)',
          animation: 'loadbar-slide 1.1s ease-in-out infinite',
        }} />
      ) : (
        <div style={{
          width: '100%', height: '100%',
          background: 'var(--blue)',
          animation: 'loadbar-finish 0.5s ease-out forwards',
        }} />
      )}
    </div>
  )
}
