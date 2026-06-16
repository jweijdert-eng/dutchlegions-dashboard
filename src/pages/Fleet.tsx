import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getCharacterFleet, getFleetInfo, getFleetMembers, getFleetWings,
  resolveNames, setFleetSettings, kickFleetMember, moveFleetMember, inviteFleetMember, resolveCharacterIds,
  createFleetWing, renameFleetWing, deleteFleetWing, createFleetSquad, renameFleetSquad, deleteFleetSquad,
  getSystems, getRegions, getSystemCoords, getSystemJumps,
  type CharacterFleet, type FleetInfo, type FleetMember, type FleetWing,
} from '../api/esi'
import { secColor } from '../utils/secColor'
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

// New Eden cluster-kaart: alle systemen als dots (canvas), fleet-leden + regio-namen
// als overlay (SVG). Interactief: slepen = pannen, scrollen = zoomen.
function ClusterMap({ coords, sysMeta, regionMap, adj, memberNodes }: {
  coords: Record<string, [number, number]>
  sysMeta: Record<string, [string, number, number]>
  regionMap: Record<string, string>
  adj: Record<string, number[]>
  memberNodes: MemberNode[]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Staand canvas — New Eden is hoger (z-span) dan breed (x-span), net als de echte cluster-map.
  const W = 660, H = 760, PAD = 30
  const [tf, setTf] = useState({ k: 1, x: 0, y: 0 })
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
  }, [coords, sysMeta, adj, base, tf])

  // Auto-zoom: éénmalig inzoomen op de FC zodra coords + leden geladen zijn.
  useEffect(() => {
    if (didAuto.current || !base) return
    const fc = memberNodes.find(n => n.isFc) ?? memberNodes[0]
    const c = fc && coords[String(fc.sid)]
    if (!c) return
    didAuto.current = true
    const k = 6
    const [bx, by] = base(c[0], c[1])
    setTf({ k, x: W / 2 - bx * k, y: H / 2 - by * k })
  }, [base, memberNodes, coords])

  if (!base) {
    return <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>Kaart laden…</div>
  }
  const maxCount = Math.max(...memberNodes.map(n => n.members.length), 1)

  // Muis → interne kaart-coördinaten (CSS-schaal compenseren).
  const toLocal = (clientX: number, clientY: number): [number, number] => {
    const r = wrapRef.current!.getBoundingClientRect()
    return [(clientX - r.left) * (W / r.width), (clientY - r.top) * (H / r.height)]
  }
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const [mx, my] = toLocal(e.clientX, e.clientY)
    const f = e.deltaY < 0 ? 1.18 : 1 / 1.18
    setTf(t => {
      const k = Math.max(0.8, Math.min(16, t.k * f))
      const fr = k / t.k
      return { k, x: mx - (mx - t.x) * fr, y: my - (my - t.y) * fr }
    })
  }
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

  return (
    <div ref={wrapRef} onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={endDrag} onMouseLeave={endDrag}
      style={{ position: 'relative', background: '#05050e', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}>
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
          const [x, y] = screen(c[0], c[1])
          if (x < 4 || x > W - 4 || y < 8 || y > H - 2) return null
          const name = sysMeta[sid]?.[0]; if (!name) return null
          return <text key={sid} x={x + 3} y={y - 3} fontSize={5} fill="rgba(225,228,240,0.8)" stroke="#05050e" strokeWidth={0.35} paintOrder="stroke">{name}</text>
        })}
        {/* Fleet-leden — groene ring + aantal (zoals de in-game map) */}
        {memberNodes.map(n => {
          const c = coords[String(n.sid)]
          if (!c) return null
          const [x, y] = screen(c[0], c[1])
          const r = 3 + (n.members.length / maxCount) * 4
          return (
            <g key={n.sid}>
              <circle cx={x} cy={y} r={r + 4} fill="#3ecf6e" fillOpacity={0.12} />
              <circle cx={x} cy={y} r={r + 1.5} fill="none" stroke="#3ecf6e" strokeWidth={1.4} />
              {n.isFc && <circle cx={x} cy={y} r={r + 4} fill="none" stroke="#f0c040" strokeWidth={1} strokeDasharray="3 2" />}
              <circle cx={x} cy={y} r={r} fill={secColor(n.sec)} stroke="#05050e" strokeWidth={0.8} />
              <text x={x} y={y + 2.6} textAnchor="middle" fontSize={Math.min(9, r + 1.5)} fontWeight={700} fill="#05050e">{n.members.length}</text>
              <text x={x + r + 4} y={y + 2.5} fontSize={6.5} fontWeight={700} fill="#fff" stroke="#05050e" strokeWidth={0.55} paintOrder="stroke">
                {n.name}{n.jumps != null && n.jumps > 0 ? ` · ${n.jumps}j` : n.isFc ? ' · FC' : ''}
              </text>
            </g>
          )
        })}
      </svg>
      {/* Zoom-knoppen */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[['+', 1.4], ['−', 1 / 1.4]].map(([lbl, f]) => (
          <button key={lbl as string} onClick={() => setTf(t => ({ ...t, k: Math.max(0.8, Math.min(16, t.k * (f as number))) }))}
            style={{ width: 26, height: 26, background: 'rgba(11,11,26,0.85)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}>{lbl}</button>
        ))}
        <button onClick={() => {
          const fc = memberNodes.find(n => n.isFc) ?? memberNodes[0]
          const c = fc && coords[String(fc.sid)]
          if (!c) { setTf({ k: 1, x: 0, y: 0 }); return }
          const k = 6, [bx, by] = base(c[0], c[1])
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
      <div style={{ position: 'absolute', bottom: 6, left: 8, fontSize: '0.58rem', color: 'rgba(150,165,210,0.5)' }}>sleep = pan · scroll = zoom</div>
    </div>
  )
}

export default function Fleet() {
  // Álle accounts, niet alleen de geselecteerde — je kunt met een ander character in fleet zitten.
  const { tokens } = useAuth()

  const [charFleet, setCharFleet]     = useState<CharacterFleet | null>(null)
  const [fleetInfo, setFleetInfo]     = useState<FleetInfo | null>(null)
  const [members, setMembers]         = useState<ResolvedMember[]>([])
  const [wings, setWings]             = useState<FleetWing[]>([])
  const [loading, setLoading]         = useState(true)
  const [notInFleet, setNotInFleet]   = useState(false)
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

  // Pas de zware kaart-bundels alleen laden als de kaart geopend wordt.
  useEffect(() => {
    if (view !== 'map') return
    getSystemCoords().then(setCoords).catch(() => {})
    getSystemJumps().then(setAdj).catch(() => {})
    getSystems().then(setSysMeta).catch(() => {})
    getRegions().then(setRegionMap).catch(() => {})
  }, [view])

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
  const toggleFreeMove = () => withBusy(() => setFleetSettings(charFleet!.fleet_id, fleetToken!.accessToken, { is_free_move: !fleetInfo?.is_free_move }), 'Free Move gewijzigd')
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
              {/* Kaart — rechts, begrensd zodat 'ie niet enorm wordt */}
              <div style={{ flex: 1, minWidth: 320, maxWidth: 560 }}>
                <ClusterMap coords={coords} sysMeta={sysMeta} regionMap={regionMap} adj={adj} memberNodes={fleetMap.memberNodes} />
              </div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
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
          )}

          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textAlign: 'right' }}>
            Ververst elke 15 seconden
          </div>
        </div>
      )}
    </Layout>
  )
}
