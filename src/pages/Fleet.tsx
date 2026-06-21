import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getCharacterFleet, getFleetInfo, getFleetMembers, getFleetWings,
  resolveNames, setFleetSettings, kickFleetMember, moveFleetMember, inviteFleetMember, resolveCharacterIds,
  createFleetWing, renameFleetWing, deleteFleetWing, createFleetSquad, renameFleetSquad, deleteFleetSquad,
  getSystems, getRegions, getSystemCoords, getSystemJumps, setWaypoint,
  type CharacterFleet, type FleetInfo, type FleetMember, type FleetWing,
} from '../api/esi'
import { secColor } from '../utils/secColor'
import { useSiteConfig, type JumpBridge } from '../hooks/useSiteConfig'
import { useIntelSystems, type SystemIntelGroup } from '../hooks/useIntelSystems'
import { fetchDscanItems, type DscanGroup } from '../utils/dscan'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'

// Scopes uit het EVE access-token (JWT 'scp'-claim) lezen — om te waarschuwen als
// de fleet-schrijfrechten ontbreken (token van vóór de scope-uitbreiding).
function tokenScopes(accessToken: string): string[] {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { scp?: string | string[] }
    return Array.isArray(payload.scp) ? payload.scp : typeof payload.scp === 'string' ? payload.scp.split(' ') : []
  } catch { return [] }
}

function sanitizeMotd(html: string): string {
  return html
    .replace(/<(?!\/?(a|b|i|br|font|span|p|ul|li|strong|em)\b)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '')
}

const ROLE_LABEL: Record<string, string> = {
  fleet_commander: 'FC',
  wing_commander:  'WC',
  squad_commander: 'SC',
  squad_member:    'Member',
}

const ROLE_COLOR: Record<string, string> = {
  fleet_commander: '#f0c040',
  wing_commander:  '#00b4d8',
  squad_commander: '#3ecf6e',
  squad_member:    'var(--text-dim)',
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span style={{
      fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.08em',
      color: ROLE_COLOR[role] ?? 'var(--text-dim)',
      background: `${ROLE_COLOR[role] ?? 'var(--border)'}18`,
      border: `1px solid ${ROLE_COLOR[role] ?? 'var(--border)'}44`,
      borderRadius: 2, padding: '0.1rem 0.35rem',
    }}>
      {ROLE_LABEL[role] ?? role}
    </span>
  )
}

interface ResolvedMember extends FleetMember {
  characterName: string
  shipName: string
  systemName: string
}

const miniBtn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', fontSize: '0.58rem', lineHeight: 1, padding: '0.12rem 0.35rem', cursor: 'pointer' }
const miniBtnRed: React.CSSProperties = { ...miniBtn, color: 'var(--red)', borderColor: 'rgba(224,85,85,0.4)' }

interface MemberNode {
  sid: number; members: ResolvedMember[]; name: string
  sec: number; region: string; jumps: number | undefined; isFc: boolean
}

const DSCAN_RE = /https?:\/\/dscan\.info\/v\/[a-f0-9]+/ig   // global → alle links in één melding

// Structuur-trefwoorden in intel → het EVE-type waarvan het icoon getoond wordt.
const STRUCT_KEYWORDS: { kw: RegExp; name: string }[] = [
  { kw: /\bess\b/i,     name: 'Encounter Surveillance System' },
  { kw: /\bskyhook\b/i, name: 'Orbital Skyhook' },
]

