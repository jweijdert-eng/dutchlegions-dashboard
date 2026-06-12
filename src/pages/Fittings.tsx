import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { deleteFitting, getFittings, getTypesMeta, resolveNames, resolveTypeIds, saveFitting, type Fitting } from '../api/esi'
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

  const slotLines = (flags: string[]) =>
    f.items
      .filter(i => flags.includes(i.flag))
      .sort((a, b) => flags.indexOf(a.flag) - flags.indexOf(b.flag))
      .map(i => f.itemNames.get(i.type_id) ?? `Type ${i.type_id}`)

  const quantLines = (flags: string[]) =>
    f.items
      .filter(i => flags.includes(i.flag))
      .map(i => {
        const name = f.itemNames.get(i.type_id) ?? `Type ${i.type_id}`
        return i.quantity > 1 ? `${name} x${i.quantity}` : name
      })

  const parts = [
    slotLines(['LoSlot0','LoSlot1','LoSlot2','LoSlot3','LoSlot4','LoSlot5','LoSlot6','LoSlot7']),
    slotLines(['MedSlot0','MedSlot1','MedSlot2','MedSlot3','MedSlot4','MedSlot5','MedSlot6','MedSlot7']),
    slotLines(['HiSlot0','HiSlot1','HiSlot2','HiSlot3','HiSlot4','HiSlot5','HiSlot6','HiSlot7']),
    slotLines(['RigSlot0','RigSlot1','RigSlot2']),
    slotLines(['SubSystemSlot0','SubSystemSlot1','SubSystemSlot2','SubSystemSlot3']),
    quantLines(['DroneBay']),
    quantLines(['Cargo']),
  ].filter(p => p.length > 0)

  return `${header}\n\n${parts.map(p => p.join('\n')).join('\n\n')}`
}

function toDna(f: ResolvedFitting): string {
  const section = (flags: string[]) =>
    f.items.filter(i => flags.includes(i.flag)).map(i => `${i.type_id};${i.quantity}`).join(':')
  return [
    f.ship_type_id,
    section(['HiSlot0','HiSlot1','HiSlot2','HiSlot3','HiSlot4','HiSlot5','HiSlot6','HiSlot7']),
    section(['MedSlot0','MedSlot1','MedSlot2','MedSlot3','MedSlot4','MedSlot5','MedSlot6','MedSlot7']),
    section(['LoSlot0','LoSlot1','LoSlot2','LoSlot3','LoSlot4','LoSlot5','LoSlot6','LoSlot7']),
    section(['RigSlot0','RigSlot1','RigSlot2']),
    section(['SubSystemSlot0','SubSystemSlot1','SubSystemSlot2','SubSystemSlot3']),
    '',
  ].join(':')
}

const SLOT_GROUPS: Record<string, { label: string; color: string; flags: string[] }> = {
  high:  { label: 'High Slots',  color: '#e05555', flags: ['HiSlot0','HiSlot1','HiSlot2','HiSlot3','HiSlot4','HiSlot5','HiSlot6','HiSlot7'] },
  mid:   { label: 'Mid Slots',   color: '#00b4d8', flags: ['MedSlot0','MedSlot1','MedSlot2','MedSlot3','MedSlot4','MedSlot5','MedSlot6','MedSlot7'] },
  low:   { label: 'Low Slots',   color: '#f0c040', flags: ['LoSlot0','LoSlot1','LoSlot2','LoSlot3','LoSlot4','LoSlot5','LoSlot6','LoSlot7'] },
  rig:   { label: 'Rigs',        color: '#a78bfa', flags: ['RigSlot0','RigSlot1','RigSlot2'] },
  sub:   { label: 'Subsystems',  color: '#3ecf6e', flags: ['SubSystemSlot0','SubSystemSlot1','SubSystemSlot2','SubSystemSlot3'] },
  drone: { label: 'Drones',      color: '#f97316', flags: ['DroneBay'] },
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
  const SECTION_SLOTS = [HI_FLAGS, MED_FLAGS, LO_FLAGS, RIG_FLAGS]

  const items: Array<{ name: string; quantity: number; flag: string }> = []
  let section = 0
  const sectionIdx: Record<number, number> = {}

  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (line === '') { section++; continue }
    if (line.startsWith('[')) continue

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
    } else if (section === 4 && quantity === 1) {
      const idx = sectionIdx[section] ?? 0
      flag = SUB_FLAGS[Math.min(idx, SUB_FLAGS.length - 1)]
      sectionIdx[section] = idx + 1
    } else if (section <= 5) {
      flag = 'DroneBay'
    } else {
      flag = 'Cargo'
    }

    items.push({ name, quantity, flag })
  }

  return { shipName: shipName.trim(), fittingName: fittingName.trim(), items }
}

// ─── Fitting Wheel ────────────────────────────────────────────────────────────

