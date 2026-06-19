import { useEffect, useMemo, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { useAuth } from '../auth/AuthContext'
import { usePageLoading } from '../hooks/usePageLoading'

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
interface Recipe { perRun: number; materials: [number, number][] }

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
      for (const bp of Object.values(bps)) {
        const [prodId, perRun] = bp.p
        if (!byProduct.has(prodId)) byProduct.set(prodId, { perRun, materials: bp.m })
      }
      return byProduct
    })
    .catch(() => new Map<number, Recipe>())
  return _bpInflight
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

// ── Materiaalboom → platte bill-of-materials ────────────────────────────────
interface BuildRow { typeId: number; needed: number; runs: number; output: number }
interface BuyRow { typeId: number; qty: number }
function computeBom(target: number, targetQty: number, me: number, recipes: Map<number, Recipe>, buyOverrides: Record<number, true>) {
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

  // ouders-eerst verwerken zodat de totale vraag per node vaststaat vóór het uitsplitsen
  const demand = new Map<number, number>([[target, targetQty]])
  const builds: BuildRow[] = []
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i]
    const r = recipes.get(t)!
    const need = demand.get(t) ?? 0
    const runs = Math.ceil(need / r.perRun)
    builds.push({ typeId: t, needed: need, runs, output: runs * r.perRun })
    for (const [m, q] of r.materials) {
      demand.set(m, (demand.get(m) ?? 0) + applyME(q, me) * runs)
    }
  }
  const buys: BuyRow[] = []
  for (const [t, q] of demand) if (!isBuilt(t)) buys.push({ typeId: t, qty: q })
  buys.sort((a, b) => b.qty - a.qty)
  return { builds, buys, buildable: true }
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
  const { tokens, mainCharId } = useAuth()
  const charId = mainCharId ?? tokens[0]?.characterId ?? 0
  const charName = tokens.find(t => t.characterId === charId)?.characterName ?? ''

  const [names, setNames] = useState<Record<string, string>>({})
  const [recipes, setRecipes] = useState<Map<number, Recipe>>(new Map())
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  usePageLoading(loading)
  const [prices, setPrices] = useState<Map<number, number>>(new Map())

  // create-dialoog
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [newQty, setNewQty] = useState(1)
  const [newMe, setNewMe] = useState(10)

  const nameOf = (id: number) => names[String(id)] ?? `Type ${id}`

  useEffect(() => {
    Promise.all([loadTypeNames(), loadRecipes()]).then(([n, r]) => { setNames(n); setRecipes(r) })
  }, [])

  useEffect(() => {
    if (!charId) return
    setLoading(true)
    apiLoad(charId).then(p => { setProjects(p); setActiveId(p[0]?.id ?? null) }).finally(() => setLoading(false))
  }, [charId])

  const active = projects.find(p => p.id === activeId) ?? null

  // De bill-of-materials van het actieve project
  const bom = useMemo(() => {
    if (!active || recipes.size === 0) return null
    return computeBom(active.targetTypeId, active.targetQty, active.me, recipes, active.buyOverrides)
  }, [active?.targetTypeId, active?.targetQty, active?.me, active?.buyOverrides, recipes])

  // Jita-prijzen voor de koop-lijst
  useEffect(() => {
    if (!bom || bom.buys.length === 0) return
    fetchJitaSell(bom.buys.map(b => b.typeId)).then(setPrices)
  }, [bom?.buys.map(b => b.typeId).join(',')])

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

  // Voortgangs-percentage: aandeel afgeronde koop- + bouwregels
  const pct = useMemo(() => {
    if (!active || !bom) return 0
    let total = 0, done = 0
    for (const b of bom.buys) {
      total++
      const pr = active.progress[b.typeId]
      if (pr?.done || (pr?.bought ?? 0) >= b.qty) done++
    }
    for (const b of bom.builds) {
      total++
      if (active.progress[b.typeId]?.job === 'done') done++
    }
    return total ? Math.round((done / total) * 100) : 0
  }, [active, bom])

  const totalCost = useMemo(() => {
    if (!bom) return 0
    return bom.buys.reduce((s, b) => s + (prices.get(b.typeId) ?? 0) * b.qty, 0)
  }, [bom, prices])

  if (!charId) return <Layout header={<PageHeader title="Bouwproject" />}><div style={{ padding: '2rem', color: 'var(--text-dim)' }}>Log in om bouwprojecten te beheren.</div></Layout>

  return (
    <Layout header={<PageHeader title="Bouwproject" />}>
      <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Projectenlijst */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <button onClick={() => setCreating(true)} style={btnPrimary}>+ Nieuw project</button>
          <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{fmtNum(active.targetQty)}× · ME {active.me}% · ~{fmtISK(totalCost)} ISK materiaal (Jita sell)</div>
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

            {/* Te bouwen */}
            <Section title={`Te bouwen (${bom.builds.length})`}>
              {bom.builds.map(b => {
                const job = active.progress[b.typeId]?.job ?? 'todo'
                return (
                  <div key={b.typeId} style={rowWrap}>
                    <EveImage category="types" id={b.typeId} variation="icon" size={32} px={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.76rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {nameOf(b.typeId)}{b.typeId === active.targetTypeId && <span style={{ color: 'var(--blue)', fontSize: '0.6rem', marginLeft: 6 }}>EINDPRODUCT</span>}
                      </div>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{fmtNum(b.output)} stuks · {b.runs} run{b.runs !== 1 ? 's' : ''}</div>
                    </div>
                    <button onClick={() => toggleBuild(b.typeId)} style={{ ...pill, color: JOB_COLOR[job], borderColor: JOB_COLOR[job] }}>{JOB_LABEL[job]}</button>
                  </div>
                )
              })}
            </Section>

            {/* Te kopen */}
            <Section title={`Te kopen (${bom.buys.length})`}>
              {bom.buys.map(b => {
                const pr = active.progress[b.typeId]
                const bought = pr?.bought ?? 0
                const complete = pr?.done || bought >= b.qty
                const price = prices.get(b.typeId) ?? 0
                const buildable = recipes.has(b.typeId)
                return (
                  <div key={b.typeId} style={{ ...rowWrap, opacity: complete ? 0.5 : 1 }}>
                    <input type="checkbox" checked={!!complete} onChange={e => setBuy(b.typeId, { done: e.target.checked })} style={{ width: 16, height: 16 }} />
                    <EveImage category="types" id={b.typeId} variation="icon" size={32} px={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.76rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nameOf(b.typeId)}</div>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                        {fmtNum(b.qty)} nodig{price > 0 && <> · ~{fmtISK(price * b.qty)} ISK</>}
                      </div>
                    </div>
                    <input type="number" min={0} placeholder="0" value={bought || ''} onChange={e => setBuy(b.typeId, { bought: Math.max(0, parseInt(e.target.value) || 0) })}
                      style={{ ...input, width: 90 }} title="Aantal gekocht" />
                    {buildable && (
                      <button onClick={() => toggleBuyOverride(b.typeId)} style={{ ...pill, borderColor: active.buyOverrides[b.typeId] ? 'var(--gold)' : 'var(--border)', color: active.buyOverrides[b.typeId] ? 'var(--gold)' : 'var(--text-dim)' }}
                        title="Dit onderdeel zelf bouwen i.p.v. kopen">{active.buyOverrides[b.typeId] ? 'kopen ✓' : 'bouwen?'}</button>
                    )}
                  </div>
                )
              })}
            </Section>
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
const input: React.CSSProperties = { background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', padding: '0.32rem 0.5rem', fontSize: '0.74rem' }
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.66rem', color: 'var(--text-dim)' }
