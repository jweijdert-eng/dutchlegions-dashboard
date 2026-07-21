// Handmatig bijgehouden aankopen (station-trading posities), lokaal opgeslagen
// in de browser. Bewust los van de wallet-transacties: dit is jouw eigen
// "ik kocht dit tegen die prijs"-lijst om open posities te volgen.

export interface Position {
  id: string
  typeId: number
  name: string
  qty: number
  buyPrice: number   // prijs per stuk die je betaalde
  date: string       // ISO
}

const KEY = 'jita:positions'

export function loadPositions(): Position[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Position[]) : []
  } catch { return [] }
}

export function savePositions(list: Position[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* quota/private mode */ }
}

export function addPosition(p: Omit<Position, 'id' | 'date'>): Position {
  const pos: Position = {
    ...p,
    id: (crypto as { randomUUID?: () => string }).randomUUID?.() ?? String(Date.now() + Math.random()),
    date: new Date().toISOString(),
  }
  savePositions([pos, ...loadPositions()])
  return pos
}

export function removePosition(id: string): void {
  savePositions(loadPositions().filter(p => p.id !== id))
}

export function updatePosition(id: string, patch: Partial<Pick<Position, 'qty' | 'buyPrice' | 'name'>>): void {
  savePositions(loadPositions().map(p => (p.id === id ? { ...p, ...patch } : p)))
}

// ── Auto-posities (uit de wallet) bewerkbaar maken: verbergen + overschrijven ──
const HIDDEN_KEY = 'jita:autoHidden'
const OVERRIDE_KEY = 'jita:autoOverride'
export interface AutoOverride { qty?: number; buyPrice?: number }

export function loadHidden(): number[] {
  try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as number[] } catch { return [] }
}
export function toggleHidden(typeId: number, hide: boolean): void {
  const s = new Set(loadHidden())
  if (hide) s.add(typeId); else s.delete(typeId)
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s])) } catch { /* quota */ }
}
export function loadOverrides(): Record<number, AutoOverride> {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') as Record<number, AutoOverride> } catch { return {} }
}
export function setOverride(typeId: number, o: AutoOverride): void {
  const m = loadOverrides(); m[typeId] = { ...m[typeId], ...o }
  try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(m)) } catch { /* quota */ }
}
export function clearOverride(typeId: number): void {
  const m = loadOverrides(); delete m[typeId]
  try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(m)) } catch { /* quota */ }
}