const WHEEL = 440
const WCX = 220
const WCY = 220
const OUTER_R = 192   // icon center radius (near outer edge)
const INNER_R = 120   // drone inner radius
const ICON_SZ = 40    // square icon size
const SHIP_D = 350    // ship render diameter (large, fills inner circle)

// 0° = top (north), clockwise
function slotXY(deg: number, r: number) {
  const rad = deg * Math.PI / 180
  return {
    left: Math.round(WCX + r * Math.sin(rad) - ICON_SZ / 2),
    top:  Math.round(WCY - r * Math.cos(rad) - ICON_SZ / 2),
  }
}
function arcPt(deg: number, r: number): [number, number] {
  const rad = deg * Math.PI / 180
  return [WCX + r * Math.sin(rad), WCY - r * Math.cos(rad)]
}

// EVE Workbench layout: Hi=TOP, Med=RIGHT, Rig=BOTTOM, Lo=LEFT
const HI  = { color: '#4ade80', bg: 'rgba(20,83,45,0.88)'    }
const MED = { color: '#fb923c', bg: 'rgba(120,45,15,0.88)'   }
const RIG = { color: '#22d3ee', bg: 'rgba(12,74,110,0.88)'   }
const LO  = { color: '#fbbf24', bg: 'rgba(70,55,5,0.88)'     }

const SLOT_POS: Record<string, { deg: number; r: number; color: string; bg: string }> = {
  HiSlot0: { deg: 330, r: OUTER_R, ...HI },
  HiSlot1: { deg: 339, r: OUTER_R, ...HI },
  HiSlot2: { deg: 347, r: OUTER_R, ...HI },
  HiSlot3: { deg: 356, r: OUTER_R, ...HI },
  HiSlot4: { deg: 4,   r: OUTER_R, ...HI },
  HiSlot5: { deg: 13,  r: OUTER_R, ...HI },
  HiSlot6: { deg: 21,  r: OUTER_R, ...HI },
  HiSlot7: { deg: 30,  r: OUTER_R, ...HI },
  MedSlot0: { deg: 45,  r: OUTER_R, ...MED },
  MedSlot1: { deg: 58,  r: OUTER_R, ...MED },
  MedSlot2: { deg: 71,  r: OUTER_R, ...MED },
  MedSlot3: { deg: 84,  r: OUTER_R, ...MED },
  MedSlot4: { deg: 96,  r: OUTER_R, ...MED },
  MedSlot5: { deg: 109, r: OUTER_R, ...MED },
  MedSlot6: { deg: 122, r: OUTER_R, ...MED },
  MedSlot7: { deg: 135, r: OUTER_R, ...MED },
  RigSlot0: { deg: 150, r: OUTER_R, ...RIG },
  RigSlot1: { deg: 180, r: OUTER_R, ...RIG },
  RigSlot2: { deg: 210, r: OUTER_R, ...RIG },
  LoSlot0:  { deg: 225, r: OUTER_R, ...LO },
  LoSlot1:  { deg: 238, r: OUTER_R, ...LO },
  LoSlot2:  { deg: 251, r: OUTER_R, ...LO },
  LoSlot3:  { deg: 264, r: OUTER_R, ...LO },
  LoSlot4:  { deg: 276, r: OUTER_R, ...LO },
  LoSlot5:  { deg: 289, r: OUTER_R, ...LO },
  LoSlot6:  { deg: 302, r: OUTER_R, ...LO },
  LoSlot7:  { deg: 315, r: OUTER_R, ...LO },
}

