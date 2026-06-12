import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getPlanets, getPlanetDetail, getSchematic, resolveNames,
  type Planet, type PlanetPin, type SchematicPin,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'
import { usePageLoading } from '../hooks/usePageLoading'

const PLANET_COLOR: Record<string, string> = {
  temperate: '#3ecf6e', barren: '#a78bfa', gas: '#f97316',
  ice: '#00b4d8', lava: '#e05555', oceanic: '#0ea5e9',
  plasma: '#f0c040', storm: '#c8ddf0',
}

const PI_TIER: Record<number, number> = {}

interface SchematicFull {
  id: number
  name: string
  cycleTime: number
  inputs: SchematicPin[]
  output: SchematicPin | null
}

interface ChainNode {
  typeId: number
  name: string
  tier: 'raw' | 'p1' | 'p2' | 'p3' | 'p4'
  pinCount: number
  cycleTime: number
  outputQtyPerCycle: number
  inputs: Array<{ typeId: number; name: string; qtyPerCycle: number }>
}

interface ColonyChain {
  planetId: number
  planetType: string
  system: string
  systemId: number
  nodes: ChainNode[]
  rawTypes: Array<{ typeId: number; name: string; count: number }>
  expiry: Date | null
  isExpired: boolean
}

function tierLabel(t: ChainNode['tier']) {
  return t === 'raw' ? 'Raw' : t.toUpperCase()
}

function tierColor(t: ChainNode['tier']) {
  switch (t) {
    case 'raw': return 'var(--border)'
    case 'p1':  return '#34d399'
    case 'p2':  return '#60a5fa'
    case 'p3':  return '#a78bfa'
    case 'p4':  return '#f0c040'
  }
}

function guessTier(name: string): ChainNode['tier'] {
  const n = name.toLowerCase()
  if (n.includes('wetware') || n.includes('nano') || n.includes('integrity') ||
      n.includes('broadcast') || n.includes('recursive') || n.includes('sterile') ||
      n.includes('self-harm') || n.includes('transcranial') || n.includes('biotech')) return 'p4'
  if (n.includes('robotics') || n.includes('coolant') || n.includes('enriched') ||
      n.includes('fertilizer') || n.includes('genetically') || n.includes('livestock') ||
      n.includes('mechanical') || n.includes('oxidizing') || n.includes('polytextiles') ||
      n.includes('supertensile') || n.includes('synthetic') || n.includes('transmitter') ||
      n.includes('viral') || n.includes('water-cooled') || n.includes('condensates')) return 'p3'
  if (n.includes('biofuels') || n.includes('bacteria') || n.includes('biomass') ||
      n.includes('chiral') || n.includes('electrolytes') || n.includes('industrial') ||
      n.includes('oxidizing compounds') || n.includes('oxygen') || n.includes('plasmoids') ||
      n.includes('precious') || n.includes('protein') || n.includes('reactive') ||
      n.includes('silicate') || n.includes('toxic') || n.includes('water') ||
      n.includes('consumer') || n.includes('construction') || n.includes('test') ||
      n.includes('livestock')) return 'p2'
  if (n.includes('basic')) return 'p1'
  // Check output name - if schematic name contains "advanced" or similar
  if (n.includes('advanced')) return 'p2'
  return 'p1'
}

function Arrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', color: 'var(--border)', fontSize: '1rem', padding: '0 0.25rem' }}>→</div>
  )
}

