export interface ZkillEntry {
  killmail_id: number
  zkb: { hash: string; totalValue: number; solo: boolean; npc: boolean }
}

async function zkill(path: string): Promise<ZkillEntry[]> {
  try {
    const res = await fetch(`https://zkillboard.com${path}`, {
      headers: { 'User-Agent': 'EVE Dashboard (personal)' },
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? (data as ZkillEntry[]) : []
  } catch { return [] }
}

export const getKills  = (charId: number, page = 1) => zkill(`/api/kills/characterID/${charId}/page/${page}/`)
export const getLosses = (charId: number, page = 1) => zkill(`/api/losses/characterID/${charId}/page/${page}/`)

// zKillboard character-statistieken (voor het recruiter/vetting-rapport).
export interface ZkillTopValue {
  characterID?: number; characterName?: string
  corporationID?: number; corporationName?: string
  allianceID?: number; allianceName?: string
  shipTypeID?: number; shipName?: string
  solarSystemID?: number; solarSystemName?: string
  regionID?: number; regionName?: string
  kills: number
}
export interface ZkillStats {
  shipsDestroyed?: number; shipsLost?: number
  iskDestroyed?: number; iskLost?: number
  soloKills?: number; soloLosses?: number
  dangerRatio?: number; gangRatio?: number
  topLists?: Array<{ type: string; title: string; values: ZkillTopValue[] }>
  activepvp?: { kills?: { count: number } }
}

export async function getCharacterStats(charId: number): Promise<ZkillStats | null> {
  try {
    const res = await fetch(`https://zkillboard.com/api/stats/characterID/${charId}/`, {
      headers: { 'User-Agent': 'EVE Dashboard (personal)' },
    })
    if (!res.ok) return null
    return await res.json() as ZkillStats
  } catch { return null }
}

// Corp-brede killboard (alle leden samen).
export const getCorpKills  = (corpId: number, page = 1) => zkill(`/api/kills/corporationID/${corpId}/page/${page}/`)
export const getCorpLosses = (corpId: number, page = 1) => zkill(`/api/losses/corporationID/${corpId}/page/${page}/`)
