// Herkent scheepstypes in een intel-bericht → EVE type-id's (voor iconen).
// Gedeeld door de Intel-pagina en de kaart-tooltip.
export const SHIP_TYPE_IDS: Record<string, number> = {
  // Interdictors
  sabre: 22456, flycatcher: 12038, heretic: 12034, eris: 12032,
  // Heavy Interdictors
  phobos: 12017, devoter: 12015, onyx: 12021, broadsword: 12019,
  // Interceptors
  stiletto: 11978, crow: 11176, malediction: 11178, ares: 11202,
  // Recons
  rapier: 11969, huginn: 12013, arazu: 11959, lachesis: 11957,
  curse: 11961, pilgrim: 11963,
  // T3 Cruisers
  tengu: 29984, proteus: 29988, loki: 29990, legion: 29986,
  // Carriers (generic → Thanatos)
  thanatos: 23919, chimera: 23917, nidhoggur: 23915, archon: 23921,
  carrier: 23919, carriers: 23919,
  // Dreads (generic → Naglfar)
  naglfar: 19720, moros: 19726, phoenix: 19722, revelation: 19724,
  dread: 19720, dreads: 19720,
  // Supercarriers
  hel: 23913, nyx: 23911, aeon: 23757, wyvern: 3514,
  super: 23913, supers: 23913,
  // Titans (generic → Avatar)
  avatar: 671, titan: 671, titans: 671,
  // Rorqual
  rorqual: 28352,
  // BLOPS (generic → Redeemer)
  redeemer: 28710, sin: 28665, widow: 28846, panther: 28659,
  blops: 28710,
  // Bombers (generic → Nemesis)
  nemesis: 12023, manticore: 12032, hound: 12034, purifier: 12038,
  bomber: 12023, bombers: 12023,
}

const SHIP_PATTERN = `\\b(${Object.keys(SHIP_TYPE_IDS).sort((a, b) => b.length - a.length).join('|')})s?\\b`

export function extractShips(msg: string): { typeId: number; name: string }[] {
  const re = new RegExp(SHIP_PATTERN, 'gi')
  const results: { typeId: number; name: string }[] = []
  const seen = new Set<number>()
  let match: RegExpExecArray | null
  while ((match = re.exec(msg)) !== null) {
    const w = match[1].toLowerCase()
    const typeId = SHIP_TYPE_IDS[w] ?? SHIP_TYPE_IDS[w.replace(/s$/, '')] ?? null
    if (!typeId || seen.has(typeId)) continue
    seen.add(typeId)
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
    results.push({ typeId, name })
  }
  return results
}
