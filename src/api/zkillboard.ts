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
