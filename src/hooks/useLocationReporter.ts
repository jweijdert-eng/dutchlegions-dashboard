import { useEffect, useRef } from 'react'
import type { TokenData } from '../auth/sso'
import { apiHeaders } from '../auth/apiToken'
import { getCharacterLocation, getCharacterShip, tokenScopes } from '../api/esi'
import { getMemberSettings } from '../utils/memberSettings'

// Meldt elke 30 s aan de eigen server waar je characters zitten (ESI-locatie met het
// token van dat character), zodat de pagina "Waar is iedereen" het kan tonen. Alleen
// zolang het dashboard ergens open staat; zonder locatie-recht in het token gebeurt
// er niets. Uitzetten kan in Instellingen (Locatie delen).
export const LOC_SCOPE  = 'esi-location.read_location.v1'
export const SHIP_SCOPE = 'esi-location.read_ship_type.v1'
const POLL_MS      = 30_000
const HEARTBEAT_MS = 2 * 60_000   // ongewijzigd? dan toch elke 2 min even laten weten dat we er nog zijn

interface Melding { key: string; at: number }

export function useLocationReporter(tokens: TokenData[]) {
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  const laatste = useRef(new Map<number, Melding>())
  const gedeeld = useRef<boolean | null>(null)   // laatst gemelde stand van de instelling

  useEffect(() => {
    let bezig = false
    async function ronde() {
      if (bezig) return
      bezig = true
      try {
        const delen = getMemberSettings().shareLocation
        const nu = Date.now()
        const geldig = tokensRef.current.filter(t => t.expiresAt > nu)

        if (!delen) {
          // Net uitgezet: één keer afmelden per character, daarna stil.
          if (gedeeld.current !== false) {
            for (const t of geldig) {
              await fetch('/api/locations.php', {
                method: 'POST', headers: apiHeaders(t.accessToken, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ shared: false }),
              }).catch(() => {})
            }
            laatste.current.clear()
            gedeeld.current = false
          }
          return
        }
        gedeeld.current = true

        for (const t of geldig) {
          const scp = tokenScopes(t.accessToken)
          if (!scp.includes(LOC_SCOPE)) continue
          const loc = await getCharacterLocation(t.characterId, t.accessToken)
          if (!loc?.solar_system_id) continue
          const ship = scp.includes(SHIP_SCOPE) ? await getCharacterShip(t.characterId, t.accessToken) : null
          const key = [loc.solar_system_id, loc.station_id ?? 0, loc.structure_id ?? 0, ship?.ship_type_id ?? 0, ship?.ship_name ?? ''].join('|')
          const vorige = laatste.current.get(t.characterId)
          if (vorige && vorige.key === key && nu - vorige.at < HEARTBEAT_MS) continue
          const res = await fetch('/api/locations.php', {
            method: 'POST', headers: apiHeaders(t.accessToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              name: t.characterName,
              solar_system_id: loc.solar_system_id,
              station_id: loc.station_id ?? null,
              structure_id: loc.structure_id ?? null,
              ship_type_id: ship?.ship_type_id ?? null,
              ship_name: ship?.ship_name ?? null,
            }),
          }).catch(() => null)
          if (res?.ok) laatste.current.set(t.characterId, { key, at: nu })
        }
      } finally { bezig = false }
    }
    ronde()
    const id = setInterval(ronde, POLL_MS)
    const opInstelling = () => { ronde() }
    window.addEventListener('membersettings', opInstelling)
    return () => { clearInterval(id); window.removeEventListener('membersettings', opInstelling) }
  }, [])
}
