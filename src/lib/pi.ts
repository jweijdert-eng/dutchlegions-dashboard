/**
 * De rekenkern van de PI-planner.
 *
 * Losgetrokken uit de pagina zodat de opmaak opnieuw kan zonder de wiskunde aan
 * te raken. Wat hier staat is in de praktijk rechtgezet, en dat is niet
 * vrijblijvend:
 *
 *  - **Hall's stelling** voor het planeetbeslag: overlappende grondstoftypes
 *    delen dezelfde fysieke planeten, dus per grondstof optellen liegt.
 *  - **Een systeem per karakter** via max-flow: je kunt een kolonie alleen
 *    bedienen als je in dat systeem bent.
 *  - **Meerdere kolonies per planeet**: elk karakter mag zijn eigen command
 *    center op dezelfde planeet zetten.
 *  - **P4 hoort op Barren of Temperate**: een High-Tech Production Plant kan
 *    nergens anders staan.
 */

interface Pin { type_id: number; is_input: boolean; quantity: number }
export interface Schem { schematic_name: string; cycle_time: number; pins: Pin[] }

/* Eén voorgestelde planeet in het plan. */
export interface Voorstel {
  systeem: string; sprongen: number; straal?: number
  planeet: string; type: string; rol: string
  /* Tweede (of derde) kolonie op dezelfde planeet, van een ander karakter. Mag,
   * maar de extractors delen dan dezelfde hotspots en halen dus minder. */
  gedeeld?: boolean
}

/* Een kolonie die er nú staat, uit ESI. `voorraad` is wat er op de planeet
 * ligt tegen Jita sell — dat is wat je kwijt bent als je 'm weggooit zonder
 * eerst te lanceren. */
export interface Kolonie {
  planetId: number; charId: number; charNaam: string
  naam: string; systeemId: number; type: string
  pins: number; voorraad: number; extractieTot: number | null
}

/* De Squall (type 81008) heeft 45.000 m³ infrastructure hold naast 3.000 m³
 * cargo — opgevraagd uit ESI, dogma-attribuut 5646. */
export const SQUALL = 45000

/* CPU-verbruik per gebouw, opgevraagd uit ESI (dogma 49 'CPU Load').
 *
 * Het budget van een command center is 1.675 plus 5.000 per niveau Command
 * Center Upgrades. ESI geeft die bonus niet prijs, dus dit is nagerekend aan
 * een echte kolonie: een character met CCU 4 had een launchpad plus achttien
 * advanced factories staan — 12.600 CPU — en de game liet dat toe. Met de
 * 2.300 per niveau die hier eerst stond zou dat niet gepast hebben.
 *
 * Links kosten er nog bovenop, naar rato van hun lengte; vandaar dat de planner
 * de kleinste planeten uitkiest. */
export const CPU = { launchpad: 3600, ecu: 400, basis: 200, geavanceerd: 500, opslag: 500 }
/* Een Storage Facility houdt 12.000 m³ vast tegen 500 CPU; een launchpad 10.000
 * tegen 3.600. Een launchpad kan als enige naar de customs office schieten, dus
 * daar heb je er één van nodig — al het bufferen doe je met storage. */
export const ccBudget = (niveau: number) => 1675 + 5000 * niveau

/* Planeettypes. De id's staan in de SDE, de namen niet in type-names.json. */
export const PLANEETTYPE: Record<number, string> = {
  11: 'Temperate', 12: 'Ice', 13: 'Gas', 2014: 'Oceanic', 2015: 'Lava',
  2016: 'Barren', 2017: 'Storm', 2063: 'Plasma', 30889: 'Shattered',
}
export const PLANEETKLEUR: Record<string, string> = {
  Temperate: '#3ecf6e', Barren: '#a78bfa', Gas: '#f97316', Ice: '#00b4d8',
  Lava: '#e05555', Oceanic: '#0ea5e9', Plasma: '#f0c040', Storm: '#c8ddf0',
  Shattered: '#8a93a8',
}

/* Welke grondstof op welk planeettype voorkomt.
 *
 * Dit is een SPELREGEL, geen data: het staat niet in de SDE en niet in ESI.
 * Ik heb het er niet uit kunnen halen, dus het staat hier met de hand — stabiel
 * al jaren, maar als CCP het ooit wijzigt moet dit mee.
 *
 * De namen moeten LETTERLIJK kloppen met die in de SDE, anders lijkt een
 * grondstof nergens te halen en valt een heel product af. Twee die dat hier
 * deden: het is 'Microorganisms' (één woord, niet 'Micro Organisms'), en
 * 'Heavy Water' komt in géén enkel recept voor — die stond er ten onrechte. */
