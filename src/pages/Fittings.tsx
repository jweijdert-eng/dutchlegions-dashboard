import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { deleteFitting, getFittings, getShipSlots, getTypesMeta, resolveNames, resolveTypeIds, saveFitting, type Fitting, type ShipSlots } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedFitting extends Fitting {
  shipName: string
  itemNames: Map<number, string>
  charId: number
}

const META_BADGE: Record<number, { label: string; color: string }> = {
  2:  { label: 'T2',      color: '#00b4d8' },
  3:  { label: 'Story',   color: '#a78bfa' },
  4:  { label: 'Faction', color: '#f0c040' },
  5:  { label: 'Officer', color: '#f97316' },
  6:  { label: 'DS',      color: '#e05555' },
  14: { label: 'T3',      color: '#3ecf6e' },
  15: { label: 'T3D',     color: '#3ecf6e' },
}

function MetaBadge({ metaId }: { metaId?: number }) {
  if (!metaId || !META_BADGE[metaId]) return null
  const { label, color } = META_BADGE[metaId]
  return (
    <span style={{
      display: 'inline-block', padding: '0.05rem 0.28rem',
      borderRadius: 2, fontSize: '0.54rem', fontWeight: 800, lineHeight: 1.5,
      background: `${color}22`, border: `1px solid ${color}55`, color,
      letterSpacing: '0.03em', flexShrink: 0,
    }}>
      {label}
    </span>
  )
}

function toEft(f: ResolvedFitting): string {
  const header = `[${f.shipName}, ${f.name}]`

  // Items die een slot delen (turret + geladen charge) op één regel: "Module, Charge"
  const slotLines = (flags: string[]) => {
    const byFlag = new Map<string, string[]>()
    for (const i of f.items) {
      if (!flags.includes(i.flag)) continue
      const name = f.itemNames.get(i.type_id) ?? `Type ${i.type_id}`
      byFlag.set(i.flag, [...(byFlag.get(i.flag) ?? []), name])
    }
    return [...byFlag.entries()]
      .sort((a, b) => flags.indexOf(a[0]) - flags.indexOf(b[0]))
      .map(([, names]) => names.join(', '))
  }

  const quantLines = (flags: string[]) =>
    f.items
      .filter(i => flags.includes(i.flag))
      .map(i => {
        const name = f.itemNames.get(i.type_id) ?? `Type ${i.type_id}`
        return i.quantity > 1 ? `${name} x${i.quantity}` : name
      })

  // Lo/med/hi/rig zijn positioneel (lege sectie = lege regel), zodat import
  // de secties weer correct kan toewijzen; de rest alleen indien gevuld.
  const structural = [
    slotLines(['LoSlot0','LoSlot1','LoSlot2','LoSlot3','LoSlot4','LoSlot5','LoSlot6','LoSlot7']),
    slotLines(['MedSlot0','MedSlot1','MedSlot2','MedSlot3','MedSlot4','MedSlot5','MedSlot6','MedSlot7']),
    slotLines(['HiSlot0','HiSlot1','HiSlot2','HiSlot3','HiSlot4','HiSlot5','HiSlot6','HiSlot7']),
    slotLines(['RigSlot0','RigSlot1','RigSlot2']),
  ]
  const optional = [
    slotLines(['SubSystemSlot0','SubSystemSlot1','SubSystemSlot2','SubSystemSlot3']),
    slotLines(['ServiceSlot0','ServiceSlot1','ServiceSlot2','ServiceSlot3','ServiceSlot4','ServiceSlot5','ServiceSlot6','ServiceSlot7']),
    quantLines(['DroneBay']),
    quantLines(['FighterBay']),
    quantLines(['Cargo']),
  ].filter(p => p.length > 0)

  const parts = [...structural, ...optional]
  return `${header}\n\n${parts.map(p => p.join('\n')).join('\n\n')}`.replace(/\n{3,}$/g, '\n')
}

function toDna(f: ResolvedFitting): string {
  const section = (prefix: string) =>
    f.items.filter(i => i.flag.startsWith(prefix)).map(i => `${i.type_id};${i.quantity}`).join(':')
  const sections = ['HiSlot', 'MedSlot', 'LoSlot', 'RigSlot', 'SubSystemSlot', 'ServiceSlot', 'DroneBay', 'FighterBay', 'Cargo']
    .map(section)
    .filter(s => s !== '')
  return [f.ship_type_id, ...sections].join(':') + '::'
}

