const PROXIES = [
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
]

export interface DscanItem {
  typeName: string
  typeId: number | null
}

export interface DscanGroup {
  typeName: string
  typeId: number | null
  count: number
}

export async function fetchDscanItems(url: string): Promise<DscanGroup[]> {
  const m = url.match(/dscan\.info\/v\/([a-f0-9]+)/i)
  if (!m) throw new Error('Geen geldige dscan.info URL')
  const target = `https://dscan.info/v/${m[1]}`

  let html = ''
  for (const makeUrl of PROXIES) {
    try {
      const res = await fetch(makeUrl(target))
      if (res.ok) {
        const txt = await res.text()
        if (txt.length > 200) { html = txt; break }
      }
    } catch { continue }
  }
  if (!html) throw new Error('Kon dscan.info niet bereiken')

  const doc  = new DOMParser().parseFromString(html, 'text/html')
  const items: DscanItem[] = []

  // Strategy 1: table rows — find a numeric cell, treat the neighbour as ship name
  doc.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('td')).map(c => c.textContent?.trim() ?? '')
    if (cells.length < 2) return
    const numIdx = cells.findIndex(c => /^\d+$/.test(c))
    if (numIdx === -1) return
    const nameIdx = numIdx === 0 ? 1 : 0
    const count = parseInt(cells[numIdx])
    const name  = cells[nameIdx]
    if (count > 0 && count < 500 && name.length > 2 && /^[A-Z]/.test(name))
      for (let i = 0; i < count; i++) items.push({ typeName: name, typeId: null })
  })

  // Strategy 2: list items / rows
  if (items.length === 0) {
    doc.querySelectorAll('li, [class*="row"], [class*="ship"], [class*="type"]').forEach(el => {
      const txt = el.textContent?.trim() ?? ''
      const hit = /^(\d+)\s+([A-Z].{2,})$/.exec(txt) ?? /^([A-Z].{2,})\s+(\d+)$/.exec(txt)
      if (!hit) return
      const count = parseInt(hit[1].match(/^\d+$/) ? hit[1] : hit[2])
      const name  = hit[1].match(/^\d+$/) ? hit[2] : hit[1]
      if (count > 0 && count < 500 && name.length > 2)
        for (let i = 0; i < count; i++) items.push({ typeName: name.trim(), typeId: null })
    })
  }

  // Strategy 3: raw text pattern  "N ShipName"
  if (items.length === 0) {
    const text = doc.body?.textContent ?? ''
    const re = /\b(\d{1,3})\s+([A-Z][A-Za-z' \-]{2,40}?)(?=\s*\d|\s*\n|\s{2,}|$)/g
    let hit: RegExpExecArray | null
    while ((hit = re.exec(text)) !== null) {
      const count = parseInt(hit[1])
      const name  = hit[2].trim()
      if (name.length < 3 || count >= 500) continue
      for (let i = 0; i < count; i++) items.push({ typeName: name, typeId: null })
    }
  }

  if (items.length === 0) throw new Error('Geen schepen gevonden in dscan')

  // Resolve names to type IDs
  const needsResolve = [...new Set(items.filter(i => i.typeId == null).map(i => i.typeName))]
  const nameMap = await resolveTypeIds(needsResolve)

  // Group by type
  const groups = new Map<string, DscanGroup>()
  for (const item of items) {
    const typeId = item.typeId ?? nameMap.get(item.typeName) ?? null
    const key    = typeId != null ? `id:${typeId}` : `name:${item.typeName}`
    const g      = groups.get(key)
    if (g) g.count++
    else groups.set(key, { typeName: item.typeName, typeId, count: 1 })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

async function resolveTypeIds(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (names.length === 0) return out
  await Promise.all(names.map(async name => {
    try {
      const res = await fetch(
        `https://esi.evetech.net/latest/search/?categories=inventory_type&search=${encodeURIComponent(name)}&strict=true&datasource=tranquility`
      )
      if (!res.ok) return
      const data = await res.json()
      const ids: number[] = data.inventory_type ?? []
      if (ids.length > 0) out.set(name, ids[0])
    } catch { /* ignore */ }
  }))
  return out
}
