import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'
import { useAuth } from '../auth/AuthContext'
import { getPlanets, getPlanetDetail, getPlanetInfo } from '../api/esi'

/* PI-OPZETPLANNER
 *
 * Niet te verwarren met de PI-winstplanner: die rangschikt recepten op ISK/dag.
 * Deze beantwoordt de vraag die daarna komt — "ik heb 21 planeetslots en een
 * thuissysteem, hoeveel Robotics haal ik daaruit en wélke planeten pak ik?"
 *
 * De keten komt uit schematics.json (de SDE), de planeten uit planets.json.
 * Eén ding staat in géén enkele database: hoe rijk een planeet is. Dat is een
 * ruisfunctie die je alleen in de client ziet. Vandaar dat de opbrengst per
 * extractieplaneet een invulveld is en geen berekening — alles wat daarvan
 * afhangt is dus een schatting met jouw eigen getal erin.
 */

interface Pin { type_id: number; is_input: boolean; quantity: number }
interface Schem { schematic_name: string; cycle_time: number; pins: Pin[] }

/* Eén voorgestelde planeet in het plan. */
interface Voorstel {
  systeem: string; sprongen: number; straal?: number
  planeet: string; type: string; rol: string
}

/* Een kolonie die er nú staat, uit ESI. `voorraad` is wat er op de planeet
 * ligt tegen Jita sell — dat is wat je kwijt bent als je 'm weggooit zonder
 * eerst te lanceren. */
interface Kolonie {
  planetId: number; charId: number; charNaam: string
  naam: string; systeemId: number; type: string
  pins: number; voorraad: number; extractieTot: number | null
}

/* De Squall (type 81008) heeft 45.000 m³ infrastructure hold naast 3.000 m³
 * cargo — opgevraagd uit ESI, dogma-attribuut 5646. */
const SQUALL = 45000

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
const CPU = { launchpad: 3600, ecu: 400, basis: 200, geavanceerd: 500, opslag: 500 }
/* Een Storage Facility houdt 12.000 m³ vast tegen 500 CPU; een launchpad 10.000
 * tegen 3.600. Een launchpad kan als enige naar de customs office schieten, dus
 * daar heb je er één van nodig — al het bufferen doe je met storage. */
const ccBudget = (niveau: number) => 1675 + 5000 * niveau

