import { useEffect, useState } from 'react'
import { getSystemInfo, setWaypoint } from '../api/esi'
import { useAuth } from '../auth/AuthContext'
import { secColor } from '../utils/secColor'

function fmtSec(sec: number): string {
  const v = sec > 0 && sec < 0.05 ? 0.1 : Math.round(sec * 10) / 10
  return v.toFixed(1)
}

interface Props {
  name: string
  systemId?: number
  fontSize?: string
}

export default function SolarSystem({ name, systemId, fontSize = '0.7rem' }: Props) {
  const { tokens } = useAuth()
  const [sec, setSec]         = useState<number | null>(null)
  const [tooltip, setTooltip] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [wpState, setWpState] = useState<'idle' | 'ok' | 'err'>('idle')

  useEffect(() => {
    if (!systemId) return
    getSystemInfo(systemId).then(info => {
      if (!info) return
      setSec(info.security_status)
      const parts = [info.region_name, info.constellation_name].filter(Boolean)
      if (parts.length > 0) setTooltip(parts.join(' › '))
    })
  }, [systemId])

  async function handleWaypoint(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    const token = tokens[0]?.accessToken
    if (!token || !systemId) return
    const ok = await setWaypoint(systemId, token)
    setWpState(ok ? 'ok' : 'err')
    setTimeout(() => setWpState('idle'), 2000)
  }

  const showBtn = systemId != null && tokens.length > 0

  return (
    <span
      title={tooltip ?? undefined}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.3em', fontSize, cursor: tooltip ? 'help' : undefined }}
      onMouseEnter={() => showBtn && setHovered(true)}
      onMouseLeave={() => showBtn && setHovered(false)}
    >
      {sec !== null && (
        <span style={{ color: secColor(sec), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {fmtSec(sec)}
        </span>
      )}
      <span>{name}</span>
      {showBtn && (hovered || wpState !== 'idle') && (
        <span
          onClick={handleWaypoint}
          title={wpState === 'ok' ? 'Waypoint ingesteld!' : wpState === 'err' ? 'Mislukt (character ingelogd in EVE?)' : 'Stel in als waypoint'}
          style={{
            cursor: 'pointer',
            color: wpState === 'ok' ? 'var(--green)' : wpState === 'err' ? 'var(--red)' : 'rgba(255,255,255,0.3)',
            fontSize: '0.85em',
            lineHeight: 1,
            userSelect: 'none',
            transition: 'color 0.15s',
          }}
        >
          {wpState === 'ok' ? '✓' : wpState === 'err' ? '✗' : '▶'}
        </span>
      )}
    </span>
  )
}
