import { useState, useEffect, useRef } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import SolarSystem from '../components/SolarSystem'
import { useAuth } from '../auth/AuthContext'

interface JumpBridge {
  id: string
  systemA: string
  systemB: string
  label: string
  online: boolean
}

interface RouteResult {
  systems: string[]
  bridgeSet: Set<string>   // system names that are bridge-hop endpoints in this route
  jumps: number
  bridgeJumps: number
}

// ─── ESI routing ─────────────────────────────────────────────────────────────

async function resolveIds(names: string[]): Promise<Map<string, number>> {
  if (!names.length) return new Map()
  const res = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(names),
  })
  if (!res.ok) throw new Error(`ESI ids: ${res.status}`)
  const data = await res.json() as { solar_systems?: { id: number; name: string }[] }
  return new Map((data.solar_systems ?? []).map(s => [s.name.toLowerCase(), s.id]))
}

async function resolveNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map()
  const res = await fetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids),
  })
  if (!res.ok) throw new Error(`ESI names: ${res.status}`)
  const data = await res.json() as { id: number; name: string }[]
  return new Map(data.map(d => [d.id, d.name]))
}

async function calcSmartRoute(bridges: JumpBridge[], from: string, to: string): Promise<RouteResult | 'none'> {
  const online = bridges.filter(b => b.online)
  const allNames = [...new Set([from, to, ...online.flatMap(b => [b.systemA, b.systemB])])]
  const nameToId = await resolveIds(allNames)

  const originId = nameToId.get(from.toLowerCase())
  const destId   = nameToId.get(to.toLowerCase())
  if (!originId) throw new Error(`Systeem niet gevonden: "${from}"`)
  if (!destId)   throw new Error(`Systeem niet gevonden: "${to}"`)

  // Build bridge connections list and lookup set
  const connections: [number, number][] = []
  const bridgePairs = new Set<string>()
  for (const b of online) {
    const aId = nameToId.get(b.systemA.toLowerCase())
    const bId = nameToId.get(b.systemB.toLowerCase())
    if (!aId || !bId) continue
    connections.push([aId, bId], [bId, aId])
    bridgePairs.add(`${aId},${bId}`)
    bridgePairs.add(`${bId},${aId}`)
  }

  const params = new URLSearchParams({ datasource: 'tranquility', flag: 'shortest' })
  for (const [a, b] of connections) params.append('connections', `${a},${b}`)

  const res = await fetch(`https://esi.evetech.net/latest/route/${originId}/${destId}/?${params}`)
  if (res.status === 404) return 'none'
  if (!res.ok) throw new Error(`ESI route: ${res.status}`)

  const routeIds: number[] = await res.json()
  const idToName = await resolveNames(routeIds)
  const systems  = routeIds.map(id => idToName.get(id) ?? String(id))

  // Determine which hops used a bridge
  const bridgeSet = new Set<string>()
  let bridgeJumps = 0
  for (let i = 0; i < routeIds.length - 1; i++) {
    if (bridgePairs.has(`${routeIds[i]},${routeIds[i + 1]}`)) {
      bridgeSet.add(systems[i])
      bridgeSet.add(systems[i + 1])
      bridgeJumps++
    }
  }

  return { systems, bridgeSet, jumps: systems.length - 1, bridgeJumps }
}

// ─── Lokale bridge-only BFS (fallback) ───────────────────────────────────────

