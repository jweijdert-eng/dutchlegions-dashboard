import { useEffect, useRef, useState } from 'react'
import { getStationInfo, getStructureInfo, getSystemInfo } from '../api/esi'
import { useAuth } from '../auth/AuthContext'
import { secColor } from '../utils/secColor'

interface Props {
  locationId: number
  name: string
  fontSize?: string
}

export default function Location({ locationId, name, fontSize = '0.75rem' }: Props) {
  const { tokens } = useAuth()
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const [sec, setSec]               = useState<number | null>(null)
  const [tooltip, setTooltip]       = useState<string | null>(null)
  const [resolvedName, setResolvedName] = useState<string | null>(null)

  useEffect(() => {
    setResolvedName(null)
    setSec(null)
    setTooltip(null)
    async function resolve() {
      let systemId: number | null = null

      if (locationId < 1_000_000_000) {
        const station = await getStationInfo(locationId)
        systemId = station?.system_id ?? null
        if (station?.name) setResolvedName(station.name)
      } else {
        const structure = await getStructureInfo(locationId, tokensRef.current)
        systemId = structure?.solar_system_id ?? null
        if (structure?.name) setResolvedName(structure.name)
      }

      if (!systemId) return
      const sys = await getSystemInfo(systemId)
      if (!sys) return
      setSec(sys.security_status)
      const parts = [sys.region_name, sys.constellation_name].filter(Boolean)
      if (parts.length) setTooltip(parts.join(' › '))
    }
    resolve()
  }, [locationId])

  function fmtSec(s: number) {
    const v = s > 0 && s < 0.05 ? 0.1 : Math.round(s * 10) / 10
    return v.toFixed(1)
  }

  return (
    <span
      title={tooltip ?? undefined}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.3em', fontSize, cursor: tooltip ? 'help' : undefined }}
    >
      {sec !== null && (
        <span style={{ color: secColor(sec), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {fmtSec(sec)}
        </span>
      )}
      <span>{resolvedName ?? name}</span>
    </span>
  )
}
