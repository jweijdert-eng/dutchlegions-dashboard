import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { useAuth } from '../auth/AuthContext'
import { usePageLoading } from '../hooks/usePageLoading'
import { getAssets, getBlueprints, getIndustryJobs, getStructureInfo, resolveNames } from '../api/esi'

// ── Types ───────────────────────────────────────────────────────────────────
type JobState = 'todo' | 'running' | 'done'
interface Progress { bought?: number; done?: boolean; job?: JobState }
interface Project {
  id: string
  name: string
  targetTypeId: number
  targetName: string
  targetQty: number
  me: number
  buyOverrides: Record<number, true>   // typeIds die je liever koopt dan bouwt (snoeit de subboom)
  progress: Record<number, Progress>
  createdAt: number
  updatedAt: number
}

interface CompactBp { m: [number, number][]; p: [number, number] }
interface Recipe { perRun: number; materials: [number, number][]; bpId: number }

// ── SDE-data (eenmalig laden, gedeeld) ──────────────────────────────────────
let _namesInflight: Promise<Record<string, string>> | null = null
function loadTypeNames(): Promise<Record<string, string>> {
  if (!_namesInflight) _namesInflight = fetch('/type-names.json').then(r => r.json()).catch(() => ({}))
  return _namesInflight
}
let _bpInflight: Promise<Map<number, Recipe>> | null = null
function loadRecipes(): Promise<Map<number, Recipe>> {
  // bouwt een reverse-index: product-typeId → manufacturing-recept
  if (!_bpInflight) _bpInflight = fetch('/blueprints.json')
    .then(r => r.json() as Promise<Record<string, CompactBp>>)
    .then(bps => {
      const byProduct = new Map<number, Recipe>()
      for (const [bid, bp] of Object.entries(bps)) {
        const [prodId, perRun] = bp.p
        if (!byProduct.has(prodId)) byProduct.set(prodId, { perRun, materials: bp.m, bpId: Number(bid) })
      }
      return byProduct
    })
    .catch(() => new Map<number, Recipe>())
  return _bpInflight
}

// PI-produceerbare commodities = alle schematic-outputs (is_input=false) uit schematics.json
let _piInflight: Promise<Set<number>> | null = null
function loadPiOutputs(): Promise<Set<number>> {
  if (!_piInflight) _piInflight = fetch('/schematics.json')
    .then(r => r.json() as Promise<Record<string, { pins: { type_id: number; is_input: boolean }[] }>>)
    .then(sch => {
      const s = new Set<number>()
      for (const sc of Object.values(sch)) for (const p of sc.pins) if (!p.is_input) s.add(p.type_id)
      return s
    })
    .catch(() => new Set<number>())
  return _piInflight
}

// ME verlaagt de materiaalhoeveelheid per run (0–10%). TE laten we buiten beschouwing.
function applyME(qty: number, me: number): number {
  return Math.max(1, Math.ceil(qty * (1 - me / 100)))
}
function fmtNum(n: number): string { return n.toLocaleString('nl-NL') }
function fmtISK(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' mrd'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' mln'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return Math.round(v).toString()
}

// ── Materiaalboom → platte bill-of-materials (netto, na voorraad/jobs) ───────
interface BuildRow { typeId: number; needed: number; net: number; runs: number; output: number }
interface BuyRow { typeId: number; needed: number; net: number }
function computeBom(
  target: number, targetQty: number, me: number,
  recipes: Map<number, Recipe>, buyOverrides: Record<number, true>, supply: Map<number, number>,
) {
  const isBuilt = (t: number) => recipes.has(t) && !buyOverrides[t]
  if (!recipes.has(target)) return { builds: [] as BuildRow[], buys: [] as BuyRow[], buildable: false }

  // post-order over de te-bouwen subgraaf (kinderen vóór ouders)
  const order: number[] = []
  const seen = new Set<number>()
  const visit = (t: number) => {
    if (seen.has(t)) return
    seen.add(t)
    const r = recipes.get(t)
    if (!r) return
    for (const [m] of r.materials) if (isBuilt(m)) visit(m)
    order.push(t)
  }
  visit(target)   // het eindproduct bouwen we sowieso

  // ouders-eerst: trek beschikbare voorraad/in-productie af en bouw alleen het tekort,
  // zodat het tekort doorwerkt naar de sub-materialen (MRP / netto-behoefte)
  const demand = new Map<number, number>([[target, targetQty]])
  const builds: BuildRow[] = []
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i]
    const r = recipes.get(t)!
    const need = demand.get(t) ?? 0
    const net = Math.max(0, need - (supply.get(t) ?? 0))
    const runs = Math.ceil(net / r.perRun)
    builds.push({ typeId: t, needed: need, net, runs, output: runs * r.perRun })
    for (const [m, q] of r.materials) {
      demand.set(m, (demand.get(m) ?? 0) + applyME(q, me) * runs)
    }
  }
  const buys: BuyRow[] = []
  for (const [t, q] of demand) if (!isBuilt(t)) buys.push({ typeId: t, needed: q, net: Math.max(0, q - (supply.get(t) ?? 0)) })
  buys.sort((a, b) => b.net - a.net || b.needed - a.needed)
  return { builds, buys, buildable: true }
}

