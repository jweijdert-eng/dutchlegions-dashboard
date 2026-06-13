import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getAssets, getAssetLocations, getLocation, getRoute, getStationInfo, getStructureInfo, getSystemSecurity, resolveNames, type AssetItem, type AssetLocation } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

async function resolveTypeNames(typeIds: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  const uncached: number[] = []
  for (const id of typeIds) {
    const cached = localStorage.getItem(`tn_${id}`)
    if (cached) result.set(id, cached)
    else uncached.push(id)
  }
  if (uncached.length > 0) {
    const fetched = await resolveNames(uncached)
    for (const [id, name] of fetched) {
      result.set(id, name)
      try { localStorage.setItem(`tn_${id}`, name) } catch { /* localStorage vol */ }
    }
    // Fallback via /universe/types/ for any still-missing IDs
    const missing = uncached.filter(id => !fetched.has(id))
    await Promise.all(missing.map(async id => {
      try {
        const r = await fetch(`https://esi.evetech.net/latest/universe/types/${id}/?datasource=tranquility&language=en`)
        if (r.ok) {
          const d = await r.json()
          if (d.name) {
            result.set(id, d.name)
            try { localStorage.setItem(`tn_${id}`, d.name) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }))
  }
  return result
}

type OwnedAsset = AssetItem & { owner: number }

type ResolvedAsset = {
  typeId: number
  name: string
  quantity: number
  flag: string
  locationId: number
  locationName: string
  ownerCharId?: number
}

const FLAG_LABEL: Record<string, string> = {
  Hangar: 'Hangar', CargoHold: 'Cargo', DroneBay: 'Drones',
  ShipHangar: 'Ship Hangar', SpecializedFuelBay: 'Fuel Bay',
  FighterBay: 'Fighters', FleetHangar: 'Fleet Hangar',
  Unlocked: 'Unlocked', Locked: 'Locked',
}

function fmtFlag(f: string) {
  return FLAG_LABEL[f] ?? f.replace(/([A-Z])/g, ' $1').trim()
}

// Modules die in een schip gefit zitten (Hi/Med/Lo/Rig slots) — niet tonen in de
// asset-lijst; het schip zelf blijft wel staan.
const FITTED_SLOT_RE = /^(Hi|Med|Lo|Rig|SubSystem)Slot\d+$/
const isFittedSlot = (flag: string) => FITTED_SLOT_RE.test(flag)

export default function Assets() {
  const { tokens: allTokens, activeTokens } = useAuth()
  const [selectedChar, setSelectedChar] = useState<number | 'all'>('all')
  const tokens = selectedChar === 'all' ? allTokens : allTokens.filter(t => t.characterId === selectedChar)
  const routeCharacterId = selectedChar === 'all'
    ? activeTokens[0]?.characterId ?? allTokens[0]?.characterId ?? null
    : selectedChar

  const [items, setItems] = useState<ResolvedAsset[]>([])
  const [locationSystemMap, setLocationSystemMap] = useState<Record<number, number>>({})
  const [securityMap, setSecurityMap] = useState<Record<number, number>>({})
  const [routeCounts, setRouteCounts] = useState<Record<number, number | null>>({})
  const [originSystemId, setOriginSystemId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const fetchId = useRef(0)
  const routeFetchId = useRef(0)
  usePageLoading(loading)

  const characterOptions = useMemo(() => [{ label: 'All characters', id: 'all' as const }, ...allTokens.map(t => ({ label: `${t.characterName ?? t.characterId}`, id: t.characterId }))], [allTokens])

  async function loadAssets() {
    if (tokens.length === 0) { setItems([]); return }
    const my = ++fetchId.current
    setLoading(true)
    try {
      const allRaw: OwnedAsset[] = []
      const allLocations: Array<{ owner: number; loc: AssetLocation }> = []
      await Promise.all(tokens.map(async t => {
        const raw = await getAssets(t.characterId, t.accessToken).catch(() => [] as AssetItem[])
        allRaw.push(...raw.map(r => ({ ...r, owner: t.characterId })))
        const locations = await getAssetLocations(t.characterId, t.accessToken).catch(() => [] as AssetLocation[])
        allLocations.push(...locations.map(loc => ({ owner: t.characterId, loc })))
      }))
      if (my !== fetchId.current) return

      const byItem = new Map(allRaw.map(a => [`${a.owner}:${a.item_id}`, a]))
      const locationMap = new Map<string, AssetLocation>()
      for (const entry of allLocations) {
        locationMap.set(`${entry.owner}:${entry.loc.item_id}`, entry.loc)
      }

      type RootLocation = { id: number; type: 'station' | 'solar_system' | 'structure' | 'other' }

      function resolveAssetLocation(loc: AssetLocation, owner: number): RootLocation {
        if (typeof loc.location_id !== 'number' || Number.isNaN(loc.location_id)) {
          return { id: 0, type: 'other' }
        }
        const inferredType = loc.location_type === 'structure' ? 'structure'
          : loc.location_type === 'station' ? 'station'
          : loc.location_type === 'solar_system' ? 'solar_system'
          : loc.location_type === 'item' ? 'item'
          : loc.location_id >= 1_000_000_000 ? 'structure'
          : loc.location_id < 1_000_000_000 ? 'station'
          : 'other'

        if (inferredType !== 'item') {
          return { id: loc.location_id, type: inferredType }
        }

        const parent = byItem.get(`${owner}:${loc.location_id}`)
        return parent ? rootLocation(parent) : {
          id: loc.location_id,
          type: loc.location_id >= 1_000_000_000 ? 'structure' : 'other',
        }
      }

      function rootLocation(a: OwnedAsset): RootLocation {
        const loc = locationMap.get(`${a.owner}:${a.item_id}`)
        if (loc) return resolveAssetLocation(loc, a.owner)
        if (a.location_type !== 'item') {
          return {
            id: a.location_id,
            type: a.location_type === 'station' ? 'station'
              : a.location_type === 'solar_system' ? 'solar_system'
              : a.location_id >= 1_000_000_000 ? 'structure'
              : 'other',
          }
        }
        const parent = byItem.get(`${a.owner}:${a.location_id}`)
        return parent ? rootLocation(parent) : {
          id: a.location_id,
          type: a.location_id >= 1_000_000_000 ? 'structure' : 'other',
        }
      }

      const rootLocations = allRaw.map(a => rootLocation(a))
      const rootIds = [...new Set(rootLocations.map(r => r.id))]
      // Ontdubbelen: anders wordt bv. getStructureInfo N× tegelijk aangeroepen voor
      // dezelfde citadel als er N items in staan (cache is nog leeg bij parallelle start).
      const stationIds = [...new Set(rootLocations.filter(r => r.type === 'station').map(r => r.id))]
      const systemIds = [...new Set(rootLocations.filter(r => r.type === 'solar_system').map(r => r.id))]
      const structureIds = [...new Set(rootLocations.filter(r => r.type === 'structure').map(r => r.id))]
      const typeIds = [...new Set(allRaw.map(a => a.type_id))]

      const [typeMap, locationNameMap] = await Promise.all([ resolveTypeNames(typeIds), resolveNames(rootIds) ])

      const structureInfoMap = new Map<number, { name: string; systemId: number }>()
      await Promise.all(structureIds.map(async id => {
        const info = await getStructureInfo(id, allTokens)
        if (!info) return
        let systemId = info.solar_system_id
        // If system unknown, try to resolve from structure name prefix (e.g. "9F-7PZ - Ssamesh" → "9F-7PZ")
        if (systemId === 0 && info.name) {
          const prefix = info.name.split(' - ')[0]?.trim()
          if (prefix) {
            try {
              const res = await fetch(`https://esi.evetech.net/latest/universe/ids/?datasource=tranquility`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([prefix]),
              })
              if (res.ok) {
                const data = await res.json()
                if (data.systems?.[0]?.id) systemId = data.systems[0].id
              }
            } catch { /* ignore */ }
          }
        }
        structureInfoMap.set(id, { name: info.name, systemId })
      }))

      const stationInfoMap = new Map<number, { name: string; systemId: number }>()
      await Promise.all(stationIds.map(async id => {
        const station = await getStationInfo(id)
        if (station) stationInfoMap.set(id, { name: station.name, systemId: station.system_id })
      }))

      const locationNames = new Map<number, string>([
        ...locationNameMap.entries(),
        ...[...stationInfoMap.entries()].map(([id, info]) => [id, info.name] as [number, string]),
        ...[...structureInfoMap.entries()].map(([id, info]) => [id, info.name] as [number, string]),
      ])

      // build resolved items (gefitte modules in slots niet tonen; boom is al opgebouwd)
      const resolved: ResolvedAsset[] = allRaw.filter(a => !isFittedSlot(a.location_flag)).map(a => {
        const root = rootLocation(a)
        return {
          typeId: a.type_id,
          name: typeMap.get(a.type_id) ?? `Type ${a.type_id}`,
          quantity: a.quantity,
          flag: fmtFlag(a.location_flag),
          locationId: root.id,
          locationName: locationNames.get(root.id) ?? (root.type === 'structure' ? `\x00struct:${root.id}` : `\x00loc:${root.id}`),
          ownerCharId: a.owner,
        }
      })

      // merge by locationName|typeId|flag|ownerCharId
      const merged = new Map<string, ResolvedAsset>()
      for (const r of resolved) {
        const key = `${r.locationName}|${r.typeId}|${r.flag}|${r.ownerCharId}`
        const ex = merged.get(key)
        if (ex) ex.quantity += r.quantity
        else merged.set(key, { ...r })
      }

      const isUnknown = (loc: string) => loc.startsWith('\x00struct:') || loc.startsWith('\x00loc:')
      const final = [...merged.values()].sort((a, b) => {
        const au = isUnknown(a.locationName), bu = isUnknown(b.locationName)
        if (au !== bu) return au ? 1 : -1
        return a.locationName.localeCompare(b.locationName) || a.name.localeCompare(b.name)
      })
      setItems(final)
      setRouteCounts({})
      const locationsToSystems: Record<number, number> = {}
      for (const id of systemIds) locationsToSystems[id] = id
      for (const [id, info] of stationInfoMap.entries()) if (info.systemId > 0) locationsToSystems[id] = info.systemId
      for (const [id, info] of structureInfoMap.entries()) if (info.systemId > 0) locationsToSystems[id] = info.systemId
      setLocationSystemMap(locationsToSystems)

      // Security status per system
      const uniqueSystems = [...new Set(Object.values(locationsToSystems))].filter(Boolean)
      const secEntries = await Promise.all(
        uniqueSystems.map(async sysId => {
          const sec = await getSystemSecurity(sysId).catch(() => null)
          return [sysId, sec] as const
        })
      )
      const secMap: Record<number, number> = {}
      for (const [sysId, sec] of secEntries) if (sec !== null) secMap[sysId] = sec
      setSecurityMap(secMap)
      // default collapse state: all collapsed
      const collapsedState: Record<string, boolean> = {}
      for (const it of final) collapsedState[it.locationName] = true
      setCollapsed(collapsedState)
    } finally { setLoading(false) }
  }

  useEffect(() => { loadAssets() }, [selectedChar, allTokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  useEffect(() => {
    if (!routeCharacterId) { setOriginSystemId(null); return }
    const token = allTokens.find(t => t.characterId === routeCharacterId)?.accessToken
    if (!token) { setOriginSystemId(null); return }

    let active = true
    getLocation(routeCharacterId, token)
      .then(loc => { if (!active) return; setOriginSystemId(loc?.solar_system_id ?? null) })
      .catch(() => { if (!active) return; setOriginSystemId(null) })
    return () => { active = false }
  }, [routeCharacterId, allTokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  useEffect(() => {
    if (originSystemId === null) { setRouteCounts({}); return }

    const locationIds = Array.from(new Set(items.map(i => i.locationId)))
    const destinationSystems = new Map<number, number>()
    for (const locationId of locationIds) {
      const sys = locationSystemMap[locationId]
      if (typeof sys === 'number' && sys > 0) destinationSystems.set(locationId, sys)
    }

    if (destinationSystems.size === 0) { setRouteCounts({}); return }

    const current = ++routeFetchId.current
    const initialCounts: Record<number, number | null> = {}
    destinationSystems.forEach((_, locationId) => { initialCounts[locationId] = null })
    setRouteCounts(initialCounts)

    Promise.all([...destinationSystems.entries()].map(async ([locationId, destinationSystemId]) => {
      if (destinationSystemId === originSystemId) return [locationId, 0] as const
      try {
        const route = await getRoute(originSystemId, destinationSystemId)
        return [locationId, Math.max(0, route.length - 1)] as const
      } catch {
        return [locationId, -1] as const  // -1 = unreachable (wormhole / no gate route)
      }
    })).then(results => {
      if (current !== routeFetchId.current) return
      setRouteCounts(prev => {
        const next = { ...prev }
        for (const [locationId, count] of results) next[locationId] = count
        return next
      })
    })
  }, [originSystemId, items, locationSystemMap])

  const filtered = items.filter(i => {
    const s = search.trim().toLowerCase()
    if (!s) return true
    return i.name.toLowerCase().includes(s) || i.locationName.toLowerCase().includes(s) || String(i.typeId) === s
  })

  const groups = useMemo(() => {
    const m = new Map<string, { locationId: number; items: ResolvedAsset[] }>()
    for (const it of filtered) {
      const g = m.get(it.locationName) ?? { locationId: it.locationId, items: [] }
      g.items.push(it)
      m.set(it.locationName, g)
    }
    return m
  }, [filtered])

  // EVE-security-kleurgradiënt, afgerond per 0.1 (zelfde tinten als in-game)
  function secColor(shown: number) {
    if (shown >= 1.0) return '#2FEFEF' // 1.0  cyaan
    if (shown >= 0.9) return '#48F0C0' // 0.9
    if (shown >= 0.8) return '#00EF47' // 0.8
    if (shown >= 0.7) return '#00F000' // 0.7
    if (shown >= 0.6) return '#8FEF2F' // 0.6
    if (shown >= 0.5) return '#EFEF00' // 0.5  geel
    if (shown >= 0.4) return '#D77700' // 0.4
    if (shown >= 0.3) return '#F06000' // 0.3
    if (shown >= 0.2) return '#F04800' // 0.2
    if (shown >= 0.1) return '#D73000' // 0.1
    return '#F00000'                   // ≤ 0.0  null-sec / rood
  }

  function secLabel(locationId: number) {
    const sysId = locationSystemMap[locationId]
    const sec = sysId !== undefined ? securityMap[sysId] : undefined
    if (sec === undefined) return null
    // EVE-afronding op 1 decimaal; kleine positieve trueSec toont CCP als 0.1 (lowsec),
    // nullsec (≤ 0.0) toont de echte waarde, incl. negatief.
    const rounded = Math.round(sec * 10) / 10
    const shown = sec > 0 && rounded <= 0 ? 0.1 : rounded
    return { label: shown.toFixed(1), color: secColor(shown) }
  }

  function toggle(loc: string) {
    setCollapsed(c => ({ ...c, [loc]: !c[loc] }))
  }

  function exportCsv() {
    const rows = [['location', 'locationId', 'ownerCharId', 'typeId', 'name', 'flag', 'quantity']]
    for (const it of items) rows.push([it.locationName, String(it.locationId), String(it.ownerCharId ?? ''), String(it.typeId), it.name, it.flag, String(it.quantity)])
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'assets_export.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const totalItems = items.reduce((s, i) => s + i.quantity, 0)

  return (
    <Layout header={<PageHeader title="Assets" sub={loading ? 'Laden...' : `${totalItems.toLocaleString()} items · ${groups.size} locaties`} right={
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select
          value={selectedChar}
          onChange={e => setSelectedChar(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          style={{
            padding: '0.3rem 0.55rem', background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 4, color: 'var(--text)', fontSize: '0.78rem', cursor: 'pointer',
          }}
        >
          {characterOptions.map(o => <option key={String(o.id)} value={String(o.id)}>{o.label}</option>)}
        </select>
        <input
          placeholder="Zoek item of locatie..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '0.3rem 0.6rem', width: 210, background: 'var(--surface2)',
            border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)',
            fontSize: '0.78rem', outline: 'none',
          }}
        />
        <button
          onClick={() => loadAssets()}
          disabled={loading}
          style={{
            padding: '0.3rem 0.75rem', background: 'rgba(0,180,216,0.1)',
            border: '1px solid rgba(0,180,216,0.4)', borderRadius: 4, color: 'var(--blue)',
            fontSize: '0.78rem', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
          }}
        >
          Ververs
        </button>
        <button
          onClick={exportCsv}
          disabled={items.length === 0}
          style={{
            padding: '0.3rem 0.75rem', background: 'var(--surface2)',
            border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)',
            fontSize: '0.78rem', cursor: items.length === 0 ? 'default' : 'pointer', opacity: items.length === 0 ? 0.4 : 1,
          }}
        >
          Export CSV
        </button>
      </div>
    }/>}>

      {loading && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)' }}>Assets laden...</div>}

      {!loading && groups.size === 0 && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)' }}>Geen assets gevonden</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {[...groups.entries()].map(([loc, { locationId, items }]) => {
          const isStruct = loc.startsWith('\x00struct:')
          const isLoc = loc.startsWith('\x00loc:')
          const unknown = isStruct || isLoc
          const structId = isStruct ? loc.slice('\x00struct:'.length) : isLoc ? loc.slice('\x00loc:'.length) : null
          const displayName = isStruct ? 'Onbekende structuur' : isLoc ? 'Onbekende locatie' : loc
          const open = !collapsed[loc]
          const qty = items.reduce((s, it) => s + it.quantity, 0)
          const routeCount = routeCounts[locationId]
          const routeLabel = routeCount === null
            ? originSystemId !== null ? 'berekenen…' : ''
            : routeCount === undefined || routeCount === -1
              ? ''
              : `${routeCount} sprongen`
          const sec = secLabel(locationId)

          return (
            <div key={loc} style={{ background: 'var(--surface)', border: `1px solid ${unknown ? 'rgba(28,28,53,0.6)' : 'var(--border)'}`, borderRadius: 4, overflow: 'hidden', opacity: unknown ? 0.65 : 1 }}>
              <div onClick={() => toggle(loc)} style={{ padding: '0.6rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', background: 'var(--surface2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: unknown ? 'var(--text-dim)' : 'var(--blue)' }}>{open ? '▾' : '▸'}</span>
                  {!unknown && sec && (
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: sec.color, minWidth: 28, textAlign: 'right' }}>{sec.label}</span>
                  )}
                  <span style={{ fontSize: '0.88rem', fontWeight: 600, color: unknown ? 'var(--text-dim)' : 'var(--text)' }}>{displayName}</span>
                  {unknown && structId && (
                    <span style={{ fontSize: '0.68rem', color: 'rgba(150,155,180,0.4)', fontFamily: 'monospace' }}>#{structId}</span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'flex', gap: '1rem', alignItems: 'center' }}>
                  <span>{items.length} soorten · {qty.toLocaleString()} items</span>
                  <span>{routeLabel}</span>
                </div>
              </div>

              {open && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={`${it.typeId}-${it.ownerCharId}-${i}`} style={{ borderTop: '1px solid rgba(28,28,53,0.5)', background: i % 2 ? 'rgba(15,15,34,0.04)' : 'transparent' }}>
                        <td style={{ padding: '0.4rem 0.6rem', width: 48 }}><EveImage category="types" id={it.typeId} variation="icon" size={32} px={32} /></td>
                        <td style={{ padding: '0.4rem 0.6rem', fontWeight: 700 }}>{it.name}</td>
                        <td style={{ padding: '0.4rem 0.6rem', color: 'var(--text-dim)' }}>{it.flag}</td>
                        <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', fontWeight: 700 }}>{it.quantity > 1 ? it.quantity.toLocaleString() : ''}</td>
                        <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                          {allTokens.find(t => t.characterId === it.ownerCharId)?.characterName ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>
    </Layout>
  )
}