export const PLANEET_P0: Record<string, string[]> = {
  Temperate: ['Aqueous Liquids', 'Autotrophs', 'Carbon Compounds', 'Complex Organisms', 'Microorganisms'],
  Ice: ['Aqueous Liquids', 'Microorganisms', 'Noble Gas', 'Planktic Colonies'],
  Gas: ['Aqueous Liquids', 'Base Metals', 'Ionic Solutions', 'Noble Gas', 'Reactive Gas'],
  Oceanic: ['Aqueous Liquids', 'Carbon Compounds', 'Complex Organisms', 'Microorganisms', 'Planktic Colonies'],
  Lava: ['Base Metals', 'Felsic Magma', 'Heavy Metals', 'Non-CS Crystals', 'Suspended Plasma'],
  Barren: ['Aqueous Liquids', 'Base Metals', 'Carbon Compounds', 'Microorganisms', 'Noble Metals'],
  Storm: ['Aqueous Liquids', 'Base Metals', 'Ionic Solutions', 'Noble Gas', 'Suspended Plasma'],
  Plasma: ['Base Metals', 'Heavy Metals', 'Noble Metals', 'Non-CS Crystals', 'Suspended Plasma'],
}

/* Waar een High-Tech Production Plant mag staan. */
export const P4_PLANEET = ['Barren', 'Temperate']

export const ROMEINS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV']

export const fmt = (n: number, d = 0) =>
  n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d })
export const fmtISK = (n: number) =>
  n >= 1e9 ? `${fmt(n / 1e9, 2)} mld` : n >= 1e6 ? `${fmt(n / 1e6, 1)} mln` : fmt(n)

/* ── laden ─────────────────────────────────────────────────────────────── */
const bestand = <T,>(pad: string, leeg: T) => {
  let p: Promise<T> | null = null
  return () => (p ??= fetch(pad).then(r => r.json()).catch(() => leeg))
}
export const laadSchematics = bestand<Record<string, Schem>>('/schematics.json', {})
export const laadNamen = bestand<Record<string, string>>('/type-names.json', {})
export const laadPlaneten = bestand<Record<string, [number, number, number][]>>('/planets.json', {})
export const laadSystemen = bestand<Record<string, [string, number, number]>>('/systems.json', {})
export const laadTypeInfo = bestand<Record<string, [number, number, number]>>('/type-info.json', {})
export const laadSprongen = bestand<Record<string, number[]>>('/system-jumps.json', {})

