import { createContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getMail, getIndustryJobs, getLocation, getShip, resolveNames } from '../api/esi'
import { getMemberSettings } from '../utils/memberSettings'

export interface CharLocation {
  system: string
  systemId: number | null
  shipName: string
  shipTypeId: number | null
  shipTypeName: string | null
}

interface AlertsState {
  unreadMail: number
  readyJobs: number
  locations: Map<number, CharLocation>
}

const defaultState: AlertsState = { unreadMail: 0, readyJobs: 0, locations: new Map() }
export const AlertsContext = createContext<AlertsState>(defaultState)

const REFRESH_MS = 30 * 1000

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { tokens } = useAuth()
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const [state, setState] = useState<AlertsState>(defaultState)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevReadyJobs = useRef(0)
  const notifRequested = useRef(false)

  useEffect(() => {
    if (!notifRequested.current && Notification.permission === 'default') {
      notifRequested.current = true
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    if (tokens.length === 0) return

    async function fetch() {
      const currentTokens = tokensRef.current
      let unreadMail = 0
      let readyJobs  = 0
      const systemIds:  number[] = []
      const shipTypeIds: number[] = []

      const raw = await Promise.all(currentTokens.map(async t => {
        const [mail, jobs, loc, ship] = await Promise.allSettled([
          getMail(t.characterId, t.accessToken),
          getIndustryJobs(t.characterId, t.accessToken),
          getLocation(t.characterId, t.accessToken),
          getShip(t.characterId, t.accessToken),
        ])
        return { charId: t.characterId, mail, jobs, loc, ship }
      }))

      for (const r of raw) {
        if (r.mail.status  === 'fulfilled') unreadMail += r.mail.value.filter(m => m.is_read === false).length
        if (r.jobs.status  === 'fulfilled') readyJobs  += r.jobs.value.filter(j => j.status === 'ready').length
        if (r.loc.status   === 'fulfilled') systemIds.push(r.loc.value.solar_system_id)
        if (r.ship.status  === 'fulfilled') shipTypeIds.push(r.ship.value.ship_type_id)
      }

      const nameMap = await resolveNames([...new Set([...systemIds, ...shipTypeIds])]).catch(() => new Map<number, string>())

      const locations = new Map<number, CharLocation>()
      for (const r of raw) {
        const systemId = r.loc.status === 'fulfilled' ? r.loc.value.solar_system_id : null
        const system   = systemId ? (nameMap.get(systemId) ?? '—') : '—'
        const shipTypeId = r.ship.status === 'fulfilled' ? r.ship.value.ship_type_id : null
        const shipTypeName = shipTypeId ? (nameMap.get(shipTypeId) ?? null) : null
        const shipName = r.ship.status  === 'fulfilled'
          ? (r.ship.value.ship_name || nameMap.get(r.ship.value.ship_type_id) || '—')
          : '—'
        locations.set(r.charId, { system, systemId, shipName, shipTypeId, shipTypeName })
      }

      if (readyJobs > prevReadyJobs.current && prevReadyJobs.current >= 0 && Notification.permission === 'granted' && getMemberSettings().notifJobs !== false) {
        new Notification('EVE Industry', {
          body: `${readyJobs} job${readyJobs !== 1 ? 's' : ''} klaar om op te halen!`,
          icon: '/favicon.ico',
        })
      }
      prevReadyJobs.current = readyJobs

      setState({ unreadMail, readyJobs, locations })
    }

    fetch()
    timerRef.current = setInterval(fetch, REFRESH_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [tokens.map(t => t.characterId).join(',')])

  return <AlertsContext.Provider value={state}>{children}</AlertsContext.Provider>
}

