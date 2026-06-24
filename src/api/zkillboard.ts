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

// Corp-brede killboard (alle leden samen).
export const getCorpKills  = (corpId: number, page = 1) => zkill(`/api/kills/corporationID/${corpId}/page/${page}/`)
export const getCorpLosses = (corpId: number, page = 1) => zkill(`/api/losses/corporationID/${corpId}/page/${page}/`)

// Recente corp-losses via de eigen proxy (CORS + User-Agent server-side, betrouwbaarder
// dan rechtstreeks zKill vanuit de browser). Voor het vijand-dossier.
export async function getCorpLossesViaProxy(corpId: number): Promise<ZkillEntry[]> {
  try {
    const res = await fetch(`/api/zkill.php?losses=1&type=corporationID&id=${corpId}`)
    if (!res.ok) return []
    const d = await res.json()
    return Array.isArray(d) ? (d as ZkillEntry[]) : []
  } catch { return [] }
}