/* Planeettypes. De id's staan in de SDE, de namen niet in type-names.json. */
const PLANEETTYPE: Record<number, string> = {
  11: 'Temperate', 12: 'Ice', 13: 'Gas', 2014: 'Oceanic', 2015: 'Lava',
  2016: 'Barren', 2017: 'Storm', 2063: 'Plasma', 30889: 'Shattered',
}
const PLANEETKLEUR: Record<string, string> = {
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
const PLANEET_P0: Record<string, string[]> = {
  Temperate: ['Aqueous Liquids', 'Autotrophs', 'Carbon Compounds', 'Complex Organisms', 'Microorganisms'],
  Ice: ['Aqueous Liquids', 'Microorganisms', 'Noble Gas', 'Planktic Colonies'],
  Gas: ['Aqueous Liquids', 'Base Metals', 'Ionic Solutions', 'Noble Gas', 'Reactive Gas'],
  Oceanic: ['Aqueous Liquids', 'Carbon Compounds', 'Complex Organisms', 'Microorganisms', 'Planktic Colonies'],
  Lava: ['Base Metals', 'Felsic Magma', 'Heavy Metals', 'Non-CS Crystals', 'Suspended Plasma'],
  Barren: ['Aqueous Liquids', 'Base Metals', 'Carbon Compounds', 'Microorganisms', 'Noble Metals'],
  Storm: ['Aqueous Liquids', 'Base Metals', 'Ionic Solutions', 'Noble Gas', 'Suspended Plasma'],
  Plasma: ['Base Metals', 'Heavy Metals', 'Noble Metals', 'Non-CS Crystals', 'Suspended Plasma'],
}

const ROMEINS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV']

const fmt = (n: number, d = 0) =>
  n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtISK = (n: number) =>
  n >= 1e9 ? `${fmt(n / 1e9, 2)} mld` : n >= 1e6 ? `${fmt(n / 1e6, 1)} mln` : fmt(n)

/* ── laden ─────────────────────────────────────────────────────────────── */
const bestand = <T,>(pad: string, leeg: T) => {
  let p: Promise<T> | null = null
  return () => (p ??= fetch(pad).then(r => r.json()).catch(() => leeg))
}
const laadSchematics = bestand<Record<string, Schem>>('/schematics.json', {})
const laadNamen = bestand<Record<string, string>>('/type-names.json', {})
const laadPlaneten = bestand<Record<string, [number, number, number][]>>('/planets.json', {})
const laadSystemen = bestand<Record<string, [string, number, number]>>('/systems.json', {})
const laadTypeInfo = bestand<Record<string, [number, number, number]>>('/type-info.json', {})
const laadSprongen = bestand<Record<string, number[]>>('/system-jumps.json', {})

async function jitaPrijzen(ids: number[]): Promise<Map<number, number>> {
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
interface Stap { naam: string; typeId: number; fabrieken: number; perUur: number;
                 tier: number; opExtractie: boolean }
interface Keten { doelId: number; stappen: Stap[]; p0: { naam: string; perUur: number }[] }

function bouwKeten(sch: Record<string, Schem>, namen: Record<string, string>,
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
interface Pasvorm { lijnen: number; extractie: number; fabriek: number; rem: string
                    tekort: { naam: string; perUur: number }[]; fabriekenPerLijn: number
                    /* Wat één enkele lijn kost. Zonder dit staat er bij een product dat
                     * niet past alleen "0 lijnen", en dan weet je niet of je er één
                     * planeet naast zit of tien. */
                    voorEenLijn: number }

function pasIn(keten: Keten, vrijePlaneten: string[], oogst: number,
               slots: number, perFabriekPlaneet: number): Pasvorm {
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

  const telling: Record<string, number> = {}
  for (const t of vrijePlaneten) telling[t] = (telling[t] ?? 0) + 1
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
                            perType: Record<string, number> }
export interface Toewijzing { sys: number; type: string; vraag: number; aantal: number }

/* Lost de verdeling op voor één concrete systeem/karakter-indeling.
 * `vragen[i].alleenSys` beperkt een vraag tot één systeem — zo kun je eerst
 * proberen de fabrieken thuis te houden. */
function verdeelOverSystemen(
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
        edges.push([1 + i, k, keuze[j].perType[ty]])
        herkomst.push({ vraag: i, sys: j, type: ty })
      }
    }
  })
  for (let j = 0; j < S; j++) for (const [ty, aantal] of Object.entries(keuze[j].perType)) {
    edges.push([ptNode.get(`${j}|${ty}`)!, sysNode + j, aantal]); herkomst.push({ vraag: -1, sys: -1, type: '' })
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

const combinaties = <T,>(a: T[], k: number): T[][] =>
  k === 0 ? [[]] : a.length < k ? []
    : [...combinaties(a.slice(1), k - 1).map(c => [a[0], ...c]), ...combinaties(a.slice(1), k)]

/* Alle manieren om k karakters aan k systemen te hangen. Boven de zes
 * karakters wordt dat te veel; dan pakken we alleen de voor de hand liggende
 * koppeling (grootste karakter op het grootste systeem). */
function slotIndelingen(slots: number[], k: number): number[][] {
  if (slots.length > 6) return [slots.slice().sort((a, b) => b - a).slice(0, k)]
  const uit = new Set<string>()
  const loop = (rest: number[], gekozen: number[]) => {
    if (gekozen.length === k) { uit.add(gekozen.join(',')); return }
    rest.forEach((s, i) => loop([...rest.slice(0, i), ...rest.slice(i + 1)], [...gekozen, s]))
  }
  loop(slots, [])
  return [...uit].map(s => s.split(',').map(Number))
}

export interface PasvormSys extends Pasvorm { keuze: SysKeuze[]; toewijzing: Toewijzing[] }

function pasInSystemen(keten: Keten, kandidaten: SysKeuze[], slots: number[],
                       oogst: number, perFabriekPlaneet: number): PasvormSys {
  const alleTypes = Object.keys(PLANEET_P0)
  const alle = kandidaten.flatMap(s => Object.entries(s.perType).flatMap(([t, n]) => Array(n).fill(t) as string[]))
  const tekort = keten.p0.filter(r => !alle.some(t => (PLANEET_P0[t] ?? []).includes(r.naam)))
  const fabriekenPerLijn = keten.stappen.filter(s => !s.opExtractie)
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
    const fab = Math.ceil(fabriekenPerLijn * L / Math.max(1, perFabriekPlaneet))
    if (L === 1) beste.voorEenLijn = ex + fab
    if (ex + fab > totaalSlots) { beste.rem = 'slots op'; break }

    let gelukt: { keuze: SysKeuze[]; toewijzing: Toewijzing[] } | null = null
    for (let k = 1; k <= Math.min(slots.length, lijst.length) && !gelukt; k++) {
      for (const combo of combinaties(lijst, k)) {
        for (const indeling of slotIndelingen(slots, k)) {
          const keuze = combo.map((s, i) => ({ ...s, slots: indeling[i] }))
          /* Eerst proberen de fabrieken bij elkaar te houden in het systeem
           * dat het dichtst bij huis ligt: daar komt alle P1 samen. */
          const thuisIdx = keuze.reduce((b, s, i) => s.sprongen < keuze[b].sprongen ? i : b, 0)
          const metFab = (alleenSys?: number) =>
            verdeelOverSystemen([...vragen, { types: alleTypes, n: fab, alleenSys }], keuze)
          const t = metFab(thuisIdx) ?? metFab()
          if (t) { gelukt = { keuze, toewijzing: t }; break }
        }
        if (gelukt) break
      }
    }
    if (!gelukt) { beste.rem = 'geen indeling met één systeem per karakter'; break }
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
function knelpunt(vragen: { types: string[]; n: number }[],
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
export default function PiOpzet() {
  const [sch, setSch] = useState<Record<string, Schem>>({})
  const [namen, setNamen] = useState<Record<string, string>>({})
  const [planeten, setPlaneten] = useState<Record<string, [number, number, number][]>>({})
  const [systemen, setSystemen] = useState<Record<string, [string, number, number]>>({})
  const [sprongen, setSprongen] = useState<Record<string, number[]>>({})
  const [prijs, setPrijs] = useState<Map<number, number>>(new Map())
  const [vol, setVol] = useState<Map<number, number>>(new Map())
  const [bezig, setBezig] = useState(true)

  const bewaard = (sleutel: string, leeg: string) =>
    localStorage.getItem('piopzet.' + sleutel) ?? leeg
  const [thuis, setThuis] = useState(bewaard('thuis', 'Q-02UL'))
  const [doel, setDoel] = useState(bewaard('doel', 'Neocoms'))
  /* Per karakter apart, want Interplanetary Consolidation verschilt: één plus
   * je skillniveau, dus V geeft zes planeten en IV vijf. "6,5,5,5" is dus vier
   * karakters met samen 21 slots. Eén getal voor het totaal zou de verdeling
   * scheef maken. */
  const [perAccount, setPerAccount] = useState(bewaard('peraccount', '6,5,5,5'))
  const accountSlots = useMemo(() => perAccount.split(/[,;\s]+/)
    .map(x => Math.max(0, Math.min(6, parseInt(x) || 0))).filter(Boolean), [perAccount])
  const slots = accountSlots.reduce((a, b) => a + b, 0) || 1
  const accounts = accountSlots.length || 1
  const [maxSprong, setMaxSprong] = useState(Number(bewaard('maxsprong', '2')))
  const [oogst, setOogst] = useState(Number(bewaard('oogst', '12000')))
  const [perFabriekPlaneet, setPerFabriekPlaneet] = useState(Number(bewaard('perplaneet', '5')))
  const [ccNiveau, setCcNiveau] = useState(Number(bewaard('ccniveau', '4')))
  const [uitgesloten, setUitgesloten] = useState<string[]>(
    JSON.parse(bewaard('uit', '[]')))
  /* Aan tenzij je 'm uitzet: je kunt een kolonie alleen bedienen als je in dat
   * systeem bent, dus een karakter dat over drie systemen verdeeld staat is
   * elke ophaalronde onderweg. */
  const [perSysteem, setPerSysteem] = useState(bewaard('persysteem', '1') === '1')

  useEffect(() => {
    const w = { thuis, doel, peraccount: perAccount, maxsprong: maxSprong, oogst,
                perplaneet: perFabriekPlaneet, ccniveau: ccNiveau,
                uit: JSON.stringify(uitgesloten), persysteem: perSysteem ? '1' : '0' }
    for (const [k, v] of Object.entries(w)) localStorage.setItem('piopzet.' + k, String(v))
  }, [thuis, doel, perAccount, maxSprong, oogst, perFabriekPlaneet, ccNiveau, uitgesloten, perSysteem])

  useEffect(() => {
    let leeft = true
    Promise.all([laadSchematics(), laadNamen(), laadPlaneten(), laadSystemen(),
                 laadSprongen(), laadTypeInfo()])
      .then(([s, n, p, sy, sp, ti]) => {
        if (!leeft) return
        setSch(s); setNamen(n); setPlaneten(p); setSystemen(sy); setSprongen(sp)
        setVol(new Map(Object.entries(ti as Record<string, [number, number, number]>)
          .map(([id, v]) => [Number(id), v[1]])))
        setBezig(false)
      })
    return () => { leeft = false }
  }, [])
  usePageLoading(bezig)

  /* ── wat er nú staat ────────────────────────────────────────────────────
   * Het plan hierboven is een tekentafel-antwoord; dit is de werkelijkheid.
   * `tokens` en niet `activeTokens`: de planner verdeelt over ál je karakters,
   * dus een gekozen karakter in de kop mag de telling niet halveren. (Het is
   * ook de stabiele array — activeTokens is elke render een nieuwe en zou deze
   * effect-hook eindeloos opnieuw laten lopen.) */
  const { tokens } = useAuth()
  const [kolonies, setKolonies] = useState<Kolonie[]>([])
  const [kolBezig, setKolBezig] = useState(false)
  const [kolFout, setKolFout] = useState<string[]>([])

  useEffect(() => {
    if (!tokens.length) { setKolonies([]); return }
    let leeft = true
    setKolBezig(true); setKolFout([])
    ;(async () => {
      const rijen: { charId: number; charNaam: string; token: string;
                     planetId: number; systeemId: number; type: string }[] = []
      const fouten: string[] = []
      await Promise.all(tokens.map(async t => {
        try {
          for (const p of await getPlanets(t.characterId, t.accessToken)) {
            rijen.push({ charId: t.characterId, charNaam: t.characterName,
              token: t.accessToken, planetId: p.planet_id,
              systeemId: p.solar_system_id,
              /* ESI's eigen planet_type ('barren') is betrouwbaarder dan het
               * type-id omzetten: die id-tabel verschilt per bron. */
              type: p.planet_type.charAt(0).toUpperCase() + p.planet_type.slice(1) })
          }
        } catch { fouten.push(t.characterName) }
      }))
      const uit = await Promise.all(rijen.map(async r => ({
        r,
        /* De planeetnaam ("Q-02UL IV") kan alleen hiervandaan komen:
         * /universe/names/ kent planeten niet. */
        info: await getPlanetInfo(r.planetId),
        detail: await getPlanetDetail(r.charId, r.planetId, r.token).catch(() => null),
      })))
      const inhoudIds = new Set<number>()
      for (const u of uit) for (const pin of u.detail?.pins ?? [])
        for (const c of pin.contents ?? []) inhoudIds.add(c.type_id)
      const pr = await jitaPrijzen([...inhoudIds])
      if (!leeft) return
      setKolonies(uit.map(({ r, info, detail }) => {
        let voorraad = 0
        let extractieTot: number | null = null
        for (const pin of detail?.pins ?? []) {
          for (const c of pin.contents ?? []) voorraad += (pr.get(c.type_id) ?? 0) * c.amount
          const t = pin.expiry_time ? Date.parse(pin.expiry_time) : NaN
          if (!isNaN(t)) extractieTot = Math.max(extractieTot ?? 0, t)
        }
        return {
          planetId: r.planetId, charId: r.charId, charNaam: r.charNaam,
          naam: info?.name ?? `planeet ${r.planetId}`,
          systeemId: r.systeemId, type: r.type,
          pins: detail?.pins.length ?? 0, voorraad, extractieTot,
        }
      }))
      setKolFout(fouten)
      setKolBezig(false)
    })()
    return () => { leeft = false }
  }, [tokens])

  /* systeem-id van het thuissysteem */
  const thuisId = useMemo(() => {
    const t = Object.entries(systemen).find(([, v]) => v[0].toLowerCase() === thuis.toLowerCase())
    return t ? Number(t[0]) : 0
  }, [systemen, thuis])

  /* alle P2/P3/P4-recepten om uit te kiezen */
  const doelen = useMemo(() => {
    const maakt = new Set(Object.values(sch)
      .map(s => s.pins.find(p => !p.is_input)?.type_id).filter(Boolean))
    return [...Object.values(sch)]
      .filter(s => s.pins.filter(p => p.is_input).some(p => maakt.has(p.type_id)))
      .map(s => s.schematic_name).sort()
  }, [sch, namen])

  /* de keten voor één lijn — daarmee schalen we later op */
  const eenLijn = useMemo(
    () => (Object.keys(sch).length ? bouwKeten(sch, namen, doel, 1) : null),
    [sch, namen, doel])

  /* systemen binnen bereik, met hun planeten */
  const buurt = useMemo(() => {
    if (!thuisId || !Object.keys(sprongen).length) return []
    const afst: Record<number, number> = { [thuisId]: 0 }
    let rand = [thuisId]
    for (let d = 1; d <= maxSprong; d++) {
      const volgend: number[] = []
      for (const s of rand) for (const b of sprongen[String(s)] ?? []) {
        if (afst[b] === undefined) { afst[b] = d; volgend.push(b) }
      }
      rand = volgend
    }
    return Object.entries(afst).map(([id, d]) => ({
      id: Number(id),
      naam: systemen[id]?.[0] ?? id,
      sprongen: d,
      planeten: (planeten[id] ?? []).map(([idx, tid, straal]) => ({
        idx, type: PLANEETTYPE[tid] ?? String(tid), straal,
      })),
    })).sort((a, b) => a.sprongen - b.sprongen || a.naam.localeCompare(b.naam))
  }, [thuisId, sprongen, systemen, planeten, maxSprong])

  /* Sprongen van huis naar een willekeurig systeem — `buurt` gaat maar tot
   * maxSprong, en je huidige kolonies liggen juist vaak daarbuiten. */
  const afstand = useMemo(() => {
    const d = new Map<number, number>()
    if (!thuisId || !Object.keys(sprongen).length) return d
    d.set(thuisId, 0)
    let rand = [thuisId]
    for (let k = 1; k <= 15 && rand.length; k++) {
      const volgend: number[] = []
      for (const s of rand) for (const b of sprongen[String(s)] ?? []) {
        if (!d.has(b)) { d.set(b, k); volgend.push(b) }
      }
      rand = volgend
    }
    return d
  }, [thuisId, sprongen])

  /* Planeten waar al een command center van je staat. */
  const bezet = useMemo(() => new Set(kolonies.map(k => k.naam)), [kolonies])

  /* hoeveel lijnen passen er in je slots? */
  const vrijePlaneten = useMemo(() => buurt.filter(s => !uitgesloten.includes(s.naam))
    .flatMap(s => s.planeten.map(p => p.type)), [buurt, uitgesloten])

  /* Per systeem hoeveel planeten van elk type — de invoer voor de
   * één-systeem-per-karakter-variant. Shattered valt af: daar kan geen PI op. */
  const systeemKandidaten = useMemo<SysKeuze[]>(() =>
    buurt.filter(s => !uitgesloten.includes(s.naam)).map(s => {
      const perType: Record<string, number> = {}
      for (const p of s.planeten) if (PLANEET_P0[p.type]) perType[p.type] = (perType[p.type] ?? 0) + 1
      return { naam: s.naam, sprongen: s.sprongen, slots: 0, perType }
    }).filter(s => Object.keys(s.perType).length > 0), [buurt, uitgesloten])

  const plan = useMemo(() => {
    if (!eenLijn) return null
    return perSysteem
      ? pasInSystemen(eenLijn, systeemKandidaten, accountSlots, oogst, perFabriekPlaneet)
      : pasIn(eenLijn, vrijePlaneten, oogst, slots, perFabriekPlaneet)
  }, [eenLijn, perSysteem, systeemKandidaten, accountSlots, vrijePlaneten,
      oogst, slots, perFabriekPlaneet])

  /* Jita-waarde van de opbrengst */
  useEffect(() => {
    if (!eenLijn) return
    const ids = eenLijn.stappen.map(s => s.typeId)
    jitaPrijzen(ids).then(setPrijs)
  }, [eenLijn])

  /* ── welk product levert hier het meest op? ───────────────────────────────
   * De vraag "wat moet ik maken" hing tot nu toe in de lucht: je koos een
   * product en zag pas dáárna wat het opbracht. Dit draait dezelfde som voor
   * elk recept en zet ze op omzet op een rij. Dat de beste keuze per systeem
   * verschilt is juist de kern — het hangt af van welke planeettypes er om de
   * hoek liggen, en Q-02UL heeft geen Temperate en geen Lava in het systeem. */
  const doelTypeId = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of Object.values(sch)) {
      const uit = s.pins.find(p => !p.is_input)
      if (uit) m.set(s.schematic_name, uit.type_id)
    }
    return m
  }, [sch])

  const [alleprijs, setAlleprijs] = useState<Map<number, number>>(new Map())
  useEffect(() => {
    const ids = doelen.map(d => doelTypeId.get(d)).filter((x): x is number => !!x)
    if (ids.length) jitaPrijzen(ids).then(setAlleprijs)
  }, [doelen, doelTypeId])

  const ranglijst = useMemo(() => {
    if (!Object.keys(sch).length || !vrijePlaneten.length || !alleprijs.size) return []
    const uit: { doel: string; typeId: number; perDag: number; isk: number
                 lijnen: number; slotsGebruikt: number }[] = []
    for (const d of doelen) {
      const k = bouwKeten(sch, namen, d, 1)
      if (!k) continue
      const p = perSysteem
        ? pasInSystemen(k, systeemKandidaten, accountSlots, oogst, perFabriekPlaneet)
        : pasIn(k, vrijePlaneten, oogst, slots, perFabriekPlaneet)
      if (!p.lijnen || p.tekort.length) continue
      const stap = k.stappen.find(s => s.typeId === k.doelId)
      if (!stap) continue
      const perDag = stap.perUur * 24 * p.lijnen
      const isk = perDag * (alleprijs.get(k.doelId) ?? 0)
      if (isk <= 0) continue
      uit.push({ doel: d, typeId: k.doelId, perDag, isk,
                 lijnen: p.lijnen, slotsGebruikt: p.extractie + p.fabriek })
    }
    return uit.sort((a, b) => b.isk - a.isk)
  }, [sch, namen, doelen, vrijePlaneten, oogst, slots, perFabriekPlaneet, alleprijs,
      perSysteem, systeemKandidaten, accountSlots])

  /* Het eindproduct staat vooraan: de lijst is aflopend op tier gesorteerd.
   * Stond hier eerst [length - 1], en dat is juist de láágste trap — de teller
   * riep dan 5.760 Robotics/dag terwijl het er 216 zijn. */
  const doelStap = eenLijn?.stappen.find(s => s.typeId === eenLijn.doelId)
  const perDag = (doelStap?.perUur ?? 0) * 24 * (plan?.lijnen ?? 0)
  const iskDag = perDag * (prijs.get(doelStap?.typeId ?? 0) ?? 0)

  /* welke planeten stel ik voor, verdeeld over de accounts */
  const vakjes = useMemo<{ kop: string; planeten: Voorstel[] }[]>(() => {
    if (!plan || !eenLijn || !plan.lijnen) return []

    /* Één systeem per karakter: de max-flow heeft al bepaald hoeveel planeten
     * van welk type elk systeem levert. Hier hoeven alleen nog de concrete
     * bolletjes gekozen te worden. */
    if (perSysteem && 'toewijzing' in plan) {
      const p = plan as PasvormSys
      return p.keuze.map((sys, j) => {
        const inSysteem = buurt.find(b => b.naam === sys.naam)
        const vrij = (inSysteem?.planeten ?? []).slice()
          /* Binnen één systeem scheelt de afstand niets meer, dus: eerst een
           * planeet waar je al staat, dan de kleinste (kortere links). */
          .sort((a, b) =>
            (bezet.has(`${sys.naam} ${ROMEINS[a.idx]}`) ? 0 : 1)
            - (bezet.has(`${sys.naam} ${ROMEINS[b.idx]}`) ? 0 : 1)
            || (a.straal ?? 0) - (b.straal ?? 0))
        const gebruikt = new Set<number>()
        const pak = (type: string, aantal: number, rol: string): Voorstel[] => {
          const uit: Voorstel[] = []
          for (const pl of vrij) {
            if (uit.length >= aantal) break
            if (pl.type !== type || gebruikt.has(pl.idx)) continue
            gebruikt.add(pl.idx)
            uit.push({ systeem: sys.naam, sprongen: sys.sprongen, straal: pl.straal,
              planeet: `${sys.naam} ${ROMEINS[pl.idx]}`, type: pl.type, rol })
          }
          return uit
        }
        /* Fabrieken eerst: die krijgen zo de kleinste planeten, en juist zij
         * hebben de meeste links (launchpad naar vijf fabrieken). */
        const mijn = p.toewijzing.filter(t => t.sys === j)
          .sort((a, b) => (b.vraag === eenLijn.p0.length ? 1 : 0) - (a.vraag === eenLijn.p0.length ? 1 : 0))
          .flatMap(t => pak(t.type, t.aantal,
            t.vraag === eenLijn.p0.length ? 'fabriek P2/P3' : `${eenLijn.p0[t.vraag].naam} → P1`))
        return { kop: `${sys.naam} — ${mijn.length} van ${sys.slots} planeten`, planeten: mijn }
      }).filter(v => v.planeten.length > 0)
    }

    const gekozen: Voorstel[] = []
    const vrij = buurt.filter(s => !uitgesloten.includes(s.naam))
      .flatMap(s => s.planeten.map(p => ({ ...p, systeem: s.naam, sprongen: s.sprongen })))
    const pnaam = (p: { systeem: string; idx: number }) => `${p.systeem} ${ROMEINS[p.idx]}`

    /* Eerst de FABRIEKSPLANETEN, en pas daarna de extractie.
     *
     * Andersom pikte de extractie alle acht planeten van het thuissysteem in en
     * belandden de fabrieken een sprong verderop — dan sleep je je P1 het
     * systeem uít en het eindproduct weer terug. De fabrieken horen juist waar
     * je woont: daar komt alles samen.
     *
     * Een fabrieksplaneet mag elk type zijn, dus die kan wijken; een grondstof
     * kan dat niet. Daarom pakt hij een planeet alleen als de extractie er
     * daarna nog steeds op past (dezelfde Hall-toets als de planner zelf).
     * Binnen hetzelfde systeem de kleinste planeet: een link kost CPU naar rato
     * van z'n lengte, en juist de fabrieksplaneet heeft de meeste links. */
    const vraag = eenLijn.p0.map(r => ({
      types: Object.keys(PLANEET_P0).filter(ty => PLANEET_P0[ty].includes(r.naam)),
      n: Math.ceil(r.perUur * plan.lijnen / Math.max(1, oogst)),
    }))
    const telling: Record<string, number> = {}
    for (const p of vrij) telling[p.type] = (telling[p.type] ?? 0) + 1

    const fabrieken: Voorstel[] = []
    const genomen = new Set<string>()
    for (const p of vrij.slice().sort((a, b) =>
      a.sprongen - b.sprongen || (a.straal ?? 0) - (b.straal ?? 0))) {
      if (fabrieken.length >= plan.fabriek) break
      if (genomen.has(pnaam(p)) || !PLANEET_P0[p.type]) continue
      telling[p.type]--
      if (knelpunt(vraag, telling)) { telling[p.type]++; continue }
      genomen.add(pnaam(p))
      fabrieken.push({ systeem: p.systeem, sprongen: p.sprongen, straal: p.straal,
        planeet: pnaam(p), type: p.type, rol: 'fabriek P2/P3' })
    }

    /* Schaarste eerst. `p0` komt alfabetisch binnen, en dan pikte Aqueous
     * Liquids — dat op zes planeettypes mag — de Gas-planeten in het
     * thuissysteem in, waarna Reactive Gas, dat álleen van Gas komt, een
     * sprong verderop moest zoeken. De Hall-toets zegt dát het past; deze
     * volgorde zorgt dat het uitdelen die verdeling ook vindt. */
    const naarSchaarste = eenLijn.p0.slice().sort((a, b) =>
      vrij.filter(p => (PLANEET_P0[p.type] ?? []).includes(a.naam)).length
      - vrij.filter(p => (PLANEET_P0[p.type] ?? []).includes(b.naam)).length)

    for (const r of naarSchaarste) {
      const nodigAantal = Math.ceil(r.perUur * plan.lijnen / Math.max(1, oogst))
      /* Volgorde van voorkeur:
       *  1. een systeem waar je toch al komt — dat scheelt een stop op je
       *     ophaalronde, en dat weegt zwaarder dan één sprong verder;
       *  2. dichter bij huis;
       *  3. een planeet waar je al een kolonie hébt — dat scheelt een command
       *     center en het opnieuw neerzetten. Bewust ná de sprongen: reistijd
       *     betaal je elke ophaalronde opnieuw, een verhuizing maar één keer;
       *  4. de kleinste planeet, want ook een extractieplaneet heeft links
       *     (koppen naar de fabriek) en die kosten CPU naar rato van hun
       *     lengte. Tussen 1.730 en 10.370 km zit een factor zes. */
      const alGekozen = new Set([...gekozen, ...fabrieken].map(g => g.systeem))
      const kandidaten = vrij
        .filter(p => (PLANEET_P0[p.type] ?? []).includes(r.naam)
          && !genomen.has(pnaam(p)))
        .sort((a, b) =>
          (alGekozen.has(a.systeem) ? 0 : 1) - (alGekozen.has(b.systeem) ? 0 : 1)
          || a.sprongen - b.sprongen
          || (bezet.has(`${a.systeem} ${ROMEINS[a.idx]}`) ? 0 : 1)
             - (bezet.has(`${b.systeem} ${ROMEINS[b.idx]}`) ? 0 : 1)
          || (a.straal ?? 0) - (b.straal ?? 0))
      for (const p of kandidaten.slice(0, nodigAantal)) {
        genomen.add(pnaam(p))
        gekozen.push({ systeem: p.systeem, sprongen: p.sprongen, straal: p.straal,
          planeet: pnaam(p), type: p.type, rol: `${r.naam} → P1` })
      }
    }
    /* Zonder de systeem-eis vullen we de karakters op volgorde bij: het ene
     * account kan er zes, het andere vijf. */
    const alles = [...gekozen, ...fabrieken]
    const uit = accountSlots.map(() => [] as Voorstel[])
    let a = 0
    for (const pl of alles) {
      while (a < uit.length && uit[a].length >= accountSlots[a]) a++
      if (a >= uit.length) break
      uit[a].push(pl)
    }
    return uit.map((planeten, i) => ({
      kop: `ACCOUNT ${i + 1} — ${planeten.length} van ${accountSlots[i]} planeten`, planeten,
    })).filter(v => v.planeten.length > 0)
  }, [plan, eenLijn, buurt, uitgesloten, oogst, bezet, perSysteem, accountSlots])

  const verdeling = useMemo(() => vakjes.flatMap(v => v.planeten), [vakjes])

  /* ── van wat er staat naar wat er moet komen ─────────────────────────────
   * Matchen op planeetnaam ("Q-02UL IV"), niet op karakter: staat de kolonie
   * op het goede bolletje maar op een ander karakter, dan is dat geen sloopwerk
   * maar hooguit een andere piloot die 'm beheert. */
  const omzetten = useMemo(() => {
    const voorstel = new Map(verdeling.map(v => [v.planeet, v]))
    const heb = new Map(kolonies.map(k => [k.naam, k]))
    return {
      houden: kolonies.filter(k => voorstel.has(k.naam)),
      weg: kolonies.filter(k => !voorstel.has(k.naam)),
      nieuw: verdeling.filter(v => !heb.has(v.planeet)),
      voorstel,
    }
  }, [verdeling, kolonies])

  const perChar = useMemo(() => {
    const m = new Map<string, number>()
    for (const k of kolonies) m.set(k.charNaam, (m.get(k.charNaam) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [kolonies])

  const kaart: React.CSSProperties = {
    background: 'var(--card, #151b24)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '0.9rem 1rem', marginBottom: '1rem',
  }
  const invoer: React.CSSProperties = {
    background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4,
    color: '#fff', padding: '0.3rem 0.45rem', fontSize: '0.74rem', width: 78,
  }
  const label: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.66rem',
    color: 'var(--text-dim)', letterSpacing: '0.04em',
  }

  return (
    <Layout header={<PageHeader title="PI-opzetplanner"
      sub={bezig ? 'Laden…' : `${doel} vanuit ${thuis} · ${slots} slots · ${accounts} accounts`} />}>

      {/* ── instellingen ── */}
      <div style={{ ...kaart, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={label}>THUISSYSTEEM
          <input value={thuis} onChange={e => setThuis(e.target.value)}
            style={{ ...invoer, width: 110 }} /></label>
        <label style={label}>PRODUCT
          <select value={doel} onChange={e => setDoel(e.target.value)}
            style={{ ...invoer, width: 168 }}>
            {doelen.map(d => <option key={d} value={d}>{d}</option>)}
          </select></label>
        <label style={label} title="Planeten per karakter, gescheiden door komma's. Max 6 (Interplanetary Consolidation V).">
          PLANETEN PER ACCOUNT
          <input value={perAccount} onChange={e => setPerAccount(e.target.value)}
            style={{ ...invoer, width: 96 }} /></label>
        <label style={label}>MAX SPRONGEN
          <input type="number" min={0} max={6} value={maxSprong}
            onChange={e => setMaxSprong(Math.max(0, +e.target.value || 0))} style={invoer} /></label>
        <label style={label} title="Wat één extractieplaneet per uur van één grondstof levert. Staat in geen enkele database — lees het af in de client.">
          P0/UUR PER PLANEET
          <input type="number" min={1000} step={1000} value={oogst}
            onChange={e => setOogst(Math.max(1, +e.target.value || 1))} style={invoer} /></label>
        <label style={label} title="Command Center Upgrades. Bepaalt hoeveel CPU en powergrid je command center levert.">
          CCU-NIVEAU
          <input type="number" min={0} max={5} value={ccNiveau}
            onChange={e => setCcNiveau(Math.max(0, Math.min(5, +e.target.value || 0)))}
            style={invoer} /></label>
        <label style={label}>FABRIEKEN/PLANEET
          <input type="number" min={1} max={12} value={perFabriekPlaneet}
            onChange={e => setPerFabriekPlaneet(Math.max(1, +e.target.value || 1))} style={invoer} /></label>
        <label style={{ ...label, flexDirection: 'row', alignItems: 'center', gap: 6,
          cursor: 'pointer', paddingBottom: 4 }}
          title="Je kunt een kolonie alleen bedienen als je in dat systeem bent. Aan = elk karakter parkeert in één systeem en pakt daar al z'n planeten.">
          <input type="checkbox" checked={perSysteem}
            onChange={e => setPerSysteem(e.target.checked)} style={{ cursor: 'pointer' }} />
          1 SYSTEEM PER KARAKTER
        </label>
      </div>

      {/* ── uitkomst ── */}
      {plan && eenLijn && (
        <div style={{ ...kaart, borderColor: plan.lijnen ? 'rgba(62,207,110,.35)' : 'var(--red)' }}>
          {plan.tekort.length > 0 && (
            <div style={{ color: 'var(--red)', fontSize: '0.78rem', marginBottom: '0.6rem' }}>
              ⚠ Binnen {maxSprong} sprongen is er geen planeet die{' '}
              <b>{plan.tekort.map(t => t.naam).join(', ')}</b> levert. Zet het bereik hoger,
              of haal deze grondstof ergens anders vandaan.
            </div>
          )}
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--gold, #f0c040)' }}>
                {fmt(perDag)} <span style={{ fontSize: '0.9rem' }}>{doel}/dag</span>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                {plan.lijnen > 0 ? <>
                  {plan.lijnen} productielijn{plan.lijnen === 1 ? '' : 'en'} ·{' '}
                  {plan.extractie} extractie + {plan.fabriek} fabriek ={' '}
                  {plan.extractie + plan.fabriek} van je {slots} slots
                  {plan.rem ? ` · begrensd door: ${plan.rem}` : ''}
                </> : <span style={{ color: 'var(--red)' }}>
                  Past hier niet: één enkele lijn vraagt al <b>{plan.voorEenLijn} planeten</b>
                  {plan.rem === 'slots op'
                    ? ` en je hebt er ${slots}.`
                    : ` — ${plan.rem}.`} Diepere ketens (P4) besteden hun planeten aan
                  tussenstappen in plaats van aan doorvoer.
                </span>}
              </div>
            </div>
            {iskDag > 0 && (
              <div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#3ecf6e' }}>
                  {fmtISK(iskDag)} <span style={{ fontSize: '0.8rem' }}>omzet/dag</span>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  tegen Jita sell · {fmtISK(iskDag * 30)}/maand · vóór customs-tax
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── wat levert het meeste op ── */}
      {ranglijst.length > 0 && (
        <div style={kaart}>
          <h3 style={{ margin: '0 0 0.2rem', fontSize: '0.72rem', letterSpacing: '0.1em',
            color: 'var(--text-dim)' }}>
            WAT LEVERT HET MEESTE OP VANUIT {thuis.toUpperCase()} — klik om te kiezen
          </h3>
          <div style={{ fontSize: '.7rem', color: 'var(--text-dim)', marginBottom: '.5rem' }}>
            Zelfde som als hierboven, voor elk recept: past de keten in je {slots} slots
            en in de planeten binnen {maxSprong} sprongen, en wat is dat per dag waard
            tegen Jita sell? Recepten waarvoor een grondstof hier niet te halen is
            staan er niet tussen.
          </div>
          {ranglijst.slice(0, 12).map((r, i) => {
            const gekozen = r.doel === doel
            return (
              <div key={r.doel} onClick={() => setDoel(r.doel)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                  padding: '0.26rem 0.3rem', fontSize: '0.8rem', borderRadius: 4,
                  background: gekozen ? 'rgba(240,192,64,.08)' : 'transparent' }}>
                <span style={{ width: 20, color: 'var(--text-dim)', fontSize: '.72rem' }}>
                  {i + 1}.</span>
                <EveImage category="types" id={r.typeId} variation="icon" size={32} px={22}
                  style={{ borderRadius: 3, flexShrink: 0 }} />
                <span style={{ flex: 1, fontWeight: gekozen ? 700 : 400,
                  color: gekozen ? 'var(--gold,#f0c040)' : undefined }}>{r.doel}</span>
                <span style={{ width: 96, textAlign: 'right', color: 'var(--text-dim)' }}>
                  {fmt(r.perDag)}/dag</span>
                <span style={{ width: 92, textAlign: 'right', color: '#3ecf6e' }}>
                  {fmtISK(r.isk)}</span>
                <span style={{ width: 104, textAlign: 'right', color: 'var(--text-dim)',
                  fontSize: '.72rem' }}>
                  {fmtISK(r.isk * 30)}/mnd</span>
                <span style={{ width: 96, textAlign: 'right', color: 'var(--text-dim)',
                  fontSize: '.72rem' }}>
                  {r.lijnen} lijn · {r.slotsGebruikt} slots</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── logistiek ── */}
      {plan && eenLijn && plan.lijnen > 0 && (() => {
        /* P1 is wat er van de extractieplaneten naar huis moet: het niveau
         * direct boven P0. Ruwe P0 slepen is vier keer zo veel volume, dus dat
         * verwerk je op de planeet zelf. */
        // Op `opExtractie` filteren en niet op tier === 1: na het hernummeren
        // heeft maar één stap tier 1, terwijl er vier P1-soorten naar huis gaan.
        const p1 = eenLijn.stappen.filter(s => s.opExtractie)
        const inM3 = p1.reduce((a, s) => a + s.perUur * plan.lijnen * (vol.get(s.typeId) ?? 0), 0)
        const uitM3 = (doelStap?.perUur ?? 0) * plan.lijnen * (vol.get(doelStap?.typeId ?? 0) ?? 0)
        const ritten = (inM3 * 24) / SQUALL
        return (
          <div style={kaart}>
            <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.72rem', letterSpacing: '0.1em',
              color: 'var(--text-dim)' }}>LOGISTIEK — Squall, 45.000 m³ infrastructure hold</h3>
            <div style={{ display: 'flex', gap: '1.6rem', flexWrap: 'wrap', fontSize: '0.82rem' }}>
              <span>P1 naar {thuis}: <b>{fmt(inM3 * 24)} m³/dag</b></span>
              <span>{doel} eruit: <b>{fmt(uitM3 * 24)} m³/dag</b></span>
              <span style={{ color: ritten <= 1 ? '#3ecf6e' : 'var(--gold,#f0c040)' }}>
                {ritten <= 1
                  ? `één rit per ${fmt(1 / Math.max(ritten, 1e-9), 1)} dagen — hauling beperkt je niet`
                  : `${fmt(ritten, 1)} ritten per dag`}
              </span>
            </div>
          </div>
        )
      })()}

      {/* ── de keten ── */}
      {eenLijn && plan && (
        <div style={kaart}>
          <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.72rem', letterSpacing: '0.1em',
            color: 'var(--text-dim)' }}>DE KETEN — {plan.lijnen} lijn(en)</h3>
          {eenLijn.stappen.slice().reverse().map(s => (
            <div key={s.naam} style={{ display: 'flex', alignItems: 'center', gap: 8,
              padding: '0.3rem 0', fontSize: '0.8rem' }}>
              <EveImage category="types" id={s.typeId} variation="icon" size={32} px={26}
                style={{ borderRadius: 3, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{s.naam}</span>
              <span style={{ color: 'var(--text-dim)', width: 168, textAlign: 'right' }}>
                {Math.ceil(s.fabrieken * plan.lijnen)} fabriek(en){' '}
                <span style={{ opacity: 0.7 }}>
                  {s.opExtractie ? 'op de extractieplaneet' : 'op een fabrieksplaneet'}
                </span>
              </span>
              <span style={{ width: 110, textAlign: 'right' }}>
                {fmt(s.perUur * plan.lijnen, 1)}/uur
              </span>
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.5rem',
            paddingTop: '0.5rem' }}>
            {eenLijn.p0.map(r => (
              <div key={r.naam} style={{ display: 'flex', gap: 8, fontSize: '0.8rem',
                padding: '0.2rem 0' }}>
                <span style={{ flex: 1, color: 'var(--text-dim)' }}>{r.naam} (P0)</span>
                <span>{fmt(r.perUur * plan.lijnen)}/uur</span>
                <span style={{ width: 96, textAlign: 'right', color: 'var(--text-dim)' }}>
                  {Math.ceil(r.perUur * plan.lijnen / Math.max(1, oogst))} planeet/planeten
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── voorgestelde planeten ── */}
      {verdeling.length > 0 && (
        <div style={kaart}>
          <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.72rem', letterSpacing: '0.1em',
            color: 'var(--text-dim)' }}>
            VOORSTEL — {verdeling.length} planeten over {vakjes.length}
            {perSysteem ? ' karakters, elk in één systeem' : ` van je ${accounts} accounts`}
          </h3>
          {vakjes.map(({ kop, planeten: mijn }, a) => {
            return (
              <div key={a} style={{ marginBottom: '0.7rem' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--gold,#f0c040)', fontWeight: 700 }}>
                  {perSysteem ? `KARAKTER ${a + 1} parkeert in ` : ''}{kop}
                </div>
                {mijn.map(p => (
                  <div key={p.planeet} style={{ display: 'flex', gap: 8, fontSize: '0.78rem',
                    padding: '0.16rem 0' }}>
                    <span style={{ width: 106 }}>{p.planeet}</span>
                    <span style={{ width: 74, color: PLANEETKLEUR[p.type] ?? '#8a93a8' }}>{p.type}</span>
                    <span style={{ width: 58, color: 'var(--text-dim)' }}>
                      {p.sprongen === 0 ? 'thuis' : `${p.sprongen} spr`}</span>
                    <span style={{ width: 74, textAlign: 'right', color: 'var(--text-dim)' }}
                          title="Straal. Links kosten CPU naar rato van hun lengte, dus klein is beter.">
                      {p.straal ? `${fmt(p.straal)} km` : ''}</span>
                    <span style={{ flex: 1, color: 'var(--text-dim)' }}>{p.rol}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* ── verhuisplan: wat staat er nu, wat gaat weg ── */}
      <div style={kaart}>
        <h3 style={{ margin: '0 0 0.2rem', fontSize: '0.72rem', letterSpacing: '0.1em',
          color: 'var(--text-dim)' }}>
          VERHUISPLAN — wat je nu hebt tegenover het voorstel
        </h3>
        {!tokens.length ? (
          <div style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>
            Log in om je huidige kolonies uit ESI te halen.
          </div>
        ) : kolBezig ? (
          <div style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Kolonies laden…</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '1.4rem', flexWrap: 'wrap',
              fontSize: '.8rem', margin: '.4rem 0 .8rem' }}>
              <span><b>{kolonies.length}</b> kolonies nu</span>
              <span style={{ color: '#3ecf6e' }}><b>{omzetten.houden.length}</b> blijven staan</span>
              <span style={{ color: 'var(--red)' }}><b>{omzetten.weg.length}</b> afbreken</span>
              <span style={{ color: 'var(--gold,#f0c040)' }}><b>{omzetten.nieuw.length}</b> nieuw neerzetten</span>
              {perChar.length > 0 && (
                <span style={{ color: 'var(--text-dim)' }}>
                  nu in gebruik: {perChar.map(([, n]) => n).join(',')}
                  <button onClick={() => setPerAccount(perChar.map(([, n]) => n).join(','))}
                    style={{ ...invoer, width: 'auto', marginLeft: 8, cursor: 'pointer',
                      padding: '.15rem .4rem' }}>overnemen</button>
                </span>
              )}
            </div>
            {kolFout.length > 0 && (
              <div style={{ color: 'var(--red)', fontSize: '.74rem', marginBottom: '.6rem' }}>
                Kolonies van {kolFout.join(', ')} konden niet opgehaald worden —
                token verlopen of de PI-scope ontbreekt.
              </div>
            )}

            {omzetten.weg.length > 0 && (
              <div style={{ marginBottom: '.8rem' }}>
                <div style={{ fontSize: '.7rem', color: 'var(--red)', fontWeight: 700,
                  marginBottom: '.2rem' }}>AFBREKEN — {omzetten.weg.length} kolonies</div>
                {omzetten.weg.map(k => {
                  const spr = afstand.get(k.systeemId)
                  const uren = k.extractieTot ? (k.extractieTot - Date.now()) / 3600e3 : 0
                  return (
                    <div key={k.planetId} style={{ display: 'flex', gap: 8, fontSize: '.78rem',
                      padding: '.16rem 0' }}>
                      <span style={{ width: 106 }}>{k.naam}</span>
                      <span style={{ width: 74, color: PLANEETKLEUR[k.type] ?? '#8a93a8' }}>{k.type}</span>
                      <span style={{ width: 58, color: 'var(--text-dim)' }}>
                        {spr === undefined ? '—' : spr === 0 ? 'thuis' : `${spr} spr`}</span>
                      <span style={{ width: 110, color: 'var(--text-dim)' }}>{k.charNaam}</span>
                      <span style={{ width: 88, textAlign: 'right',
                        color: k.voorraad > 1e6 ? 'var(--gold,#f0c040)' : 'var(--text-dim)' }}
                        title="Wat er nog op de planeet ligt tegen Jita sell. Weggooien van de kolonie gooit dit óók weg.">
                        {k.voorraad > 0 ? fmtISK(k.voorraad) : ''}</span>
                      <span style={{ flex: 1, color: 'var(--text-dim)', fontSize: '.72rem' }}>
                        {uren > 0
                          ? `extractie loopt nog ${fmt(uren, 0)} u`
                          : k.extractieTot ? 'extractie afgelopen' : 'geen extractie'}</span>
                    </div>
                  )
                })}
              </div>
            )}

            {omzetten.houden.length > 0 && (
              <div style={{ marginBottom: '.8rem' }}>
                <div style={{ fontSize: '.7rem', color: '#3ecf6e', fontWeight: 700,
                  marginBottom: '.2rem' }}>BLIJFT STAAN — {omzetten.houden.length} planeten</div>
                {omzetten.houden.map(k => (
                  <div key={k.planetId} style={{ display: 'flex', gap: 8, fontSize: '.78rem',
                    padding: '.16rem 0' }}>
                    <span style={{ width: 106 }}>{k.naam}</span>
                    <span style={{ width: 74, color: PLANEETKLEUR[k.type] ?? '#8a93a8' }}>{k.type}</span>
                    <span style={{ width: 110, color: 'var(--text-dim)' }}>{k.charNaam}</span>
                    <span style={{ flex: 1, color: 'var(--text-dim)' }}>
                      {omzetten.voorstel.get(k.naam)?.rol} — command center kan blijven,
                      de opstelling zet je om
                    </span>
                  </div>
                ))}
              </div>
            )}

            {omzetten.nieuw.length > 0 && (
              <div style={{ marginBottom: '.6rem' }}>
                <div style={{ fontSize: '.7rem', color: 'var(--gold,#f0c040)', fontWeight: 700,
                  marginBottom: '.2rem' }}>NIEUW NEERZETTEN — {omzetten.nieuw.length} planeten</div>
                {omzetten.nieuw.map(v => (
                  <div key={v.planeet} style={{ display: 'flex', gap: 8, fontSize: '.78rem',
                    padding: '.16rem 0' }}>
                    <span style={{ width: 106 }}>{v.planeet}</span>
                    <span style={{ width: 74, color: PLANEETKLEUR[v.type] ?? '#8a93a8' }}>{v.type}</span>
                    <span style={{ width: 58, color: 'var(--text-dim)' }}>
                      {v.sprongen === 0 ? 'thuis' : `${v.sprongen} spr`}</span>
                    <span style={{ flex: 1, color: 'var(--text-dim)' }}>{v.rol}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', lineHeight: 1.55,
              borderTop: '1px solid var(--border)', paddingTop: '.5rem' }}>
              <b>Volgorde die het minste kost:</b> lanceer eerst wat er nog op de planeet
              ligt — <i>Delete Colony</i> gooit de inhoud én het command center weg, daar
              komt niets van terug. Laat een lopend extractieprogramma uitlopen (hierboven
              staat hoe lang nog). Doe het dan planeet voor planeet: pas slopen als je het
              nieuwe command center bij je hebt, want je slot staat zolang leeg. Reken op
              één nieuw command center per planeet uit de markt, en zet het meteen op het
              goede type — een command center verplaatsen kan niet.
            </div>
          </>
        )}
      </div>

      {/* ── de opstelling op een planeet ── */}
      {plan && plan.lijnen > 0 && (() => {
        const ex = CPU.launchpad + 2 * CPU.ecu + 2 * CPU.basis
        const fa = CPU.launchpad + CPU.opslag + perFabriekPlaneet * CPU.geavanceerd
        const budget = ccBudget(ccNiveau)
        const balk = (n: number) => n > budget
          ? { color: 'var(--red)' } : { color: '#3ecf6e' }
        return (
          <div style={kaart}>
            <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.72rem', letterSpacing: '0.1em',
              color: 'var(--text-dim)' }}>DE OPSTELLING PER PLANEET</h3>
            <div style={{ fontSize: '.74rem', color: 'var(--text-dim)', marginBottom: '.7rem' }}>
              Hieronder staat wát er op een planeet komt en wat dat aan CPU kost.
              Het echte neerzetten en verbinden doe je op het oppervlak — daar is{' '}
              <a href="https://industrialeve.com/colony-builder/" target="_blank"
                 rel="noreferrer" style={{ color: 'var(--gold,#f0c040)' }}>
                de colony builder van industrialeve.com</a> handig voor. Die kan
              je opzet niet vanaf hier inladen, dus kies daar zelf het planeettype
              en zet de gebouwen hieronder neer.
            </div>
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 280 }}>
                <b style={{ fontSize: '0.82rem' }}>Extractieplaneet ({plan.extractie}×)</b>
                <pre style={{ margin: '.4rem 0', fontSize: '.72rem', lineHeight: 1.5,
                  color: 'var(--text-dim)' }}>{`      extractor   basis-fabriek
               \   /
                LAUNCHPAD
               /   \
      extractor   basis-fabriek`}</pre>
                <div style={{ fontSize: '.74rem', color: 'var(--text-dim)' }}>
                  Twee extractors op de hotspot, de launchpad ertussen, twee
                  basisfabrieken die er P1 van maken. Extractorkoppen zijn gratis —
                  alleen de links tússen gebouwen kosten CPU.
                </div>
                <div style={{ marginTop: '.4rem', fontSize: '.8rem', ...balk(ex) }}>
                  {fmt(ex)} van {fmt(budget)} CPU
                  <span style={{ color: 'var(--text-dim)' }}> · rest voor links</span>
                </div>
              </div>
              <div style={{ minWidth: 280 }}>
                <b style={{ fontSize: '0.82rem' }}>Fabrieksplaneet ({plan.fabriek}×)</b>
                <pre style={{ margin: '.4rem 0', fontSize: '.72rem', lineHeight: 1.5,
                  color: 'var(--text-dim)' }}>{`   fabriek   STORAGE   fabriek
          \    |    /
           LAUNCHPAD
          /    |    \
   fabriek   fabriek   fabriek`}</pre>
                <div style={{ fontSize: '.74rem', color: 'var(--text-dim)' }}>
                  Launchpad in het midden, fabrieken er strak omheen. Eén storage
                  erbij voor de buffer: die houdt 12.000 m³ vast tegen 500 CPU,
                  waar een tweede launchpad er 3.600 zou kosten voor minder ruimte.
                </div>
                <div style={{ marginTop: '.4rem', fontSize: '.8rem', ...balk(fa) }}>
                  {fmt(fa)} van {fmt(budget)} CPU
                  <span style={{ color: 'var(--text-dim)' }}> · rest voor links</span>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── wat er in de buurt ligt ── */}
      <div style={kaart}>
        <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.72rem', letterSpacing: '0.1em',
          color: 'var(--text-dim)' }}>
          PLANETEN BINNEN {maxSprong} SPRONGEN — klik een systeem om het uit te sluiten
        </h3>
        {buurt.map(s => {
          const uit = uitgesloten.includes(s.naam)
          const telling = s.planeten.reduce<Record<string, number>>(
            (a, p) => ({ ...a, [p.type]: (a[p.type] ?? 0) + 1 }), {})
          return (
            <div key={s.id} onClick={() => setUitgesloten(v =>
              uit ? v.filter(x => x !== s.naam) : [...v, s.naam])}
              style={{ display: 'flex', gap: 10, padding: '0.28rem 0', fontSize: '0.8rem',
                cursor: 'pointer', opacity: uit ? 0.4 : 1,
                textDecoration: uit ? 'line-through' : 'none' }}>
              <span style={{ width: 90, fontWeight: 600 }}>{s.naam}</span>
              <span style={{ width: 52, color: 'var(--text-dim)' }}>
                {s.sprongen === 0 ? 'thuis' : `${s.sprongen} spr`}</span>
              <span style={{ flex: 1 }}>
                {Object.entries(telling).sort().map(([t, n]) => (
                  <span key={t} style={{ color: PLANEETKLEUR[t] ?? '#8a93a8', marginRight: 10 }}>
                    {n}× {t}</span>
                ))}
              </span>
            </div>
          )
        })}
        <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
          Hoe rijk een planeet is staat in geen database — niet in de SDE en niet in ESI.
          Lees het af in de client en vul het hierboven in bij <b>P0/uur per planeet</b>;
          alles wat daarvan afhangt is een schatting met jouw getal.
        </div>
      </div>
    </Layout>
  )
}