const SLOT_GROUPS: Record<string, { label: string; color: string; flags: string[] }> = {
  high:  { label: 'High Slots',  color: '#e05555', flags: ['HiSlot0','HiSlot1','HiSlot2','HiSlot3','HiSlot4','HiSlot5','HiSlot6','HiSlot7'] },
  mid:   { label: 'Mid Slots',   color: '#00b4d8', flags: ['MedSlot0','MedSlot1','MedSlot2','MedSlot3','MedSlot4','MedSlot5','MedSlot6','MedSlot7'] },
  low:   { label: 'Low Slots',   color: '#f0c040', flags: ['LoSlot0','LoSlot1','LoSlot2','LoSlot3','LoSlot4','LoSlot5','LoSlot6','LoSlot7'] },
  rig:   { label: 'Rigs',        color: '#a78bfa', flags: ['RigSlot0','RigSlot1','RigSlot2'] },
  sub:   { label: 'Subsystems',  color: '#3ecf6e', flags: ['SubSystemSlot0','SubSystemSlot1','SubSystemSlot2','SubSystemSlot3'] },
  svc:   { label: 'Service Slots', color: '#e879f9', flags: ['ServiceSlot0','ServiceSlot1','ServiceSlot2','ServiceSlot3','ServiceSlot4','ServiceSlot5','ServiceSlot6','ServiceSlot7'] },
  drone: { label: 'Drones',      color: '#f97316', flags: ['DroneBay'] },
  fighter: { label: 'Fighters',  color: '#fb7185', flags: ['FighterBay'] },
  cargo: { label: 'Cargo',       color: '#94a3b8', flags: ['Cargo'] },
}

function parseEft(eft: string): { shipName: string; fittingName: string; items: Array<{ name: string; quantity: number; flag: string }> } | null {
  const lines = eft.trim().split('\n')
  const header = lines[0].trim().match(/^\[(.+?),\s*(.+)\]$/)
  if (!header) return null
  const [, shipName, fittingName] = header

  const HI_FLAGS  = ['HiSlot0','HiSlot1','HiSlot2','HiSlot3','HiSlot4','HiSlot5','HiSlot6','HiSlot7']
  const MED_FLAGS = ['MedSlot0','MedSlot1','MedSlot2','MedSlot3','MedSlot4','MedSlot5','MedSlot6','MedSlot7']
  const LO_FLAGS  = ['LoSlot0','LoSlot1','LoSlot2','LoSlot3','LoSlot4','LoSlot5','LoSlot6','LoSlot7']
  const RIG_FLAGS = ['RigSlot0','RigSlot1','RigSlot2']
  const SUB_FLAGS = ['SubSystemSlot0','SubSystemSlot1','SubSystemSlot2','SubSystemSlot3']
  // EFT section order: low, mid, high, rigs, [subsystems: alleen T3C], drones, cargo
  const SECTION_SLOTS = [LO_FLAGS, MED_FLAGS, HI_FLAGS, RIG_FLAGS]
  const isT3 = ['tengu', 'loki', 'proteus', 'legion'].includes(shipName.trim().toLowerCase())
  const subSection   = isT3 ? 4 : -1
  const droneSection = isT3 ? 5 : 4

  const body = lines.slice(1)
  if (body[0]?.trim() === '') body.shift() // optionele lege regel na header is geen sectie-overgang

  const items: Array<{ name: string; quantity: number; flag: string }> = []
  let section = 0
  const sectionIdx: Record<number, number> = {}

  for (const raw of body) {
    let line = raw.trim()
    if (line === '') { section++; continue }
    if (line.startsWith('[')) continue // [Empty Low slot] e.d.
    line = line.replace(/\s*\/offline$/i, '')

    // Loaded charge on module line: "200mm AutoCannon II, Republic Fleet EMP S"
    let chargeName: string | null = null
    if (section < 3) {
      const comma = line.indexOf(', ')
      if (comma > 0) {
        chargeName = line.slice(comma + 2).trim()
        line = line.slice(0, comma).trim()
      }
    }

    const qMatch = line.match(/^(.+?)\s+x\s*(\d+)$/i)
    const name = qMatch ? qMatch[1].trim() : line
    const quantity = qMatch ? parseInt(qMatch[2]) : 1
    if (!name) continue

    let flag: string
    if (section < 4) {
      const slots = SECTION_SLOTS[section]
      const idx = sectionIdx[section] ?? 0
      flag = slots[Math.min(idx, slots.length - 1)]
      sectionIdx[section] = idx + 1
    } else if (section === subSection) {
      const idx = sectionIdx[section] ?? 0
      flag = SUB_FLAGS[Math.min(idx, SUB_FLAGS.length - 1)]
      sectionIdx[section] = idx + 1
    } else if (section === droneSection) {
      flag = 'DroneBay'
    } else {
      flag = 'Cargo'
    }

    items.push({ name, quantity, flag })
    if (chargeName) items.push({ name: chargeName, quantity: 1, flag })
  }

  return { shipName: shipName.trim(), fittingName: fittingName.trim(), items }
}

