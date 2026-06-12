export function fmtISK(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toLocaleString('nl-NL', { maximumFractionDigits: 2 })
}

export function parseItemLines(raw: string): Array<{ name: string; qty: number }> {
  const items: Array<{ name: string; qty: number }> = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.includes('\t')) {
      const parts = trimmed.split('\t')
      const name = parts[0].trim()
      const qty = parseInt(parts[1]?.replace(/[^0-9]/g, '') || '1') || 1
      if (name) items.push({ name, qty })
      continue
    }

    const multBefore = trimmed.match(/^([\d,. ]+)\s*[xX]\s+(.+)$/)
    if (multBefore) {
      items.push({ name: multBefore[2].trim(), qty: parseInt(multBefore[1].replace(/[^0-9]/g, '')) || 1 })
      continue
    }

    const multAfter = trimmed.match(/^(.+?)\s+[xX]\s*([\d,. ]+)$/)
    if (multAfter) {
      items.push({ name: multAfter[1].trim(), qty: parseInt(multAfter[2].replace(/[^0-9]/g, '')) || 1 })
      continue
    }

    items.push({ name: trimmed, qty: 1 })
  }

  const merged = new Map<string, { name: string; qty: number }>()
  for (const item of items) {
    const key = item.name.toLowerCase()
    const existing = merged.get(key)
    if (existing) existing.qty += item.qty
    else merged.set(key, { ...item })
  }

  return Array.from(merged.values())
}

export async function pLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let idx = 0

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