function bfsBridgeOnly(bridges: JumpBridge[], from: string, to: string): string[] | null {
  const fromL = from.trim().toLowerCase(), toL = to.trim().toLowerCase()
  if (fromL === toL) return [from]
  const adj = new Map<string, string[]>()
  const add = (a: string, b: string) => { const k = a.toLowerCase(); if (!adj.has(k)) adj.set(k, []); adj.get(k)!.push(b) }
  for (const b of bridges.filter(b => b.online)) { add(b.systemA, b.systemB); add(b.systemB, b.systemA) }
  const queue: string[][] = [[from]], visited = new Set([fromL])
  while (queue.length) {
    const path = queue.shift()!
    for (const nb of adj.get(path[path.length - 1].toLowerCase()) ?? []) {
      const nL = nb.toLowerCase()
      if (nL === toL) return [...path, nb]
      if (!visited.has(nL)) { visited.add(nL); queue.push([...path, nb]) }
    }
  }
  return null
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseBridges(text: string): Omit<JumpBridge, 'online'>[] {
  const results: Omit<JumpBridge, 'online'>[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line) continue
    const label = line.match(/\(([^)]+)\)/)?.[1] ?? ''
    const clean = line.replace(/\(.*?\)/g, '').replace(/\s*[-–—]\s*ansiblex.*$/i, '').replace(/:.*/g, '').trim()
    // Splits op pijl/pipe-scheiders (GEEN kaal koppelteken — nullsec-namen als 5T-KM3
    // bevatten koppeltekens). Fallback: dash/pijl mét spaties eromheen ("Jita - Amarr").
    let parts = clean.split(/\s*(?:»|›|→|↔|<->|->|=>|\||\t|,|;)\s*/).filter(Boolean)
    if (parts.length < 2) parts = clean.split(/\s+(?:[-–—>])\s+/).filter(Boolean)
    if (parts.length < 2) continue
    const systemA = parts[0].trim(), systemB = parts[1].trim()
    if (!systemA || !systemB || systemA.toLowerCase() === systemB.toLowerCase()) continue
    // Ongerichte dedup: A»B en B»A zijn dezelfde bridge (lijst staat vaak heen én terug).
    const id = [systemA.toLowerCase(), systemB.toLowerCase()].sort().join('|')
    if (seen.has(id)) continue
    seen.add(id); results.push({ id, systemA, systemB, label })
  }
  return results
}

// ─── Force-directed map ───────────────────────────────────────────────────────

const VW = 820, VH = 460, NR = 7
interface Vec2 { x: number; y: number }

function isRouteEdge(route: string[], a: string, b: string): boolean {
  const aL = a.toLowerCase(), bL = b.toLowerCase()
  for (let i = 0; i < route.length - 1; i++) {
    const r0 = route[i].toLowerCase(), r1 = route[i + 1].toLowerCase()
    if ((r0 === aL && r1 === bL) || (r0 === bL && r1 === aL)) return true
  }
  return false
}