// ─── Fitting Wheel ────────────────────────────────────────────────────────────

const WHEEL = 440
const WCX = 220
const WCY = 220
const SHIP_D = 350    // ship render diameter (large, fills inner circle)

// 0° = top (north), clockwise
function arcPt(deg: number, r: number): [number, number] {
  const rad = deg * Math.PI / 180
  return [WCX + r * Math.sin(rad), WCY - r * Math.cos(rad)]
}

// In-game layout: Hi=TOP, Med=RIGHT, Lo=BOTTOM, Rigs klein linksonder, Subs links
const RING_IN  = 178
const RING_OUT = 214

const WHEEL_GROUPS: Array<{ prefix: string; attr: keyof ShipSlots; center: number; slotW: number; color: string; max: number }> = [
  { prefix: 'HiSlot',        attr: 'hi',      center: 0,   slotW: 11, color: '#4ade80', max: 8 },
  { prefix: 'MedSlot',       attr: 'med',     center: 90,  slotW: 11, color: '#38bdf8', max: 8 },
  { prefix: 'LoSlot',        attr: 'low',     center: 180, slotW: 11, color: '#fbbf24', max: 8 },
  { prefix: 'RigSlot',       attr: 'rig',     center: 247, slotW: 9,  color: '#a78bfa', max: 3 },
  { prefix: 'SubSystemSlot', attr: 'sub',     center: 293, slotW: 11, color: '#3ecf6e', max: 4 },
  { prefix: 'ServiceSlot',   attr: 'service', center: 285, slotW: 11, color: '#e879f9', max: 8 },
]

// Annulaire sector (trapezium-slot in de ring), hoeken in graden vanaf noord
function segPath(a1: number, a2: number, r1 = RING_IN, r2 = RING_OUT) {
  const [x1, y1] = arcPt(a1, r2), [x2, y2] = arcPt(a2, r2)
  const [x3, y3] = arcPt(a2, r1), [x4, y4] = arcPt(a1, r1)
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r2} ${r2} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
    + ` L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${r1} ${r1} 0 0 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z`
}

