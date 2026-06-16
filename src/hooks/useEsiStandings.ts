import { useCallback, useEffect, useRef, useState } from 'react'
import type { TokenData } from '../auth/sso'

const BASE = 'https://esi.evetech.net/latest'

interface Contact {
  contact_id: number
  contact_type: 'character' | 'corporation' | 'alliance' | 'faction'
  standing: number
}

interface CharInfo {
  corporation_id: number
  alliance_id?: number
}

// Gepagineerde contacts ophalen voor een willekeurig contacts-endpoint.
async function fetchContactsAt(path: string, token: string): Promise<Contact[]> {
  const all: Contact[] = []
  let page = 1
  while (true) {
    const res = await fetch(`${BASE}${path}?datasource=tranquility&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) break
    const data: Contact[] = await res.json()
    all.push(...data)
    const pages = Number(res.headers.get('X-Pages') ?? 1)
    if (page >= pages) break
    page++
  }
  return all
}

async function resolveNamesToIds(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < names.length; i += 500) {
    const batch = names.slice(i, i + 500)
    try {
      const res = await fetch(`${BASE}/universe/ids/?datasource=tranquility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      })
      if (!res.ok) continue
      const data: { characters?: { id: number; name: string }[] } = await res.json()
      data.characters?.forEach(c => out.set(c.name.toLowerCase(), c.id))
    } catch { /* ignore */ }
  }
  return out
}

async function fetchCharInfo(characterId: number): Promise<CharInfo> {
  const res = await fetch(`${BASE}/characters/${characterId}/?datasource=tranquility`)
  if (!res.ok) throw new Error('failed')
  return res.json() as Promise<CharInfo>
}

export type EsiStanding = 'friend' | 'enemy' | 'neutral'

function toStanding(value: number | undefined): EsiStanding {
  if (value === undefined) return 'neutral'
  if (value > 0) return 'friend'
  if (value < 0) return 'enemy'
  return 'neutral'
}

export function useEsiStandings(token: TokenData | undefined): (name: string) => EsiStanding {
  // contact_id (char/corp/alliance) → standing value
  const [contacts,  setContacts]  = useState<Map<number, number>>(new Map())
  // lowercase name → character id
  const [nameIds,   setNameIds]   = useState<Map<string, number>>(new Map())
  // character id → { corporation_id, alliance_id }
  const [charInfos, setCharInfos] = useState<Map<number, CharInfo>>(new Map())

  const seenNamesRef    = useRef<Set<string>>(new Set())
  const seenCharIds     = useRef<Set<number>>(new Set())
  const pendingNamesRef = useRef<Set<string>>(new Set())
  const pendingIdsRef   = useRef<Set<number>>(new Set())
  const nameTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const infoTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Standings ophalen: alliance- + corp- + persoonlijke contacts samenvoegen.
  // Volgorde = oplopende prioriteit (persoonlijk overschrijft corp overschrijft alliance).
  useEffect(() => {
    if (!token) return
    let cancelled = false
    ;(async () => {
      const map = new Map<number, number>()
      let corpId: number | undefined, allianceId: number | undefined
      try { const info = await fetchCharInfo(token.characterId); corpId = info.corporation_id; allianceId = info.alliance_id } catch { /* ignore */ }
      if (allianceId) { try { (await fetchContactsAt(`/alliances/${allianceId}/contacts/`, token.accessToken)).forEach(c => map.set(c.contact_id, c.standing)) } catch { /* geen scope/rol */ } }
      if (corpId)     { try { (await fetchContactsAt(`/corporations/${corpId}/contacts/`, token.accessToken)).forEach(c => map.set(c.contact_id, c.standing)) } catch { /* geen scope/rol */ } }
      try { (await fetchContactsAt(`/characters/${token.characterId}/contacts/`, token.accessToken)).forEach(c => map.set(c.contact_id, c.standing)) } catch { /* geen scope */ }
      if (!cancelled) setContacts(map)
    })()
    return () => { cancelled = true }
  }, [token?.characterId])

  const flushCharInfos = useCallback(async () => {
    const ids = Array.from(pendingIdsRef.current)
    pendingIdsRef.current.clear()
    const results = await Promise.allSettled(ids.map(id => fetchCharInfo(id).then(info => ({ id, info }))))
    setCharInfos(prev => {
      const next = new Map(prev)
      results.forEach(r => { if (r.status === 'fulfilled') next.set(r.value.id, r.value.info) })
      return next
    })
  }, [])

  const queueCharInfo = useCallback((id: number) => {
    if (seenCharIds.current.has(id)) return
    seenCharIds.current.add(id)
    pendingIdsRef.current.add(id)
    if (infoTimerRef.current) clearTimeout(infoTimerRef.current)
    infoTimerRef.current = setTimeout(flushCharInfos, 400)
  }, [flushCharInfos])

  const flushNames = useCallback(async () => {
    const batch = Array.from(pendingNamesRef.current)
    pendingNamesRef.current.clear()
    if (batch.length === 0) return
    const resolved = await resolveNamesToIds(batch)
    if (resolved.size === 0) return
    setNameIds(prev => {
      const next = new Map(prev)
      resolved.forEach((id, name) => next.set(name, id))
      return next
    })
    // Queue char info for all resolved IDs
    resolved.forEach(id => queueCharInfo(id))
  }, [queueCharInfo])

  const queueName = useCallback((name: string) => {
    const key = name.toLowerCase()
    if (seenNamesRef.current.has(key)) return
    seenNamesRef.current.add(key)
    pendingNamesRef.current.add(name)
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current)
    nameTimerRef.current = setTimeout(flushNames, 400)
  }, [flushNames])

  const getStanding = useCallback((name: string): EsiStanding => {
    const key    = name.toLowerCase()
    const charId = nameIds.get(key)

    if (charId === undefined) {
      queueName(name)
      return 'neutral'
    }

    // 1. Directe character standing
    if (contacts.has(charId)) return toStanding(contacts.get(charId))

    // 2. Corp / alliance standing
    const info = charInfos.get(charId)
    if (info === undefined) {
      queueCharInfo(charId)
      return 'neutral'
    }

    if (contacts.has(info.corporation_id)) return toStanding(contacts.get(info.corporation_id))
    if (info.alliance_id && contacts.has(info.alliance_id)) return toStanding(contacts.get(info.alliance_id))

    return 'neutral'
  }, [contacts, nameIds, charInfos, queueName, queueCharInfo])

  return getStanding
}
