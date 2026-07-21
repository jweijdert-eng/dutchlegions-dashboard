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