function BridgeMap({ bridges, routeResult, onNodeClick }: {
  bridges: JumpBridge[]
  routeResult: RouteResult | null
  onNodeClick: (sys: string) => void
}) {
  const posRef    = useRef<Map<string, Vec2>>(new Map())
  const velRef    = useRef<Map<string, Vec2>>(new Map())
  const pinnedRef = useRef<string | null>(null)
  const dragRef   = useRef<{ id: string; ox: number; oy: number } | null>(null)
  const svgRef    = useRef<SVGSVGElement>(null)
  const frameRef  = useRef(0)
  const [, setTick] = useState(0)
  const [simVer, setSimVer] = useState(0)

  const nodes   = [...new Set(bridges.flatMap(b => [b.systemA, b.systemB]))]
  const nodeKey = nodes.slice().sort().join(',')
  const edgeKey = bridges.map(b => `${b.systemA}|${b.systemB}`).sort().join(',')
  const route   = routeResult?.systems ?? []
  const bridgeSet = routeResult?.bridgeSet ?? new Set<string>()
  const routeSet  = new Set(route.map(s => s.toLowerCase()))

  useEffect(() => {
    const pos = posRef.current, vel = velRef.current
    const set = new Set(nodes)
    for (const id of [...pos.keys()]) if (!set.has(id)) { pos.delete(id); vel.delete(id) }
    nodes.forEach((id, i) => {
      if (!pos.has(id)) {
        const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI
        pos.set(id, { x: VW / 2 + Math.cos(angle) * VW * 0.3, y: VH / 2 + Math.sin(angle) * VH * 0.3 })
        vel.set(id, { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2 })
      }
    })
  }, [nodeKey])

  useEffect(() => {
    if (!nodes.length) return
    let alive = true
    function step() {
      if (!alive) return
      const pos = posRef.current, vel = velRef.current
      let ke = 0
      const fx = new Map<string, number>(), fy = new Map<string, number>()
      for (const id of nodes) { fx.set(id, 0); fy.set(id, 0) }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i]), b = pos.get(nodes[j]); if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y, d2 = Math.max(dx * dx + dy * dy, 400), d = Math.sqrt(d2), f = 8000 / d2
        fx.set(nodes[i], fx.get(nodes[i])! - f * dx / d); fy.set(nodes[i], fy.get(nodes[i])! - f * dy / d)
        fx.set(nodes[j], fx.get(nodes[j])! + f * dx / d); fy.set(nodes[j], fy.get(nodes[j])! + f * dy / d)
      }
      for (const b of bridges) {
        const pa = pos.get(b.systemA), pb = pos.get(b.systemB); if (!pa || !pb) continue
        const dx = pb.x - pa.x, dy = pb.y - pa.y, d = Math.max(Math.sqrt(dx * dx + dy * dy), 1), f = (d - 120) * 0.04
        fx.set(b.systemA, (fx.get(b.systemA) ?? 0) + f * dx / d); fy.set(b.systemA, (fy.get(b.systemA) ?? 0) + f * dy / d)
        fx.set(b.systemB, (fx.get(b.systemB) ?? 0) - f * dx / d); fy.set(b.systemB, (fy.get(b.systemB) ?? 0) - f * dy / d)
      }
      for (const id of nodes) {
        const p = pos.get(id); if (!p) continue
        fx.set(id, fx.get(id)! + (VW / 2 - p.x) * 0.015); fy.set(id, fy.get(id)! + (VH / 2 - p.y) * 0.015)
      }
      for (const id of nodes) {
        if (pinnedRef.current === id) continue
        const p = pos.get(id), v = vel.get(id); if (!p || !v) continue
        const nvx = (v.x + (fx.get(id) ?? 0)) * 0.73, nvy = (v.y + (fy.get(id) ?? 0)) * 0.73
        vel.set(id, { x: nvx, y: nvy }); ke += nvx * nvx + nvy * nvy
        pos.set(id, { x: Math.max(NR + 4, Math.min(VW - NR - 4, p.x + nvx)), y: Math.max(NR + 14, Math.min(VH - NR - 4, p.y + nvy)) })
      }
      setTick(t => t + 1)
      if (ke > 0.4) frameRef.current = requestAnimationFrame(step)
    }
    cancelAnimationFrame(frameRef.current); frameRef.current = requestAnimationFrame(step)
    return () => { alive = false; cancelAnimationFrame(frameRef.current) }
  }, [nodeKey, edgeKey, simVer])

  function svgPt(clientX: number, clientY: number): Vec2 {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / r.width * VW, y: (clientY - r.top) / r.height * VH }
  }

  function onNodeMouseDown(e: React.MouseEvent, id: string) {
    e.preventDefault(); pinnedRef.current = id
    const { x, y } = svgPt(e.clientX, e.clientY), p = posRef.current.get(id)!
    dragRef.current = { id, ox: x - p.x, oy: y - p.y }
  }

  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!dragRef.current) return
    const { id, ox, oy } = dragRef.current, { x, y } = svgPt(e.clientX, e.clientY)
    posRef.current.set(id, { x: Math.max(NR + 4, Math.min(VW - NR - 4, x - ox)), y: Math.max(NR + 14, Math.min(VH - NR - 4, y - oy)) })
    velRef.current.set(id, { x: 0, y: 0 }); setTick(t => t + 1)
  }

  function onSvgMouseUp() {
    if (!dragRef.current) return
    pinnedRef.current = null; dragRef.current = null; setSimVer(v => v + 1)
  }

  return (
    <div style={{ position: 'relative', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
      <button onClick={() => {
        nodes.forEach((id, i) => {
          const angle = (i / Math.max(nodes.length, 1)) * 2 * Math.PI
          posRef.current.set(id, { x: VW / 2 + Math.cos(angle) * VW * 0.3, y: VH / 2 + Math.sin(angle) * VH * 0.3 })
          velRef.current.set(id, { x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3 })
        }); setSimVer(v => v + 1)
      }} title="Layout opnieuw" style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, padding: '0.2rem 0.5rem', borderRadius: 2, fontSize: '0.6rem', cursor: 'pointer', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>↺ Reset</button>

      <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} style={{ width: '100%', display: 'block' }}
        onMouseMove={onSvgMouseMove} onMouseUp={onSvgMouseUp} onMouseLeave={onSvgMouseUp}>
        {bridges.map(b => {
          const pa = posRef.current.get(b.systemA), pb = posRef.current.get(b.systemB); if (!pa || !pb) return null
          const inRoute = route.length > 1 && isRouteEdge(route, b.systemA, b.systemB)
          return <line key={b.id} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
            stroke={inRoute ? '#00b4d8' : b.online ? 'rgba(62,207,110,0.35)' : 'rgba(224,85,85,0.2)'}
            strokeWidth={inRoute ? 2.5 : 1.2} strokeDasharray={b.online ? undefined : '5,4'} />
        })}
        {nodes.map(id => {
          const p = posRef.current.get(id); if (!p) return null
          const inRoute = routeSet.has(id.toLowerCase())
          const isBridgeHop = bridgeSet.has(id)
          const isEndpoint = route[0]?.toLowerCase() === id.toLowerCase() || route[route.length - 1]?.toLowerCase() === id.toLowerCase()
          return (
            <g key={id} style={{ cursor: 'grab' }} onMouseDown={ev => onNodeMouseDown(ev, id)} onClick={() => !dragRef.current && onNodeClick(id)}>
              <circle cx={p.x} cy={p.y} r={NR + 5} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={NR}
                fill={isEndpoint ? 'var(--blue)' : isBridgeHop ? 'rgba(0,180,216,0.4)' : inRoute ? 'rgba(0,180,216,0.2)' : 'rgba(0,180,216,0.12)'}
                stroke={inRoute ? '#00b4d8' : 'rgba(0,180,216,0.5)'} strokeWidth={1.5} />
              <text x={p.x} y={p.y + NR + 11} textAnchor="middle"
                fill={inRoute ? '#7dd3fc' : 'var(--text-dim)'} fontSize={9}
                style={{ userSelect: 'none', pointerEvents: 'none', fontFamily: 'inherit' }}>{id}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── Opslag ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'eve_jumpbridges'
function loadBridges(): JumpBridge[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}
// Gedeeld op de server opgeslagen als [A, B]-paren → naar het lokale JumpBridge-model.
function pairToBridge([a, b]: [string, string]): JumpBridge {
  const A = String(a).toUpperCase(), B = String(b).toUpperCase()
  return { id: [A, B].sort().join('|'), systemA: A, systemB: B, label: '', online: true }
}

// ─── Hoofdpagina ──────────────────────────────────────────────────────────────

export default function JumpBridges() {
  const [bridges,     setBridges]     = useState<JumpBridge[]>(loadBridges)
  const [importText,  setImportText]  = useState('')
  const [showImport,  setShowImport]  = useState(() => loadBridges().length === 0)
  const [routeFrom,   setRouteFrom]   = useState('')
  const [routeTo,     setRouteTo]     = useState('')
  const [routeResult, setRouteResult] = useState<RouteResult | 'none' | null>(null)
  const [routeError,  setRouteError]  = useState<string | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [search,      setSearch]      = useState('')
  const [view,        setView]        = useState<'list' | 'map'>('list')
  const [copied,      setCopied]      = useState(false)
  const [saveState,   setSaveState]   = useState<'idle' | 'saving' | 'done'>('idle')

  const { activeTokens, mainCharId } = useAuth()
  const token = (activeTokens.find(t => t.characterId === mainCharId) ?? activeTokens[0])?.accessToken

  // De gedeelde (corp-brede) lijst van de server laden — die de admin/leden bijwerken.
  useEffect(() => {
    fetch('/api/ansiblex.php', { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { bridges?: [string, string][] }) => {
        if (Array.isArray(d?.bridges) && d.bridges.length) {
          const bs = d.bridges.map(pairToBridge)
          setBridges(bs); localStorage.setItem(STORAGE_KEY, JSON.stringify(bs)); setShowImport(false)
        }
      })
      .catch(() => { /* offline → lokale cache blijft staan */ })
  }, [])

  // Opslaan: lokaal (cache) + gedeeld op de server (member-schrijfbaar endpoint).
  function save(next: JumpBridge[]) {
    setBridges(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    if (!token) return
    setSaveState('saving')
    fetch('/api/ansiblex.php', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, bridges: next.map(b => [b.systemA, b.systemB]) }) })
      .then(() => setSaveState('done')).catch(() => setSaveState('idle'))
      .finally(() => setTimeout(() => setSaveState('idle'), 1500))
  }

  // Hele lijst als "A » B"-tekst naar het klembord.
  function copyList() {
    const text = bridges.map(b => `${b.systemA} » ${b.systemB}`).join('\n')
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => {})
  }

  function doImport() {
    const parsed = parseBridges(importText); if (!parsed.length) return
    const existing = new Set(bridges.map(b => b.id))
    const fresh = parsed.filter(p => !existing.has(p.id)).map(p => ({ ...p, online: true }))
    save([...bridges, ...fresh]); setImportText(''); setShowImport(false)
  }

  // Vervang de hele lijst door de plaktekst (voor een geüpdatete Ansiblex-lijst).
  function doReplace() {
    const parsed = parseBridges(importText); if (!parsed.length) return
    save(parsed.map(p => ({ ...p, online: true })))
    setImportText(''); setShowImport(false)
  }

  async function calcRoute() {
    if (!routeFrom.trim() || !routeTo.trim()) return
    setRouteLoading(true); setRouteResult(null); setRouteError(null)
    try {
      const result = await calcSmartRoute(bridges, routeFrom.trim(), routeTo.trim())
      setRouteResult(result)
    } catch (e) {
      // Fallback: bridge-only
      const fallback = bfsBridgeOnly(bridges, routeFrom.trim(), routeTo.trim())
      if (fallback) {
        const bridgeSet = new Set(fallback.map(s => s))
        setRouteResult({ systems: fallback, bridgeSet, jumps: fallback.length - 1, bridgeJumps: fallback.length - 1 })
        setRouteError(`ESI niet bereikbaar, alleen bridge-route getoond.`)
      } else {
        setRouteResult('none')
      }
    } finally {
      setRouteLoading(false)
    }
  }

  function handleNodeClick(sys: string) {
    if (!routeFrom || routeFrom === sys) { setRouteFrom(sys); return }
    setRouteTo(sys); setRouteResult(null)
  }

  const currentRoute = Array.isArray(routeResult) ? [] : routeResult && routeResult !== 'none' ? routeResult.systems : []
  const onlineCount  = bridges.filter(b => b.online).length
  const filtered     = search
    ? bridges.filter(b => b.systemA.toLowerCase().includes(search.toLowerCase()) || b.systemB.toLowerCase().includes(search.toLowerCase()) || b.label.toLowerCase().includes(search.toLowerCase()))
    : bridges

  return (
    <Layout header={
      <PageHeader title="Jump Bridges" sub={`${bridges.length} bridges${saveState === 'saving' ? ' · opslaan…' : saveState === 'done' ? ' · opgeslagen ✓' : ' · gedeeld met de corp'}`}
        right={
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {(['list', 'map'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: 'pointer', background: view === v ? 'rgba(0,180,216,0.1)' : 'transparent', border: `1px solid ${view === v ? 'var(--blue)' : 'var(--border)'}`, color: view === v ? 'var(--blue)' : 'var(--text-dim)', textTransform: 'capitalize' }}>{v === 'list' ? 'Lijst' : 'Map'}</button>
            ))}
            <button onClick={copyList} disabled={bridges.length === 0} title="Kopieer alle bridges als tekst"
              style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: bridges.length ? 'pointer' : 'not-allowed', background: copied ? 'rgba(62,207,110,0.12)' : 'transparent', border: `1px solid ${copied ? 'var(--green)' : 'var(--border)'}`, color: copied ? 'var(--green)' : 'var(--text-dim)', opacity: bridges.length ? 1 : 0.5 }}>
              {copied ? '✓ Gekopieerd' : '📋 Kopiëren'}
            </button>
            <button onClick={() => setShowImport(s => !s)} style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: 'pointer', background: showImport ? 'rgba(0,180,216,0.1)' : 'transparent', border: `1px solid ${showImport ? 'var(--blue)' : 'var(--border)'}`, color: showImport ? 'var(--blue)' : 'var(--text-dim)' }}>✏️ Bijwerken</button>
          </div>
        }
      />
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

        {/* Import */}
        {showImport && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.4rem' }}>ANSIBLEX-LIJST BIJWERKEN</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.5rem', lineHeight: 1.5 }}>
              Plak de lijst — één per regel, bv.&nbsp;
              <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0.1rem 0.3rem', borderRadius: 2, fontSize: '0.62rem' }}>BKG-Q2 » 9F-7PZ</code>.
              Heen/terug (A»B én B»A) wordt automatisch samengevoegd. <b>Vervang alles</b> = de plaktekst wordt de complete lijst; <b>Toevoegen</b> houdt de bestaande erbij. Wijzigingen zijn <b>gedeeld met de hele corp</b>.
            </div>
            <textarea value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={'Jita » Amarr\nAmarr » Dodixie (Ansiblex Gate)\n...'} rows={6}
              style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.5rem', fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }} />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', justifyContent: 'flex-end', alignItems: 'center' }}>
              {importText.trim() && <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginRight: 'auto' }}>{parseBridges(importText).length} bridge(s) herkend</span>}
              <button onClick={() => { setShowImport(false); setImportText('') }} style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>Annuleren</button>
              <button onClick={doImport} disabled={!importText.trim()} style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: importText.trim() ? 'pointer' : 'not-allowed', background: 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.4)', color: 'var(--blue)', opacity: importText.trim() ? 1 : 0.5 }}>Toevoegen</button>
              <button onClick={doReplace} disabled={!importText.trim()} style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', fontWeight: 600, cursor: importText.trim() ? 'pointer' : 'not-allowed', background: 'rgba(62,207,110,0.12)', border: '1px solid var(--green)', color: 'var(--green)', opacity: importText.trim() ? 1 : 0.5 }}>Vervang alles</button>
            </div>
          </div>
        )}

        {/* Route planner */}
        {bridges.length > 0 && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.5rem' }}>
              ROUTE PLANNER
              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: '0.5rem', opacity: 0.6, fontSize: '0.58rem' }}>
                gates + jump bridges · elk systeem in EVE
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="text" placeholder="Van systeem..." value={routeFrom}
                onChange={e => { setRouteFrom(e.target.value); setRouteResult(null); setRouteError(null) }}
                onKeyDown={e => e.key === 'Enter' && calcRoute()}
                style={{ flex: 1, minWidth: 120, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.6rem', outline: 'none' }} />
              <span style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>»</span>
              <input type="text" placeholder="Naar systeem..." value={routeTo}
                onChange={e => { setRouteTo(e.target.value); setRouteResult(null); setRouteError(null) }}
                onKeyDown={e => e.key === 'Enter' && calcRoute()}
                style={{ flex: 1, minWidth: 120, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.6rem', outline: 'none' }} />
              <button onClick={calcRoute} disabled={routeLoading}
                style={{ padding: '0.3rem 0.65rem', borderRadius: 2, fontSize: '0.68rem', cursor: 'pointer', background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.35)', color: 'var(--blue)', whiteSpace: 'nowrap', opacity: routeLoading ? 0.6 : 1 }}>
                {routeLoading ? 'Berekenen...' : 'Bereken route'}
              </button>
            </div>

            {routeError && (
              <div style={{ marginTop: '0.4rem', fontSize: '0.65rem', color: 'var(--gold)' }}>{routeError}</div>
            )}

            {routeResult && (
              <div style={{ marginTop: '0.6rem', padding: '0.5rem 0.6rem', background: 'rgba(0,0,0,0.2)', borderRadius: 2 }}>
                {routeResult === 'none' ? (
                  <span style={{ fontSize: '0.72rem', color: 'var(--red)' }}>Geen route gevonden.</span>
                ) : (
                  <>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>
                      {routeResult.jumps} jumps totaal
                      {routeResult.bridgeJumps > 0 && <span style={{ color: 'var(--blue)', marginLeft: '0.4rem' }}>· {routeResult.bridgeJumps} bridge{routeResult.bridgeJumps !== 1 ? 's' : ''}</span>}
                      {routeResult.jumps - routeResult.bridgeJumps > 0 && <span style={{ color: 'var(--green)', marginLeft: '0.4rem' }}>· {routeResult.jumps - routeResult.bridgeJumps} gate{routeResult.jumps - routeResult.bridgeJumps !== 1 ? 's' : ''}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', flexWrap: 'wrap' }}>
                      {routeResult.systems.map((sys, i) => {
                        const nextSys = routeResult.systems[i + 1]
                        const isBridgeHop = nextSys ? routeResult.bridgeSet.has(sys) && routeResult.bridgeSet.has(nextSys) &&
                          bridges.some(b => b.online && ((b.systemA.toLowerCase() === sys.toLowerCase() && b.systemB.toLowerCase() === nextSys.toLowerCase()) || (b.systemB.toLowerCase() === sys.toLowerCase() && b.systemA.toLowerCase() === nextSys.toLowerCase()))) : false
                        return (
                          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                            {i > 0 && <span style={{ color: isBridgeHop ? 'var(--blue)' : 'var(--text-dim)', fontSize: isBridgeHop ? '0.85rem' : '0.7rem', fontWeight: isBridgeHop ? 700 : 400 }}>{isBridgeHop ? '»' : '›'}</span>}
                            <span style={{ fontSize: '0.7rem', color: routeResult.bridgeSet.has(sys) ? 'var(--blue)' : 'var(--text)' }}><SolarSystem name={sys} fontSize="0.7rem" /></span>
                          </span>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Map */}
        {view === 'map' && bridges.length > 0 && (
          <BridgeMap bridges={bridges} routeResult={Array.isArray(routeResult) ? null : routeResult === 'none' ? null : routeResult ?? null} onNodeClick={handleNodeClick} />
        )}

        {/* Lijst */}
        {view === 'list' && (bridges.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 2rem', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
            <div style={{ fontSize: '2rem', color: 'var(--border)', marginBottom: '1rem' }}>»</div>
            Nog geen jump bridges. Klik op "+ Importeren" om te beginnen.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="text" placeholder="Zoek systeem of label..." value={search} onChange={e => setSearch(e.target.value)}
                style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.6rem', outline: 'none' }} />
              <button onClick={() => save(bridges.map(b => ({ ...b, online: true })))}  style={{ padding: '0.3rem 0.55rem', borderRadius: 2, fontSize: '0.62rem', cursor: 'pointer', background: 'rgba(62,207,110,0.08)',  border: '1px solid rgba(62,207,110,0.3)',  color: 'var(--green)', whiteSpace: 'nowrap' }}>Alles online</button>
              <button onClick={() => save(bridges.map(b => ({ ...b, online: false })))} style={{ padding: '0.3rem 0.55rem', borderRadius: 2, fontSize: '0.62rem', cursor: 'pointer', background: 'rgba(224,85,85,0.07)', border: '1px solid rgba(224,85,85,0.25)', color: 'var(--red)',   whiteSpace: 'nowrap' }}>Alles offline</button>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ padding: '0.55rem 1rem', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 1fr 80px 28px', gap: '0.5rem' }}>
                {['VAN', 'NAAR', 'STATUS', ''].map(h => <span key={h} style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>{h}</span>)}
              </div>
              {filtered.map(b => (
                <div key={b.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 28px', gap: '0.5rem', alignItems: 'center', padding: '0.38rem 1rem', borderBottom: '1px solid rgba(28,28,53,0.5)', opacity: b.online ? 1 : 0.45, transition: 'opacity 0.15s' }}>
                  <div style={{ minWidth: 0 }}>
                    <SolarSystem name={b.systemA} fontSize="0.72rem" />
                    {b.label && <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</div>}
                  </div>
                  <SolarSystem name={b.systemB} fontSize="0.72rem" />
                  <button onClick={() => save(bridges.map(x => x.id === b.id ? { ...x, online: !x.online } : x))}
                    style={{ padding: '0.18rem 0.4rem', borderRadius: 2, fontSize: '0.62rem', cursor: 'pointer', fontWeight: 700, background: b.online ? 'rgba(62,207,110,0.1)' : 'rgba(224,85,85,0.08)', border: `1px solid ${b.online ? 'rgba(62,207,110,0.4)' : 'rgba(224,85,85,0.3)'}`, color: b.online ? 'var(--green)' : 'var(--red)' }}>
                    {b.online ? '● Online' : '○ Offline'}
                  </button>
                  <button onClick={() => save(bridges.filter(x => x.id !== b.id))} title="Verwijderen"
                    style={{ background: 'transparent', border: 'none', color: 'rgba(200,200,220,0.25)', cursor: 'pointer', fontSize: '0.7rem', padding: '0.2rem', lineHeight: 1 }}>✕</button>
                </div>
              ))}
              {!filtered.length && <div style={{ padding: '1.5rem', textAlign: 'center', fontSize: '0.72rem', color: 'var(--text-dim)' }}>Geen resultaten.</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>Opgeslagen in lokale browser storage</span>
              <button onClick={() => { if (confirm('Alle jump bridges verwijderen?')) save([]) }}
                style={{ background: 'transparent', border: 'none', color: 'rgba(224,85,85,0.45)', fontSize: '0.65rem', cursor: 'pointer' }}>Alles wissen</button>
            </div>
          </>
        ))}
      </div>
    </Layout>
  )
}