export async function jitaPrijzen(ids: number[]): Promise<Map<number, number>> {
  const uit = new Map<number, number>()
  if (!ids.length) return uit
  try {
    const r = await fetch(
      `https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=${ids.join(',')}`,
      { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    for (const [id, v] of Object.entries<any>(d)) uit.set(Number(id), Number(v?.sell?.min) || 0)
  } catch { /* zonder prijzen werkt de rest gewoon */ }
  return uit
}

/* ── de keten uitrekenen ───────────────────────────────────────────────── */
export interface Stap { naam: string; typeId: number; fabrieken: number; perUur: number;
                 tier: number; opExtractie: boolean
                 /* 1..4 = P1..P4. Niet hetzelfde als `tier`: dat is een
                  * volgnummer binnen déze keten. */
                 niveau: number }
export interface Keten { doelId: number; stappen: Stap[]; p0: { naam: string; perUur: number }[] }

/**
 * Op welk P-niveau zit dit product? Alleen P0 als invoer is P1, en elke laag
 * daarboven telt er één bij op. De `bezig`-set vangt een recept dat (door een
 * fout in de data) naar zichzelf zou wijzen.
 */
function niveauVan(typeId: number, opId: Map<number, Schem>, bezig: Set<number>): number {
  const s = opId.get(typeId)
  if (!s || bezig.has(typeId)) return 0
  bezig.add(typeId)
  let diepste = 0
  for (const inp of s.pins.filter(p => p.is_input)) {
    diepste = Math.max(diepste, niveauVan(inp.type_id, opId, bezig))
  }
  bezig.delete(typeId)
  return diepste + 1
}

export function bouwKeten(sch: Record<string, Schem>, namen: Record<string, string>,
                   doel: string, lijnen: number): Keten | null {
  /* Koppelen op type-id en niet op naam. Drie schematics heten net anders dan
   * hun product — 'Ukomi Superconductor' maakt 'Ukomi Superconductors',
   * enkelvoud tegen meervoud, net als High-Tech Transmitter(s) en Transcranial
   * Microcontroller(s). Op naam matchen zag die als grondstof, waardoor elke
   * keten die ze gebruikt (de meeste P4's) stukliep op "geen planeet levert
   * High-Tech Transmitters". */
  const opId = new Map<number, Schem>()
  const opNaam = new Map<string, Schem>()
  for (const s of Object.values(sch)) {
    opNaam.set(s.schematic_name, s)
    const uit = s.pins.find(p => !p.is_input)
    if (uit) opId.set(uit.type_id, s)
  }
  const start = opNaam.get(doel)
  if (!start) return null

  const stappen = new Map<number, Stap>()
  const p0 = new Map<string, number>()

  const loop = (s: Schem, fabrieken: number, tier: number) => {
    const uit = s.pins.find(p => !p.is_input)!
    const perUur = uit.quantity * (3600 / s.cycle_time) * fabrieken
    const b = stappen.get(uit.type_id)
    if (b) { b.fabrieken += fabrieken; b.perUur += perUur }
    else {
      // Alleen P0 als invoer = een P1-fabriek, en die hoort op de
      // extractieplaneet zelf; anders sleep je vier keer zo veel volume.
      const alleenP0 = s.pins.filter(p => p.is_input).every(p => !opId.has(p.type_id))
      stappen.set(uit.type_id, {
        naam: namen[String(uit.type_id)] ?? s.schematic_name,
        typeId: uit.type_id, fabrieken, perUur, tier, opExtractie: alleenP0,
        niveau: niveauVan(uit.type_id, opId, new Set()),
      })
    }
    for (const inp of s.pins.filter(p => p.is_input)) {
      const nodig = inp.quantity * (3600 / s.cycle_time) * fabrieken   // stuks/uur
      const bron = opId.get(inp.type_id)
      if (!bron) {
        const rn = namen[String(inp.type_id)] ?? String(inp.type_id)
        p0.set(rn, (p0.get(rn) ?? 0) + nodig)
        continue
      }
      const bronUit = bron.pins.find(p => !p.is_input)!
      loop(bron, nodig / (bronUit.quantity * (3600 / bron.cycle_time)), tier - 1)
    }
  }
  loop(start, lijnen, 9)

  const lijst = [...stappen.values()].sort((a, b) => b.tier - a.tier)
  lijst.forEach((s, i) => { s.tier = lijst.length - i })
  return {
    doelId: start.pins.find(p => !p.is_input)!.type_id,
    stappen: lijst,
    p0: [...p0.entries()].map(([naam, perUur]) => ({ naam, perUur }))
      .sort((a, b) => a.naam.localeCompare(b.naam)),
  }
}

/* ── past deze keten in je slots? ──────────────────────────────────────────
 * Losgetrokken van de pagina omdat de ranglijst hem voor élk product draait,
 * niet alleen voor het gekozen product. */
export interface Pasvorm { lijnen: number; extractie: number; fabriek: number; rem: string
                    tekort: { naam: string; perUur: number }[]; fabriekenPerLijn: number
                    /* Wat één enkele lijn kost. Zonder dit staat er bij een product dat
                     * niet past alleen "0 lijnen", en dan weet je niet of je er één
                     * planeet naast zit of tien. */
                    voorEenLijn: number }

export function pasIn(keten: Keten, vrijePlaneten: string[], oogst: number,
               slots: number, perFabriekPlaneet: number, accounts = 1): Pasvorm {
  const nodig = keten.p0
  const tekort = nodig.filter(r =>
    !vrijePlaneten.some(t => (PLANEET_P0[t] ?? []).includes(r.naam)))

  /* Zonder een grens op het aantal beschikbare planeten beloofde de planner
   * 4 Robotics-lijnen terwijl er maar 6 Lava-planeten binnen bereik liggen en
   * er 8 nodig zijn: slots genoeg, planeten niet. */

  /* Alleen P2 en hoger tellen mee voor de fabrieksplaneten; de P1-fabrieken
   * draaien op de extractieplaneten waar de grondstof vandaan komt. */
  const fabriekenPerLijn = keten.stappen
    .filter(s => !s.opExtractie)
    .reduce((a, s) => a + Math.ceil(s.fabrieken), 0)

  /* Elk karakter mag een eigen kolonie op dezelfde planeet zetten, dus wat er
   * ligt telt maal het aantal karakters. Zonder dit rekende de planner vier
   * Lava-planeten als vier kolonies terwijl het er met vier accounts zestien
   * kunnen zijn. */
  const telling: Record<string, number> = {}
  for (const t of vrijePlaneten) telling[t] = (telling[t] ?? 0) + Math.max(1, accounts)
  /* Fabrieken mogen op elk type — behalve Shattered, daar kun je geen PI op
   * neerzetten. PLANEET_P0 kent Shattered niet, dus die sleutels zijn precies
   * de bruikbare types. */
  const alleTypes = Object.keys(PLANEET_P0)

  const beste = { lijnen: 0, extractie: 0, fabriek: 0, rem: '', voorEenLijn: 0 }
  for (let L = 1; L <= 40; L++) {
    const perGrondstof = nodig.map(r => ({
      types: Object.keys(PLANEET_P0).filter(ty => PLANEET_P0[ty].includes(r.naam)),
      n: Math.ceil(r.perUur * L / Math.max(1, oogst)),
    }))
    const ex = perGrondstof.reduce((a, x) => a + x.n, 0)
    const fab = Math.ceil(fabriekenPerLijn * L / Math.max(1, perFabriekPlaneet))
    if (L === 1) beste.voorEenLijn = ex + fab
    const bot = knelpunt([...perGrondstof, { types: alleTypes, n: fab }], telling)
    if (bot) { beste.rem = `te weinig ${bot}-planeten`; break }
    if (ex + fab > slots) { beste.rem = 'slots op'; break }
    beste.lijnen = L; beste.extractie = ex; beste.fabriek = fab
  }
  return { ...beste, tekort, fabriekenPerLijn }
}

/* ── één systeem per karakter ──────────────────────────────────────────────
 *
 * Je kunt een kolonie alleen bedienen als je ín dat systeem bent. Een plan dat
 * één karakter over drie systemen uitsmeert laat je dus elke ophaalronde heen
 * en weer vliegen. Hieronder kiest elk karakter één systeem en pakt daar zijn
 * planeten — het aantal slots van dat karakter is meteen het plafond van dat
 * systeem.
 *
 * Dat is geen simpele telling meer: de vraag naar planeettypes en de grens per
 * systeem grijpen in elkaar. Het is wél precies een stroomprobleem —
 * vraag → (systeem, type) → systeem → put, met de slots als capaciteit op de
 * laatste pijl. Max-flow zegt of alles rondkomt én wáár elke planeet vandaan
 * komt, dus het voorstel valt eruit zonder tweede rekenslag. */
function maxflow(n: number, edges: [number, number, number][], s: number, t: number) {
  const g: { v: number; c: number; r: number }[][] = Array.from({ length: n }, () => [])
  const plek: [number, number][] = []
  for (const [u, v, c] of edges) {
    plek.push([u, g[u].length])
    g[u].push({ v, c, r: g[v].length })
    g[v].push({ v: u, c: 0, r: g[u].length - 1 })
  }
  let totaal = 0
  for (;;) {
    const vorig: ([number, number] | null)[] = new Array(n).fill(null)
    vorig[s] = [-1, -1]
    const rij = [s]
    while (rij.length) {
      const u = rij.shift()!
      for (let i = 0; i < g[u].length; i++) {
        const e = g[u][i]
        if (e.c > 0 && vorig[e.v] === null) { vorig[e.v] = [u, i]; rij.push(e.v) }
      }
    }
    if (vorig[t] === null) break
    let extra = Infinity
    for (let v = t; v !== s;) { const [u, i] = vorig[v]!; extra = Math.min(extra, g[u][i].c); v = u }
    for (let v = t; v !== s;) {
      const [u, i] = vorig[v]!
      g[u][i].c -= extra; g[g[u][i].v][g[u][i].r].c += extra; v = u
    }
    totaal += extra
  }
  return { totaal, gebruikt: (i: number) => edges[i][2] - g[plek[i][0]][plek[i][1]].c }
}

export interface SysKeuze { naam: string; sprongen: number; slots: number
                            /* Hoeveel karakters er in dit systeem zitten. Elk karakter mag
                             * zijn eigen kolonie op dezelfde planeet zetten (één command
                             * center per planeet PER karakter), dus dit is de vermenig-
                             * vuldiger op alles wat er ligt. */
                            kar: number
                            perType: Record<string, number> }
export interface Toewijzing { sys: number; type: string; vraag: number; aantal: number }

/* Lost de verdeling op voor één concrete systeem/karakter-indeling.
 * `vragen[i].alleenSys` beperkt een vraag tot één systeem — zo kun je eerst
 * proberen de fabrieken thuis te houden. */
export function verdeelOverSystemen(
  vragen: { types: string[]; n: number; alleenSys?: number }[],
  keuze: SysKeuze[],
): Toewijzing[] | null {
  const S = keuze.length
  const ptNode = new Map<string, number>()
  let n = 1 + vragen.length
  for (let j = 0; j < S; j++) for (const ty of Object.keys(keuze[j].perType)) ptNode.set(`${j}|${ty}`, n++)
  const sysNode = n; n += S
  const put = n++

  const edges: [number, number, number][] = []
  const herkomst: { vraag: number; sys: number; type: string }[] = []
  let vraagTotaal = 0
  vragen.forEach((q, i) => { edges.push([0, 1 + i, q.n]); herkomst.push({ vraag: -1, sys: -1, type: '' }); vraagTotaal += q.n })
  vragen.forEach((q, i) => {
    for (let j = 0; j < S; j++) {
      if (q.alleenSys !== undefined && q.alleenSys !== j) continue
      for (const ty of q.types) {
        const k = ptNode.get(`${j}|${ty}`)
        if (k === undefined) continue
        edges.push([1 + i, k, keuze[j].perType[ty] * Math.max(1, keuze[j].kar)])
        herkomst.push({ vraag: i, sys: j, type: ty })
      }
    }
  })
  for (let j = 0; j < S; j++) for (const [ty, aantal] of Object.entries(keuze[j].perType)) {
    edges.push([ptNode.get(`${j}|${ty}`)!, sysNode + j, aantal * Math.max(1, keuze[j].kar)])
    herkomst.push({ vraag: -1, sys: -1, type: '' })
  }
  for (let j = 0; j < S; j++) { edges.push([sysNode + j, put, keuze[j].slots]); herkomst.push({ vraag: -1, sys: -1, type: '' }) }

  const { totaal, gebruikt } = maxflow(n, edges, 0, put)
  if (totaal !== vraagTotaal) return null
  const uit: Toewijzing[] = []
  for (let i = 0; i < edges.length; i++) {
    const h = herkomst[i]
    if (h.vraag < 0) continue
    const a = gebruikt(i)
    if (a > 0) uit.push({ sys: h.sys, type: h.type, vraag: h.vraag, aantal: a })
  }
  return uit
}

export const combinaties = <T,>(a: T[], k: number): T[][] =>
  k === 0 ? [[]] : a.length < k ? []
    : [...combinaties(a.slice(1), k - 1).map(c => [a[0], ...c]), ...combinaties(a.slice(1), k)]

/* Alle manieren om de karakters over m gekozen systemen te verdelen, met
 * minstens één karakter per systeem.
 *
 * Eerder kreeg elk karakter zijn eigen systeem, en dat was te streng: je mag
 * met meerdere karakters in hetzelfde systeem zitten en dan allemaal een eigen
 * kolonie op dezelfde planeet neerzetten. Rond Q-02UL liggen maar vier
 * Lava-planeten in twee systemen; onder de oude aanname stopte de planner
 * daarom bij twee karakters, terwijl vier karakters samen in één systeem er
 * gewoon vier kolonies per planeet naast kunnen zetten.
 *
 * Ontdubbeld op de vorm (aantal karakters + slots per systeem): met vier
 * karakters van 6/5/5/5 slots zijn er maar een handvol echt verschillende
 * verdelingen. */
export function slotGroepen(slots: number[], m: number): { kar: number; slots: number }[][] {
  if (m > slots.length) return []
  const uit = new Map<string, { kar: number; slots: number }[]>()
  const groepen: number[][] = Array.from({ length: m }, () => [])
  const loop = (i: number) => {
    if (uit.size > 300) return                    // rem, anders loopt het uit de hand
    if (i === slots.length) {
      if (groepen.some(g => g.length === 0)) return
      const vorm = groepen.map(g => ({ kar: g.length, slots: g.reduce((a, b) => a + b, 0) }))
      uit.set(vorm.map(v => `${v.kar}:${v.slots}`).join('|'), vorm)
      return
    }
    for (let j = 0; j < m; j++) { groepen[j].push(slots[i]); loop(i + 1); groepen[j].pop() }
  }
  loop(0)
  return [...uit.values()]
}

export interface PasvormSys extends Pasvorm { keuze: SysKeuze[]; toewijzing: Toewijzing[] }

export function pasInSystemen(keten: Keten, kandidaten: SysKeuze[], slots: number[],
                       oogst: number, perFabriekPlaneet: number): PasvormSys {
  const alleTypes = Object.keys(PLANEET_P0)
  const alle = kandidaten.flatMap(s => Object.entries(s.perType).flatMap(([t, n]) => Array(n).fill(t) as string[]))
  const tekort = keten.p0.filter(r => !alle.some(t => (PLANEET_P0[t] ?? []).includes(r.naam)))
  const fabriekenPerLijn = keten.stappen.filter(s => !s.opExtractie)
    .reduce((a, s) => a + Math.ceil(s.fabrieken), 0)
  /* Een High-Tech Production Plant (P4) kan alleen op Barren of Temperate.
   * Die fabrieken vragen dus om een ander soort planeet dan de rest. */
  const p4PerLijn = keten.stappen.filter(s => !s.opExtractie && s.niveau >= 4)
    .reduce((a, s) => a + Math.ceil(s.fabrieken), 0)
  const totaalSlots = slots.reduce((a, b) => a + b, 0)

  /* Grotere systemen eerst, want die kunnen een heel karakter vullen; en niet
   * meer dan acht kandidaten, anders loopt het aantal combinaties op. */
  const lijst = kandidaten.slice()
    .sort((a, b) => a.sprongen - b.sprongen
      || Object.values(b.perType).reduce((x, y) => x + y, 0) - Object.values(a.perType).reduce((x, y) => x + y, 0))
    .slice(0, 8)

  const leeg: PasvormSys = { lijnen: 0, extractie: 0, fabriek: 0, rem: '', tekort,
    fabriekenPerLijn, voorEenLijn: 0, keuze: [], toewijzing: [] }
  let beste = leeg

  for (let L = 1; L <= 40; L++) {
    const vragen = keten.p0.map(r => ({
      types: alleTypes.filter(ty => PLANEET_P0[ty].includes(r.naam)),
      n: Math.ceil(r.perUur * L / Math.max(1, oogst)),
    }))
    const ex = vragen.reduce((a, q) => a + q.n, 0)
    const perPl = Math.max(1, perFabriekPlaneet)
    const fabP4 = Math.ceil(p4PerLijn * L / perPl)
    const fabRest = Math.ceil((fabriekenPerLijn - p4PerLijn) * L / perPl)
    const fab = fabP4 + fabRest
    if (L === 1) beste.voorEenLijn = ex + fab
    if (ex + fab > totaalSlots) { beste.rem = 'slots op'; break }

    let gelukt: { keuze: SysKeuze[]; toewijzing: Toewijzing[] } | null = null
    /* Weinig systemen eerst: samen in één systeem zitten is bijna altijd
     * handiger dan uitwaaieren, en het scheelt ophaalrondes. */
    for (let m = 1; m <= Math.min(slots.length, lijst.length) && !gelukt; m++) {
      for (const combo of combinaties(lijst, m)) {
        for (const indeling of slotGroepen(slots, m)) {
          const keuze = combo.map((s, i) => ({ ...s, slots: indeling[i].slots, kar: indeling[i].kar }))
          /* Eerst proberen de fabrieken bij elkaar te houden in het systeem
           * dat het dichtst bij huis ligt: daar komt alle P1 samen. */
          const thuisIdx = keuze.reduce((b, s, i) => s.sprongen < keuze[b].sprongen ? i : b, 0)
          const metFab = (alleenSys?: number) =>
            verdeelOverSystemen([...vragen,
              { types: P4_PLANEET, n: fabP4, alleenSys },
              { types: alleTypes, n: fabRest, alleenSys }], keuze)
          const t = metFab(thuisIdx) ?? metFab()
          if (t) { gelukt = { keuze, toewijzing: t }; break }
        }
        if (gelukt) break
      }
    }
    if (!gelukt) { beste.rem = 'geen verdeling die past'; break }
    beste = { ...beste, lijnen: L, extractie: ex, fabriek: fab, ...gelukt }
  }
  return beste
}

/* Past deze vraag naar planeten op wat er ligt?
 *
 * Optellen per grondstof afzonderlijk is niet genoeg: één planeet kan maar één
 * kolonie dragen, en de typegroepen overlappen. Aqueous Liquids mag op zes
 * types, Ionic Solutions op twee daarvan — apart geteld passen ze allebei,
 * samen niet. Vanuit Q-02UL beloofde de oude telling 15 kolonies op 8 planeten.
 *
 * Dit is de stelling van Hall: er is pas een geldige verdeling als voor élke
 * deelverzameling van de vragen het aantal planeten in de vereniging van hun
 * types minstens zo groot is als de opgetelde vraag. Vier à vijf grondstoffen
 * plus de fabrieken is hooguit 63 deelverzamelingen — goedkoop genoeg om per
 * product te doen. Geeft de knellende typegroep terug, of null als het past. */
export function knelpunt(vragen: { types: string[]; n: number }[],
                  telling: Record<string, number>): string | null {
  const k = vragen.length
  for (let m = 1; m < (1 << k); m++) {
    let som = 0
    const uni = new Set<string>()
    for (let i = 0; i < k; i++) if (m & (1 << i)) {
      som += vragen[i].n
      for (const t of vragen[i].types) uni.add(t)
    }
    let hebben = 0
    for (const t of uni) hebben += telling[t] ?? 0
    if (som > hebben) return [...uni].sort().join('/')
  }
  return null
}

/* Eenmalige verhuizing naar Q-02UL (Delve).
 *
 * De oude waarden stonden al in localStorage, dus een andere default alleen
 * doet niets. Dit draait één keer per browser en laat alles met rust wat je
 * daarna zelf instelt.
 *
 * Het product is Neocoms: hoogste omzet van alle recepten die hier passen, en
 * dat blijft zo tot vier sprongen ver. Let op de keerzijde — Felsic Magma komt
 * alleen van Lava, en binnen twee sprongen liggen er precies vier. Vier lijnen
 * gebruiken ze alle vier, dus als een corpgenoot er al zit valt er een lijn af.
 * Condensates (2e, ~12% minder) draait op Gas, waarvan er zeventien liggen, en
 * is daarmee de uitwijk.
 *
 * Robotics kán hier niet: Heavy Metals én Non-CS Crystals komen allebei alleen
 * van Lava of Plasma, en er is geen Plasma in de buurt — twee lijnen slokken
 * dan élke Lava-planeet op. */
;(() => {
  try {
    const t = localStorage.getItem('piopzet.thuis')
    if (!localStorage.getItem('piopzet.q02ul')) {
      localStorage.setItem('piopzet.q02ul', '1')
      if (!t || t === 'RF-K9W') localStorage.setItem('piopzet.thuis', 'Q-02UL')
      /* AJI-MA lag bij het oude thuissysteem; als uitsluiting hier zinloos. */
      if (localStorage.getItem('piopzet.uit') === '["AJI-MA"]')
        localStorage.setItem('piopzet.uit', '[]')
    }
    /* Tweede stap: eerst stond Condensates ingesteld, tot de ranglijst met
     * echte Jita-prijzen erbij kwam. Neocoms staat daar bovenaan. */
    if (!localStorage.getItem('piopzet.doel_neocom')) {
      localStorage.setItem('piopzet.doel_neocom', '1')
      const d = localStorage.getItem('piopzet.doel')
      if (!d || d === 'Robotics' || d === 'Condensates')
        localStorage.setItem('piopzet.doel', 'Neocoms')
    }
  } catch { /* privémodus zonder localStorage: gewoon de defaults */ }
})()

/* ── pagina ────────────────────────────────────────────────────────────── */

/**
 * Van "zoveel planeten van dit type in dat systeem" naar concrete bolletjes.
 *
 * De max-flow heeft al bepaald wélk systeem wat levert; hier wordt per systeem
 * gekozen wélke planeet. Waar je al staat gaat voor (dan hoef je niets af te
 * breken), daarna de kleinste - kortere links kosten minder CPU.
 */
export function kiesPlaneten(
  plan: PasvormSys, keten: Keten,
  buurt: { naam: string; planeten: { idx: number; type: string; straal?: number }[] }[],
  bezet: Set<string>,
): { kop: string; planeten: Voorstel[]; kar: number; slots: number }[] {
  return plan.keuze.map((sys, j) => {
      const inSysteem = buurt.find(b => b.naam === sys.naam)
      const vrij = (inSysteem?.planeten ?? []).slice()
        /* Binnen één systeem scheelt de afstand niets meer, dus: eerst een
         * planeet waar je al staat, dan de kleinste (kortere links). */
        .sort((a, b) =>
          (bezet.has(`${sys.naam} ${ROMEINS[a.idx]}`) ? 0 : 1)
          - (bezet.has(`${sys.naam} ${ROMEINS[b.idx]}`) ? 0 : 1)
          || (a.straal ?? 0) - (b.straal ?? 0))
      /* Hoe vaak een planeet al gebruikt is. Zitten er meerdere karakters in
       * dit systeem, dan mag dezelfde planeet net zo vaak terugkomen: elk
       * karakter zet er zijn eigen kolonie op. */
      const gebruikt = new Map<number, number>()
      const ruimte = Math.max(1, sys.kar)
      const pak = (type: string, aantal: number, rol: string): Voorstel[] => {
        const uit: Voorstel[] = []
        /* Eerst iedereen op een eigen planeet; pas als die op zijn een tweede
         * kolonie ernaast. Zo stapel je alleen waar het echt moet - en dat is
         * ook waar de opbrengst per extractor gaat zakken. */
        for (let ronde = 0; ronde < ruimte && uit.length < aantal; ronde++) {
          for (const pl of vrij) {
            if (uit.length >= aantal) break
            if (pl.type !== type || (gebruikt.get(pl.idx) ?? 0) > ronde) continue
            gebruikt.set(pl.idx, (gebruikt.get(pl.idx) ?? 0) + 1)
            uit.push({ systeem: sys.naam, sprongen: sys.sprongen, straal: pl.straal,
              planeet: `${sys.naam} ${ROMEINS[pl.idx]}`, type: pl.type, rol,
              /* tweede kolonie op dezelfde planeet: die deelt de hotspots */
              gedeeld: ronde > 0 })
          }
        }
        return uit
      }
      /* Fabrieken eerst: die krijgen zo de kleinste planeten, en juist zij
       * hebben de meeste links (launchpad naar vijf fabrieken). */
      const isFabriek = (nr: number) => nr >= keten.p0.length
      /* Dezelfde telling als in pasInSystemen: zit er P4 in de keten, dan is
       * de eerste fabrieksvraag die van de High-Tech Production Plants. */
      const p4PerLijn = keten.stappen
        .filter(st => !st.opExtractie && st.niveau >= 4).length
      /* Hoe de fabrieksregel heet, hangt af van wat er in deze keten zit:
       * bij een P3-product staan er P2- en P3-fabrieken, bij een P4 ook een
       * High-Tech Production Plant - en die kan alleen op Barren/Temperate. */
      const fabTop = Math.max(2, ...keten.stappen.filter(st => !st.opExtractie)
        .map(st => st.niveau))
      /* Welke niveaus er op een gewone fabrieksplaneet draaien: bij een
       * P3-keten P2 én P3, bij een P4-keten dezelfde twee (de P4 zelf staat
       * apart, want die vraagt om Barren of Temperate). */
      const gewoonTop = Math.min(fabTop, p4PerLijn > 0 ? 3 : fabTop)
      const fabNaam = (nr: number) => nr === keten.p0.length && p4PerLijn > 0
        ? 'High-Tech Production Plant (P4)'
        : `Advanced Industry Facility (P2${gewoonTop > 2 ? `/P${gewoonTop}` : ''})`
      const mijn = plan.toewijzing.filter(t => t.sys === j)
        .sort((a, b) => (isFabriek(b.vraag) ? 1 : 0) - (isFabriek(a.vraag) ? 1 : 0))
        .flatMap(t => pak(t.type, t.aantal,
          isFabriek(t.vraag) ? fabNaam(t.vraag) : `${keten.p0[t.vraag].naam} → P1`))
      const kop = `${sys.naam} — ${mijn.length} van ${sys.slots} slots`
        + (sys.kar > 1 ? ` · ${sys.kar} karakters` : '')
      return { kop, planeten: mijn, kar: sys.kar, slots: sys.slots }
  }).filter(v => v.planeten.length > 0)
}

/**
 * Hetzelfde plan, maar dan per account in plaats van per systeem.
 *
 * De planner denkt in systemen; jij logt in per account. Zitten er twee
 * karakters in hetzelfde systeem, dan moeten we weten wélke twee - het plan
 * weet alleen "twee karakters, samen elf slots". Met een handvol accounts is
 * alle combinaties aflopen goedkoop genoeg om dat exact te maken.
 */
export function perAccount(
  vakjes: { planeten: Voorstel[]; kar: number; slots: number }[],
  accountSlots: number[],
): { nr: number; slots: number; systeem: string; rijen: Voorstel[] }[] {
  const over = accountSlots.map((slots, i) => ({ nr: i + 1, slots, vrij: true }))

  const kies = (kar: number, slots: number) => {
    const pool = over.filter(a => a.vrij)
    const zoek = (i: number, gekozen: typeof pool): typeof pool | null => {
      const som = gekozen.reduce((n, a) => n + a.slots, 0)
      if (gekozen.length === kar) return som === slots ? gekozen : null
      if (i >= pool.length || som > slots) return null
      return zoek(i + 1, [...gekozen, pool[i]]) ?? zoek(i + 1, gekozen)
    }
    /* Komt het niet precies uit, dan de grootste accounts eerst: liever een
     * benadering dan helemaal geen indeling. */
    const uit = zoek(0, []) ?? pool.slice().sort((a, b) => b.slots - a.slots).slice(0, kar)
    for (const a of uit) a.vrij = false
    return uit
  }

  const uit: { nr: number; slots: number; systeem: string; rijen: Voorstel[] }[] = []
  for (const vak of vakjes) {
    const systeem = vak.planeten[0]?.systeem ?? ''
    const emmers = kies(Math.max(1, vak.kar), vak.slots)
      .map(a => ({ ...a, rijen: [] as Voorstel[] }))
    /* Uitdelen over de accounts.
     *
     * Eén karakter kan maar één kolonie per planeet hebben; een tweede kolonie
     * op dezelfde planeet hoort dus bij een ánder account. Twee dingen zijn
     * daarvoor nodig:
     *
     *  1. **De gedeelde planeten eerst.** Deel je op volgorde uit, dan zit de
     *     ruimte bij de andere accounts al vol tegen de tijd dat de tweede
     *     kolonie aan de beurt is, en blijft alleen het account over dat die
     *     planeet al heeft. Zo kreeg account 1 dezelfde planeet twee keer.
     *  2. **Zo veel mogelijk op één account.** Account 1 eerst helemaal vol,
     *     dan pas account 2. Dat scheelt inloggen: elke kolonie erbij op een
     *     nieuw karakter is weer een client die je moet openen om te oogsten.
     */
    const kolonies = new Map<string, number>()
    for (const r of vak.planeten) kolonies.set(r.planeet, (kolonies.get(r.planeet) ?? 0) + 1)
    const volgorde = [...vak.planeten].sort(
      (a, b) => (kolonies.get(b.planeet) ?? 0) - (kolonies.get(a.planeet) ?? 0))

    emmers.sort((a, b) => a.nr - b.nr)
    for (const rij of volgorde) {
      // Het eerste account dat nog ruimte heeft en deze planeet nog niet heeft.
      const doel = emmers.find(e => e.rijen.length < e.slots
                                    && !e.rijen.some(r => r.planeet === rij.planeet))
      /* Past hij nergens meer, dan valt de regel weg. Dat is geen mooie
       * uitkomst, maar hem tóch bij een account zetten levert een kolonie op
       * die je in het spel niet kunt neerzetten - en daar heb je niets aan. */
      if (doel) doel.rijen.push(rij)
    }
    for (const e of emmers) {
      e.rijen.sort((a, b) => vak.planeten.indexOf(a) - vak.planeten.indexOf(b))
    }
    for (const e of emmers) {
      if (e.rijen.length) uit.push({ nr: e.nr, slots: e.slots, systeem, rijen: e.rijen })
    }
  }
  return uit.sort((a, b) => a.nr - b.nr)
}