function FittingWheel({ fitting, metaMap: _metaMap }: { fitting: ResolvedFitting; metaMap: Map<number, number> }) {
  const [hovered, setHovered] = useState<string | null>(null)

  // Group items per flag; when multiple exist (turret + ammo), prefer quantity=1 (the module)
  const byFlag = new Map<string, typeof fitting.items[number]>()
  for (const item of fitting.items) {
    const existing = byFlag.get(item.flag)
    if (!existing || item.quantity === 1) byFlag.set(item.flag, item)
  }

  // Collect drone bay items separately (multiple items share the same 'DroneBay' flag)
  const droneItems = fitting.items.filter(i => i.flag === 'DroneBay')

  const SHIP_R    = SHIP_D / 2                           // 175
  const ARC_R     = WCX - 3                              // outer-rim arc radius

  // Dark ring from ship edge to container edge
  const ringStrokeR = (SHIP_R + WCX) / 2               // midpoint
  const ringStrokeW = WCX - SHIP_R + 4                  // full width + a little overlap

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

      {/* SVG: dark outer ring + vignette + rim arcs */}
      <svg width={WHEEL} height={WHEEL} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          {/* Vignette gradient for ship render edges */}
          <radialGradient id={`vig-${fitting.fitting_id}`} cx="50%" cy="50%" r="50%">
            <stop offset="48%" stopColor="transparent" />
            <stop offset="72%" stopColor="rgba(3,4,10,0.55)" />
            <stop offset="90%" stopColor="rgba(3,4,10,0.92)" />
            <stop offset="100%" stopColor="rgba(3,4,10,0.99)" />
          </radialGradient>
        </defs>

        {/* Vignette over ship render edges */}
        <circle cx={WCX} cy={WCY} r={SHIP_R} fill={`url(#vig-${fitting.fitting_id})`} />

        {/* Dark outer ring behind module icons */}
        <circle cx={WCX} cy={WCY} r={ringStrokeR} fill="none" stroke="rgba(3,4,10,0.98)" strokeWidth={ringStrokeW} />

        {/* Outer rim border */}
        <circle cx={WCX} cy={WCY} r={WCX - 1} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1.5" />

        {/* Inner rim border (ship render / ring divide) */}
        <circle cx={WCX} cy={WCY} r={SHIP_R + 1} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

        {/* Colored slot-type arc at outer rim */}
        {([
          { from: 330, to: 30,  color: HI.color  },
          { from: 45,  to: 135, color: MED.color },
          { from: 150, to: 210, color: RIG.color },
          { from: 225, to: 315, color: LO.color  },
        ] as const).map(({ from, to, color }) => {
          const [x1, y1] = arcPt(from, ARC_R)
          const [x2, y2] = arcPt(to,   ARC_R)
          return (
            <path key={color}
              d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${ARC_R} ${ARC_R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`}
              fill="none" stroke={color} strokeWidth="3" opacity="0.5" strokeLinecap="round"
            />
          )
        })}
      </svg>

      {/* Module slots — empty placeholders + fitted items */}
      {Object.entries(SLOT_POS).map(([flag, def]) => {
        const item = byFlag.get(flag)
        const isHov = hovered === flag
        const { left, top } = slotXY(def.deg, def.r)
        if (!item) {
          return (
            <div key={flag} style={{
              position: 'absolute', left, top,
              width: ICON_SZ, height: ICON_SZ, borderRadius: 5,
              border: `1px solid ${def.color}28`,
              background: def.bg.replace('0.88', '0.18'),
              zIndex: 4,
            }} />
          )
        }
        const name = fitting.itemNames.get(item.type_id) ?? `Type ${item.type_id}`
        return (
          <div
            key={flag}
            onMouseEnter={() => setHovered(flag)}
            onMouseLeave={() => setHovered(null)}
            title={name + (item.quantity > 1 ? ` ×${item.quantity}` : '')}
            style={{
              position: 'absolute', left, top,
              width: ICON_SZ, height: ICON_SZ, borderRadius: 5,
              border: `1px solid ${isHov ? def.color : def.color + '70'}`,
              background: def.bg,
              boxShadow: isHov ? `0 0 10px ${def.color}60, inset 0 0 6px ${def.color}20` : 'none',
              overflow: 'hidden', cursor: 'default',
              transition: 'border-color 0.12s, box-shadow 0.15s',
              zIndex: isHov ? 6 : 4,
            }}
          >
            <EveImage category="types" id={item.type_id} variation="icon" size={64} px={ICON_SZ} style={{ borderRadius: 0 }} />
          </div>
        )
      })}

      {/* Drone bay (up to 3 types shown) */}
      {droneItems.slice(0, 3).map((item, i) => {
        const name = fitting.itemNames.get(item.type_id) ?? `Type ${item.type_id}`
        const deg = 247 + i * 16
        const { left, top } = slotXY(deg, INNER_R)
        const isHov = hovered === `drone_${i}`
        return (
          <div
            key={`drone_${i}`}
            onMouseEnter={() => setHovered(`drone_${i}`)}
            onMouseLeave={() => setHovered(null)}
            title={`${name} ×${item.quantity}`}
            style={{
              position: 'absolute', left, top,
              width: ICON_SZ, height: ICON_SZ, borderRadius: 5,
              border: `1px solid ${isHov ? '#f97316' : '#f9731650'}`,
              background: isHov ? 'rgba(120,45,5,0.95)' : 'rgba(80,30,5,0.88)',
              boxShadow: isHov ? '0 0 10px rgba(249,115,22,0.55)' : 'none',
              overflow: 'hidden', cursor: 'default',
              transition: 'border-color 0.12s, box-shadow 0.15s',
              zIndex: isHov ? 6 : 4,
            }}
          >
            <EveImage category="types" id={item.type_id} variation="icon" size={64} px={ICON_SZ} style={{ borderRadius: 0 }} />
          </div>
        )
      })}
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
        name: importName || parsed.fittingName,
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

  const filtered = fittings.filter(f =>
    search === '' ||
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    f.shipName.toLowerCase().includes(search.toLowerCase())
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
                placeholder={'[Rifter, My Fit]\n\nSmall Shield Extender I\n\nDamage Control I\n\n'}
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
