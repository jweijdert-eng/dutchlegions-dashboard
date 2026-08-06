import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

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

/* De Squall (type 81008) heeft 45.000 m³ infrastructure hold naast 3.000 m³
 * cargo — opgevraagd uit ESI, dogma-attribuut 5646. */
const SQUALL = 45000

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
const laadPlaneten = bestand<Record<string, [number, number][]>>('/planets.json', {})
const laadSystemen = bestand<Record<string, [string, number, number]>>('/systems.json', {})
const laadTypeInfo = bestand<Record<string, [number, number, number]>>('/type-info.json', {})
const laadSprongen = bestand<Record<string, number[]>>('/system-jumps.json', {})

async function jitaPrijzen(ids: number[]): Promise<Map<number, number>> {
  const uit = new Map<number, number>()
  if (!ids.length) return uit
  try {
    const r = await fetch(
      `https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=${ids.join(',')}`,
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

/* ── pagina ────────────────────────────────────────────────────────────── */
export default function PiOpzet() {
  const [sch, setSch] = useState<Record<string, Schem>>({})
  const [namen, setNamen] = useState<Record<string, string>>({})
  const [planeten, setPlaneten] = useState<Record<string, [number, number][]>>({})
  const [systemen, setSystemen] = useState<Record<string, [string, number, number]>>({})
  const [sprongen, setSprongen] = useState<Record<string, number[]>>({})
  const [prijs, setPrijs] = useState<Map<number, number>>(new Map())
  const [vol, setVol] = useState<Map<number, number>>(new Map())
  const [bezig, setBezig] = useState(true)

  const bewaard = (sleutel: string, leeg: string) =>
    localStorage.getItem('piopzet.' + sleutel) ?? leeg
  const [thuis, setThuis] = useState(bewaard('thuis', 'RF-K9W'))
  const [doel, setDoel] = useState(bewaard('doel', 'Robotics'))
  const [slots, setSlots] = useState(Number(bewaard('slots', '21')))
  const [accounts, setAccounts] = useState(Number(bewaard('accounts', '4')))
  const [maxSprong, setMaxSprong] = useState(Number(bewaard('maxsprong', '2')))
  const [oogst, setOogst] = useState(Number(bewaard('oogst', '12000')))
  const [perFabriekPlaneet, setPerFabriekPlaneet] = useState(Number(bewaard('perplaneet', '5')))
  const [uitgesloten, setUitgesloten] = useState<string[]>(
    JSON.parse(bewaard('uit', '["AJI-MA"]')))

  useEffect(() => {
    const w = { thuis, doel, slots, accounts, maxsprong: maxSprong, oogst,
                perplaneet: perFabriekPlaneet, uit: JSON.stringify(uitgesloten) }
    for (const [k, v] of Object.entries(w)) localStorage.setItem('piopzet.' + k, String(v))
  }, [thuis, doel, slots, accounts, maxSprong, oogst, perFabriekPlaneet, uitgesloten])

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
      // Alleen het romeinse nummer en het planeettype; de planeet-id gebruikten
      // we nergens en die halveerde wel de bundel.
      planeten: (planeten[id] ?? []).map(([idx, tid]) => ({
        idx, type: PLANEETTYPE[tid] ?? String(tid),
      })),
    })).sort((a, b) => a.sprongen - b.sprongen || a.naam.localeCompare(b.naam))
  }, [thuisId, sprongen, systemen, planeten, maxSprong])

  /* hoeveel lijnen passen er in je slots? */
  const plan = useMemo(() => {
    if (!eenLijn) return null
    const nodig = eenLijn.p0
    const bruikbaar = new Set(buurt.filter(s => !uitgesloten.includes(s.naam))
      .flatMap(s => s.planeten.map(p => p.type)))
    const tekort = nodig.filter(r =>
      ![...bruikbaar].some(t => (PLANEET_P0[t] ?? []).includes(r.naam)))

    /* per lijn: extractieplaneten per grondstof + fabrieksplaneten */
    /* Alleen P2 en hoger tellen mee voor de fabrieksplaneten; de P1-fabrieken
     * draaien op de extractieplaneten waar de grondstof vandaan komt. Die
     * stonden hier eerst óók bij, en dan passen er kunstmatig minder lijnen. */
    const fabriekenPerLijn = eenLijn.stappen
      .filter(s => !s.opExtractie)
      .reduce((a, s) => a + Math.ceil(s.fabrieken), 0)
    const beste = { lijnen: 0, extractie: 0, fabriek: 0 }
    for (let L = 1; L <= 40; L++) {
      const ex = nodig.reduce((a, r) => a + Math.ceil(r.perUur * L / Math.max(1, oogst)), 0)
      const fab = Math.ceil(fabriekenPerLijn * L / Math.max(1, perFabriekPlaneet))
      if (ex + fab > slots) break
      beste.lijnen = L; beste.extractie = ex; beste.fabriek = fab
    }
    return { ...beste, tekort, fabriekenPerLijn }
  }, [eenLijn, buurt, uitgesloten, oogst, slots, perFabriekPlaneet])

  /* Jita-waarde van de opbrengst */
  useEffect(() => {
    if (!eenLijn) return
    const ids = eenLijn.stappen.map(s => s.typeId)
    jitaPrijzen(ids).then(setPrijs)
  }, [eenLijn])

  /* Het eindproduct staat vooraan: de lijst is aflopend op tier gesorteerd.
   * Stond hier eerst [length - 1], en dat is juist de láágste trap — de teller
   * riep dan 5.760 Robotics/dag terwijl het er 216 zijn. */
  const doelStap = eenLijn?.stappen.find(s => s.typeId === eenLijn.doelId)
  const perDag = (doelStap?.perUur ?? 0) * 24 * (plan?.lijnen ?? 0)
  const iskDag = perDag * (prijs.get(doelStap?.typeId ?? 0) ?? 0)

  /* welke planeten stel ik voor, verdeeld over de accounts */
  const verdeling = useMemo(() => {
    if (!plan || !eenLijn) return []
    const gekozen: { systeem: string; sprongen: number; planeet: string; type: string; rol: string }[] = []
    const vrij = buurt.filter(s => !uitgesloten.includes(s.naam))
      .flatMap(s => s.planeten.map(p => ({ ...p, systeem: s.naam, sprongen: s.sprongen })))

    for (const r of eenLijn.p0) {
      const nodigAantal = Math.ceil(r.perUur * plan.lijnen / Math.max(1, oogst))
      const kandidaten = vrij
        .filter(p => (PLANEET_P0[p.type] ?? []).includes(r.naam)
          && !gekozen.some(g => g.planeet === `${p.systeem} ${ROMEINS[p.idx]}`))
        .sort((a, b) => a.sprongen - b.sprongen)
      for (const p of kandidaten.slice(0, nodigAantal)) {
        gekozen.push({ systeem: p.systeem, sprongen: p.sprongen,
          planeet: `${p.systeem} ${ROMEINS[p.idx]}`, type: p.type, rol: `${r.naam} → P1` })
      }
    }
    /* fabrieksplaneten: het dichtst bij huis, type doet er niet toe */
    const rest = vrij
      .filter(p => !gekozen.some(g => g.planeet === `${p.systeem} ${ROMEINS[p.idx]}`))
      .sort((a, b) => a.sprongen - b.sprongen)
    for (const p of rest.slice(0, plan.fabriek)) {
      gekozen.push({ systeem: p.systeem, sprongen: p.sprongen,
        planeet: `${p.systeem} ${ROMEINS[p.idx]}`, type: p.type, rol: 'fabriek P2/P3' })
    }
    return gekozen
  }, [plan, eenLijn, buurt, uitgesloten, oogst])

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
        <label style={label}>PLANEETSLOTS
          <input type="number" min={1} max={100} value={slots}
            onChange={e => setSlots(Math.max(1, +e.target.value || 1))} style={invoer} /></label>
        <label style={label}>ACCOUNTS
          <input type="number" min={1} max={20} value={accounts}
            onChange={e => setAccounts(Math.max(1, +e.target.value || 1))} style={invoer} /></label>
        <label style={label}>MAX SPRONGEN
          <input type="number" min={0} max={6} value={maxSprong}
            onChange={e => setMaxSprong(Math.max(0, +e.target.value || 0))} style={invoer} /></label>
        <label style={label} title="Wat één extractieplaneet per uur van één grondstof levert. Staat in geen enkele database — lees het af in de client.">
          P0/UUR PER PLANEET
          <input type="number" min={1000} step={1000} value={oogst}
            onChange={e => setOogst(Math.max(1, +e.target.value || 1))} style={invoer} /></label>
        <label style={label}>FABRIEKEN/PLANEET
          <input type="number" min={1} max={12} value={perFabriekPlaneet}
            onChange={e => setPerFabriekPlaneet(Math.max(1, +e.target.value || 1))} style={invoer} /></label>
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
                {plan.lijnen} productielijn{plan.lijnen === 1 ? '' : 'en'} ·{' '}
                {plan.extractie} extractie + {plan.fabriek} fabriek = {plan.extractie + plan.fabriek}{' '}
                van je {slots} slots
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
            VOORSTEL — {verdeling.length} planeten over {accounts} accounts
          </h3>
          {Array.from({ length: accounts }, (_, a) => {
            const mijn = verdeling.filter((_, i) => i % accounts === a)
            if (!mijn.length) return null
            return (
              <div key={a} style={{ marginBottom: '0.7rem' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--gold,#f0c040)', fontWeight: 700 }}>
                  ACCOUNT {a + 1} — {mijn.length} planeten
                </div>
                {mijn.map(p => (
                  <div key={p.planeet} style={{ display: 'flex', gap: 8, fontSize: '0.78rem',
                    padding: '0.16rem 0' }}>
                    <span style={{ width: 106 }}>{p.planeet}</span>
                    <span style={{ width: 74, color: PLANEETKLEUR[p.type] ?? '#8a93a8' }}>{p.type}</span>
                    <span style={{ width: 58, color: 'var(--text-dim)' }}>
                      {p.sprongen === 0 ? 'thuis' : `${p.sprongen} spr`}</span>
                    <span style={{ flex: 1, color: 'var(--text-dim)' }}>{p.rol}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

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
