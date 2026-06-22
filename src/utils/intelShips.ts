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

// Runtime-map: hardcoded shorthand (dread/carrier/supers/…) + alle SDE-schepen uit /ships.json.
let SHIP_MAP: Record<string, number> = { ...SHIP_TYPE_IDS }
const buildPattern = () => `\\b(${Object.keys(SHIP_MAP).sort((a, b) => b.length - a.length).join('|')})s?\\b`
let SHIP_PATTERN = buildPattern()

// Eénmalig alle scheepsnamen laden (zodat élk schip herkend wordt, niet alleen de ~55 shorthand).
let _loading: Promise<void> | null = null
export function loadShipNames(): Promise<void> {
  return (_loading ??= fetch('/ships.json').then(r => r.json()).then((j: Record<string, number>) => {
    SHIP_MAP = { ...j, ...SHIP_TYPE_IDS }   // shorthand wint van de volledige naam
    SHIP_PATTERN = buildPattern()
  }).catch(() => { /* val terug op de basislijst */ }))
}

// Is dit woord/frase een scheepstype? (voor de intel-enemy-resolver, om schepen uit te sluiten)
export function isShipName(word: string): boolean {
  const w = word.toLowerCase()
  return w in SHIP_MAP || w.replace(/s$/, '') in SHIP_MAP
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
export function extractShips(msg: string): { typeId: number; name: string }[] {
  const re = new RegExp(SHIP_PATTERN, 'gi')
  const results: { typeId: number; name: string }[] = []
  const seen = new Set<number>()
  let match: RegExpExecArray | null
  while ((match = re.exec(msg)) !== null) {
    const w = match[1].toLowerCase()
    const typeId = SHIP_MAP[w] ?? SHIP_MAP[w.replace(/s$/, '')] ?? null
    if (!typeId || seen.has(typeId)) continue
    seen.add(typeId)
    results.push({ typeId, name: match[1].split(/\s+/).map(cap).join(' ') })
  }
  return results
}