// ── Hiërarchische boom (per tak de benodigde hoeveelheid, met ME) ───────────
interface TreeNode { typeId: number; qty: number; runs: number; build: boolean; children: TreeNode[]; depth: number }
function buildTree(target: number, targetQty: number, me: number, recipes: Map<number, Recipe>, buyOverrides: Record<number, true>): TreeNode | null {
  if (!recipes.has(target)) return null
  const isBuilt = (t: number) => recipes.has(t) && !buyOverrides[t]
  const make = (typeId: number, qty: number, depth: number, seen: Set<number>): TreeNode => {
    const built = depth === 0 ? recipes.has(typeId) : isBuilt(typeId)
    const children: TreeNode[] = []
    let runs = 0
    if (built && !seen.has(typeId) && depth < 20) {
      const r = recipes.get(typeId)!
      runs = Math.ceil(qty / r.perRun)
      const seen2 = new Set(seen).add(typeId)
      for (const [m, mq] of r.materials) children.push(make(m, applyME(mq, me) * runs, depth + 1, seen2))
    }
    return { typeId, qty, runs, build: built && children.length > 0, children, depth }
  }
  return make(target, targetQty, 0, new Set())
}
function flattenTree(root: TreeNode, collapsed: Set<number>): TreeNode[] {
  const rows: TreeNode[] = []
  const walk = (n: TreeNode) => {
    rows.push(n)
    if (n.children.length && !collapsed.has(n.typeId)) for (const c of n.children) walk(c)
  }
  walk(root)
  return rows
}