function ringArc(a1: number, a2: number, r: number) {
  const [x1, y1] = arcPt(a1, r), [x2, y2] = arcPt(a2, r)
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

const typeIcon = (id: number) => `https://images.evetech.net/types/${id}/icon?size=64`

function FittingWheel({ fitting, metaMap: _metaMap }: { fitting: ResolvedFitting; metaMap: Map<number, number> }) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [shipSlots, setShipSlots] = useState<ShipSlots | null>(null)

  useEffect(() => {
    let alive = true
    getShipSlots(fitting.ship_type_id).then(s => { if (alive) setShipSlots(s) })
    return () => { alive = false }
  }, [fitting.ship_type_id])

  // Alle items per slot-flag; bij turret + geladen ammo is de module het qty-1 item
  const byFlag = new Map<string, Array<typeof fitting.items[number]>>()
  for (const item of fitting.items) {
    byFlag.set(item.flag, [...(byFlag.get(item.flag) ?? []), item])
  }

  const itemName = (id: number) => fitting.itemNames.get(id) ?? `Type ${id}`

  // Aantal getoonde slots: dogma-waarde van het schip, minimaal wat er gefit is
  const fittedCount = (prefix: string) => {
    let m = 0
    for (const i of fitting.items) {
      if (!i.flag.startsWith(prefix)) continue
      const n = parseInt(i.flag.slice(prefix.length))
      if (!isNaN(n)) m = Math.max(m, n + 1)
    }
    return m
  }

  const SHIP_R = SHIP_D / 2
  const R_MID  = (RING_IN + RING_OUT) / 2
  const ICON   = 34

  return (
    <div style={{ position: 'relative', width: WHEEL, height: WHEEL, flexShrink: 0, borderRadius: '50%', background: 'rgba(3,4,10,0.99)', overflow: 'hidden' }}>
      {/* Ship render — large, fills inner circle */}
      <div style={{
        position: 'absolute',
        left: WCX - SHIP_R, top: WCY - SHIP_R,
        width: SHIP_D, height: SHIP_D,
        borderRadius: '50%', overflow: 'hidden',
        background: '#05060e',
      }}>
        <EveImage category="types" id={fitting.ship_type_id} variation="render" size={512} px={SHIP_D} />
      </div>

      <svg width={WHEEL} height={WHEEL} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          {/* Holo-tint + vignette over de ship render */}
          <radialGradient id={`vig-${fitting.fitting_id}`} cx="50%" cy="50%" r="50%">
            <stop offset="40%" stopColor="rgba(60,120,200,0.09)" />
            <stop offset="60%" stopColor="rgba(25,50,95,0.12)" />
            <stop offset="78%" stopColor="rgba(3,4,10,0.7)" />
            <stop offset="92%" stopColor="rgba(3,4,10,0.95)" />
            <stop offset="100%" stopColor="rgba(3,4,10,0.99)" />
          </radialGradient>
        </defs>

        <circle cx={WCX} cy={WCY} r={SHIP_R} fill={`url(#vig-${fitting.fitting_id})`} />

        {/* Donkere ring waar de slot-segmenten in liggen */}
        <circle cx={WCX} cy={WCY} r={(RING_IN + WCX) / 2} fill="none" stroke="rgba(4,6,11,0.97)" strokeWidth={WCX - RING_IN + 4} />
        <circle cx={WCX} cy={WCY} r={WCX - 1} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1.5" />
        <circle cx={WCX} cy={WCY} r={RING_IN - 1} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

        {/* Slot-segmenten per groep, in-game stijl: alleen de échte slots van het schip */}
        {WHEEL_GROUPS.map(g => {
          const n = Math.min(g.max, Math.max(shipSlots?.[g.attr] ?? 0, fittedCount(g.prefix)))
          if (n === 0) return null
          const start = g.center - n * g.slotW / 2
          return (
            <g key={g.prefix}>
              {/* Groepskleur-boog aan de binnenrand, ter oriëntatie */}
              <path d={ringArc(start + 0.8, start + n * g.slotW - 0.8, RING_IN - 4)} fill="none" stroke={g.color} strokeWidth="2" opacity="0.45" strokeLinecap="round" />
              {Array.from({ length: n }, (_, i) => {
                const a1 = start + i * g.slotW + 0.7
                const a2 = start + (i + 1) * g.slotW - 0.7
                const flag = `${g.prefix}${i}`
                const inSlot = byFlag.get(flag) ?? []
                const mod = inSlot.length <= 1 ? inSlot[0] : (inSlot.find(x => x.quantity === 1) ?? inSlot[0])
                const charge = inSlot.find(x => x !== mod)
                const isHov = hovered === flag
                const mid = (a1 + a2) / 2
                const [ix, iy]   = arcPt(mid, R_MID)
                const [chx, chy] = arcPt(mid, RING_IN + 8)
                const clipId = `cl-${fitting.fitting_id}-${flag}`
                return (
                  <g key={flag} style={{ pointerEvents: 'auto' }}
                     onMouseEnter={() => setHovered(flag)} onMouseLeave={() => setHovered(null)}>
                    <title>{mod ? itemName(mod.type_id) + (charge ? `\n↳ ${itemName(charge.type_id)}` : '') : 'Leeg slot'}</title>
                    <clipPath id={clipId}><path d={segPath(a1, a2)} /></clipPath>
                    <path d={segPath(a1, a2)}
                      fill={mod ? (isHov ? 'rgba(44,58,50,0.97)' : 'rgba(24,32,28,0.95)') : 'rgba(11,15,21,0.9)'}
                      stroke={isHov ? g.color : 'rgba(255,255,255,0.10)'} strokeWidth="1"
                      style={{ transition: 'fill 0.12s' }} />
                    {mod && (
                      <image href={typeIcon(mod.type_id)} x={ix - ICON / 2} y={iy - ICON / 2} width={ICON} height={ICON}
                        clipPath={`url(#${clipId})`} preserveAspectRatio="xMidYMid slice" />
                    )}
                    {/* Groene 'gefit'-rand aan de buitenkant, zoals in-game */}
                    {mod && (
                      <path d={ringArc(a1 + 1, a2 - 1, RING_OUT + 2.5)} fill="none" stroke="#5fe879" strokeWidth="3" strokeLinecap="round" opacity={isHov ? 1 : 0.8} />
                    )}
                    {/* Geladen charge als kleine badge aan de binnenkant van het slot */}
                    {charge && (
                      <>
                        <clipPath id={`${clipId}-c`}><circle cx={chx} cy={chy} r={9} /></clipPath>
                        <circle cx={chx} cy={chy} r={10} fill="rgba(4,7,11,0.95)" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
                        <image href={typeIcon(charge.type_id)} x={chx - 9} y={chy - 9} width={18} height={18} clipPath={`url(#${clipId}-c)`} />
                      </>
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Fittings() {
  const { activeTokens: tokens } = useAuth()
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const [fittings, setFittings]   = useState<ResolvedFitting[]>([])
  const [loading, setLoading]     = useState(true)
  usePageLoading(loading)
  const [search, setSearch]       = useState('')
  const [open, setOpen]           = useState<Set<number>>(new Set())
  const [copied, setCopied]       = useState<number | null>(null)
  const [copiedDna, setCopiedDna] = useState<number | null>(null)
  const [metaMap, setMetaMap]     = useState(new Map<number, number>())
  const fetchId = useRef(0)
  const [reloadKey, setReloadKey] = useState(0)

  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [deleting, setDeleting]           = useState<number | null>(null)
  const [deleteError, setDeleteError]     = useState<string | null>(null)

  const [importOpen, setImportOpen]       = useState(false)
  const [importEft, setImportEft]         = useState('')
  const [importName, setImportName]       = useState('')
  const [importCharId, setImportCharId]   = useState<number | null>(null)
  const [importing, setImporting]         = useState(false)
  const [importError, setImportError]     = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  const [eftPreview, setEftPreview]       = useState<{ shipName: string; itemCount: number } | null>(null)

  function copyEft(f: ResolvedFitting) {
    navigator.clipboard.writeText(toEft(f)).then(() => {
      setCopied(f.fitting_id)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  function copyDna(f: ResolvedFitting) {
    navigator.clipboard.writeText(toDna(f)).then(() => {
      setCopiedDna(f.fitting_id)
      setTimeout(() => setCopiedDna(null), 1500)
    })
  }

  async function handleDelete(f: ResolvedFitting) {
    setDeleting(f.fitting_id)
    setDeleteError(null)
    const token = tokensRef.current.find(t => t.characterId === f.charId)?.accessToken
    if (!token) { setDeleting(null); return }
    const result = await deleteFitting(f.charId, f.fitting_id, token)
    setDeleting(null)
    setConfirmDelete(null)
    if (result.ok) {
      setFittings(prev => prev.filter(x => x.fitting_id !== f.fitting_id))
    } else {
      setDeleteError(`Verwijderen mislukt (${result.status})${result.error ? ': ' + result.error : ''}`)
    }
  }

  function handleEftChange(value: string) {
    setImportEft(value)
    setImportError(null)
    setImportSuccess(null)
    const parsed = parseEft(value)
    if (parsed) {
      setEftPreview({ shipName: parsed.shipName, itemCount: parsed.items.length })
      setImportName(parsed.fittingName)
    } else {
      setEftPreview(null)
    }
  }

  async function handleSaveFitting() {
    const parsed = parseEft(importEft)
    if (!parsed) { setImportError('Ongeldig EFT formaat'); return }

    const charId = importCharId ?? tokensRef.current[0]?.characterId
    const token = tokensRef.current.find(t => t.characterId === charId)?.accessToken
    if (!charId || !token) { setImportError('Geen character geselecteerd'); return }

    setImporting(true)
    setImportError(null)

    try {
      const uniqueNames = [...new Set([parsed.shipName, ...parsed.items.map(i => i.name)])]
      const typeIdMap = await resolveTypeIds(uniqueNames)

      const shipTypeId = typeIdMap.get(parsed.shipName.toLowerCase())
      if (!shipTypeId) {
        setImportError(`Schip niet gevonden: ${parsed.shipName}`)
        setImporting(false)
        return
      }

      const fittingItems: Array<{ flag: string; quantity: number; type_id: number }> = []
      const missing: string[] = []
      for (const item of parsed.items) {
        const typeId = typeIdMap.get(item.name.toLowerCase())
        if (!typeId) { missing.push(item.name); continue }
        fittingItems.push({ flag: item.flag, quantity: item.quantity, type_id: typeId })
      }

      if (missing.length > 0) {
        setImportError(`Modules niet gevonden: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} meer)` : ''}`)
        setImporting(false)
        return
      }

      const result = await saveFitting(charId, token, {
        name: (importName || parsed.fittingName).slice(0, 50),
        description: '',
        ship_type_id: shipTypeId,
        items: fittingItems,
      })

      if (result.ok) {
        setImportSuccess('Fitting opgeslagen!')
        setTimeout(() => {
          setImportOpen(false)
          setImportSuccess(null)
          setReloadKey(k => k + 1)
        }, 1200)
      } else {
        setImportError(`Opslaan mislukt (${result.status})${result.error ? ': ' + result.error : ''}`)
      }
    } catch {
      setImportError('Opslaan mislukt')
    }
    setImporting(false)
  }

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setFittings([])

    async function load() {
      const allFits: Array<Fitting & { _charId: number }> = []
      await Promise.all(tokens.map(async t => {
        const f = await getFittings(t.characterId, t.accessToken).catch(() => [] as Fitting[])
        allFits.push(...f.map(fit => ({ ...fit, _charId: t.characterId })))
      }))

      if (myId !== fetchId.current) return

      const typeIds = [...new Set([
        ...allFits.map(f => f.ship_type_id),
        ...allFits.flatMap(f => f.items.map(i => i.type_id)),
      ])]
      const nameMap = await resolveNames(typeIds)

      if (myId !== fetchId.current) return

      const resolved: ResolvedFitting[] = allFits
        .map(f => ({
          ...f,
          charId:    f._charId,
          shipName:  nameMap.get(f.ship_type_id) ?? `Ship ${f.ship_type_id}`,
          itemNames: nameMap,
        }))
        .sort((a, b) => a.shipName.localeCompare(b.shipName) || a.name.localeCompare(b.name))

      setFittings(resolved)
      setLoading(false)

      const allItemIds = [...new Set([
        ...allFits.map(f => f.ship_type_id),
        ...allFits.flatMap(f => f.items.map(i => i.type_id)),
      ])]
      getTypesMeta(allItemIds).then(meta => {
        if (myId !== fetchId.current) return
        setMetaMap(meta)
      })
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(','), reloadKey])

  const q = search.toLowerCase()
  const filtered = fittings.filter(f =>
    q === '' ||
    f.name.toLowerCase().includes(q) ||
    f.shipName.toLowerCase().includes(q) ||
    f.items.some(i => (f.itemNames.get(i.type_id) ?? '').toLowerCase().includes(q))
  )

  const toggleOpen = (id: number) => {
    setOpen(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  return (
    <Layout header={
      <PageHeader
        title="Fittings"
        sub={loading ? 'Laden...' : `${fittings.length} fittings`}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={() => {
                setImportOpen(true)
                setImportError(null); setImportSuccess(null)
                setEftPreview(null); setImportName(''); setImportEft('')
                setImportCharId(tokensRef.current[0]?.characterId ?? null)
              }}
              style={{
                background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.3)',
                color: 'var(--blue)', borderRadius: 2, fontSize: '0.72rem',
                padding: '0.3rem 0.6rem', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              + Importeer EFT
            </button>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Zoek fitting of schip..."
              style={{
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 2, padding: '0.3rem 0.6rem', color: 'var(--text)',
                fontSize: '0.72rem', outline: 'none', width: 220,
              }}
            />
          </div>
        }
      />
    }>
      {deleteError && (
        <div style={{
          background: 'rgba(224,85,85,0.12)', border: '1px solid rgba(224,85,85,0.4)',
          borderRadius: 3, padding: '0.6rem 1rem', marginBottom: '0.75rem',
          fontSize: '0.75rem', color: '#e05555', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          {deleteError}
          <button onClick={() => setDeleteError(null)} style={{ background: 'none', border: 'none', color: '#e05555', cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}>✕</button>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Fittings laden...</div>
      )}
      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen fittings gevonden</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {filtered.map(f => {
          const isOpen       = open.has(f.fitting_id)
          const isConfirming = confirmDelete === f.fitting_id
          const isDeleting   = deleting === f.fitting_id
          return (
            <div key={f.fitting_id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
              {/* Header row */}
              <div
                onClick={() => !isConfirming && toggleOpen(f.fitting_id)}
                style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: isConfirming ? 'default' : 'pointer', background: isOpen ? 'rgba(0,180,216,0.05)' : 'var(--surface2)' }}
                onMouseEnter={e => !isConfirming && (e.currentTarget.style.background = 'rgba(0,180,216,0.07)')}
                onMouseLeave={e => !isConfirming && (e.currentTarget.style.background = isOpen ? 'rgba(0,180,216,0.05)' : 'var(--surface2)')}
              >
                <EveImage category="types" id={f.ship_type_id} variation="icon" size={64} px={42} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.82rem', fontWeight: 700 }}>{f.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.1rem' }}>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{f.shipName}</span>
                    <MetaBadge metaId={metaMap.get(f.ship_type_id)} />
                  </div>
                  {f.description && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.15rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.description}</div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                  {isConfirming ? (
                    <>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>Verwijderen?</span>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(f) }}
                        disabled={isDeleting}
                        style={{ background: 'rgba(224,85,85,0.15)', border: '1px solid rgba(224,85,85,0.4)', color: '#e05555', borderRadius: 2, fontSize: '0.62rem', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                      >
                        {isDeleting ? '...' : 'Ja'}
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); setConfirmDelete(null) }}
                        style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 2, fontSize: '0.62rem', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                      >
                        Nee
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{f.items.length} modules</span>
                      <button onClick={e => { e.stopPropagation(); copyEft(f) }} title="Kopieer EFT"
                        style={{ background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.25)', color: copied === f.fitting_id ? 'var(--green)' : 'var(--blue)', borderRadius: 2, fontSize: '0.62rem', padding: '0.2rem 0.45rem', cursor: 'pointer' }}>
                        {copied === f.fitting_id ? '✓ EFT' : '⎘ EFT'}
                      </button>
                      <button onClick={e => { e.stopPropagation(); copyDna(f) }} title="Kopieer Ship DNA"
                        style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)', color: copiedDna === f.fitting_id ? 'var(--green)' : '#a78bfa', borderRadius: 2, fontSize: '0.62rem', padding: '0.2rem 0.45rem', cursor: 'pointer' }}>
                        {copiedDna === f.fitting_id ? '✓ DNA' : '⎘ DNA'}
                      </button>
                      <button onClick={e => { e.stopPropagation(); setConfirmDelete(f.fitting_id) }} title="Fitting verwijderen"
                        style={{ background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.25)', color: '#e05555', borderRadius: 2, fontSize: '0.62rem', padding: '0.2rem 0.45rem', cursor: 'pointer' }}>
                        🗑
                      </button>
                      <span style={{ color: 'var(--blue)', fontSize: '0.7rem' }}>{isOpen ? '▾' : '▸'}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Expanded: wheel + slot list */}
              {isOpen && !isConfirming && (
                <div style={{ padding: '1rem 1.25rem', display: 'flex', gap: '1.5rem', alignItems: 'flex-start', background: 'rgba(0,0,0,0.2)', flexWrap: 'wrap' }}>
                  <FittingWheel fitting={f} metaMap={metaMap} />
                  <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {Object.entries(SLOT_GROUPS).map(([key, group]) => {
                      const items = f.items.filter(i => group.flags.includes(i.flag))
                      if (items.length === 0) return null
                      return (
                        <div key={key}>
                          <div style={{ fontSize: '0.58rem', color: group.color, fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.35rem' }}>
                            {group.label.toUpperCase()}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
                            {items.map((item, j) => (
                              <div key={j} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <EveImage category="types" id={item.type_id} variation="icon" size={32} px={20} />
                                <span style={{ fontSize: '0.68rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                  {f.itemNames.get(item.type_id) ?? `Type ${item.type_id}`}
                                  {item.quantity > 1 && <span style={{ color: 'var(--text-dim)', marginLeft: '0.3rem' }}>×{item.quantity}</span>}
                                </span>
                                <MetaBadge metaId={metaMap.get(item.type_id)} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Import modal */}
      {importOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget) setImportOpen(false) }}
        >
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '1.5rem', width: '100%', maxWidth: 500, maxHeight: '85vh', overflow: 'auto' }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '1.25rem' }}>Fitting importeren (EFT)</div>

            {tokens.length > 1 && (
              <div style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>Character</div>
                <select
                  value={importCharId ?? tokensRef.current[0]?.characterId ?? ''}
                  onChange={e => setImportCharId(Number(e.target.value))}
                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 2, padding: '0.3rem 0.5rem', fontSize: '0.75rem', width: '100%', boxSizing: 'border-box' }}
                >
                  {tokens.map(t => <option key={t.characterId} value={t.characterId}>{t.characterName}</option>)}
                </select>
              </div>
            )}

            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>EFT</div>
              <textarea
                value={importEft}
                onChange={e => handleEftChange(e.target.value)}
                rows={12}
                placeholder={'[Rifter, My Fit]\n\nDamage Control I\n\nSmall Shield Extender I\n\n'}
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 2, padding: '0.5rem', fontSize: '0.72rem', fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>

            {eftPreview && (
              <div style={{ fontSize: '0.7rem', color: 'var(--green)', marginBottom: '0.75rem', background: 'rgba(62,207,110,0.08)', border: '1px solid rgba(62,207,110,0.25)', borderRadius: 2, padding: '0.4rem 0.6rem' }}>
                ✓ {eftPreview.shipName} — {eftPreview.itemCount} modules
              </div>
            )}

            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '0.3rem' }}>Naam</div>
              <input
                value={importName}
                onChange={e => setImportName(e.target.value)}
                placeholder="Fitting naam..."
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 2, padding: '0.3rem 0.5rem', fontSize: '0.75rem', boxSizing: 'border-box', outline: 'none' }}
              />
            </div>

            {importError && (
              <div style={{ fontSize: '0.7rem', color: '#e05555', marginBottom: '0.75rem', background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.3)', borderRadius: 2, padding: '0.4rem 0.6rem' }}>
                {importError}
              </div>
            )}
            {importSuccess && (
              <div style={{ fontSize: '0.7rem', color: 'var(--green)', marginBottom: '0.75rem', background: 'rgba(62,207,110,0.08)', border: '1px solid rgba(62,207,110,0.25)', borderRadius: 2, padding: '0.4rem 0.6rem' }}>
                {importSuccess}
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setImportOpen(false)}
                style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 2, fontSize: '0.75rem', padding: '0.4rem 0.8rem', cursor: 'pointer' }}
              >
                Annuleer
              </button>
              <button
                onClick={handleSaveFitting}
                disabled={importing || !eftPreview}
                style={{
                  background: !eftPreview ? 'rgba(0,180,216,0.05)' : 'rgba(0,180,216,0.2)',
                  border: '1px solid rgba(0,180,216,0.4)',
                  color: !eftPreview ? 'rgba(0,180,216,0.35)' : 'var(--blue)',
                  borderRadius: 2, fontSize: '0.75rem', padding: '0.4rem 0.8rem',
                  cursor: importing || !eftPreview ? 'not-allowed' : 'pointer',
                }}
              >
                {importing ? 'Opslaan...' : 'Opslaan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