// New Eden cluster-kaart: alle systemen als dots (canvas), fleet-leden + regio-namen
// als overlay (SVG). Interactief: slepen = pannen, scrollen = zoomen.
function ClusterMap({ coords, sysMeta, regionMap, adj, memberNodes, bridges, intel, intelStatus }: {
  coords: Record<string, [number, number]>
  sysMeta: Record<string, [string, number, number]>
  regionMap: Record<string, string>
  adj: Record<string, number[]>
  memberNodes: MemberNode[]
  bridges: JumpBridge[]
  intel: Record<string, SystemIntelGroup>
  intelStatus: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Staand canvas — New Eden is hoger (z-span) dan breed (x-span), net als de echte cluster-map.
  const W = 660, H = 760, PAD = 30
  const [tf, setTf] = useState({ k: 1, x: 0, y: 0 })
  const [hoverSys, setHoverSys] = useState<string | null>(null)   // intel-marker waar de muis op staat
  const [sovMap, setSovMap]     = useState<Record<number, number>>({})   // systemId → sov-alliance
  const [allyNames, setAllyNames] = useState<Record<number, string>>({}) // allianceId → naam (lazy)
  const [structTypes, setStructTypes] = useState<Record<string, number>>({})  // structuur-naam → type-id (ESS, Skyhook…)
  const [dscan, setDscan]       = useState<Record<string, DscanGroup[]>>({})   // dscan-url → schepen
  const { tokens } = useAuth()
  const [destMsg, setDestMsg]   = useState<{ text: string; ok: boolean } | null>(null)
  const [ctx, setCtx]           = useState<{ x: number; y: number; sid: number; name: string } | null>(null)

  // Rechtsklik op een systeem → in-game-stijl contextmenu (waypoint-acties + links).
  function openCtx(e: React.MouseEvent, sid: number, name: string) {
    e.preventDefault(); e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, sid, name })
  }
  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [ctx])

  // mode: 'set' = nieuwe route (clear others) · 'add' = waypoint toevoegen · 'all' = set op alle accounts
  async function doWaypoint(sid: number, name: string, mode: 'set' | 'add' | 'all') {
    setCtx(null)
    if (mode === 'all') {
      if (!tokens.length) { setDestMsg({ text: 'Geen account ingelogd', ok: false }); return }
      setDestMsg({ text: `Route → ${name} op ${tokens.length} accounts…`, ok: true })
      const res = await Promise.all(tokens.map(t => setWaypoint(sid, t.accessToken, true)))
      const okN = res.filter(Boolean).length
      setDestMsg({ text: `Route gezet op ${okN}/${tokens.length} accounts → ${name}`, ok: okN > 0 })
    } else {
      const token = tokens[0]?.accessToken
      if (!token) { setDestMsg({ text: 'Geen account ingelogd', ok: false }); return }
      const clear = mode === 'set'
      setDestMsg({ text: `${clear ? 'Route' : 'Waypoint'} → ${name}…`, ok: true })
      const ok = await setWaypoint(sid, token, clear)
      setDestMsg({ text: ok ? `${clear ? 'Route gezet' : 'Waypoint toegevoegd'} → ${name}` : `Mislukt → ${name} (zit je character in EVE?)`, ok })
    }
    setTimeout(() => setDestMsg(null), 3000)
  }
  const dscanFetching           = useRef(new Set<string>())
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const didAuto = useRef(false)

  // Basisprojectie (vast, fit alle coords). Daarna pas/zoom-transform eroverheen.
  const base = useMemo(() => {
    const entries = Object.values(coords)
    if (entries.length === 0) return null
    const xs = entries.map(c => c[0]), zs = entries.map(c => -c[1])
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs)
    const spanX = (maxX - minX) || 1, spanZ = (maxZ - minZ) || 1
    const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanZ)
    const offX = (W - scale * spanX) / 2 - minX * scale
    const offZ = (H - scale * spanZ) / 2 - minZ * scale
    return (x: number, z: number): [number, number] => [offX + x * scale, offZ + (-z) * scale]
  }, [coords])

  const screen = (x: number, z: number): [number, number] => {
    const [bx, by] = base!(x, z)
    return [bx * tf.k + tf.x, by * tf.k + tf.y]
  }

  // Regio-zwaartepunten (voor de namen).
  const regions = useMemo(() => {
    const acc = new Map<number, { sx: number; sy: number; n: number }>()
    for (const [sid, c] of Object.entries(coords)) {
      const rid = sysMeta[sid]?.[2]
      if (rid == null) continue
      const a = acc.get(rid) ?? { sx: 0, sy: 0, n: 0 }
      a.sx += c[0]; a.sy += c[1]; a.n++; acc.set(rid, a)
    }
    return [...acc.entries()].map(([rid, a]) => ({ rid, name: regionMap[String(rid)] ?? '', x: a.sx / a.n, z: a.sy / a.n }))
  }, [coords, sysMeta, regionMap])

  // Systeemnaam (hoofdletters) → systeem-id, voor het resolven van bridges en intel.
  const nameToId = useMemo(() => {
    const m = new Map<string, string>()
    for (const [id, meta] of Object.entries(sysMeta)) m.set(meta[0].toUpperCase(), id)
    return m
  }, [sysMeta])

  // Jump bridges → coördinaat-paren.
  const bridgeCoords = useMemo(() => {
    const out: Array<[[number, number], [number, number]]> = []
    for (const [a, b] of bridges) {
      const ia = nameToId.get(a.trim().toUpperCase()), ib = nameToId.get(b.trim().toUpperCase())
      if (!ia || !ib) continue
      const ca = coords[ia], cb = coords[ib]
      if (ca && cb) out.push([ca, cb])
    }
    return out
  }, [bridges, nameToId, coords])

  // Intel → kaart-markers (rood !-icoon bij threat, oranje bij onbekend; clear = niets).
  const intelMarkers = useMemo(() => {
    const out: Array<{ c: [number, number]; sys: string; threat: boolean; spike: boolean; group: SystemIntelGroup }> = []
    for (const [sys, group] of Object.entries(intel)) {
      if (group.threat === 'clear') continue
      const id = nameToId.get(sys)
      const c = id && coords[id]
      const spike = group.entries.some(e => /\bspike\b/i.test(e.message))
      if (c) out.push({ c, sys, threat: group.threat === 'threat', spike, group })
    }
    return out
  }, [intel, nameToId, coords])

  // Canvas (her)tekenen bij data- of transform-wijziging.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !base) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = W * dpr; cv.height = H * dpr
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const scr = (c: [number, number]): [number, number] => { const [bx, by] = base(c[0], c[1]); return [bx * tf.k + tf.x, by * tf.k + tf.y] }

    // 1) Stargate-lijnen (zoals de in-game star map).
    ctx.strokeStyle = 'rgba(190,70,130,0.45)'
    ctx.lineWidth = Math.min(1.4, 0.5 + tf.k * 0.12)
    ctx.beginPath()
    for (const [sid, neighbors] of Object.entries(adj)) {
      const ca = coords[sid]; if (!ca) continue
      const sidN = Number(sid)
      const [ax, ay] = scr(ca)
      for (const nb of neighbors) {
        if (sidN > nb) continue                 // elke gate één keer
        const cb = coords[String(nb)]; if (!cb) continue
        const [bx, by] = scr(cb)
        if ((ax < 0 && bx < 0) || (ax > W && bx > W) || (ay < 0 && by < 0) || (ay > H && by > H)) continue
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      }
    }
    ctx.stroke()

    // 1b) Jump bridges (Ansiblex) — groene gebogen lijn (zoals de in-game route).
    if (bridgeCoords.length) {
      ctx.save()
      ctx.strokeStyle = 'rgba(82,224,128,0.5)'
      ctx.lineWidth = Math.min(2.4, 1 + tf.k * 0.07)
      ctx.lineCap = 'round'
      ctx.shadowColor = 'rgba(82,224,128,0.3)'
      ctx.shadowBlur = 3
      ctx.beginPath()
      for (const [ca, cb] of bridgeCoords) {
        const [ax, ay] = scr(ca); const [bx, by] = scr(cb)
        if ((ax < 0 && bx < 0) || (ax > W && bx > W) || (ay < 0 && by < 0) || (ay > H && by > H)) continue
        // Boog: controlepunt loodrecht op het midden van de verbinding.
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        const dx = bx - ax, dy = by - ay
        const len = Math.hypot(dx, dy) || 1
        const off = len * 0.28
        ctx.moveTo(ax, ay)
        ctx.quadraticCurveTo(mx + (dy / len) * off, my - (dx / len) * off, bx, by)
      }
      ctx.stroke()
      ctx.restore()
    }

    // 2) Systemen als dots (gekleurd op security).
    for (const [sid, c] of Object.entries(coords)) {
      const [x, y] = scr(c)
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue
      ctx.fillStyle = secColor(sysMeta[sid]?.[1] ?? 0)
      ctx.globalAlpha = 0.85
      const s = 1.0 + (tf.k - 1) * 0.16
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, s / 2), 0, Math.PI * 2); ctx.fill()
    }
    ctx.globalAlpha = 1
  }, [coords, sysMeta, adj, base, tf, bridgeCoords])

  // Auto-zoom: éénmalig inzoomen op de FC zodra coords + leden geladen zijn.
  useEffect(() => {
    if (didAuto.current || !base) return
    const fc = memberNodes.find(n => n.isFc) ?? memberNodes[0]
    const c = fc && coords[String(fc.sid)]
    if (!c) return
    didAuto.current = true
    const k = 24
    const [bx, by] = base(c[0], c[1])
    setTf({ k, x: W / 2 - bx * k, y: H / 2 - by * k })
  }, [base, memberNodes, coords])

  // Sovereignty-kaart één keer ophalen zodra er intel is → header toont de sov-houder.
  useEffect(() => {
    if (Object.keys(intel).length === 0 || Object.keys(sovMap).length) return
    fetch('https://esi.evetech.net/latest/sovereignty/map/?datasource=tranquility')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Array<{ system_id: number; alliance_id?: number }>) => {
        const m: Record<number, number> = {}
        for (const row of rows) if (row.alliance_id) m[row.system_id] = row.alliance_id
        setSovMap(m)
      }).catch(() => {})
  }, [intel, sovMap])

  // Structuur-types (ESS, Skyhook…) één keer resolven → iconen bij die meldingen.
  useEffect(() => {
    const names = STRUCT_KEYWORDS.map(s => s.name)
    fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(names),
    }).then(r => (r.ok ? r.json() : null))
      .then(d => {
        const m: Record<string, number> = {}
        for (const t of d?.inventory_types ?? []) m[t.name] = t.id
        if (Object.keys(m).length) setStructTypes(m)
      }).catch(() => {})
  }, [])

  // dscan.info-links in het gehoverde systeem ophalen → scheepslijst (gecached).
  useEffect(() => {
    if (!hoverSys) return
    const g = intel[hoverSys]
    if (!g) return
    for (const e of g.entries) {
      for (const url of e.message.match(DSCAN_RE) ?? []) {
        if (!dscan[url] && !dscanFetching.current.has(url)) {
          dscanFetching.current.add(url)
          fetchDscanItems(url)
            .then(groups => setDscan(p => ({ ...p, [url]: groups })))
            .catch(() => setDscan(p => ({ ...p, [url]: [] })))   // fout → stop met laden
        }
      }
    }
  }, [hoverSys, intel, dscan])

  // Naam van de sov-alliance van het gehoverde systeem ophalen (gecached).
  useEffect(() => {
    if (!hoverSys) return
    const sid = nameToId.get(hoverSys)
    const aid = sid ? sovMap[Number(sid)] : undefined
    if (aid && !allyNames[aid]) {
      resolveNames([aid]).then(map => { const n = map.get(aid); if (n) setAllyNames(p => ({ ...p, [aid]: n })) }).catch(() => {})
    }
  }, [hoverSys, sovMap, nameToId, allyNames])

  // Zoom met scrollwiel — native non-passive listener: React koppelt onWheel
  // passive, waardoor e.preventDefault() niet werkt en de pagina meescrollt.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = (e.clientX - r.left) * (W / r.width)
      const my = (e.clientY - r.top) * (H / r.height)
      const f = e.deltaY < 0 ? 1.18 : 1 / 1.18
      setTf(t => {
        const k = Math.max(0.8, Math.min(40, t.k * f))
        const fr = k / t.k
        return { k, x: mx - (mx - t.x) * fr, y: my - (my - t.y) * fr }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [base])

  if (!base) {
    return <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>Kaart laden…</div>
  }
  const maxCount = Math.max(...memberNodes.map(n => n.members.length), 1)

  const onDown = (e: React.MouseEvent) => { drag.current = { sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y } }
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    const r = wrapRef.current!.getBoundingClientRect()
    const sc = W / r.width
    const cx = e.clientX, cy = e.clientY
    setTf(t => ({ ...t, x: d.ox + (cx - d.sx) * sc, y: d.oy + (cy - d.sy) * sc }))
  }
  const endDrag = () => { drag.current = null }

  // Labels meeschalen met de zoom (vaste SVG-units → anders blijven ze even klein bij inzoomen).
  const sysFont    = Math.min(16, 3 + tf.k * 0.45)
  const memFont    = Math.min(15, 3 + tf.k * 0.42)
  // Systemen met een fleet-marker krijgen géén los dot-label (de marker toont de naam al).
  const memberSids = new Set(memberNodes.map(n => String(n.sid)))
  const markerFont = Math.min(17, 4 + tf.k * 0.48)
  const memLine    = memFont * 1.18

  return (
    <div ref={wrapRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={endDrag} onMouseLeave={endDrag}
      style={{ position: 'relative', background: '#05050e', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}>
      <style>{`@keyframes spikePulse {0%,100%{box-shadow:0 0 0 0 rgba(240,160,48,0.6);background:rgba(224,85,85,0.92)}50%{box-shadow:0 0 18px 5px rgba(240,160,48,0.9);background:rgba(240,160,48,0.95)}}`}</style>
      {/* Waypoint-feedback bij klik op een systeem */}
      {destMsg && (
        <div style={{
          position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 9, pointerEvents: 'none',
          background: destMsg.ok ? 'rgba(62,207,110,0.92)' : 'rgba(224,85,85,0.92)', color: '#05050e', fontWeight: 700,
          fontSize: '0.72rem', padding: '0.4rem 0.9rem', borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 3px 14px rgba(0,0,0,0.5)',
        }}>📍 {destMsg.text}</div>
      )}
      {/* Rechtsklik-contextmenu (in-game stijl) */}
      {ctx && (
        <div onClick={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
          style={{
            position: 'fixed', left: Math.min(ctx.x, window.innerWidth - 200), top: Math.min(ctx.y, window.innerHeight - 230),
            zIndex: 1000, minWidth: 184, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4,
            boxShadow: '0 8px 28px rgba(0,0,0,0.6)', overflow: 'hidden', fontSize: '0.72rem',
          }}>
          <div style={{ padding: '0.4rem 0.7rem', borderBottom: '1px solid var(--border)', color: 'var(--gold)', fontWeight: 700, whiteSpace: 'nowrap' }}>{ctx.name}</div>
          <CtxItem onClick={() => doWaypoint(ctx.sid, ctx.name, 'set')}>▶ Set Destination</CtxItem>
          <CtxItem onClick={() => doWaypoint(ctx.sid, ctx.name, 'add')}>＋ Add Waypoint</CtxItem>
          {tokens.length > 1 && <CtxItem onClick={() => doWaypoint(ctx.sid, ctx.name, 'all')}>⧉ Alle accounts ({tokens.length})</CtxItem>}
          <div style={{ borderTop: '1px solid var(--border)' }} />
          <CtxLink href={`https://evemaps.dotlan.net/system/${encodeURIComponent(ctx.name.replace(/ /g, '_'))}`}>🗺 Dotlan</CtxLink>
          <CtxLink href={`https://zkillboard.com/system/${ctx.sid}/`}>💀 zKillboard</CtxLink>
        </div>
      )}
      {/* SPIKE-waarschuwing — groot, pulserend rood/oranje */}
      {intelMarkers.some(m => m.spike) && (
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 8, pointerEvents: 'none',
          color: '#fff', fontWeight: 800, fontSize: '0.82rem', letterSpacing: '0.08em', textShadow: '0 1px 2px rgba(0,0,0,0.6)',
          padding: '0.45rem 1.1rem', borderRadius: 6, border: '2px solid #fff', whiteSpace: 'nowrap',
          animation: 'spikePulse 0.8s ease-in-out infinite',
        }}>
          ⚠ SPIKE — {intelMarkers.filter(m => m.spike).map(m => m.sys).join(', ')}
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }} />
      <svg viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {/* Regio-namen (alleen ver uitgezoomd; bij inzoomen storen ze) */}
        {tf.k < 5 && regions.map(rg => {
          const [x, y] = screen(rg.x, rg.z)
          if (x < 0 || x > W || y < 0 || y > H) return null
          return <text key={rg.rid} x={x} y={y} textAnchor="middle" fontSize={8.5} fill="rgba(205,214,235,0.8)" stroke="#05050e" strokeWidth={0.5} paintOrder="stroke">{rg.name}</text>
        })}
        {/* Systeem-labels bij inzoomen (zoals de in-game star map) */}
        {tf.k >= 5 && Object.entries(coords).map(([sid, c]) => {
          if (memberSids.has(sid)) return null
          const [x, y] = screen(c[0], c[1])
          if (x < 4 || x > W - 4 || y < 8 || y > H - 2) return null
          const name = sysMeta[sid]?.[0]; if (!name) return null
          return <text key={sid} x={x + sysFont * 0.5} y={y - sysFont * 0.4} fontSize={sysFont} fill="rgba(225,228,240,0.8)" stroke="#05050e" strokeWidth={sysFont * 0.07} paintOrder="stroke"
            style={{ cursor: 'context-menu', pointerEvents: 'auto' }} onContextMenu={e => openCtx(e, +sid, name)}><title>Rechtsklik voor route-menu</title>{name}</text>
        })}
        {/* Fleet-leden — groene ring + aantal (zoals de in-game map) */}
        {memberNodes.map(n => {
          const c = coords[String(n.sid)]
          if (!c) return null
          const [x, y] = screen(c[0], c[1])
          const r = 3 + (n.members.length / maxCount) * 4
          return (
            <g key={n.sid} style={{ cursor: 'context-menu', pointerEvents: 'auto' }} onContextMenu={e => openCtx(e, n.sid, n.name)}>
              <title>Rechtsklik {n.name} voor route-menu</title>
              <circle cx={x} cy={y} r={r + 4} fill="#3ecf6e" fillOpacity={0.12} />
              <circle cx={x} cy={y} r={r + 1.5} fill="none" stroke="#3ecf6e" strokeWidth={1.4} />
              {n.isFc && <circle cx={x} cy={y} r={r + 4} fill="none" stroke="#f0c040" strokeWidth={1} strokeDasharray="3 2" />}
              <circle cx={x} cy={y} r={r} fill={secColor(n.sec)} stroke="#05050e" strokeWidth={0.8} />
              <text x={x} y={y + 2.6} textAnchor="middle" fontSize={Math.min(9, r + 1.5)} fontWeight={700} fill="#05050e">{n.members.length}</text>
              <text x={x + r + 4} y={y + markerFont * 0.38} fontSize={markerFont} fontWeight={700} fill="#fff" stroke="#05050e" strokeWidth={markerFont * 0.085} paintOrder="stroke">
                {n.name}{n.jumps != null && n.jumps > 0 ? ` · ${n.jumps}j` : n.isFc ? ' · FC' : ''}
              </text>
              {/* Member-namen onder de marker */}
              {n.members.slice(0, 8).map((m, i) => (
                <text key={m.character_id} x={x} y={y + r + memFont + i * memLine} textAnchor="middle" fontSize={memFont}
                  fill="rgba(225,232,245,0.92)" stroke="#05050e" strokeWidth={memFont * 0.07} paintOrder="stroke">{m.characterName}</text>
              ))}
              {n.members.length > 8 && (
                <text x={x} y={y + r + memFont + 8 * memLine} textAnchor="middle" fontSize={memFont} fill="var(--text-dim)" stroke="#05050e" strokeWidth={memFont * 0.07} paintOrder="stroke">+{n.members.length - 8} meer</text>
              )}
            </g>
          )
        })}
        {/* Intel — rood !-icoon bij threat, oranje bij onbekende sighting (uit de intel-chats) */}
        {intelMarkers.map(({ c, sys, threat, spike, group }) => {
          const [x, y] = screen(c[0], c[1])
          if (x < -10 || x > W + 10 || y < -10 || y > H + 10) return null
          const ir = Math.max(5, markerFont * 0.7)
          const col = threat ? '#e05555' : '#f0a030'
          return (
            <g key={`intel-${sys}`} style={{ pointerEvents: 'auto', cursor: 'context-menu' }}
              onContextMenu={e => openCtx(e, +sys, sysMeta[sys]?.[0] ?? `Systeem ${sys}`)}
              onMouseEnter={() => setHoverSys(sys)} onMouseLeave={() => setHoverSys(h => h === sys ? null : h)}>
              {/* Onzichtbaar hover-vlak (ruimer dan het icoon) */}
              <circle cx={x} cy={y} r={Math.max(ir * 1.8, 10)} fill="transparent" />
              {/* SPIKE → grote, snelle dubbele puls (rood + oranje) */}
              {spike && <>
                <circle cx={x} cy={y} fill="none" stroke="#e05555" strokeWidth={3}>
                  <animate attributeName="r" values={`${ir};${ir * 6}`} dur="1s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.95;0" dur="1s" repeatCount="indefinite" />
                  <animate attributeName="stroke-width" values="3.5;0.5" dur="1s" repeatCount="indefinite" />
                </circle>
                <circle cx={x} cy={y} fill="none" stroke="#f0a030" strokeWidth={3}>
                  <animate attributeName="r" values={`${ir};${ir * 6}`} dur="1s" begin="0.5s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.95;0" dur="1s" begin="0.5s" repeatCount="indefinite" />
                  <animate attributeName="stroke-width" values="3.5;0.5" dur="1s" begin="0.5s" repeatCount="indefinite" />
                </circle>
              </>}
              {/* Pulserende ring (radar-ping) */}
              <circle cx={x} cy={y} fill="none" stroke={col} strokeWidth={1.5}>
                <animate attributeName="r" values={`${ir};${ir * 2.8}`} dur="1.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.85;0" dur="1.5s" repeatCount="indefinite" />
                <animate attributeName="stroke-width" values="2;0.4" dur="1.5s" repeatCount="indefinite" />
              </circle>
              <circle cx={x} cy={y} r={ir} fill={col} stroke="#05050e" strokeWidth={ir * 0.12} />
              <text x={x} y={y + ir * 0.36} textAnchor="middle" fontSize={ir * 1.1} fontWeight={700} fill="#fff">!</text>
              {group.count > 0 && (
                <text x={x} y={y - ir - 1} textAnchor="middle" fontSize={ir * 0.95} fontWeight={700} fill={col} stroke="#05050e" strokeWidth={ir * 0.09} paintOrder="stroke">{group.count}+</text>
              )}
              {/* SPIKE-label op locatie (knipperend) */}
              {spike && (
                <text x={x} y={y - ir - markerFont * 1.4} textAnchor="middle" fontSize={markerFont * 1.3} fontWeight={800}
                  fill="#e05555" stroke="#05050e" strokeWidth={markerFont * 0.12} paintOrder="stroke">
                  ⚠ SPIKE
                  <animate attributeName="fill" values="#e05555;#f0a030;#e05555" dur="0.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="1;0.45;1" dur="0.8s" repeatCount="indefinite" />
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {/* Intel-tooltip bij hover — in-game stijl: lijst van meldingen met mm:ss-timer */}
      {(() => {
        const hm = hoverSys ? intelMarkers.find(m => m.sys === hoverSys) : null
        if (!hm) return null
        const [hx, hy] = screen(hm.c[0], hm.c[1])
        if (hx < 0 || hx > W || hy < 0 || hy > H) return null
        const col = hm.threat ? 'var(--red)' : '#f0a030'
        const onLeft = hx > W * 0.6
        const mmss = (t: number) => {
          const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
          return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
        }
        // Systeem-security (voor de kleur) + sov-houder (header).
        const sid = nameToId.get(hm.sys)
        const sec = sid ? sysMeta[sid]?.[1] ?? 0 : 0
        const sovAlly = sid ? sovMap[Number(sid)] : undefined
        return (
          <div style={{
            position: 'absolute', left: `${(hx / W) * 100}%`, top: `${(hy / H) * 100}%`,
            transform: `translate(${onLeft ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
            zIndex: 7, pointerEvents: 'none', width: 296,
            background: 'rgba(6,8,16,0.97)', border: `1px solid ${col}`, borderRadius: 5,
            boxShadow: '0 4px 16px rgba(0,0,0,0.6)', overflow: 'hidden',
          }}>
            {/* Systeem-header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.55rem', background: 'rgba(255,255,255,0.04)' }}>
              <span style={{ fontSize: '0.55rem', fontWeight: 700, color: '#05050e', background: col, borderRadius: 3, padding: '0.05rem 0.35rem' }}>{hm.group.entries.length}</span>
              <span style={{ fontWeight: 700, fontSize: '0.82rem', color: secColor(sec) }}>{hm.sys}</span>
              <span style={{ fontSize: '0.62rem', color: secColor(sec) }}>{(Math.round(sec * 10) / 10).toFixed(1)}</span>
              <span style={{ marginLeft: 'auto', fontSize: '0.66rem', fontVariantNumeric: 'tabular-nums', color: col, fontWeight: 700 }}>{mmss(hm.group.time)}</span>
            </div>
            {/* Sov-houder van het systeem */}
            {sovAlly && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.25rem 0.55rem', borderBottom: `1px solid ${col}`, background: hm.threat ? 'rgba(224,85,85,0.1)' : 'rgba(240,160,48,0.1)' }}>
                <EveImage category="alliances" id={sovAlly} variation="logo" size={64} px={26} style={{ borderRadius: 2, flexShrink: 0 }} />
                <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{allyNames[sovAlly] ?? 'Sov-houder…'}</span>
              </div>
            )}
            {/* Rijen: [portret][corp][alliance] · naam + alliance-naam · schip eronder */}
            {hm.group.entries.map(e => {
              const en = e.enemies && e.enemies[0]
              const ship = e.ships[0]
              const isChar = en?.kind === 'character'
              const corpId = isChar ? en!.corpId : en?.kind === 'corporation' ? en.id : undefined
              const allyId = isChar ? en!.allianceId : en?.kind === 'alliance' ? en.id : undefined
              const cleaned = e.message.replace(DSCAN_RE, '').replace(new RegExp(`\\b${e.system}\\b`, 'ig'), '').replace(/\s+/g, ' ').trim()
              const name = en ? en.name : ship ? ship.name : (cleaned || (e.message.match(DSCAN_RE) ? 'D-Scan' : e.message))
              const allyName = en?.allianceName
              const structs = STRUCT_KEYWORDS.filter(s => structTypes[s.name] && s.kw.test(e.message))
              const nameCol = e.threat === 'threat' ? '#ff7676' : e.threat === 'clear' ? 'var(--green)' : '#f0c040'
              return (
                <div key={e.id} style={{ padding: '0.35rem 0.55rem', borderBottom: '1px solid rgba(40,46,70,0.5)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    {/* Iconen: character · corp · alliance */}
                    {isChar && <EveImage category="characters" id={en!.id} variation="portrait" size={64} px={40} style={{ flexShrink: 0 }} />}
                    {corpId && <EveImage category="corporations" id={corpId} variation="logo" size={64} px={34} style={{ borderRadius: 2, flexShrink: 0 }} />}
                    {allyId && <EveImage category="alliances" id={allyId} variation="logo" size={64} px={34} style={{ borderRadius: 2, flexShrink: 0 }} />}
                    {!en && (ship
                      ? <span title={ship.name} style={{ flexShrink: 0 }}><EveImage category="types" id={ship.typeId} variation="icon" size={64} px={36} /></span>
                      : structs.length === 0 && <span style={{ flexShrink: 0, width: 34, textAlign: 'center', fontSize: '1.1rem', color: e.threat === 'threat' ? 'var(--red)' : '#f0a030', fontWeight: 700 }}>!</span>)}
                    {/* Structuur-iconen (ESS, Skyhook…) als ze genoemd worden */}
                    {structs.map(s => (
                      <span key={s.name} title={s.name} style={{ flexShrink: 0 }}><EveImage category="types" id={structTypes[s.name]} variation="icon" size={64} px={34} /></span>
                    ))}
                    {/* Naam + alliance-naam eronder */}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                      <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: nameCol }}>{name}</span>
                      {(allyName || en?.corpTicker) && (
                        <span style={{ display: 'block', fontSize: '0.58rem', color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {allyName ?? [en?.corpTicker, en?.allianceTicker].filter(Boolean).join(' ')}
                        </span>
                      )}
                    </span>
                  </div>
                  {/* Schip eronder (als bij de character een schip gemeld is) */}
                  {en && ship && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: 4, paddingLeft: '0.5rem' }}>
                      <EveImage category="types" id={ship.typeId} variation="icon" size={64} px={30} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '0.66rem', color: 'var(--text)' }}>{ship.name}</span>
                    </div>
                  )}
                  {/* dscan.info-link(s) → schepen op grid */}
                  {(e.message.match(DSCAN_RE) ?? []).map(url => {
                    const groups = dscan[url]
                    if (!groups) return <div key={url} style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginTop: 3, paddingLeft: '0.5rem' }}>◎ dscan laden…</div>
                    const ships = groups.filter(g => g.typeId)
                    if (!ships.length) return <div key={url} style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginTop: 3, paddingLeft: '0.5rem' }}>◎ dscan — geen data (open de link in de chat)</div>
                    return (
                      <div key={url} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.2rem', marginTop: 4, paddingLeft: '0.5rem' }}>
                        {ships.slice(0, 14).map(g => (
                          <span key={g.typeId} title={`${g.typeName} ×${g.count}`} style={{ position: 'relative', flexShrink: 0 }}>
                            <EveImage category="types" id={g.typeId!} variation="icon" size={64} px={28} />
                            {g.count > 1 && <span style={{ position: 'absolute', right: -2, bottom: -2, fontSize: '0.5rem', fontWeight: 700, color: '#fff', background: 'rgba(0,0,0,0.75)', borderRadius: 2, padding: '0 2px' }}>{g.count}</span>}
                          </span>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}
      {/* Zoom-knoppen */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[['+', 1.4], ['−', 1 / 1.4]].map(([lbl, f]) => (
          <button key={lbl as string} onClick={() => setTf(t => ({ ...t, k: Math.max(0.8, Math.min(40, t.k * (f as number))) }))}
            style={{ width: 26, height: 26, background: 'rgba(11,11,26,0.85)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}>{lbl}</button>
        ))}
        <button onClick={() => {
          const fc = memberNodes.find(n => n.isFc) ?? memberNodes[0]
          const c = fc && coords[String(fc.sid)]
          if (!c) { setTf({ k: 1, x: 0, y: 0 }); return }
          const k = 24, [bx, by] = base(c[0], c[1])
          setTf({ k, x: W / 2 - bx * k, y: H / 2 - by * k })
        }} title="Centreer op FC"
          style={{ width: 26, height: 26, background: 'rgba(11,11,26,0.85)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.7rem' }}>⌖</button>
      </div>
      {/* Kompas + assen (zoals de officiële cluster-map: N boven, +X rechts/rood, +Y omhoog/groen) */}
      <svg width={84} height={84} viewBox="0 0 84 84" style={{ position: 'absolute', top: 6, left: 6 }}>
        <text x={42} y={12} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">N</text>
        <polygon points="42,16 38,40 42,34 46,40" fill="#fff" />
        <polygon points="42,72 38,48 42,54 46,48" fill="rgba(255,255,255,0.5)" />
        {/* +Y groen omhoog */}
        <line x1={14} y1={70} x2={14} y2={46} stroke="#3ecf6e" strokeWidth={2} />
        <polygon points="14,44 11,50 17,50" fill="#3ecf6e" />
        <text x={20} y={50} fontSize={9} fontWeight={700} fill="#3ecf6e">+Y</text>
        {/* +X rood rechts */}
        <line x1={14} y1={70} x2={38} y2={70} stroke="#e05555" strokeWidth={2} />
        <polygon points="40,70 34,67 34,73" fill="#e05555" />
        <text x={30} y={82} fontSize={9} fontWeight={700} fill="#e05555">+X</text>
      </svg>
      <div style={{ position: 'absolute', bottom: 6, left: 8, fontSize: '0.58rem', color: 'rgba(150,165,210,0.5)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span>sleep = pan · scroll = zoom</span>
        {bridgeCoords.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)' }}>
            <svg width={18} height={8}><path d="M1 7 Q9 -1 17 5" fill="none" stroke="#52e080" strokeWidth={1.6} strokeLinecap="round" /></svg>
            jump bridge
          </span>
        )}
        {intelStatus === 'live' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: intelMarkers.length ? 'var(--red)' : 'var(--text-dim)' }}>
            <svg width={10} height={10}><circle cx={5} cy={5} r={5} fill={intelMarkers.length ? '#e05555' : '#445'} /><text x={5} y={8} textAnchor="middle" fontSize={7} fontWeight={700} fill="#fff">!</text></svg>
            {intelMarkers.length ? `intel (${intelMarkers.length})` : 'intel: niks recent'}
          </span>
        )}
      </div>
    </div>
  )
}

export default function Fleet() {
  // Álle accounts, niet alleen de geselecteerde — je kunt met een ander character in fleet zitten.
  const { tokens } = useAuth()
  const { bridges: siteBridges } = useSiteConfig()

  const [charFleet, setCharFleet]     = useState<CharacterFleet | null>(null)
  const [fleetInfo, setFleetInfo]     = useState<FleetInfo | null>(null)
  const [members, setMembers]         = useState<ResolvedMember[]>([])
  const [wings, setWings]             = useState<FleetWing[]>([])
  const [loading, setLoading]         = useState(true)
  const [notInFleet, setNotInFleet]   = useState(false)
  const { systems: intel, status: intelStatus, connect: connectIntel, chooseFolder: chooseIntelFolder, debug: intelDebug } = useIntelSystems(!notInFleet)   // intel-threats uit de chatlogs (voor de kaart)
  const [fleetErr, setFleetErr]       = useState<string | null>(null)   // foutreden bij 'niet in fleet'
  const [fleetToken, setFleetToken]   = useState<typeof tokens[number] | null>(null) // het account dat in de fleet zit
  const [myRole, setMyRole]           = useState<string | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Beheer (FC)
  const [motdDraft, setMotdDraft]   = useState('')
  const [editingMotd, setEditingMotd] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [msg, setMsg]               = useState<string | null>(null)
  const [busy, setBusy]             = useState(false)

  // Kaart
  const [view, setView] = useState<'list' | 'map'>('list')
  const [coords, setCoords]     = useState<Record<string, [number, number]>>({})
  const [adj, setAdj]           = useState<Record<string, number[]>>({})
  const [sysMeta, setSysMeta]   = useState<Record<string, [string, number, number]>>({})
  const [regionMap, setRegionMap] = useState<Record<string, string>>({})

  // Kaart-bundels laden zodra je in een fleet zit — de kaart staat nu op beide tabs.
  useEffect(() => {
    if (notInFleet) return
    getSystemCoords().then(setCoords).catch(() => {})
    getSystemJumps().then(setAdj).catch(() => {})
    getSystems().then(setSysMeta).catch(() => {})
    getRegions().then(setRegionMap).catch(() => {})
  }, [notInFleet])

  async function load() {
    if (tokens.length === 0) return

    // Vraag voor élk account de fleet-status op; meerdere van je characters kunnen
    // in dezelfde fleet zitten (bv. main + alt).
    const results = await Promise.all(tokens.map(async cand => {
      try { return { cand, cf: await getCharacterFleet(cand.characterId, cand.accessToken), err: '' } }
      catch (e) { return { cand, cf: null as CharacterFleet | null, err: (e as Error).message } }
    }))
    const inFleet = results.filter(r => r.cf)

    if (inFleet.length === 0) {
      const errs = results.map(r => r.err).join(' ')
      setNotInFleet(true)
      setFleetToken(null)
      // 403 = scope ontbreekt; 404 = ESI ziet (nog) geen fleet.
      setFleetErr(/\b403\b/.test(errs) ? 'scope' : 'none')
      setLoading(false)
      return
    }

    // Kies het account met de hoogste rol — de fleet-boss (FC) kan als enige de
    // ledenlijst/details lezen. Anders zou een alt (gewoon lid) een 404 geven.
    const rolePref: Record<string, number> = { fleet_commander: 0, wing_commander: 1, squad_commander: 2, squad_member: 3 }
    inFleet.sort((a, b) => (rolePref[a.cf!.role] ?? 9) - (rolePref[b.cf!.role] ?? 9))
    const t = inFleet[0].cand
    const cf = inFleet[0].cf!

    setFleetToken(t)
    setCharFleet(cf)
    setMyRole(cf.role)
    setNotInFleet(false)
    setFleetErr(null)
    setAccessError(null)

    const [info, memberList, wingList] = await Promise.allSettled([
      getFleetInfo(cf.fleet_id, t.accessToken),
      getFleetMembers(cf.fleet_id, t.accessToken),
      getFleetWings(cf.fleet_id, t.accessToken),
    ])

    if (info.status     === 'fulfilled') setFleetInfo(info.value)
    if (wingList.status === 'fulfilled') setWings(wingList.value)

    if (memberList.status === 'fulfilled') {
      const raw = memberList.value
      const ids = [
        ...raw.map(m => m.character_id),
        ...raw.map(m => m.ship_type_id),
        ...raw.map(m => m.solar_system_id),
      ]
      const nameMap = await resolveNames([...new Set(ids)]).catch(() => new Map<number, string>())
      setMembers(raw.map(m => ({
        ...m,
        characterName: nameMap.get(m.character_id) ?? `Character ${m.character_id}`,
        shipName:      nameMap.get(m.ship_type_id)  ?? `Ship ${m.ship_type_id}`,
        systemName:    nameMap.get(m.solar_system_id) ?? `System ${m.solar_system_id}`,
      })).sort((a, b) => {
        const order = ['fleet_commander', 'wing_commander', 'squad_commander', 'squad_member']
        return order.indexOf(a.role) - order.indexOf(b.role)
      }))
    } else {
      const err = memberList.reason as Error
      const code = err?.message?.match(/\b(40\d)\b/)?.[1]
      if (code === '404' || code === '403') {
        // ESI staat de /fleets/{id}/-endpoints alleen toe voor de fleet-boss (de FC
        // bovenaan). Niet-boss leden krijgen een 404 — geen echte fout.
        setMembers([])
        setAccessError(
          cf.role === 'fleet_commander'
            ? 'ESI geeft geen toegang tot de fleet-details. Dit gebeurt als je niet de fleet-boss bent (de allereerste FC die de fleet opende) of als de fleet net opnieuw is gevormd — laat de boss de fleet-tools openen.'
            : 'De ledenlijst en fleet-details zijn via ESI alleen zichtbaar voor de Fleet Commander (de fleet-boss). Je ziet hieronder wel je eigen rol en schip.'
        )
      } else {
        setAccessError(`Kan ledenlijst niet laden: ${err?.message ?? 'onbekende fout'}`)
      }
    }

    setLoading(false)
  }

  useEffect(() => {
    if (tokens.length === 0) return
    setLoading(true)
    load()
    intervalRef.current = setInterval(() => load(), 15_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.map(t => t.characterId).join(',')])

  const fc    = members.find(m => m.role === 'fleet_commander')
  const myChar = members.find(m => m.character_id === fleetToken?.characterId)

  // Beheer alleen voor de Fleet Commander, en alleen als de boss-endpoints écht
  // toegankelijk zijn (ledenlijst geladen).
  const canManage = myRole === 'fleet_commander' && !!charFleet && !accessError && members.length > 0
  const hasFleetWrite = fleetToken ? tokenScopes(fleetToken.accessToken).includes('esi-fleets.write_fleet.v1') : false
  const squadOptions = wings.flatMap(w => w.squads.map(s => ({ wingId: w.id, squadId: s.id, label: `${w.name} / ${s.name}` })))
  const memberCols = canManage ? '1fr 130px 120px 46px 168px' : '1fr 160px 160px 60px'

  // Kaart-data: fleet-leden gegroepeerd per systeem + jump-afstand vanaf de FC.
  const fleetMap = useMemo(() => {
    const groups = new Map<number, ResolvedMember[]>()
    for (const m of members) { const g = groups.get(m.solar_system_id) ?? []; g.push(m); groups.set(m.solar_system_id, g) }
    const memberSids = new Set(groups.keys())
    const fcSys = members.find(m => m.role === 'fleet_commander')?.solar_system_id ?? members[0]?.solar_system_id

    // Jump-afstand vanaf de FC via BFS over de stargate-buren.
    const dist = new Map<number, number>()
    if (fcSys != null) {
      dist.set(fcSys, 0)
      let frontier = [fcSys], d = 0
      while (frontier.length && d < 60 && [...memberSids].some(s => !dist.has(s))) {
        d++
        const next: number[] = []
        for (const s of frontier) for (const nb of (adj[String(s)] ?? [])) if (!dist.has(nb)) { dist.set(nb, d); next.push(nb) }
        frontier = next
      }
    }

    const memberNodes: MemberNode[] = [...groups.entries()].map(([sid, mem]) => {
      const meta = sysMeta[String(sid)]
      return {
        sid, members: mem, name: mem[0]?.systemName ?? (meta?.[0] ?? `System ${sid}`),
        sec: meta?.[1] ?? 0,
        region: meta ? (regionMap[String(meta[2])] ?? '') : '',
        jumps: dist.get(sid), isFc: sid === fcSys,
      }
    }).sort((a, b) => b.members.length - a.members.length)
    return { memberNodes }
  }, [members, adj, sysMeta, regionMap])

  async function withBusy(action: () => Promise<void>, ok: string) {
    if (!fleetToken || !charFleet) return
    setBusy(true); setMsg(null)
    try { await action(); setMsg(ok); await load() }
    catch (e) { setMsg(`Mislukt: ${(e as Error).message ?? 'fout'}`) }
    finally { setBusy(false) }
  }

  const saveMotd = () => withBusy(() => setFleetSettings(charFleet!.fleet_id, fleetToken!.accessToken, { motd: motdDraft }), 'MOTD opgeslagen')
  // Free Move: optimistisch omzetten + daarna verifiëren met de échte ESI-stand.
  // Zo zelf-corrigeert de knop als de getoonde waarde achterliep, en zien we het
  // meteen als ESI de wijziging (204) tóch niet in-game toepast.
  async function toggleFreeMove() {
    if (!fleetToken || !charFleet) return
    const target = !fleetInfo?.is_free_move
    setBusy(true); setMsg(null)
    setFleetInfo(fi => (fi ? { ...fi, is_free_move: target } : fi))
    try {
      await setFleetSettings(charFleet.fleet_id, fleetToken.accessToken, { is_free_move: target })
      setMsg(`Free Move → ${target ? 'AAN' : 'UIT'} verzonden…`)
      // Even wachten zodat ESI's eigen cache verloopt, dan de echte stand ophalen.
      await new Promise(r => setTimeout(r, 4000))
      const fresh = await getFleetInfo(charFleet.fleet_id, fleetToken.accessToken)
      setFleetInfo(fresh)
      setMsg(fresh.is_free_move === target
        ? `Free Move staat nu ${target ? 'AAN' : 'UIT'}`
        : '⚠ ESI paste het niet toe in-game — alleen de échte fleet-boss (de FC bovenaan de fleet) mag dit zetten.')
    } catch (e) {
      setFleetInfo(fi => (fi ? { ...fi, is_free_move: !target } : fi))
      setMsg(`Mislukt: ${(e as Error).message ?? 'fout'}`)
    } finally { setBusy(false) }
  }
  const kick = (memberId: number, name: string) => { if (confirm(`${name} uit de fleet verwijderen?`)) withBusy(() => kickFleetMember(charFleet!.fleet_id, fleetToken!.accessToken, memberId), `${name} verwijderd`) }
  const moveTo = (memberId: number, opt: { wingId: number; squadId: number }) =>
    withBusy(() => moveFleetMember(charFleet!.fleet_id, fleetToken!.accessToken, memberId, { role: 'squad_member', wing_id: opt.wingId, squad_id: opt.squadId }), 'Lid verplaatst')

  // Wings & squads
  const addWing    = () => withBusy(() => createFleetWing(charFleet!.fleet_id, fleetToken!.accessToken), 'Wing toegevoegd')
  const addSquad   = (wingId: number) => withBusy(() => createFleetSquad(charFleet!.fleet_id, fleetToken!.accessToken, wingId), 'Squad toegevoegd')
  const renameWing = (wingId: number, cur: string) => { const n = prompt('Wing hernoemen:', cur); if (n && n.trim()) withBusy(() => renameFleetWing(charFleet!.fleet_id, fleetToken!.accessToken, wingId, n.trim()), 'Wing hernoemd') }
  const renameSquad = (squadId: number, cur: string) => { const n = prompt('Squad hernoemen:', cur); if (n && n.trim()) withBusy(() => renameFleetSquad(charFleet!.fleet_id, fleetToken!.accessToken, squadId, n.trim()), 'Squad hernoemd') }
  const delWing    = (wingId: number, name: string) => { if (confirm(`Wing "${name}" verwijderen? Alle squads erin verdwijnen ook.`)) withBusy(() => deleteFleetWing(charFleet!.fleet_id, fleetToken!.accessToken, wingId), 'Wing verwijderd') }
  const delSquad   = (squadId: number, name: string) => { if (confirm(`Squad "${name}" verwijderen?`)) withBusy(() => deleteFleetSquad(charFleet!.fleet_id, fleetToken!.accessToken, squadId), 'Squad verwijderd') }
  async function doInvite() {
    // Namen: één per regel of komma-gescheiden.
    const names = [...new Set(inviteName.split(/[\n,]+/).map(s => s.trim()).filter(Boolean))]
    if (names.length === 0) return
    const sq = squadOptions[0]
    if (!sq) { setMsg('Geen squad om naartoe uit te nodigen — maak eerst een squad in de fleet.'); return }
    setBusy(true); setMsg(null)

    const idMap = await resolveCharacterIds(names)
    const notFound = names.filter(n => !idMap.get(n))
    const found = names.filter(n => idMap.get(n))

    let invited = 0
    const failed: string[] = []
    for (const n of found) {
      const id = idMap.get(n)!
      try {
        await inviteFleetMember(charFleet!.fleet_id, fleetToken!.accessToken, id, { role: 'squad_member', wing_id: sq.wingId, squad_id: sq.squadId })
        invited++
      } catch { failed.push(n) }
    }

    const parts: string[] = []
    if (invited > 0)        parts.push(`${invited} uitgenodigd`)
    if (failed.length)      parts.push(`${failed.length} mislukt (${failed.join(', ')})`)
    if (notFound.length)    parts.push(`${notFound.length} niet gevonden (${notFound.join(', ')})`)
    setMsg(parts.join(' · ') || 'Niets om uit te nodigen')
    if (invited > 0 && failed.length === 0 && notFound.length === 0) setInviteName('')
    setBusy(false)
  }

  return (
    <Layout header={
      <PageHeader
        title="Fleet"
        sub={
          loading ? 'Laden...' :
          notInFleet ? 'Niet in fleet' :
          `${members.length} leden · ${myRole ? ROLE_LABEL[myRole] : ''}`
        }
        right={!loading && !notInFleet && members.length > 0 ? (
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 2, overflow: 'hidden' }}>
            {(['list', 'map'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: '0.3rem 0.7rem', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer', border: 'none',
                background: view === v ? 'rgba(0,180,216,0.15)' : 'transparent',
                color: view === v ? 'var(--blue)' : 'var(--text-dim)',
              }}>{v === 'list' ? 'Leden' : '🗺 Kaart'}</button>
            ))}
          </div>
        ) : undefined}
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Fleet data laden...
        </div>
      )}

      {!loading && notInFleet && (
        <div style={{ textAlign: 'center', padding: '4rem 2rem', color: 'var(--text-dim)', fontSize: '0.85rem', lineHeight: 1.7, maxWidth: 560, margin: '0 auto' }}>
          <div style={{ fontSize: '2rem', color: 'var(--border)', marginBottom: '1rem' }}>⊞</div>
          {fleetErr === 'scope' ? (
            <>
              <div style={{ color: 'var(--gold)', fontWeight: 600, marginBottom: '0.5rem' }}>Je login mist de fleet-rechten</div>
              Je account(s) hebben de scope <code>esi-fleets.read_fleet.v1</code> niet (token van vóór de uitbreiding).
              {' '}Ga in de zijbalk naar je account, <strong>verwijder het</strong> en log opnieuw in om de fleet-rechten te verlenen.
            </>
          ) : (
            <>
              Geen van je {tokens.length} account{tokens.length !== 1 ? 's' : ''} zit op dit moment in een fleet — volgens ESI.
              <div style={{ fontSize: '0.72rem', marginTop: '0.75rem', color: 'var(--text-dim)' }}>
                Zit je er wél in? ESI loopt soms ~1 minuut achter — wacht even en het ververst vanzelf (elke 15s).
                {' '}Controleer ook of je met het juiste character bent ingelogd (de pagina checkt al je accounts).
              </div>
            </>
          )}
        </div>
      )}

      {!loading && !notInFleet && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

          {/* Fleet info balk — altijd zichtbaar als in fleet */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem' }}>
            {/* FC — alleen zichtbaar als ledenlijst beschikbaar */}
            {fc && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>FLEET COMMANDER</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <EveImage category="characters" id={fc.character_id} variation="portrait" size={32} px={24} round />
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--gold)' }}>{fc.characterName}</span>
                </div>
              </div>
            )}

            {/* Mijn rol — valt terug op charFleet als ledenlijst niet beschikbaar */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>MIJN ROL</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {myRole && <RoleBadge role={myRole} />}
                {myChar && <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{myChar.shipName}</span>}
              </div>
            </div>

            {/* Leden — alleen als beschikbaar */}
            {members.length > 0 && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>LEDEN</div>
                <span style={{ fontSize: '1rem', fontWeight: 700 }}>{members.length}</span>
              </div>
            )}

            {/* Flags — alleen als fleetInfo beschikbaar */}
            {fleetInfo && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>STATUS</div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.62rem', color: fleetInfo.is_free_move ? 'var(--green)' : 'var(--text-dim)' }}>
                    {fleetInfo.is_free_move ? '✓' : '✗'} Free Move
                  </span>
                  <span style={{ fontSize: '0.62rem', color: fleetInfo.is_registered ? 'var(--green)' : 'var(--text-dim)' }}>
                    {fleetInfo.is_registered ? '✓' : '✗'} Registered
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Fleet-beheer (alleen FC) */}
          {canManage && (
            <div style={{ background: 'var(--surface)', border: '1px solid rgba(0,180,216,0.4)', borderRadius: 3, padding: '0.85rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.12em' }}>⚑ FLEET-BEHEER (FC)</span>
                {msg && <span style={{ fontSize: '0.62rem', color: /mislukt|niet gevonden|Geen squad/i.test(msg) ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
              </div>

              {!hasFleetWrite && (
                <div style={{ background: 'rgba(240,192,64,0.08)', border: '1px solid rgba(240,192,64,0.35)', borderRadius: 3, padding: '0.55rem 0.75rem', marginBottom: '0.7rem', fontSize: '0.7rem', color: 'var(--gold)', lineHeight: 1.5 }}>
                  ⚠ Je huidige login mist de <strong>fleet-beheer-rechten</strong> (esi-fleets.write_fleet). Uitnodigen, kicken en MOTD wijzigen werken daardoor niet.
                  {' '}Los het op: ga in de zijbalk naar je account → <strong>verwijder dit account</strong> en log opnieuw in (dan worden de nieuwe rechten verleend).
                </div>
              )}

              {/* MOTD bewerken */}
              <div style={{ marginBottom: '0.7rem' }}>
                {editingMotd ? (
                  <>
                    <textarea value={motdDraft} onChange={e => setMotdDraft(e.target.value)} rows={3}
                      placeholder="Fleet MOTD…"
                      style={{ width: '100%', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.75rem', padding: '0.5rem', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }} />
                    <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                      <button onClick={() => { saveMotd(); setEditingMotd(false) }} disabled={busy} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.7rem', fontWeight: 600, padding: '0.3rem 0.8rem', cursor: 'pointer' }}>MOTD opslaan</button>
                      <button onClick={() => setEditingMotd(false)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.7rem', padding: '0.3rem 0.8rem', cursor: 'pointer' }}>Annuleren</button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => { setMotdDraft((fleetInfo?.motd ?? '').replace(/<[^>]+>/g, '')); setEditingMotd(true) }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.7rem', padding: '0.3rem 0.8rem', cursor: 'pointer' }}>✎ MOTD bewerken</button>
                )}
              </div>

              {/* Free move + uitnodigen */}
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={toggleFreeMove} disabled={busy} style={{
                  fontSize: '0.7rem', fontWeight: 600, padding: '0.3rem 0.8rem', borderRadius: 3, cursor: 'pointer',
                  background: fleetInfo?.is_free_move ? 'rgba(62,207,110,0.12)' : 'transparent',
                  border: `1px solid ${fleetInfo?.is_free_move ? 'var(--green)' : 'var(--border)'}`,
                  color: fleetInfo?.is_free_move ? 'var(--green)' : 'var(--text-dim)',
                }}>Free Move: {fleetInfo?.is_free_move ? 'AAN' : 'UIT'}</button>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                  <textarea value={inviteName} onChange={e => setInviteName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doInvite() }}
                    placeholder="Karakternaam(en) uitnodigen — één per regel of komma-gescheiden"
                    rows={2}
                    style={{ width: 300, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem', outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                  <button onClick={doInvite} disabled={busy} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.7rem', fontWeight: 600, padding: '0.35rem 0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>Uitnodigen</button>
                </div>
              </div>
            </div>
          )}

          {/* MOTD */}
          {fleetInfo?.motd && fleetInfo.motd.trim() && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '3px solid var(--blue)', borderRadius: 3, padding: '0.6rem 1rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem' }}>MOTD</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
                dangerouslySetInnerHTML={{ __html: sanitizeMotd(fleetInfo.motd) }} />
            </div>
          )}

          {/* Wing structuur */}
          {(wings.length > 0 || canManage) && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>WING / SQUAD STRUCTUUR</span>
                {canManage && (
                  <button onClick={addWing} disabled={busy} title="Wing toevoegen"
                    style={{ background: 'transparent', border: '1px dashed var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.62rem', padding: '0.2rem 0.55rem', cursor: 'pointer' }}>+ Wing</button>
                )}
              </div>
              {wings.length === 0 ? (
                <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>Nog geen wings — voeg er één toe om leden te kunnen indelen/uitnodigen.</div>
              ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {wings.map(w => {
                  const wingMembers = members.filter(m => m.wing_id === w.id)
                  return (
                    <div key={w.id}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                        <span style={{ fontSize: '0.68rem', color: 'var(--blue)', fontWeight: 600 }}>◈ {w.name}</span>
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{wingMembers.length} leden</span>
                        {canManage && (
                          <span style={{ display: 'inline-flex', gap: '0.3rem' }}>
                            <button onClick={() => addSquad(w.id)} disabled={busy} title="Squad toevoegen" style={miniBtn}>+ squad</button>
                            <button onClick={() => renameWing(w.id, w.name)} disabled={busy} title="Wing hernoemen" style={miniBtn}>✎</button>
                            <button onClick={() => delWing(w.id, w.name)} disabled={busy} title="Wing verwijderen" style={miniBtnRed}>✕</button>
                          </span>
                        )}
                      </div>
                      {w.squads.map(s => {
                        const squadMembers = members.filter(m => m.squad_id === s.id)
                        return (
                          <div key={s.id} style={{ marginLeft: '1rem', marginBottom: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                              └ {s.name} <span style={{ color: 'var(--border)' }}>({squadMembers.length})</span>
                            </span>
                            {canManage && (
                              <span style={{ display: 'inline-flex', gap: '0.3rem' }}>
                                <button onClick={() => renameSquad(s.id, s.name)} disabled={busy} title="Squad hernoemen" style={miniBtn}>✎</button>
                                <button onClick={() => delSquad(s.id, s.name)} disabled={busy} title="Squad verwijderen" style={miniBtnRed}>✕</button>
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
              )}
            </div>
          )}

          {/* Intel-status — altijd zichtbaar in fleet, zodat je weet of de kaart intel heeft */}
          {(() => {
            const nIntel = Object.values(intel).filter(i => i.threat !== 'clear').length
            if (intelStatus === 'unsupported') {
              return <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>📡 Intel op de kaart vereist Chrome of Edge.</div>
            }
            if (intelStatus === 'live') {
              const list = Object.values(intel)
                .filter(i => i.threat !== 'clear')
                .sort((a, b) => b.time - a.time)
              // Geen kanaalbestanden gevonden → toon welke kanalen er wél in de map staan.
              if (intelDebug.files === 0) {
                return <div style={{ fontSize: '0.66rem', color: 'var(--gold)', padding: '0.5rem 0.7rem', background: 'rgba(240,192,64,0.07)', border: '1px solid rgba(240,192,64,0.3)', borderRadius: 3, lineHeight: 1.6 }}>
                  📡 Geen van je ingestelde intel-kanalen gevonden in de map. Zet de juiste in <strong>Admin → 📡 Intel-kanalen</strong>.
                  {intelDebug.available.length > 0 ? (
                    <div style={{ marginTop: '0.35rem', color: 'var(--text-dim)' }}>
                      Kanalen in je map: {intelDebug.available.map(c => (
                        <code key={c} style={{ background: '#05050e', border: '1px solid var(--border)', borderRadius: 2, padding: '0.05rem 0.3rem', margin: '0 0.15rem', color: 'var(--text)' }}>{c}</code>
                      ))}
                    </div>
                  ) : <div style={{ marginTop: '0.35rem', color: 'var(--text-dim)' }}>Geen chatlog-bestanden in deze map — je hebt waarschijnlijk de verkeerde map gekoppeld.</div>}
                  <button onClick={chooseIntelFolder} style={{ marginTop: '0.45rem', background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.66rem', fontWeight: 600, padding: '0.3rem 0.7rem', cursor: 'pointer' }}>
                    📁 Kies je <code>…\EVE\logs\Chatlogs\</code>-map opnieuw
                  </button>
                </div>
              }
              return <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', padding: '0.4rem 0.6rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
                <span style={{ color: nIntel ? 'var(--red)' : 'var(--text-dim)', fontWeight: 600 }}>
                  📡 Intel {nIntel ? `(${nIntel})` : '— geen recente meldingen'}
                </span>
                {list.map(i => {
                  const mins = Math.floor((Date.now() - i.time) / 60000)
                  return (
                    <span key={i.system} title={i.entries[0]?.message}
                      style={{ background: i.threat === 'threat' ? 'rgba(224,85,85,0.15)' : 'rgba(240,160,48,0.15)', color: i.threat === 'threat' ? 'var(--red)' : '#f0a030', border: `1px solid ${i.threat === 'threat' ? 'rgba(224,85,85,0.4)' : 'rgba(240,160,48,0.4)'}`, borderRadius: 3, padding: '0.1rem 0.4rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {i.system}{i.count > 0 ? ` ${i.count}+` : ''} <span style={{ opacity: 0.6, fontWeight: 400 }}>{mins}m</span>
                    </span>
                  )
                })}
                <span style={{ marginLeft: 'auto', fontSize: '0.55rem', opacity: 0.6 }}>
                  {intelDebug.files} bestand(en) · {intelDebug.entries} regels
                </span>
              </div>
            }
            return <button onClick={connectIntel} style={{ textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, color: 'var(--blue)', padding: '0.45rem 0.7rem', background: 'rgba(0,180,216,0.1)', border: '1px solid var(--blue)', borderRadius: 3, cursor: 'pointer' }}>
              📡 {intelStatus === 'denied' ? 'Klik om intel-chatlogs te herverbinden' : 'Klik om je Chatlogs-map te koppelen — intel op de kaart'}
            </button>
          })()}

          {/* Ledenlijst, kaart of foutmelding */}
          {accessError ? (
            <div style={{ background: 'rgba(240,192,64,0.06)', border: '1px solid rgba(240,192,64,0.25)', borderRadius: 3, padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--gold)' }}>
              {accessError}
            </div>
          ) : view === 'map' ? (
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* Per-systeem overzicht — compact, links */}
              <div style={{ flex: '0 0 270px', maxWidth: 300, maxHeight: 760, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
                {fleetMap.memberNodes.map(n => (
                  <div key={n.sid} style={{ padding: '0.4rem 0.6rem', borderBottom: '1px solid rgba(28,28,53,0.5)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: secColor(n.sec), width: 26, textAlign: 'right', flexShrink: 0 }}>{(Math.round(n.sec * 10) / 10).toFixed(1)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <SolarSystem name={n.name} systemId={n.sid} fontSize="0.72rem" />
                        <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)' }}>{n.region}{n.jumps != null ? ` · ${n.jumps === 0 ? 'FC' : `${n.jumps}j`}` : ''}</div>
                      </div>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', flexShrink: 0 }}>{n.members.length}×</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.2rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                      {n.members.map(m => (
                        <span key={m.character_id} title={`${m.characterName} — ${m.shipName}`} style={{ display: 'inline-flex', flexShrink: 0 }}>
                          <EveImage category="characters" id={m.character_id} variation="portrait" size={32} px={20} round />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {/* Kaart — direct naast de card, begrensd zodat 'ie niet enorm wordt */}
              <div style={{ flex: 1, minWidth: 320, maxWidth: 860 }}>
                <ClusterMap coords={coords} sysMeta={sysMeta} regionMap={regionMap} adj={adj} memberNodes={fleetMap.memberNodes} bridges={siteBridges} intel={intel} intelStatus={intelStatus} />
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* Live-kaart ook op de Leden-tab — naast de ledentabel */}
              {Object.keys(coords).length > 0 && fleetMap.memberNodes.length > 0 && (
                <div style={{ flex: '1 1 480px', minWidth: 320, maxWidth: 760 }}>
                  <ClusterMap coords={coords} sysMeta={sysMeta} regionMap={regionMap} adj={adj} memberNodes={fleetMap.memberNodes} bridges={siteBridges} intel={intel} intelStatus={intelStatus} />
                </div>
              )}
              <div style={{ flex: '1 1 380px', minWidth: 300, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: memberCols, gap: '0.5rem' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>KARAKTER</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>SHIP</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>LOCATIE</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>ROL</span>
                {canManage && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>ACTIES</span>}
              </div>
              {members.map(m => {
                const isMe = m.character_id === fleetToken?.characterId
                return (
                  <div
                    key={m.character_id}
                    style={{
                      display: 'grid', gridTemplateColumns: memberCols,
                      gap: '0.5rem', alignItems: 'center',
                      padding: '0.45rem 1rem',
                      borderBottom: '1px solid rgba(28,28,53,0.5)',
                      background: isMe ? 'rgba(0,180,216,0.04)' : 'transparent',
                      borderLeft: isMe ? '2px solid var(--blue)' : '2px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                      <EveImage category="characters" id={m.character_id} variation="portrait" size={32} px={22} round
                        style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '0.72rem', fontWeight: isMe ? 600 : 400, color: isMe ? 'var(--blue)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.characterName}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 }}>
                      <EveImage category="types" id={m.ship_type_id} variation="icon" size={32} px={20} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.shipName}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.65rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <SolarSystem name={m.systemName} systemId={m.solar_system_id} fontSize="0.65rem" />
                    </div>
                    <RoleBadge role={m.role} />
                    {canManage && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'flex-end' }}>
                        {squadOptions.length > 0 && (
                          <select
                            value="-1"
                            onChange={e => { const i = Number(e.target.value); if (i >= 0) moveTo(m.character_id, squadOptions[i]) }}
                            disabled={busy}
                            title="Verplaats naar squad"
                            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', fontSize: '0.6rem', padding: '0.15rem 0.2rem', maxWidth: 110, cursor: 'pointer', outline: 'none' }}
                          >
                            <option value="-1">Verplaats…</option>
                            {squadOptions.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
                          </select>
                        )}
                        {!isMe && (
                          <button onClick={() => kick(m.character_id, m.characterName)} disabled={busy} title="Uit fleet verwijderen"
                            style={{ background: 'transparent', border: '1px solid rgba(224,85,85,0.4)', borderRadius: 2, color: 'var(--red)', fontSize: '0.7rem', lineHeight: 1, padding: '0.15rem 0.4rem', cursor: 'pointer', flexShrink: 0 }}>✕</button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              </div>
            </div>
          )}

          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textAlign: 'right' }}>
            Ververst elke 15 seconden
          </div>
        </div>
      )}
    </Layout>
  )
}

// ── Contextmenu-onderdelen (rechtsklik op de kaart) ──
const ctxRow: React.CSSProperties = { padding: '0.4rem 0.7rem', cursor: 'pointer', color: 'var(--text)', whiteSpace: 'nowrap' }
function CtxItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <div onClick={onClick} style={ctxRow}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,180,216,0.12)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>{children}</div>
  )
}
function CtxLink({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ ...ctxRow, display: 'block', textDecoration: 'none' }}
      onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(0,180,216,0.12)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent' }}>{children}</a>
  )
}