// ── Jita-prijzen (fuzzwork aggregates, The Forge) ───────────────────────────
async function fetchJitaSell(typeIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (typeIds.length === 0) return out
  try {
    const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=${typeIds.join(',')}`)
    const j = await r.json()
    for (const id of typeIds) {
      const sell = Number(j?.[id]?.sell?.min ?? 0)
      if (sell > 0) out.set(id, sell)
    }
  } catch { /* prijzen optioneel */ }
  return out
}

// ── API ─────────────────────────────────────────────────────────────────────
async function apiLoad(charId: number): Promise<Project[]> {
  const r = await fetch(`/api/buildprojects.php?characterId=${charId}`)
  const j = await r.json()
  return Array.isArray(j) ? j : []
}
async function apiSave(charId: number, charName: string, project: Project) {
  await fetch('/api/buildprojects.php', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: charId, characterName: charName, project }),
  }).catch(() => {})
}
async function apiDelete(charId: number, id: string) {
  await fetch('/api/buildprojects.php', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: charId, id }),
  }).catch(() => {})
}

const JOB_LABEL: Record<JobState, string> = { todo: 'Te doen', running: 'Job draait', done: 'Klaar' }
const JOB_COLOR: Record<JobState, string> = { todo: 'var(--text-dim)', running: 'var(--gold)', done: '#3ecf6e' }

export default function BuildProject() {
  const { tokens, activeTokens, mainCharId } = useAuth()
  const charId = mainCharId ?? tokens[0]?.characterId ?? 0
  const charName = tokens.find(t => t.characterId === charId)?.characterName ?? ''

  const [names, setNames] = useState<Record<string, string>>({})
  const [recipes, setRecipes] = useState<Map<number, Recipe>>(new Map())
  const [piSet, setPiSet] = useState<Set<number>>(new Set())
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [prices, setPrices] = useState<Map<number, number>>(new Map())

  // Voorraad (assets) per locatie + lopende productie (industry jobs, globaal)
  const [ownedByLoc, setOwnedByLoc] = useState<Map<number, Map<number, number>>>(new Map())
  const [locLabels, setLocLabels] = useState<Map<number, string>>(new Map())
  const [locFilter, setLocFilter] = useState<number | 'all'>('all')
  const [jobOutputMap, setJobOutputMap] = useState<Map<number, number>>(new Map())
  const [jobActive, setJobActive] = useState<Set<number>>(new Set())
  const [bpOwned, setBpOwned] = useState<Map<number, { bpo: boolean; me: number }>>(new Map())  // key = blueprint-type-id
  const [invLoading, setInvLoading] = useState(false)
  const [useSupply, setUseSupply] = useState(true)

  // create-dialoog
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [newQty, setNewQty] = useState(1)
  const [newMe, setNewMe] = useState(10)

  const nameOf = (id: number) => names[String(id)] ?? `Type ${id}`

  useEffect(() => {
    Promise.all([loadTypeNames(), loadRecipes(), loadPiOutputs()]).then(([n, r, pi]) => { setNames(n); setRecipes(r); setPiSet(pi) })
  }, [])

  useEffect(() => {
    if (!charId) return
    setLoading(true)
    apiLoad(charId).then(p => { setProjects(p); setActiveId(p[0]?.id ?? null) }).finally(() => setLoading(false))
  }, [charId])

  // Voorraad + jobs ophalen over alle ingelogde characters
  const refreshInventory = useCallback(async () => {
    if (activeTokens.length === 0 || recipes.size === 0) return
    setInvLoading(true)
    try {
      type Raw = { item_id: number; type_id: number; location_id: number; location_type: string; location_flag: string; quantity: number; owner: number }
      const allRaw: Raw[] = []
      const jobOut = new Map<number, number>()
      const jobAct = new Set<number>()
      const bpById = new Map<number, { bpo: boolean; me: number }>()
      await Promise.all(activeTokens.map(async t => {
        const [assets, jobs, blueprints] = await Promise.all([
          getAssets(t.characterId, t.accessToken).catch(() => []),
          getIndustryJobs(t.characterId, t.accessToken).catch(() => []),
          getBlueprints(t.characterId, t.accessToken).catch(() => []),
        ])
        for (const a of assets) allRaw.push({ ...a, owner: t.characterId } as Raw)
        for (const j of jobs) {
          if (j.activity_id !== 1 || !j.product_type_id) continue            // alleen manufacturing
          if (j.status !== 'active' && j.status !== 'ready' && j.status !== 'paused') continue
          const perRun = recipes.get(j.product_type_id)?.perRun ?? 1
          jobOut.set(j.product_type_id, (jobOut.get(j.product_type_id) ?? 0) + j.runs * perRun)
          jobAct.add(j.product_type_id)
        }
        for (const bp of blueprints) {
          const bpo = bp.quantity === -1
          const cur = bpById.get(bp.type_id)
          // beste exemplaar onthouden: BPO heeft voorrang, anders de hoogste ME
          if (!cur || (bpo && !cur.bpo) || bp.material_efficiency > cur.me) bpById.set(bp.type_id, { bpo, me: bp.material_efficiency })
        }
      }))

      // Wortel-locatie per asset bepalen door de container-/schip-boom omhoog te lopen
      const byItem = new Map(allRaw.map(a => [`${a.owner}:${a.item_id}`, a]))
      const rootType = new Map<number, 'station' | 'structure' | 'solar_system' | 'other'>()
      const rootLoc = (a: Raw, guard = 0): number => {
        if (a.location_type !== 'item' || guard > 12) {
          const id = a.location_id
          rootType.set(id, a.location_type === 'station' ? 'station'
            : a.location_type === 'solar_system' ? 'solar_system'
            : id >= 1_000_000_000 ? 'structure' : 'station')
          return id
        }
        const parent = byItem.get(`${a.owner}:${a.location_id}`)
        if (!parent) { const id = a.location_id; rootType.set(id, id >= 1_000_000_000 ? 'structure' : 'other'); return id }
        return rootLoc(parent, guard + 1)
      }

      const byLoc = new Map<number, Map<number, number>>()
      for (const a of allRaw) {
        if (/Slot/i.test(a.location_flag)) continue   // gefitte modules tellen niet als voorraad
        const locId = rootLoc(a)
        let m = byLoc.get(locId); if (!m) { m = new Map(); byLoc.set(locId, m) }
        m.set(a.type_id, (m.get(a.type_id) ?? 0) + a.quantity)
      }

      // Locatienamen: SDE/ESI voor stations & systemen, getStructureInfo voor citadels
      const ids = [...byLoc.keys()]
      const nameMap = await resolveNames(ids).catch(() => new Map<number, string>())
      await Promise.all(ids.filter(id => !nameMap.get(id) && rootType.get(id) === 'structure')
        .map(async id => { const info = await getStructureInfo(id, activeTokens).catch(() => null); if (info?.name) nameMap.set(id, info.name) }))

      setOwnedByLoc(byLoc)
      setLocLabels(new Map(ids.map(id => [id, nameMap.get(id) ?? `Locatie ${id}`])))
      setJobOutputMap(jobOut); setJobActive(jobAct); setBpOwned(bpById)
    } finally { setInvLoading(false) }
  }, [activeTokens.map(t => t.characterId).join(','), recipes])

  useEffect(() => { refreshInventory() }, [refreshInventory])

  const active = projects.find(p => p.id === activeId) ?? null

  // Voorraad op de gekozen locatie (of alles opgeteld)
  const ownedMap = useMemo(() => {
    if (locFilter === 'all') {
      const m = new Map<number, number>()
      for (const loc of ownedByLoc.values()) for (const [id, q] of loc) m.set(id, (m.get(id) ?? 0) + q)
      return m
    }
    return ownedByLoc.get(locFilter) ?? new Map<number, number>()
  }, [ownedByLoc, locFilter])

  const locOptions = useMemo(() =>
    [...ownedByLoc.keys()]
      .map(id => ({ id, label: locLabels.get(id) ?? `Locatie ${id}`, count: ownedByLoc.get(id)!.size }))
      .sort((a, b) => b.count - a.count),
  [ownedByLoc, locLabels])

  // Voorraad + in-productie als beschikbare 'supply' voor de netto-berekening
  const supply = useMemo(() => {
    const m = new Map<number, number>()
    if (!useSupply) return m
    for (const [id, q] of ownedMap) m.set(id, (m.get(id) ?? 0) + q)
    for (const [id, out] of jobOutputMap) m.set(id, (m.get(id) ?? 0) + out)
    return m
  }, [useSupply, ownedMap, jobOutputMap])

  // De bill-of-materials van het actieve project (platte aggregatie voor kosten/voortgang)
  const bom = useMemo(() => {
    if (!active || recipes.size === 0) return null
    return computeBom(active.targetTypeId, active.targetQty, active.me, recipes, active.buyOverrides, supply)
  }, [active?.targetTypeId, active?.targetQty, active?.me, active?.buyOverrides, recipes, supply])

  // Hiërarchische boom voor het overzicht
  const tree = useMemo(() => {
    if (!active || recipes.size === 0) return null
    return buildTree(active.targetTypeId, active.targetQty, active.me, recipes, active.buyOverrides)
  }, [active?.targetTypeId, active?.targetQty, active?.me, active?.buyOverrides, recipes])
  const buildByType = useMemo(() => new Map((bom?.builds ?? []).map(b => [b.typeId, b])), [bom])
  const buyByType = useMemo(() => new Map((bom?.buys ?? []).map(b => [b.typeId, b])), [bom])
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const toggleCollapse = (typeId: number) => setCollapsed(prev => { const n = new Set(prev); n.has(typeId) ? n.delete(typeId) : n.add(typeId); return n })
  // alle nodes met kinderen (= inklapbaar)
  const allParents = useMemo(() => {
    const s = new Set<number>()
    if (tree) { const walk = (n: TreeNode) => { if (n.children.length) { s.add(n.typeId); n.children.forEach(walk) } }; walk(tree) }
    return s
  }, [tree])
  const collapseAll = () => setCollapsed(new Set([...allParents].filter(id => id !== tree?.typeId)))  // eindproduct open laten
  const expandAll = () => setCollapsed(new Set())

  // ISK-kosten per boom-node: blad = aantal × Jita-sell, bouw-node = som van de
  // kinderen (= materiaalkosten om die sub-assemblage zelf te bouwen)
  const nodeCost = useMemo(() => {
    const m = new Map<TreeNode, number>()
    if (!tree) return m
    const calc = (n: TreeNode): number => {
      const c = n.children.length === 0
        ? n.qty * (prices.get(n.typeId) ?? 0)
        : n.children.reduce((s, ch) => s + calc(ch), 0)
      m.set(n, c)
      return c
    }
    calc(tree)
    return m
  }, [tree, prices])

  // Jita-prijzen voor alle betrokken types (koop-materialen én bouwbare items,
  // zodat we per onderdeel bouwen-vs-kopen kunnen vergelijken)
  const priceTypeIds = useMemo(() => {
    if (!bom) return [] as number[]
    return [...new Set([...bom.builds.map(b => b.typeId), ...bom.buys.map(b => b.typeId)])]
  }, [bom])
  useEffect(() => {
    if (priceTypeIds.length === 0) return
    fetchJitaSell(priceTypeIds).then(setPrices)
  }, [priceTypeIds.join(',')])

  // Debounced opslaan bij elke wijziging aan het actieve project
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateActive = (mut: (p: Project) => Project) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== activeId) return p
      const next = { ...mut(p), updatedAt: Date.now() }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => apiSave(charId, charName, next), 500)
      return next
    }))
  }

  // ── Create / delete ─────────────────────────────────────────────────────
  const productResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2 || recipes.size === 0) return [] as { id: number; name: string }[]
    const out: { id: number; name: string }[] = []
    for (const id of recipes.keys()) {
      const nm = names[String(id)]
      if (nm && nm.toLowerCase().includes(q)) out.push({ id, name: nm })
      if (out.length > 40) break
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30)
  }, [search, recipes, names])

  const createProject = (typeId: number, name: string) => {
    const p: Project = {
      id: crypto.randomUUID().slice(0, 36),
      name, targetTypeId: typeId, targetName: name, targetQty: Math.max(1, newQty), me: newMe,
      buyOverrides: {}, progress: {}, createdAt: Date.now(), updatedAt: Date.now(),
    }
    setProjects(prev => [p, ...prev])
    setActiveId(p.id)
    setCreating(false); setSearch(''); setNewQty(1)
    apiSave(charId, charName, p)
  }
  const deleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id))
    if (activeId === id) setActiveId(null)
    apiDelete(charId, id)
  }

  // ── Voortgang ─────────────────────────────────────────────────────────────
  const setBuy = (typeId: number, patch: Progress) =>
    updateActive(p => ({ ...p, progress: { ...p.progress, [typeId]: { ...p.progress[typeId], ...patch } } }))
  const toggleBuild = (typeId: number) => {
    const cur = active?.progress[typeId]?.job ?? 'todo'
    const next: JobState = cur === 'todo' ? 'running' : cur === 'running' ? 'done' : 'todo'
    setBuy(typeId, { job: next })
  }
  const toggleBuyOverride = (typeId: number) => updateActive(p => {
    const bo = { ...p.buyOverrides }
    if (bo[typeId]) delete bo[typeId]; else bo[typeId] = true
    return { ...p, buyOverrides: bo }
  })

  // helpers voor 'gedekt'-status (netto 0, of automatisch via voorraad/job, of handmatig)
  const buyCovered = (b: BuyRow) => {
    const pr = active?.progress[b.typeId]
    return b.net === 0 || pr?.done || (pr?.bought ?? 0) >= b.net
  }
  const buildCovered = (b: BuildRow) => b.net === 0 || active?.progress[b.typeId]?.job === 'done'

  const pct = useMemo(() => {
    if (!active || !bom) return 0
    const total = bom.buys.length + bom.builds.length
    if (!total) return 0
    const done = bom.buys.filter(buyCovered).length + bom.builds.filter(buildCovered).length
    return Math.round((done / total) * 100)
  }, [active, bom])

  const totalCost = useMemo(() => {
    if (!bom) return 0
    return bom.buys.reduce((s, b) => s + (prices.get(b.typeId) ?? 0) * b.net, 0)
  }, [bom, prices])

  // Bouwen-vs-kopen per eenheid: kosten om zelf te bouwen (directe materialen tegen
  // Jita-sell, met ME) versus de marktprijs van het kant-en-klare item.
  const me = active?.me ?? 0
  const verdict = (typeId: number): { build: number; buy: number; cheaper: 'build' | 'buy'; savePct: number } | null => {
    const r = recipes.get(typeId)
    if (!r) return null
    let build = 0
    for (const [m, q] of r.materials) {
      const p = prices.get(m) ?? 0
      if (!p) return null                 // onbekende materiaalprijs → geen betrouwbaar advies
      build += applyME(q, me) * p
    }
    build = build / r.perRun
    const buy = prices.get(typeId) ?? 0
    if (!buy) return null
    return { build, buy, cheaper: build < buy ? 'build' : 'buy', savePct: buy > 0 ? Math.round(Math.abs(buy - build) / buy * 100) : 0 }
  }
  const targetVerdict = active ? verdict(active.targetTypeId) : null

  // Heb je de blueprint om dit te bouwen? (alleen tonen als we je BP's hebben opgehaald)
  const bpBadge = (typeId: number) => {
    if (bpOwned.size === 0) return null
    const r = recipes.get(typeId)
    if (!r) return null
    const bp = bpOwned.get(r.bpId)
    return bp
      ? <span style={{ ...badge, color: '#7fd1ff' }} title={`Blueprint in bezit · ME ${bp.me}`}>📘 {bp.bpo ? 'BPO' : 'BPC'} ME{bp.me}</span>
      : <span style={{ ...badge, color: 'var(--red)' }} title="Je hebt deze blueprint (nog) niet">⚠ geen BP</span>
  }

  // Te maken met Planetary Interaction?
  const piBadge = (typeId: number) => piSet.has(typeId)
    ? <span style={{ ...badge, color: '#9b8cff' }} title="Te produceren met Planetary Interaction">🪐 PI</span>
    : null

  if (!charId) return <Layout header={<PageHeader title="Bouwproject" />}><div style={{ padding: '2rem', color: 'var(--text-dim)' }}>Log in om bouwprojecten te beheren.</div></Layout>

  return (
    <Layout header={<PageHeader title="Bouwproject" />}>
      <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Projectenlijst */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <button onClick={() => setCreating(true)} style={btnPrimary}>+ Nieuw project</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0.6rem 2px', fontSize: '0.66rem', color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={useSupply} onChange={e => setUseSupply(e.target.checked)} />
            Voorraad &amp; jobs meerekenen
          </label>
          <button onClick={refreshInventory} disabled={invLoading} style={{ ...btnGhost, fontSize: '0.66rem', padding: '2px 2px' }}>
            {invLoading ? '⏳ voorraad laden…' : '↻ Voorraad verversen'}
          </button>
          {useSupply && locOptions.length > 0 && (
            <select value={locFilter === 'all' ? 'all' : String(locFilter)}
              onChange={e => setLocFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              title="Tel alleen voorraad op deze locatie mee (jobs blijven globaal)"
              style={{ ...input, width: '100%', marginTop: 6 }}>
              <option value="all">📍 Alle locaties</option>
              {locOptions.map(o => <option key={o.id} value={o.id}>{o.label} ({o.count})</option>)}
            </select>
          )}
          <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {projects.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Nog geen projecten.</div>}
            {projects.map(p => (
              <button key={p.id} onClick={() => setActiveId(p.id)} style={{
                ...card, textAlign: 'left', cursor: 'pointer',
                borderColor: p.id === activeId ? 'var(--blue)' : 'var(--border)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <EveImage category="types" id={p.targetTypeId} variation="icon" size={32} px={26} />
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: '0.78rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>×{fmtNum(p.targetQty)} · ME {p.me}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Create-dialoog */}
        {creating && (
          <div style={{ ...card, flex: 1, minWidth: 320 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.85rem' }}>Nieuw bouwproject</strong>
              <button onClick={() => setCreating(false)} style={btnGhost}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <label style={lbl}>Aantal<input type="number" min={1} value={newQty} onChange={e => setNewQty(parseInt(e.target.value) || 1)} style={{ ...input, width: 80 }} /></label>
              <label style={lbl}>ME %<input type="number" min={0} max={10} value={newMe} onChange={e => setNewMe(Math.max(0, Math.min(10, parseInt(e.target.value) || 0)))} style={{ ...input, width: 60 }} /></label>
            </div>
            <input autoFocus placeholder="Zoek eindproduct (schip, module, component…)" value={search} onChange={e => setSearch(e.target.value)} style={{ ...input, width: '100%', marginBottom: 8 }} />
            <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {productResults.map(r => (
                <button key={r.id} onClick={() => createProject(r.id, r.name)} style={{ ...rowBtn }}>
                  <EveImage category="types" id={r.id} variation="icon" size={32} px={22} />
                  <span style={{ fontSize: '0.76rem' }}>{r.name}</span>
                </button>
              ))}
              {search.trim().length >= 2 && productResults.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem', padding: 6 }}>Geen bouwbaar product gevonden.</div>}
            </div>
          </div>
        )}

        {/* Actief project */}
        {!creating && active && bom && (
          <div style={{ flex: 1, minWidth: 340 }}>
            {/* Kop + voortgang */}
            <div style={{ ...card, marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <EveImage category="types" id={active.targetTypeId} variation="icon" size={64} px={48} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '1rem', color: '#fff', fontWeight: 600 }}>{active.targetName}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{fmtNum(active.targetQty)}× · ME {active.me}% · nog ~{fmtISK(totalCost)} ISK te kopen (Jita sell){useSupply && ' · voorraad/jobs meegerekend'}</div>
                  {targetVerdict && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: 2 }}>
                      Eindproduct: zelf bouwen ~{fmtISK(targetVerdict.build)} vs kopen ~{fmtISK(targetVerdict.buy)} /st →{' '}
                      <strong style={{ color: targetVerdict.cheaper === 'build' ? '#3ecf6e' : 'var(--gold)' }}>
                        {targetVerdict.cheaper === 'build' ? `zelf bouwen ${targetVerdict.savePct}% goedkoper` : `kopen ${targetVerdict.savePct}% goedkoper`}
                      </strong>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label style={{ ...lbl, fontSize: '0.62rem' }}>Aantal<input type="number" min={1} value={active.targetQty} onChange={e => updateActive(p => ({ ...p, targetQty: Math.max(1, parseInt(e.target.value) || 1) }))} style={{ ...input, width: 76 }} /></label>
                  <label style={{ ...lbl, fontSize: '0.62rem' }}>ME%<input type="number" min={0} max={10} value={active.me} onChange={e => updateActive(p => ({ ...p, me: Math.max(0, Math.min(10, parseInt(e.target.value) || 0)) }))} style={{ ...input, width: 56 }} /></label>
                  <button onClick={() => deleteProject(active.id)} style={{ ...btnGhost, color: 'var(--red)' }} title="Project verwijderen">🗑</button>
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3 }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: '#3ecf6e', borderRadius: 3, transition: 'width .3s' }} />
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', width: 36, textAlign: 'right' }}>{pct}%</span>
              </div>
            </div>

            {/* Weergave-schakelaar */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {([['tree', '🌳 Bouwschema'], ['list', '📋 Inkooplijst']] as const).map(([m, lbl2]) => (
                <button key={m} onClick={() => setViewMode(m)} style={{
                  ...pill, padding: '4px 12px',
                  background: viewMode === m ? 'rgba(80,150,255,0.18)' : 'rgba(255,255,255,0.05)',
                  borderColor: viewMode === m ? 'var(--blue)' : 'var(--text-dim)',
                  color: viewMode === m ? '#fff' : 'var(--text)',
                }}>{lbl2}</button>
              ))}
              {viewMode === 'tree' && allParents.size > 1 && (
                <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <button onClick={collapseAll} style={{ ...pill, padding: '4px 10px', background: 'rgba(255,255,255,0.08)', borderColor: 'var(--text-dim)', color: 'var(--text)' }} title="Alle sub-onderdelen inklappen">⊟ Alles inklappen</button>
                  <button onClick={expandAll} style={{ ...pill, padding: '4px 10px', background: 'rgba(255,255,255,0.08)', borderColor: 'var(--text-dim)', color: 'var(--text)' }} title="Alles uitklappen">⊞ Alles uitklappen</button>
                </span>
              )}
            </div>

            {/* Hiërarchisch bouwschema */}
            {viewMode === 'tree' && tree && (
              <Section title="Bouwschema (wat valt waaronder)">
                {flattenTree(tree, collapsed).map((n, i) => {
                  const isB = n.build
                  const bRow = isB ? buildByType.get(n.typeId) : undefined
                  const yRow = !isB ? buyByType.get(n.typeId) : undefined
                  const covered = isB ? (bRow ? buildCovered(bRow) : false) : (yRow ? buyCovered(yRow) : false)
                  const owned = useSupply ? (ownedMap.get(n.typeId) ?? 0) : 0
                  const inJob = useSupply ? (jobOutputMap.get(n.typeId) ?? 0) : 0
                  const job = active.progress[n.typeId]?.job ?? 'todo'
                  const inMaking = useSupply && jobActive.has(n.typeId)
                  const buildable = recipes.has(n.typeId)
                  const hasKids = n.children.length > 0
                  return (
                    <div key={`${n.typeId}-${n.depth}-${i}`} style={{ ...rowWrap, paddingLeft: 8 + n.depth * 18, opacity: covered && !inMaking ? 0.55 : 1 }}>
                      {hasKids
                        ? <button onClick={() => toggleCollapse(n.typeId)} style={{ ...btnGhost, width: 14, padding: 0, flexShrink: 0 }} title={collapsed.has(n.typeId) ? 'Uitklappen' : 'Inklappen'}>{collapsed.has(n.typeId) ? '▶' : '▼'}</button>
                        : <span style={{ width: 14, flexShrink: 0 }} />}
                      <StatusGlyph kind={inMaking ? 'job' : covered ? 'have' : null} />
                      <EveImage category="types" id={n.typeId} variation="icon" size={32} px={24} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.76rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {nameOf(n.typeId)}{n.typeId === active.targetTypeId && <span style={{ color: 'var(--blue)', fontSize: '0.6rem', marginLeft: 6 }}>EINDPRODUCT</span>}
                        </div>
                        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span>{fmtNum(n.qty)} {isB ? 'te bouwen' : 'nodig'}{isB && n.runs > 0 ? ` · ${n.runs} run${n.runs !== 1 ? 's' : ''}` : ''}</span>
                          {(() => { const c = nodeCost.get(n) ?? 0; if (c <= 0) return null
                            const buy = isB ? (prices.get(n.typeId) ?? 0) * n.qty : 0
                            return <span style={{ color: isB ? '#7fd1ff' : 'var(--text-dim)' }} title={isB ? 'Materiaalkosten om deze sub-assemblage zelf te bouwen' : 'Aankoopkosten (Jita sell)'}>
                              {isB ? '🔧 ' : '🛒 '}~{fmtISK(c)} ISK{buy > 0 ? <span style={{ color: c < buy ? '#3ecf6e' : 'var(--gold)' }}> (kopen ~{fmtISK(buy)})</span> : null}
                            </span> })()}
                          {owned > 0 && <span style={badge}>📦 {fmtNum(owned)}</span>}
                          {inJob > 0 && <span style={{ ...badge, color: 'var(--gold)' }}>🏭 {fmtNum(inJob)}</span>}
                          {bpBadge(n.typeId)}
                          {piBadge(n.typeId)}
                        </div>
                      </div>
                      {isB
                        ? <button onClick={() => toggleBuild(n.typeId)} style={{ ...pill, color: JOB_COLOR[job], borderColor: JOB_COLOR[job] }}>{JOB_LABEL[job]}</button>
                        : <>
                            <input type="number" min={0} placeholder="0" value={active.progress[n.typeId]?.bought || ''} onChange={e => setBuy(n.typeId, { bought: Math.max(0, parseInt(e.target.value) || 0) })} style={{ ...input, width: 80 }} title="Aantal gekocht" />
                            {buildable && <button onClick={() => toggleBuyOverride(n.typeId)} style={{ ...pill, borderColor: active.buyOverrides[n.typeId] ? 'var(--gold)' : 'var(--border)', color: active.buyOverrides[n.typeId] ? 'var(--gold)' : 'var(--text-dim)' }} title="Zelf bouwen i.p.v. kopen">{active.buyOverrides[n.typeId] ? 'kopen ✓' : 'bouwen?'}</button>}
                          </>}
                    </div>
                  )
                })}
              </Section>
            )}

            {viewMode === 'list' && (<>
            {/* Te bouwen */}
            <Section title={`Te bouwen (${bom.builds.filter(b => !buildCovered(b)).length}/${bom.builds.length})`}>
              {bom.builds.map(b => {
                const job = active.progress[b.typeId]?.job ?? 'todo'
                const owned = useSupply ? (ownedMap.get(b.typeId) ?? 0) : 0
                const inJob = useSupply ? (jobOutputMap.get(b.typeId) ?? 0) : 0
                const covered = buildCovered(b)
                const inMaking = useSupply && jobActive.has(b.typeId)
                return (
                  <div key={b.typeId} style={{ ...rowWrap, opacity: covered && !inMaking ? 0.5 : 1 }}>
                    <StatusGlyph kind={inMaking ? 'job' : covered ? 'have' : null} />
                    <EveImage category="types" id={b.typeId} variation="icon" size={32} px={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.76rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {nameOf(b.typeId)}{b.typeId === active.targetTypeId && <span style={{ color: 'var(--blue)', fontSize: '0.6rem', marginLeft: 6 }}>EINDPRODUCT</span>}
                      </div>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {b.net > 0 ? <span>{fmtNum(b.output)} te bouwen · {b.runs} run{b.runs !== 1 ? 's' : ''}</span> : <span style={{ color: '#3ecf6e' }}>✓ gedekt</span>}
                        <span style={{ color: 'var(--text-dim)' }}>({fmtNum(b.needed)} nodig)</span>
                        {owned > 0 && <span style={badge}>📦 {fmtNum(owned)}</span>}
                        {inJob > 0 && <span style={{ ...badge, color: 'var(--gold)' }}>🏭 {fmtNum(inJob)}</span>}
                        {bpBadge(b.typeId)}
                        {piBadge(b.typeId)}
                      </div>
                      {(() => { const v = verdict(b.typeId); return v ? (
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: 1 }}>
                          🔧 {fmtISK(v.build)} vs 🛒 {fmtISK(v.buy)} /st · <span style={{ color: v.cheaper === 'build' ? '#3ecf6e' : 'var(--gold)' }}>{v.cheaper === 'build' ? `bouwen −${v.savePct}%` : `kopen −${v.savePct}%`}</span>
                        </div>) : null })()}
                    </div>
                    <button onClick={() => toggleBuild(b.typeId)} style={{ ...pill, color: JOB_COLOR[job], borderColor: JOB_COLOR[job] }}>{JOB_LABEL[job]}</button>
                  </div>
                )
              })}
            </Section>

            {/* Te kopen */}
            <Section title={`Te kopen (${bom.buys.filter(b => !buyCovered(b)).length}/${bom.buys.length})`}>
              {bom.buys.map(b => {
                const pr = active.progress[b.typeId]
                const bought = pr?.bought ?? 0
                const covered = buyCovered(b)
                const owned = useSupply ? (ownedMap.get(b.typeId) ?? 0) : 0
                const price = prices.get(b.typeId) ?? 0
                const buildable = recipes.has(b.typeId)
                return (
                  <div key={b.typeId} style={{ ...rowWrap, opacity: covered ? 0.5 : 1 }}>
                    <input type="checkbox" checked={!!covered} onChange={e => setBuy(b.typeId, { done: e.target.checked })} style={{ width: 16, height: 16 }} />
                    <StatusGlyph kind={covered ? 'have' : null} />
                    <EveImage category="types" id={b.typeId} variation="icon" size={32} px={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.76rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nameOf(b.typeId)}</div>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {b.net > 0 ? <span>{fmtNum(b.net)} kopen{price > 0 && <> · ~{fmtISK(price * b.net)} ISK</>}</span> : <span style={{ color: '#3ecf6e' }}>✓ in voorraad</span>}
                        <span>({fmtNum(b.needed)} nodig)</span>
                        {owned > 0 && <span style={badge}>📦 {fmtNum(owned)}</span>}
                        {(() => { const v = buildable ? verdict(b.typeId) : null; return v && v.cheaper === 'build' && v.savePct >= 2
                          ? <span style={{ color: '#3ecf6e' }} title={`zelf bouwen ~${fmtISK(v.build)} vs kopen ~${fmtISK(v.buy)} per stuk`}>💡 bouwen −{v.savePct}%</span>
                          : null })()}
                        {buildable && bpBadge(b.typeId)}
                        {piBadge(b.typeId)}
                      </div>
                    </div>
                    <input type="number" min={0} placeholder="0" value={bought || ''} onChange={e => setBuy(b.typeId, { bought: Math.max(0, parseInt(e.target.value) || 0) })}
                      style={{ ...input, width: 90 }} title="Aantal handmatig gekocht (bovenop voorraad)" />
                    {buildable && (
                      <button onClick={() => toggleBuyOverride(b.typeId)} style={{ ...pill, borderColor: active.buyOverrides[b.typeId] ? 'var(--gold)' : 'var(--border)', color: active.buyOverrides[b.typeId] ? 'var(--gold)' : 'var(--text-dim)' }}
                        title="Dit onderdeel zelf bouwen i.p.v. kopen">{active.buyOverrides[b.typeId] ? 'kopen ✓' : 'bouwen?'}</button>
                    )}
                  </div>
                )
              })}
            </Section>
            </>)}
          </div>
        )}

        {!creating && !active && projects.length > 0 && (
          <div style={{ ...card, flex: 1, color: 'var(--text-dim)' }}>Kies een project links, of maak een nieuw project aan.</div>
        )}
        {!creating && projects.length === 0 && (
          <div style={{ ...card, flex: 1, color: 'var(--text-dim)' }}>Nog geen bouwprojecten. Klik op <strong style={{ color: '#fff' }}>+ Nieuw project</strong> en kies wat je wilt bouwen.</div>
        )}
      </div>
    </Layout>
  )
}

// Statusicoon vooraan een regel: groen vinkje = gedekt/op voorraad, oranje
// zandloper = er draait een job (in de maak).
function StatusGlyph({ kind }: { kind: 'have' | 'job' | null }) {
  if (kind === 'have') return <span title="Gedekt / op voorraad" style={{ color: '#3ecf6e', fontSize: '0.95rem', width: 16, textAlign: 'center', flexShrink: 0 }}>✓</span>
  if (kind === 'job') return <span title="In de maak (job draait)" style={{ color: 'var(--gold)', fontSize: '0.9rem', width: 16, textAlign: 'center', flexShrink: 0 }}>⏳</span>
  return <span style={{ width: 16, flexShrink: 0 }} />
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontSize: '0.66rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 6px 2px' }}>{title}</div>
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

// ── Inline-stijlen (in lijn met de rest van de app) ─────────────────────────
const card: React.CSSProperties = { background: 'var(--panel, rgba(11,11,26,0.6))', border: '1px solid var(--border)', borderRadius: 6, padding: '0.85rem' }
const rowWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.5rem 0.7rem', borderBottom: '1px solid var(--border)' }
const rowBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'transparent', border: 'none', color: 'var(--text)', textAlign: 'left', cursor: 'pointer', borderRadius: 4 }
const btnPrimary: React.CSSProperties = { width: '100%', padding: '0.55rem', background: 'var(--blue)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }
const btnGhost: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.8rem' }
const pill: React.CSSProperties = { padding: '3px 9px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 12, fontSize: '0.64rem', cursor: 'pointer', whiteSpace: 'nowrap' }
const badge: React.CSSProperties = { color: 'var(--text-dim)', whiteSpace: 'nowrap' }
const input: React.CSSProperties = { background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', padding: '0.32rem 0.5rem', fontSize: '0.74rem' }
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.66rem', color: 'var(--text-dim)' }