function NodeCard({ node }: { node: ChainNode }) {
  const color = tierColor(node.tier)
  return (
    <div style={{
      background: 'var(--surface2)', border: `1px solid ${color}44`, borderTop: `2px solid ${color}`,
      borderRadius: 3, padding: '0.5rem 0.65rem', minWidth: 130, maxWidth: 180,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.25rem' }}>
        <EveImage category="types" id={node.typeId} variation="icon" size={24} px={20} />
        <span style={{ fontSize: '0.68rem', fontWeight: 700, lineHeight: 1.2, flex: 1, minWidth: 0 }}>{node.name}</span>
      </div>
      <div style={{ fontSize: '0.58rem', color, fontWeight: 700, letterSpacing: '0.08em' }}>{tierLabel(node.tier)}</div>
      {node.pinCount > 0 && (
        <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>
          ×{node.pinCount} factory · {Math.round(3600 / node.cycleTime * node.outputQtyPerCycle)}/h
        </div>
      )}
    </div>
  )
}

export default function PIChain() {
  const { activeTokens: tokens } = useAuth()
  const [colonies, setColonies] = useState<ColonyChain[]>([])
  const [loading, setLoading]   = useState(true)
  usePageLoading(loading)
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) { setLoading(false); return }
    const myId = ++fetchId.current
    setLoading(true); setColonies([])

    async function load() {
      const allPlanets: (Planet & { token: string; charId: number })[] = []
      await Promise.all(tokens.map(async t => {
        const list = await getPlanets(t.characterId, t.accessToken).catch(() => [] as Planet[])
        allPlanets.push(...list.map(p => ({ ...p, token: t.accessToken, charId: t.characterId })))
      }))
      if (myId !== fetchId.current) return

      const systemIds = [...new Set(allPlanets.map(p => p.solar_system_id))]
      const nameMap   = await resolveNames(systemIds)
      if (myId !== fetchId.current) return

      const details = await Promise.all(allPlanets.map(async p => ({
        planet: p,
        detail: await getPlanetDetail(p.charId, p.planet_id, p.token).catch(() => ({ pins: [] as PlanetPin[] })),
      })))
      if (myId !== fetchId.current) return

      const schematicIds = [...new Set(
        details.flatMap(d => d.detail.pins.map(p => p.schematic_id).filter((id): id is number => id != null))
      )]
      const schematics = new Map<number, SchematicFull>()
      await Promise.all(schematicIds.map(async id => {
        const raw = await getSchematic(id)
        if (!raw) return
        const inputs  = (raw.pins ?? []).filter(p => p.is_input)
        const output  = (raw.pins ?? []).find(p => !p.is_input) ?? null
        schematics.set(id, { id, name: raw.schematic_name, cycleTime: raw.cycle_time, inputs, output })
      }))
      if (myId !== fetchId.current) return

      // Resolve all type IDs for names
      const allTypeIds = [...new Set([
        ...schematicIds.flatMap(id => {
          const s = schematics.get(id)
          if (!s) return []
          return [...s.inputs.map(p => p.type_id), ...(s.output ? [s.output.type_id] : [])]
        }),
      ])]
      const typeNames = await resolveNames(allTypeIds)
      if (myId !== fetchId.current) return

      const resolved: ColonyChain[] = details.map(({ planet, detail }) => {
        const expiries = detail.pins
          .filter(p => p.expiry_time)
          .map(p => new Date(p.expiry_time!))
          .filter(d => !isNaN(d.getTime()))
        const expiry    = expiries.length ? expiries.reduce((a, b) => a < b ? a : b) : null
        const isExpired = expiry ? expiry < new Date() : false

        // Count factories per schematic
        const factoryCounts = new Map<number, number>()
        for (const pin of detail.pins) {
          if (pin.schematic_id != null) {
            factoryCounts.set(pin.schematic_id, (factoryCounts.get(pin.schematic_id) ?? 0) + 1)
          }
        }

        // Build chain nodes for each unique schematic
        const nodes: ChainNode[] = []
        for (const [schId, count] of factoryCounts.entries()) {
          const sch = schematics.get(schId)
          if (!sch || !sch.output) continue
          const outputName = typeNames.get(sch.output.type_id) ?? `Type ${sch.output.type_id}`
          nodes.push({
            typeId:            sch.output.type_id,
            name:              outputName,
            tier:              guessTier(outputName),
            pinCount:          count,
            cycleTime:         sch.cycleTime,
            outputQtyPerCycle: sch.output.quantity,
            inputs: sch.inputs.map(inp => ({
              typeId: inp.type_id,
              name:   typeNames.get(inp.type_id) ?? `Type ${inp.type_id}`,
              qtyPerCycle: inp.quantity,
            })),
          })
        }

        // Extractors — what raw resources
        const extractorTypes = new Map<number, number>()
        for (const pin of detail.pins) {
          if (pin.expiry_time != null && pin.type_id) {
            extractorTypes.set(pin.type_id, (extractorTypes.get(pin.type_id) ?? 0) + 1)
          }
        }

        // Resolve extractor output types — ESI doesn't give us what they extract directly
        // but we can infer from which P1 schematics accept which inputs
        const rawTypes: ColonyChain['rawTypes'] = []
        const knownInputs = new Set(nodes.filter(n => n.tier === 'p1').flatMap(n => n.inputs.map(i => i.typeId)))
        for (const typeId of knownInputs) {
          rawTypes.push({ typeId, name: typeNames.get(typeId) ?? `Type ${typeId}`, count: 1 })
        }

        return {
          planetId:   planet.planet_id,
          planetType: planet.planet_type,
          system:     nameMap.get(planet.solar_system_id) ?? '—',
          systemId:   planet.solar_system_id,
          nodes:      nodes.sort((a, b) => a.tier.localeCompare(b.tier)),
          rawTypes,
          expiry,
          isExpired,
        }
      }).filter(c => c.nodes.length > 0)
        .sort((a, b) => {
          if (!a.expiry) return 1
          if (!b.expiry) return -1
          return a.expiry.getTime() - b.expiry.getTime()
        })

      setColonies(resolved)
      setLoading(false)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  return (
    <Layout header={
      <PageHeader
        title="PI Chain"
        sub={loading ? 'Laden...' : `${colonies.length} actieve koloniën`}
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          PI data laden...
        </div>
      )}

      {!loading && colonies.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Geen actieve PI-koloniën met fabrieken gevonden
        </div>
      )}

      {!loading && colonies.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {colonies.map(c => {
            const color = PLANET_COLOR[c.planetType] ?? 'var(--border)'

            // Group nodes by tier for flow display
            const tiers: ChainNode['tier'][] = ['p1', 'p2', 'p3', 'p4']
            const byTier = tiers.map(t => c.nodes.filter(n => n.tier === t))

            return (
              <div key={c.planetId} style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderTop: `3px solid ${c.isExpired ? 'var(--red)' : color}`,
                borderRadius: 3, overflow: 'hidden',
              }}>
                {/* Header */}
                <div style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.7rem', color, fontWeight: 700 }}>
                    {c.planetType.charAt(0).toUpperCase() + c.planetType.slice(1)}
                  </span>
                  <SolarSystem name={c.system} systemId={c.systemId} fontSize="0.78rem" />
                  {c.isExpired && (
                    <span style={{ fontSize: '0.68rem', color: 'var(--red)', fontWeight: 600 }}>⚠ Verlopen</span>
                  )}
                  {c.expiry && !c.isExpired && (
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                      Verloopt: {c.expiry.toLocaleDateString('nl', { day: 'numeric', month: 'short' })} {c.expiry.toLocaleTimeString('nl', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>

                {/* Chain flow */}
                <div style={{ padding: '0.875rem 1rem', overflowX: 'auto' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0', minWidth: 'max-content' }}>

                    {/* Raw inputs */}
                    {c.rawTypes.length > 0 && (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {c.rawTypes.map(r => (
                            <div key={r.typeId} style={{
                              background: 'var(--surface2)', border: '1px solid var(--border)',
                              borderRadius: 3, padding: '0.4rem 0.6rem', minWidth: 110,
                              display: 'flex', alignItems: 'center', gap: '0.35rem',
                            }}>
                              <EveImage category="types" id={r.typeId} variation="icon" size={20} px={18} />
                              <div>
                                <div style={{ fontSize: '0.62rem', fontWeight: 600, lineHeight: 1.2 }}>{r.name}</div>
                                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)' }}>RAW</div>
                              </div>
                            </div>
                          ))}
                        </div>
                        <Arrow />
                      </>
                    )}

                    {/* P1 → P2 → P3 → P4 */}
                    {byTier.map((nodes, ti) => {
                      if (nodes.length === 0) return null
                      return (
                        <div key={ti} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                            {nodes.map(n => <NodeCard key={n.typeId} node={n} />)}
                          </div>
                          {ti < byTier.length - 1 && byTier.slice(ti + 1).some(t => t.length > 0) && <Arrow />}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Per-hour output summary */}
                <div style={{ borderTop: '1px solid var(--border)', padding: '0.5rem 1rem', display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
                  {c.nodes.filter(n => n.tier !== 'p1' || !c.nodes.some(m => m.inputs.some(i => i.typeId === n.typeId))).map(n => (
                    <div key={n.typeId} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <EveImage category="types" id={n.typeId} variation="icon" size={20} px={18} />
                      <span style={{ fontSize: '0.68rem', color: tierColor(n.tier), fontWeight: 600 }}>{n.name}</span>
                      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                        {Math.round(3600 / n.cycleTime * n.outputQtyPerCycle * n.pinCount)}/h
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Layout>
  )
}
