import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth/AuthContext'
import {
  getPlanets, getPlanetDetail, getSchematic, resolveNames,
  type Planet, type PlanetPin, type PlanetLink, type PlanetRoute,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import SolarSystem from '../components/SolarSystem'
import EveImage from '../components/EveImage'
import StatCard from '../components/StatCard'
import { usePageLoading } from '../hooks/usePageLoading'

// ─── market prices (fuzzwork, Jita 4-4 sell-min) ──────────────────────────────

async function fetchPrices(typeIds: number[]): Promise<Map<number, number>> {
  if (typeIds.length === 0) return new Map()
  try {
    const r = await fetch(
      `https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${typeIds.join(',')}`,
      { signal: AbortSignal.timeout(6000) },
    )
    if (!r.ok) return new Map()
    const data = await r.json() as Record<string, { buy: { max: number }; sell: { min: number } }>
    const map = new Map<number, number>()
    for (const [idStr, agg] of Object.entries(data)) map.set(parseInt(idStr), agg.sell.min)
    return map
  } catch { return new Map() }
}

// Drempel waarbinnen een kolonie als "verloopt binnenkort" geldt (uren)
const SOON_MS = 12 * 3600 * 1000

// ─── constants ───────────────────────────────────────────────────────────────

const PLANET_TYPE_ID: Record<string, number> = {
  temperate: 11, ice: 12, gas: 13,
  oceanic: 2014, lava: 2015, barren: 2016, storm: 2017, plasma: 2025,
}
const PLANET_COLOR: Record<string, string> = {
  temperate: '#3ecf6e', barren: '#a78bfa', gas: '#f97316',
  ice: '#00b4d8', lava: '#e05555', oceanic: '#0ea5e9',
  plasma: '#f0c040', storm: '#c8ddf0',
}
const PLANET_LABEL: Record<string, string> = {
  temperate: 'Temperate', barren: 'Barren', gas: 'Gas', ice: 'Ice',
  lava: 'Lava', oceanic: 'Oceanic', plasma: 'Plasma', storm: 'Storm',
}
// PI-structuren classificeren op ESI-group (uit /universe/groups), niet op losse
// type_id's — die verschillen per planeettype. Extractors/fabrieken herkennen we al
// aan extractor_details/schematic_id; launchpads (group 1030) en storages (1029)
// hebben deze complete sets (8 = 1 per planeettype); de rest is een command center.
const LAUNCHPAD_IDS = new Set([2256, 2542, 2543, 2544, 2552, 2555, 2556, 2557])
const STORAGE_IDS   = new Set([2257, 2535, 2536, 2541, 2558, 2560, 2561, 2562])
// Industrie-fabrieken (group 1028) per tier — voor het juiste label
const ADV_FACTORY_IDS   = new Set([2470, 2472, 2474, 2480, 2482, 2485, 2491, 2493])
const HITECH_FACTORY_IDS = new Set([2484, 2494])

type PinKind = 'extractor' | 'factory' | 'launchpad' | 'storage' | 'command'
function pinKind(pin: PlanetPin): PinKind {
  if (pin.expiry_time != null || pin.extractor_details != null) return 'extractor'
  if (pin.schematic_id != null) return 'factory'
  if (LAUNCHPAD_IDS.has(pin.type_id)) return 'launchpad'
  if (STORAGE_IDS.has(pin.type_id))   return 'storage'
  return 'command'
}

// ─── pin styling ─────────────────────────────────────────────────────────────

function getPinStyle(pin: PlanetPin): { color: string; label: string } {
  switch (pinKind(pin)) {
    case 'extractor': return { color: '#1fd4c4', label: 'Extractor' }   // teal
    case 'factory':
      if (HITECH_FACTORY_IDS.has(pin.type_id)) return { color: '#f0c040', label: 'Hi-Tech' }  // geel
      if (ADV_FACTORY_IDS.has(pin.type_id))    return { color: '#f0c040', label: 'Advanced' } // geel
      return                                          { color: '#f5912e', label: 'Basic' }    // oranje
    case 'launchpad': return { color: '#2f6fd6', label: 'Launchpad' }   // blauw
    case 'storage':   return { color: '#2f8fd6', label: 'Storage' }     // blauw
    case 'command':   return { color: '#3a8ee6', label: 'Cmd Center' }  // (ring = kleurensegmenten)
  }
}

// ─── PI-gebouw-glyphs (RIFT-stijl: witte glyph in gekleurde ring) ──────────────

function cogPts(teeth: number, ro: number, ri: number) {
  return Array.from({ length: teeth * 2 }, (_, i) => {
    const a = (i * Math.PI / teeth) - Math.PI / 2
    const r = i % 2 === 0 ? ro : ri
    return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

const GLYPH = '#e6eef9' // bijna-wit, zoals in-game

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg - 90) * Math.PI / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

// Command Center: meerkleurige segment-ring (zoals RIFT) i.p.v. de gauge
const CMD_SEG_COLORS = ['#e0463a', '#2ec5d6', '#4ad06a', '#f5a331', '#9b6cf0']
function CmdRing({ cx, cy, r, active }: { cx: number; cy: number; r: number; active: boolean }) {
  const seg = 22
  return (
    <g opacity={active ? 1 : 0.5}>
      {Array.from({ length: seg }, (_, i) => {
        const a0 = (i / seg) * 360
        const a1 = a0 + (360 / seg) * 0.6
        const [x0, y0] = polar(cx, cy, r, a0)
        const [x1, y1] = polar(cx, cy, r, a1)
        return (
          <path key={i} d={`M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`}
            fill="none" stroke={CMD_SEG_COLORS[i % CMD_SEG_COLORS.length]} strokeWidth="2.6"/>
        )
      })}
    </g>
  )
}

function PiGlyph({ pin, size }: { pin: PlanetPin; size: number }) {
  const vb = '-14 -14 28 28'
  const sw = 1.6
  const kind = pinKind(pin)
  // Extractor Control Unit → pijl omhoog
  if (kind === 'extractor') return (
    <svg width={size} height={size} viewBox={vb}>
      <g fill="none" stroke={GLYPH} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0,9 V-8"/>
        <path d="M-6,-2 L0,-9 L6,-2"/>
      </g>
    </svg>
  )
  // Industry Facility → tandwiel
  if (kind === 'factory') return (
    <svg width={size} height={size} viewBox={vb}>
      <polygon points={cogPts(8, 11, 7.5)} fill="none" stroke={GLYPH} strokeWidth={sw} strokeLinejoin="round"/>
      <circle r="3.4" fill="none" stroke={GLYPH} strokeWidth={sw}/>
    </svg>
  )
  // Launchpad → raket
  if (kind === 'launchpad') return (
    <svg width={size} height={size} viewBox={vb}>
      <g fill="none" stroke={GLYPH} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0,-11 C 3.4,-6 3.6,-1 3.2,4 L -3.2,4 C -3.6,-1 -3.4,-6 0,-11 Z"/>
        <path d="M-3.2,2 L -6.2,7 L -3.3,5.5"/>
        <path d="M3.2,2 L 6.2,7 L 3.3,5.5"/>
        <path d="M-2,5 L -2,8.5 M2,5 L 2,8.5 M0,4 L 0,9.5"/>
      </g>
      <circle cx="0" cy="-3" r="1.4" fill={GLYPH}/>
    </svg>
  )
  // Command Center → turbofan (dichte gebogen bladen + hub)
  if (kind === 'command') {
    const blades = 12
    return (
      <svg width={size} height={size} viewBox={vb}>
        <circle r="10" fill="none" stroke={GLYPH} strokeWidth="1" opacity="0.7"/>
        <g>
          {Array.from({ length: blades }, (_, i) => {
            const a = (i / blades) * 360
            const [rx, ry] = polar(0, 0, 9.6, a)
            const [hx, hy] = polar(0, 0, 2.6, a - 52)
            const [mx, my] = polar(0, 0, 6.6, a - 16)
            return (
              <path key={i} d={`M ${rx} ${ry} Q ${mx} ${my} ${hx} ${hy} L 0 0 Z`}
                fill={GLYPH} opacity={i % 2 ? 0.5 : 0.92}/>
            )
          })}
        </g>
        <circle r="2.8" fill="#070c18" stroke={GLYPH} strokeWidth="1"/>
        <circle r="1" fill={GLYPH}/>
      </svg>
    )
  }
  // Storage → isometrische kubus (hexagon-silhouet)
  return (
    <svg width={size} height={size} viewBox={vb}>
      <g fill="none" stroke={GLYPH} strokeWidth={sw} strokeLinejoin="round">
        <polygon points="0,-10 9,-5 0,0 -9,-5"/>
        <path d="M-9,-5 V6 L0,11 V0"/>
        <path d="M9,-5 V6 L0,11"/>
      </g>
    </svg>
  )
}

// ─── interfaces ───────────────────────────────────────────────────────────────

interface SchematicInfo {
  schematic_name: string; cycle_time: number
  outputTypeId: number | null; outputQty: number; outputName: string | null
  inputTypeIds: number[]
}
interface ProductFlow {
  typeId: number; name: string | null
  perHour: number; valuePerHour: number
}
interface PinDisplay {
  pin: PlanetPin
  productTypeId: number | null
  productName: string | null
  schematicName: string | null
  cycleTime: number | null
  throughputPerHour: number | null
  contents: { typeId: number; amount: number; name: string | null }[]
}
interface ColonyInfo {
  planet: Planet
  planetTypeId: number | null
  charId: number; charName: string
  system: string; systemId: number
  pinDisplays: PinDisplay[]
  extractors: PlanetPin[]
  earliestExpiry: Date | null
  extractedResources: string[]
  links: PlanetLink[]
  routes: PlanetRoute[]
  storedValue: number          // ISK-waarde van alle pin-contents
  production: ProductFlow[]     // eindproducten van deze kolonie (per uur)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function timeRemaining(d: Date, now = Date.now()): string {
  const diff = d.getTime() - now
  if (diff <= 0) return 'Verlopen'
  const days = Math.floor(diff / 86400000)
  const h    = Math.floor((diff % 86400000) / 3600000)
  const m    = Math.floor((diff % 3600000) / 60000)
  const s    = Math.floor((diff % 60000) / 1000)
  if (days > 0) return `${days}d ${h}u ${m}m`
  if (h > 0)    return `${h}u ${m}m`
  if (m > 0)    return `${m}m ${s}s`
  return `${s}s`
}
// Hoelang geleden een tijdstip was (bv. "3u 12m geleden")
function timeSince(d: Date, now = Date.now()): string {
  const diff = now - d.getTime()
  if (diff <= 0) return 'net'
  const days = Math.floor(diff / 86400000)
  const h    = Math.floor((diff % 86400000) / 3600000)
  const m    = Math.floor((diff % 3600000) / 60000)
  if (days > 0) return `${days}d ${h}u`
  if (h > 0)    return `${h}u ${m}m`
  return `${m}m`
}
function Stars({ level }: { level: number }) {
  return (
    <span style={{ display:'inline-flex', gap:2 }}>
      {Array.from({length:5},(_,i) =>
        <span key={i} style={{fontSize:'0.52rem',color:i<level?'#f0c040':'#2a3050'}}>★</span>
      )}
    </span>
  )
}
function fmt(n: number): string {
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1)+'M'
  if (n >= 1_000)     return (n/1_000).toFixed(1)+'K'
  return n.toLocaleString()
}
function isk(n: number): string {
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B'
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M'
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K'
  return Math.round(n).toString()
}

// ─── planet image ─────────────────────────────────────────────────────────────

function PlanetImg({ typeId, color, size=52 }: { typeId:number|null; color:string; size?:number }) {
  const [src,setSrc] = useState<string|null>(
    typeId ? `https://images.evetech.net/types/${typeId}/render?size=512` : null
  )
  const [failed,setFailed] = useState(false)
  const sphereBg = [
    `radial-gradient(ellipse 80% 18% at 42% 32%, ${color}88 0%, transparent 100%)`,
    `radial-gradient(circle at 30% 25%, ${color} 0%, ${color}cc 22%, ${color}77 50%, ${color}22 68%, #050510 100%)`,
  ].join(', ')
  function onErr() {
    if (!typeId) { setFailed(true); return }
    if (src?.includes('/render')) setSrc(`https://images.evetech.net/types/${typeId}/icon?size=128`)
    else setFailed(true)
  }
  return (
    <div style={{width:size,height:size,borderRadius:'50%',flexShrink:0,overflow:'hidden',background:sphereBg,boxShadow:`0 0 12px ${color}55`}}>
      {src && !failed && <img src={src} alt="" width={size} height={size} style={{display:'block',width:'100%',height:'100%',objectFit:'cover'}} onError={onErr}/>}
    </div>
  )
}

// ─── pin circle ───────────────────────────────────────────────────────────────

function PinTooltip({ info, color, label, anchorRect }: {
  info: PinDisplay; color: string; label: string; anchorRect: DOMRect
}) {
  const now     = useNow(1000)
  const isStorage   = label === 'Storage' || label === 'Launchpad'
  const isExtractor = label === 'Extractor'
  const expiry  = info.pin.expiry_time ? new Date(info.pin.expiry_time) : null
  const expired = expiry ? expiry.getTime() < now : false
  const heads   = info.pin.extractor_details?.heads?.length ?? 0

  const TIP_W = 200
  const gap   = 8
  // Center on anchor, clamp to viewport
  const rawLeft = anchorRect.left + anchorRect.width / 2 - TIP_W / 2
  const left    = Math.max(8, Math.min(rawLeft, window.innerWidth - TIP_W - 8))
  const top     = anchorRect.top - gap  // tooltip grows upward via transform

  return createPortal(
    <div style={{
      position:'fixed', left, top,
      transform:'translateY(-100%)',
      width: TIP_W, zIndex:9999, pointerEvents:'none',
      background:'rgba(7,9,21,0.97)', backdropFilter:'blur(12px)',
      border:`1px solid ${color}44`, borderRadius:4,
      padding:'0.5rem 0.65rem',
      boxShadow:`0 4px 24px #000e, 0 0 12px ${color}22`,
    }}>
      <div style={{fontSize:'0.68rem',fontWeight:700,color,marginBottom:'0.3rem'}}>{label}</div>

      {info.schematicName && (
        <div style={{fontSize:'0.6rem',color:'#8899bb',marginBottom:'0.2rem'}}>{info.schematicName}</div>
      )}
      {info.productTypeId && info.productName && (
        <div style={{display:'flex',alignItems:'center',gap:'0.35rem',marginBottom:'0.2rem'}}>
          <EveImage category="types" id={info.productTypeId} variation="icon" size={32} px={20}/>
          <span style={{fontSize:'0.65rem',color:'#e0e8ff',fontWeight:600}}>{info.productName}</span>
        </div>
      )}
      {info.cycleTime && (
        <div style={{fontSize:'0.58rem',color:'#556'}}>{info.cycleTime/60}min cycle</div>
      )}

      {isExtractor && (
        <>
          {heads > 0 && (
            <div style={{fontSize:'0.6rem',color:'#8899bb',marginBottom:'0.15rem'}}>
              {heads} extraction {heads===1?'head':'heads'}
            </div>
          )}
          {info.throughputPerHour != null && (
            <div style={{fontSize:'0.62rem',color:'#f97316',fontWeight:600}}>
              {fmt(Math.round(info.throughputPerHour))}/hr
            </div>
          )}
          {expiry && (
            <div style={{fontSize:'0.62rem',color:expired?'#e05555':'#3ecf6e',marginTop:'0.2rem'}}>
              {expired?'✗ Verlopen':`✓ ${timeRemaining(expiry, now)}`}
            </div>
          )}
        </>
      )}

      {isStorage && info.contents.length > 0 && (
        <div style={{marginTop:'0.3rem',display:'flex',flexDirection:'column',gap:'0.2rem'}}>
          <div style={{fontSize:'0.55rem',color:'#556',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:'0.1rem'}}>Inventory</div>
          {info.contents.map((c,i) => (
            <div key={i} style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
              <EveImage category="types" id={c.typeId} variation="icon" size={32} px={18}/>
              <span style={{fontSize:'0.62rem',color:'#c8d8f0',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.name ?? `Type ${c.typeId}`}</span>
              <span style={{fontSize:'0.6rem',color:'#8899bb',flexShrink:0}}>{fmt(c.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {isStorage && info.contents.length === 0 && (
        <div style={{fontSize:'0.6rem',color:'#334',marginTop:'0.15rem'}}>Empty</div>
      )}
    </div>,
    document.body
  )
}

function PinCircle({ info, active, now }: { info: PinDisplay; active: boolean; now: number }) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { color, label } = getPinStyle(info.pin)
  const opacity = active ? 1 : 0.35

  // Functionele gauge-ring (gat onderaan). Voor extractors vult de ring met de echte
  // cyclus-voortgang (install_time → expiry_time); andere gebouwen tonen een volle ring.
  const S = 46, r = 19.5, C = 2 * Math.PI * r
  const GAUGE = 0.84, gaugeLen = GAUGE * C, gapLen = (1 - GAUGE) * C
  const isCmd = pinKind(info.pin) === 'command'
  let progress = 1
  if (pinKind(info.pin) === 'extractor') {
    const inst = info.pin.install_time ? new Date(info.pin.install_time).getTime() : NaN
    const exp  = info.pin.expiry_time  ? new Date(info.pin.expiry_time).getTime()  : NaN
    progress = (isFinite(inst) && isFinite(exp) && exp > inst)
      ? Math.min(1, Math.max(0, (now - inst) / (exp - inst))) : 1
  }

  return (
    <div
      ref={ref}
      style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}
      onMouseEnter={() => ref.current && setAnchorRect(ref.current.getBoundingClientRect())}
      onMouseLeave={() => setAnchorRect(null)}
    >
      <div style={{ position:'relative', width:S, height:S, opacity, transition:'opacity 0.2s', cursor:'default' }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{
          display:'block', filter: active ? `drop-shadow(0 0 5px ${color}aa)` : 'none',
        }}>
          {/* donkere disc */}
          <circle cx={S/2} cy={S/2} r={r-2} fill="#070c18"/>
          {isCmd ? (
            /* Command Center: meerkleurige segment-ring (geen voortgang) */
            <CmdRing cx={S/2} cy={S/2} r={r} active={active}/>
          ) : (
            <>
              {/* gauge-track (volledige boog, gedimd) */}
              <circle cx={S/2} cy={S/2} r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={`${gaugeLen} ${C}`} strokeDashoffset={gapLen / 2}
                transform={`rotate(-90 ${S/2} ${S/2})`} opacity={0.18}/>
              {/* voortgang (helder, = progress × gauge) */}
              <circle cx={S/2} cy={S/2} r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={`${progress * gaugeLen} ${C}`} strokeDashoffset={gapLen / 2}
                transform={`rotate(-90 ${S/2} ${S/2})`}
                opacity={active ? 0.95 : 0.55} style={{ transition:'stroke-dasharray 0.8s linear' }}/>
            </>
          )}
        </svg>
        {/* witte PI-glyph gecentreerd (RIFT-stijl) */}
        <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <PiGlyph pin={info.pin} size={22}/>
        </div>
        {/* product-badge rechtsonder */}
        {info.productTypeId && (
          <div style={{
            position:'absolute', bottom:-1, right:-1,
            width:17, height:17, borderRadius:'50%',
            background:'#090e1c', border:`1px solid ${color}88`,
            display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden',
          }}>
            <EveImage category="types" id={info.productTypeId} variation="icon" size={32} px={14}/>
          </div>
        )}
      </div>

      <span style={{fontSize:'0.52rem',color:active?color:'#3a4060',textTransform:'uppercase',letterSpacing:'0.04em',maxWidth:48,textAlign:'center',lineHeight:1.1}}>
        {label}
      </span>

      {anchorRect && (
        <PinTooltip info={info} color={color} label={label} anchorRect={anchorRect}/>
      )}
    </div>
  )
}

// ─── colony map ───────────────────────────────────────────────────────────────

function ColonyMap({ colony, active }: { colony: ColonyInfo; active: boolean }) {
  const W = 290, H = 155

  // Collect all lat/lon positions to compute bounding box
  const allPts: {lat:number;lon:number}[] = []
  for (const { pin } of colony.pinDisplays) {
    allPts.push({ lat: pin.latitude, lon: pin.longitude })
    pin.extractor_details?.heads?.forEach(h => allPts.push({ lat: h.latitude, lon: h.longitude }))
  }
  if (allPts.length === 0) return null

  const lats = allPts.map(p => p.lat)
  const lons = allPts.map(p => p.lon)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const latR = Math.max(maxLat - minLat, 0.05)
  const lonR = Math.max(maxLon - minLon, 0.05)
  const pad = 0.14

  function proj(lat: number, lon: number): [number, number] {
    const nx = (lon - minLon) / lonR
    const ny = 1 - (lat - minLat) / latR
    return [
      nx * W * (1 - 2*pad) + W * pad,
      ny * H * (1 - 2*pad) + H * pad,
    ]
  }

  const pinPos = new Map<number, [number, number]>()
  for (const { pin } of colony.pinDisplays) {
    pinPos.set(pin.pin_id, proj(pin.latitude, pin.longitude))
  }

  // Route color from source pin type
  const pinStyleMap = new Map(colony.pinDisplays.map(({ pin }) => [pin.pin_id, getPinStyle(pin)]))

  return (
    <div style={{ padding:'0 0.875rem 0.75rem' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{
        background:'rgba(3,6,16,0.85)', borderRadius:3, border:'1px solid #0a1422', display:'block',
      }}>
        {/* Routes (dashed commodity flow lines) */}
        {colony.routes.map(r => {
          const src = pinPos.get(r.source_pin_id)
          const dst = pinPos.get(r.destination_pin_id)
          if (!src || !dst) return null
          const c = pinStyleMap.get(r.source_pin_id)?.color ?? '#444'
          return (
            <line key={r.route_id}
              x1={src[0]} y1={src[1]} x2={dst[0]} y2={dst[1]}
              stroke={c} strokeWidth="1" opacity="0.3" strokeDasharray="3,2"
            />
          )
        })}

        {/* Links (solid bandwidth lines) */}
        {colony.links.map((l, i) => {
          const src = pinPos.get(l.source_pin_id)
          const dst = pinPos.get(l.destination_pin_id)
          if (!src || !dst) return null
          return (
            <line key={i}
              x1={src[0]} y1={src[1]} x2={dst[0]} y2={dst[1]}
              stroke="#1a3a70" strokeWidth={0.7 + l.link_level * 0.15}
              opacity={0.35 + l.link_level * 0.04}
            />
          )
        })}

        {/* Extractor heads */}
        {colony.pinDisplays.map(({ pin }) => {
          if (!pin.extractor_details?.heads?.length) return null
          const center = pinPos.get(pin.pin_id)
          if (!center) return null
          return pin.extractor_details.heads.map(h => {
            const [hx, hy] = proj(h.latitude, h.longitude)
            return (
              <g key={`h-${pin.pin_id}-${h.head_id}`}>
                <line x1={center[0]} y1={center[1]} x2={hx} y2={hy}
                  stroke="#f97316" strokeWidth="0.4" opacity="0.18" strokeDasharray="2,2"/>
                <circle cx={hx} cy={hy} r="2.2" fill="#f97316" opacity={active ? 0.65 : 0.2}/>
              </g>
            )
          })
        })}

        {/* Pins */}
        {colony.pinDisplays.map(({ pin }) => {
          const pos = pinPos.get(pin.pin_id)
          if (!pos) return null
          const { color } = getPinStyle(pin)
          const isCmd = pinKind(pin) === 'command'
          return (
            <g key={pin.pin_id}>
              <circle cx={pos[0]} cy={pos[1]} r={isCmd?8:6}
                fill={`${color}14`}/>
              <circle cx={pos[0]} cy={pos[1]} r={isCmd?6:5}
                fill="#060b16" stroke={color} strokeWidth={isCmd?1.8:1.5}
                opacity={active?1:0.35}/>
              <circle cx={pos[0]} cy={pos[1]} r="1.5"
                fill={color} opacity={active?0.85:0.25}/>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── route flow strip ─────────────────────────────────────────────────────────

function RouteFlow({ colony }: { colony: ColonyInfo }) {
  const pinById = new Map(colony.pinDisplays.map(p => [p.pin.pin_id, p]))

  // Gather unique commodities flowing through routes, grouped by tier
  // P0 = from extractors, rest = from factories
  const p0 = new Map<number, string | null>()   // typeId → name
  const pN = new Map<number, string | null>()   // typeId → name

  for (const route of colony.routes) {
    const srcPd = pinById.get(route.source_pin_id)
    if (!srcPd) continue
    const { label } = getPinStyle(srcPd.pin)
    const name = colony.pinDisplays.find(
      p => p.productTypeId === route.content_type_id
    )?.productName ?? null
    if (label === 'Extractor') p0.set(route.content_type_id, name)
    else if (label !== 'Storage' && label !== 'Launchpad' && label !== 'Cmd Center')
      pN.set(route.content_type_id, name)
  }

  // Final products: what goes INTO storage/launchpad
  const final = new Map<number, string | null>()
  for (const route of colony.routes) {
    const dstPd = pinById.get(route.destination_pin_id)
    if (!dstPd) continue
    const { label } = getPinStyle(dstPd.pin)
    if (label === 'Storage' || label === 'Launchpad') {
      const name = pN.get(route.content_type_id) ?? p0.get(route.content_type_id)
        ?? colony.pinDisplays.find(p => p.productTypeId === route.content_type_id)?.productName ?? null
      final.set(route.content_type_id, name)
    }
  }

  if (p0.size === 0 && pN.size === 0 && final.size === 0) return null

  const showP0  = p0.size > 0
  const showMid = pN.size > 0 && [...pN.keys()].some(id => !final.has(id))
  const showEnd = final.size > 0

  function TypeIcon({ typeId, name }: { typeId: number; name: string | null }) {
    return (
      <div title={name ?? `Type ${typeId}`} style={{
        width:22, height:22, borderRadius:2,
        background:'rgba(255,255,255,0.04)',
        border:'1px solid rgba(255,255,255,0.08)',
        overflow:'hidden', flexShrink:0,
      }}>
        <EveImage category="types" id={typeId} variation="icon" size={32} px={22}/>
      </div>
    )
  }

  return (
    <div style={{
      padding:'0.3rem 0.875rem 0.5rem',
      display:'flex', alignItems:'center', gap:'0.35rem', flexWrap:'wrap',
      borderTop:'1px solid #0a1422',
    }}>
      {showP0 && [...p0.entries()].map(([id, name]) => <TypeIcon key={id} typeId={id} name={name}/>)}
      {showMid && (
        <>
          <span style={{color:'#2a3a60',fontSize:'0.7rem'}}>→</span>
          {[...pN.entries()].filter(([id]) => !final.has(id)).map(([id, name]) =>
            <TypeIcon key={id} typeId={id} name={name}/>
          )}
        </>
      )}
      {showEnd && (
        <>
          <span style={{color:'#2a3a60',fontSize:'0.7rem'}}>→</span>
          {[...final.entries()].map(([id, name]) => <TypeIcon key={id} typeId={id} name={name}/>)}
        </>
      )}
    </div>
  )
}

// ─── main page ────────────────────────────────────────────────────────────────

// ─── colony card (owns live timer) ───────────────────────────────────────────

function ColonyCard({ colony: c, multiChar, mapOpen, onToggleMap }: {
  colony: ColonyInfo; multiChar: boolean; mapOpen: boolean; onToggleMap: () => void
}) {
  const now           = useNow(1000)
  const isExpired     = !!(c.earliestExpiry && c.earliestExpiry.getTime() < now)
  const hasExtractors = c.extractors.length > 0
  const active        = hasExtractors && !isExpired
  const soon          = active && !!c.earliestExpiry && c.earliestExpiry.getTime() - now < SOON_MS
  const color         = PLANET_COLOR[c.planet.planet_type] ?? '#888'
  const outputValueHr = c.production.reduce((s, p) => s + p.valuePerHour, 0)
  const expColor      = isExpired ? '#e05555' : soon ? '#f5912e' : '#3ecf6e'

  const progressPct = active && c.earliestExpiry ? (() => {
    const total   = c.earliestExpiry.getTime() - new Date(c.planet.last_update).getTime()
    const elapsed = now - new Date(c.planet.last_update).getTime()
    return Math.min(100, Math.max(0, (elapsed / total) * 100))
  })() : null

  return (
    <div style={{
      background:'linear-gradient(160deg, #090e1c 0%, #060a14 100%)',
      border:`1px solid ${isExpired?'#3a1515':soon?'#3a2a10':active?'#0d2a1a':'#131c30'}`,
      borderTop:`2px solid ${isExpired?'#e05555':soon?'#f5912e':active?'#1a5c38':'#1a2540'}`,
      borderRadius:4, overflow:'hidden',
    }}>

      {/* Header */}
      <div style={{ padding:'0.75rem 0.875rem', display:'flex', gap:'0.75rem', alignItems:'center', borderBottom:'1px solid #0d1628' }}>
        <PlanetImg typeId={c.planetTypeId} color={color} size={50}/>
        <div style={{ flex:1, minWidth:0 }}>
          <SolarSystem name={c.system} systemId={c.systemId} fontSize="0.82rem"/>
          <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginTop:'0.18rem' }}>
            <span style={{ fontSize:'0.65rem', color, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em' }}>
              {PLANET_LABEL[c.planet.planet_type] ?? c.planet.planet_type}
            </span>
            <Stars level={c.planet.upgrade_level}/>
          </div>
          <div style={{ fontSize:'0.58rem', color:'var(--text-dim)', marginTop:'0.15rem' }}>
            {c.planet.num_pins} pins · {c.extractors.length} extractors · {c.links.length} links · {c.routes.length} routes
            {multiChar && <> · <span style={{ color:'#5b7bb5' }}>{c.charName}</span></>}
          </div>
        </div>
        <div style={{ textAlign:'right', flexShrink:0 }}>
          {hasExtractors ? (
            <>
              <div style={{ fontSize:'0.55rem', color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em' }}>
                {isExpired ? 'Verlopen sinds' : 'Expires in'}
              </div>
              <div style={{ fontSize:'0.8rem', fontWeight:700, marginTop:'0.1rem', color:expColor, fontVariantNumeric:'tabular-nums' }}>
                {c.earliestExpiry ? (isExpired ? `${timeSince(c.earliestExpiry, now)} geleden` : timeRemaining(c.earliestExpiry, now)) : '—'}
              </div>
            </>
          ) : (
            <div style={{ fontSize:'0.6rem', color:'var(--text-dim)' }}>Geen extractors</div>
          )}
          {c.storedValue > 0 && (
            <div style={{ fontSize:'0.6rem', color:'#f0c040', fontWeight:600, marginTop:'0.25rem', fontVariantNumeric:'tabular-nums' }}>
              {isk(c.storedValue)} ISK
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {progressPct !== null && (
        <div style={{ height:2, background:'#0d1628' }}>
          <div style={{ height:'100%', width:`${progressPct}%`, background:'linear-gradient(90deg,#1a5c38,#3ecf6e)', transition:'width 1s linear' }}/>
        </div>
      )}

      {/* Extractor resources */}
      {c.extractedResources.length > 0 && (
        <div style={{ padding:'0.45rem 0.875rem 0', display:'flex', flexWrap:'wrap', gap:'0.25rem' }}>
          {c.extractedResources.map(r => (
            <span key={r} style={{
              fontSize:'0.55rem', fontWeight:600,
              background:`${color}12`, border:`1px solid ${color}33`,
              color, borderRadius:2, padding:'0.08rem 0.3rem',
              textTransform:'uppercase', letterSpacing:'0.04em',
            }}>{r}</span>
          ))}
        </div>
      )}

      {/* Pin circles */}
      {c.pinDisplays.length > 0 && (
        <div style={{ padding:'0.65rem 0.875rem 0.5rem', display:'flex', flexWrap:'wrap', gap:'0.55rem' }}>
          {c.pinDisplays.map((info, i) => (
            <PinCircle key={i} info={info} active={active} now={now}/>
          ))}
        </div>
      )}

      {/* Route flow strip */}
      <RouteFlow colony={c}/>

      {/* Productie-output (eindproducten per uur) */}
      {c.production.length > 0 && (
        <div style={{ padding:'0.4rem 0.875rem 0.55rem', borderTop:'1px solid #0a1422' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.3rem' }}>
            <span style={{ fontSize:'0.55rem', color:'#3a5080', textTransform:'uppercase', letterSpacing:'0.06em' }}>Output</span>
            {outputValueHr > 0 && (
              <span style={{ fontSize:'0.6rem', color:'#3ecf6e', fontWeight:600 }}>{isk(outputValueHr)} ISK/u</span>
            )}
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:'0.2rem' }}>
            {c.production.map(p => (
              <div key={p.typeId} style={{ display:'flex', alignItems:'center', gap:'0.35rem' }}>
                <EveImage category="types" id={p.typeId} variation="icon" size={32} px={18}/>
                <span style={{ fontSize:'0.62rem', color:'#c8d8f0', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {p.name ?? `Type ${p.typeId}`}
                </span>
                <span style={{ fontSize:'0.6rem', color:'#8899bb', flexShrink:0, fontVariantNumeric:'tabular-nums' }}>
                  {fmt(Math.round(p.perHour))}/u
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Map toggle */}
      <div style={{ padding:'0.3rem 0.875rem', borderTop:'1px solid #0a1422' }}>
        <button
          onClick={onToggleMap}
          style={{
            background:'none', border:'none', cursor:'pointer', padding:0,
            fontSize:'0.6rem', color:'#3a5080', textTransform:'uppercase',
            letterSpacing:'0.06em', display:'flex', alignItems:'center', gap:'0.3rem',
          }}
        >
          <span style={{ fontSize:'0.65rem' }}>{mapOpen?'▲':'▼'}</span>
          {mapOpen ? 'Verberg kaart' : 'Toon kolonie kaart'}
        </button>
      </div>

      {/* Colony map */}
      {mapOpen && <ColonyMap colony={c} active={active}/>}
    </div>
  )
}

// ─── main page ────────────────────────────────────────────────────────────────

type SortKey = 'expiry' | 'value' | 'output' | 'char' | 'system'
type FilterKey = 'all' | 'active' | 'expired'

export default function Planets() {
  const { activeTokens: tokens } = useAuth()
  const [colonies,   setColonies]   = useState<ColonyInfo[]>([])
  const [loading,    setLoading]    = useState(true)
  const [authErrors, setAuthErrors] = useState<{ charName: string; status: number }[]>([])
  const [showMap,    setShowMap]    = useState<Record<number, boolean>>({})
  const [sort,       setSort]       = useState<SortKey>('expiry')
  const [filter,     setFilter]     = useState<FilterKey>('all')
  usePageLoading(loading)
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) { setLoading(false); return }
    const myId = ++fetchId.current
    setLoading(true); setColonies([]); setAuthErrors([])

    async function load() {
      const allPlanets: (Planet & { token: string; charId: number; charName: string })[] = []
      const errs: { charName: string; status: number }[] = []

      await Promise.all(tokens.map(async t => {
        try {
          const list = await getPlanets(t.characterId, t.accessToken)
          allPlanets.push(...list.map(p => ({ ...p, token: t.accessToken, charId: t.characterId, charName: t.characterName })))
        } catch (e) {
          const status = parseInt((e as Error).message.match(/:\s*(\d+)$/)?.[1] ?? '0')
          errs.push({ charName: t.characterName, status })
        }
      }))
      if (myId !== fetchId.current) return
      if (errs.length > 0) setAuthErrors(errs)
      if (allPlanets.length === 0 && errs.length > 0) { setLoading(false); return }

      const systemIds = [...new Set(allPlanets.map(p => p.solar_system_id))]
      const nameMap   = await resolveNames(systemIds)
      if (myId !== fetchId.current) return

      const details = await Promise.all(allPlanets.map(async p => ({
        planet: p,
        detail: await getPlanetDetail(p.charId, p.planet_id, p.token)
          .catch(() => ({ pins: [], links: [], routes: [] })),
      })))
      if (myId !== fetchId.current) return

      // Resolve schematics
      const schematicIds = [...new Set(
        details.flatMap(d => d.detail.pins.map(p => p.schematic_id).filter((id): id is number => id != null))
      )]
      const schematics = new Map<number, SchematicInfo>()
      const outputTypeIds: number[] = []
      await Promise.all(schematicIds.map(async id => {
        const s = await getSchematic(id)
        if (s) {
          const output = (s.pins ?? []).find(p => !p.is_input)
          const inputs = (s.pins ?? []).filter(p => p.is_input).map(p => p.type_id)
          schematics.set(id, { schematic_name: s.schematic_name, cycle_time: s.cycle_time, outputTypeId: output?.type_id ?? null, outputQty: output?.quantity ?? 0, outputName: null, inputTypeIds: inputs })
          if (output?.type_id) outputTypeIds.push(output.type_id)
        }
      }))
      const outputNames = await resolveNames([...new Set(outputTypeIds)]).catch(() => new Map<number, string>())
      for (const [id, info] of schematics) {
        if (info.outputTypeId) schematics.set(id, { ...info, outputName: outputNames.get(info.outputTypeId) ?? null })
      }
      if (myId !== fetchId.current) return

      // Resolve all item names: extractor products + route commodities + pin contents
      const allItemIds = new Set<number>()
      for (const { detail } of details) {
        for (const pin of detail.pins) {
          if (pin.extractor_details?.product_type_id) allItemIds.add(pin.extractor_details.product_type_id)
          pin.contents?.forEach(c => allItemIds.add(c.type_id))
        }
        detail.routes.forEach(r => allItemIds.add(r.content_type_id))
      }
      const itemNames = await resolveNames([...allItemIds]).catch(() => new Map<number, string>())
      if (myId !== fetchId.current) return

      // Marktprijzen voor alle content-items + schematic-outputs (Jita sell)
      const priceIds = new Set<number>(allItemIds)
      for (const info of schematics.values()) if (info.outputTypeId) priceIds.add(info.outputTypeId)
      const prices = await fetchPrices([...priceIds])
      if (myId !== fetchId.current) return

      const resolved: ColonyInfo[] = details.map(({ planet, detail }) => {
        const extractors = detail.pins.filter(p => p.expiry_time != null)
        const factories  = detail.pins
          .filter(p => p.schematic_id != null)
          .map(p => ({ ...p, schematic: schematics.get(p.schematic_id!) ?? null }))
        const factoryByPinId = new Map(factories.map(f => [f.pin_id, f]))

        const expiries = extractors.map(e => new Date(e.expiry_time!)).filter(d => !isNaN(d.getTime()))
        const earliest = expiries.length > 0 ? expiries.reduce((a, b) => a < b ? a : b) : null

        const extractedResources = [...new Set(
          extractors
            .map(e => e.extractor_details?.product_type_id)
            .filter((id): id is number => id != null)
            .map(id => itemNames.get(id) ?? `Type ${id}`)
        )]

        // Opgeslagen ISK-waarde: alle pin-contents tegen Jita sell
        let storedValue = 0
        for (const pin of detail.pins) {
          for (const c of pin.contents ?? []) storedValue += (prices.get(c.type_id) ?? 0) * c.amount
        }

        // Eindproducten: outputs die niet als input door een fabriek in dezelfde
        // kolonie verbruikt worden (sluit tussenproducten P1→P2→… uit). Bij
        // extract-only kolonies = de geëxtraheerde P0-grondstof.
        const consumed = new Set<number>()
        for (const f of factories) f.schematic?.inputTypeIds.forEach(id => consumed.add(id))
        const perHourByType = new Map<number, number>()
        for (const f of factories) {
          const s = f.schematic
          if (s?.outputTypeId && !consumed.has(s.outputTypeId) && s.cycle_time > 0)
            perHourByType.set(s.outputTypeId, (perHourByType.get(s.outputTypeId) ?? 0) + (s.outputQty * 3600) / s.cycle_time)
        }
        for (const e of extractors) {
          const pid = e.extractor_details?.product_type_id
          const qpc = e.extractor_details?.qty_per_cycle
          const ct  = e.extractor_details?.cycle_time
          if (pid && !consumed.has(pid) && qpc && ct && ct > 0)
            perHourByType.set(pid, (perHourByType.get(pid) ?? 0) + (qpc * 3600) / ct)
        }
        const production: ProductFlow[] = [...perHourByType.entries()]
          .map(([typeId, perHour]) => ({
            typeId, name: itemNames.get(typeId) ?? null,
            perHour, valuePerHour: perHour * (prices.get(typeId) ?? 0),
          }))
          .sort((a, b) => b.valuePerHour - a.valuePerHour)

        const pinDisplays: PinDisplay[] = detail.pins.map(pin => {
          const factory = factoryByPinId.get(pin.pin_id)
          const productTypeId = pin.extractor_details?.product_type_id
            ?? factory?.schematic?.outputTypeId ?? null
          const productName = productTypeId ? (itemNames.get(productTypeId) ?? null) : null

          const qpc = pin.extractor_details?.qty_per_cycle
          const ct  = pin.extractor_details?.cycle_time
          const throughputPerHour = (qpc && ct && ct > 0) ? (qpc * 3600) / ct : null

          const contents = (pin.contents ?? []).map(c => ({
            typeId: c.type_id, amount: c.amount, name: itemNames.get(c.type_id) ?? null,
          }))

          return {
            pin, productTypeId, productName,
            schematicName: factory?.schematic?.schematic_name ?? null,
            cycleTime: factory?.schematic?.cycle_time ?? null,
            throughputPerHour,
            contents,
          }
        })

        return {
          planet,
          planetTypeId: PLANET_TYPE_ID[planet.planet_type] ?? null,
          charId: planet.charId, charName: planet.charName,
          system: nameMap.get(planet.solar_system_id) ?? `System ${planet.solar_system_id}`,
          systemId: planet.solar_system_id,
          pinDisplays, extractors, earliestExpiry: earliest,
          extractedResources,
          links:  detail.links  ?? [],
          routes: detail.routes ?? [],
          storedValue, production,
        }
      })

      setColonies(resolved)
      setLoading(false)
    }

    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const now = useNow(1000)

  // ─── aggregaten ─────────────────────────────────────────────────────────────
  const nExpired = colonies.filter(c => c.earliestExpiry && c.earliestExpiry.getTime() <  now).length
  const nActive  = colonies.filter(c => c.earliestExpiry && c.earliestExpiry.getTime() >= now).length
  const totalStored = colonies.reduce((s, c) => s + c.storedValue, 0)
  const totalOutputHr = colonies.reduce((s, c) => s + c.production.reduce((a, p) => a + p.valuePerHour, 0), 0)

  // Kolonies die binnenkort leeglopen (actief + binnen drempel), oplopend
  const soon = colonies
    .filter(c => c.earliestExpiry && c.earliestExpiry.getTime() >= now && c.earliestExpiry.getTime() - now < SOON_MS)
    .sort((a, b) => a.earliestExpiry!.getTime() - b.earliestExpiry!.getTime())

  // ─── sorteren / filteren ────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const filtered = colonies.filter(c => {
      if (filter === 'active')  return c.earliestExpiry && c.earliestExpiry.getTime() >= now
      if (filter === 'expired') return !c.earliestExpiry || c.earliestExpiry.getTime() < now
      return true
    })
    const exp = (c: ColonyInfo) => c.earliestExpiry?.getTime() ?? Infinity
    const cmp: Record<SortKey, (a: ColonyInfo, b: ColonyInfo) => number> = {
      expiry: (a, b) => exp(a) - exp(b),
      value:  (a, b) => b.storedValue - a.storedValue,
      output: (a, b) => b.production.reduce((s, p) => s + p.valuePerHour, 0) - a.production.reduce((s, p) => s + p.valuePerHour, 0),
      char:   (a, b) => a.charName.localeCompare(b.charName) || exp(a) - exp(b),
      system: (a, b) => a.system.localeCompare(b.system) || exp(a) - exp(b),
    }
    return [...filtered].sort(cmp[sort])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colonies, sort, filter, Math.floor(now / 1000)])

  const multiChar = new Set(colonies.map(c => c.charId)).size > 1

  return (
    <Layout header={
      <PageHeader
        title="Planets"
        sub={loading ? 'Laden...' : `${colonies.length} colonies · ${nExpired} verlopen · ${nActive} actief`}
        right={!loading && colonies.length > 0 ? (
          <div style={{ display:'flex', gap:'0.75rem', flexWrap:'wrap' }}>
            <Segmented
              value={filter} onChange={v => setFilter(v as FilterKey)}
              options={[['all','Alle'],['active','Actief'],['expired','Verlopen']]}
            />
            <Segmented
              value={sort} onChange={v => setSort(v as SortKey)}
              options={[
                ['expiry','Verloop'],['value','Waarde'],['output','Output'],
                ...(multiChar ? [['char','Char'] as [string,string]] : []),
                ['system','Systeem'],
              ]}
            />
          </div>
        ) : undefined}
      />
    }>
      {loading && (
        <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-dim)', fontSize:'0.8rem' }}>
          Planeet data laden...
        </div>
      )}
      {!loading && authErrors.length > 0 && (
        <div style={{ marginBottom:'0.75rem', display:'flex', flexDirection:'column', gap:'0.4rem' }}>
          {authErrors.map(e => (
            <div key={e.charName} style={{ background:'rgba(224,85,85,0.08)', border:'1px solid rgba(224,85,85,0.3)', borderRadius:3, padding:'0.6rem 1rem', fontSize:'0.75rem', color:'var(--red)' }}>
              <strong>{e.charName}</strong>: token verlopen (HTTP {e.status}) — verwijder dit account en log opnieuw in.
            </div>
          ))}
        </div>
      )}
      {!loading && colonies.length === 0 && authErrors.length === 0 && (
        <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-dim)', fontSize:'0.8rem' }}>
          Geen planetary colonies gevonden
        </div>
      )}

      {!loading && colonies.length > 0 && (
        <>
          {/* Aggregaat-stats */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(170px, 1fr))', gap:'0.6rem', marginBottom:'0.75rem' }}>
            <StatCard title="KOLONIES" value={String(colonies.length)}
              sub={`${nActive} actief · ${nExpired} verlopen`}
              accentColor={nExpired > 0 ? 'var(--red)' : 'var(--green)'} />
            <StatCard title="OPGESLAGEN WAARDE" value={`${isk(totalStored)} ISK`}
              sub="Jita sell · alle pins" accentColor="#f0c040"
              valueColor={totalStored > 0 ? '#f0c040' : undefined} />
            <StatCard title="PRODUCTIE / UUR" value={`${isk(totalOutputHr)} ISK`}
              sub="Eindproducten, alle kolonies" accentColor="#3ecf6e" />
            <StatCard title="VERLOOPT BINNENKORT" value={String(soon.length)}
              sub={`Binnen ${SOON_MS / 3600000}u`}
              accentColor={soon.length > 0 ? '#f5912e' : 'var(--border)'}
              valueColor={soon.length > 0 ? '#f5912e' : undefined} />
          </div>

          {/* Verloop-waarschuwingen */}
          {soon.length > 0 && (
            <div style={{
              marginBottom:'0.75rem', background:'rgba(245,145,46,0.07)',
              border:'1px solid rgba(245,145,46,0.3)', borderRadius:4, overflow:'hidden',
            }}>
              <div style={{ padding:'0.45rem 0.875rem', borderBottom:'1px solid rgba(245,145,46,0.18)', fontSize:'0.62rem', fontWeight:700, color:'#f5912e', textTransform:'uppercase', letterSpacing:'0.08em' }}>
                ⚠ {soon.length} extractor{soon.length>1?'s lopen':' loopt'} binnenkort leeg
              </div>
              <div style={{ display:'flex', flexDirection:'column' }}>
                {soon.map(c => (
                  <div key={c.planet.planet_id} style={{ display:'flex', alignItems:'center', gap:'0.6rem', padding:'0.35rem 0.875rem', fontSize:'0.7rem', borderTop:'1px solid rgba(245,145,46,0.08)' }}>
                    <span style={{ color:PLANET_COLOR[c.planet.planet_type] ?? '#888', fontWeight:600, minWidth:64 }}>
                      {PLANET_LABEL[c.planet.planet_type] ?? c.planet.planet_type}
                    </span>
                    <span style={{ color:'var(--text)', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {c.system}{multiChar && <span style={{ color:'var(--text-dim)' }}> · {c.charName}</span>}
                    </span>
                    <span style={{ color:'#f5912e', fontWeight:700, fontVariantNumeric:'tabular-nums', flexShrink:0 }}>
                      {timeRemaining(c.earliestExpiry!, now)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {visible.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-dim)', fontSize:'0.78rem' }}>
              Geen kolonies in dit filter
            </div>
          ) : (
            <div style={{ columnWidth:'330px', columnGap:'0.75rem' }}>
              {visible.map(c => (
                <div key={c.planet.planet_id} style={{ breakInside:'avoid', marginBottom:'0.75rem' }}>
                  <ColonyCard
                    colony={c}
                    multiChar={multiChar}
                    mapOpen={showMap[c.planet.planet_id] ?? false}
                    onToggleMap={() => setShowMap(prev => ({ ...prev, [c.planet.planet_id]: !(prev[c.planet.planet_id] ?? false) }))}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Layout>
  )
}

// ─── sort/filter segmented control ─────────────────────────────────────────────

function Segmented({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: [string, string][]
}) {
  return (
    <div style={{ display:'flex', border:'1px solid var(--border)', borderRadius:3, overflow:'hidden' }}>
      {options.map(([v, label], i) => (
        <button key={v} onClick={() => onChange(v)} style={{
          background: value === v ? 'rgba(0,180,216,0.15)' : 'transparent',
          color: value === v ? 'var(--blue)' : 'var(--text-dim)',
          border:'none', borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
          padding:'0.25rem 0.55rem', fontSize:'0.62rem', fontWeight:600, cursor:'pointer',
          letterSpacing:'0.04em', textTransform:'uppercase',
        }}>{label}</button>
      ))}
    </div>
  )
}
