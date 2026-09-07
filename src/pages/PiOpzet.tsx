/**
 * PI-opzet — wat zet ik neer?
 *
 * Eén vraag, één scherm: je kiest een product en een thuissysteem, en je krijgt
 * per account te zien welke kolonies je waar neerzet en welk gebouw erin komt.
 *
 * De vorige versie kon veel meer — een ranglijst van wat het meest opbrengt,
 * een logistiekberekening, een verhuisplan, een planetenverkenner — en juist
 * daardoor moest je zoeken naar het antwoord op deze ene vraag. Wat eruit is,
 * is er bewust uit; de rekenkern eronder (`src/lib/pi.ts`) is ongewijzigd
 * gebleven, inclusief de correcties die in de praktijk gevonden zijn.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'
import { useAuth } from '../auth/AuthContext'
import { getPlanetDetail, getPlanetInfo, getPlanets, getSkillsInfo } from '../api/esi'
import {
  PLANEETKLEUR, PLANEETTYPE, PLANEET_P0,
  bouwKeten, kiesPlaneten, laadNamen, laadPlaneten, laadSchematics, laadSprongen,
  jitaPrijzen, laadSystemen, pasInSystemen, perAccount,
  type Keten, type PasvormSys, type Schem,
} from '../lib/pi'

const fmt = (n: number, d = 0) =>
  n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d })

/* De twee skills die hierover gaan. Interplanetary Consolidation geeft je
 * planeten (één plus het niveau); Command Center Upgrades bepaalt hoeveel er op
 * zo'n planeet past. */
/* Type-id van het command center per planeetsoort. Ze zijn niet te bouwen, dus
 * dit is puur een inkooplijst. */
const CC_TYPE: Record<string, number> = {
  Barren: 2524, Gas: 2534, Ice: 2533, Lava: 2549,
  Oceanic: 2525, Plasma: 2551, Storm: 2550, Temperate: 2254,
}
const CC_M3 = 1000        // elk command center, ingepakt (ESI: volume 1000)

const SKILL_PLANETEN = 2495
const SKILL_CC = 2505

/* Wat een command center levert per upgradeniveau: [powergrid, cpu]. Niveau 0
 * komt uit ESI zelf (attribuut 11 en 48 op het Command Center: 6000 en 1675);
 * de niveaus daarboven zijn de bekende tabel van CCP. */
const CC_BUDGET: Record<number, [number, number]> = {
  0: [6000, 1675], 1: [9000, 7057], 2: [12000, 12136],
  3: [15000, 17215], 4: [17000, 21315], 5: [19000, 25415],
}
/* Wat een gebouw kost, ook uit ESI (attribuut 15 = powergrid, 49 = cpu). */
const KOST = { launchpad: [700, 3600], geavanceerd: [700, 500] }

/**
 * Hoeveel Advanced Industry Facilities er naast een launchpad passen.
 *
 * Alleen op CPU en powergrid gerekend. Links en routes kosten óók, en hoeveel
 * hangt af van hoe de gebouwen op de planeet liggen - dat weet deze pagina niet.
 * Het is dus een bovengrens, geen belofte.
 */
function maxFabrieken(ccNiveau: number): number {
  const [pg, cpu] = CC_BUDGET[Math.max(0, Math.min(5, ccNiveau))] ?? CC_BUDGET[0]
  return Math.max(0, Math.min(
    Math.floor((pg - KOST.launchpad[0]) / KOST.geavanceerd[0]),
    Math.floor((cpu - KOST.launchpad[1]) / KOST.geavanceerd[1]),
  ))
}

const fmtISK = (n: number) =>
  n >= 1e9 ? `${fmt(n / 1e9, 2)} mld` : n >= 1e6 ? `${fmt(n / 1e6, 1)} mln` : fmt(n)

export default function PiOpzet() {
  const [sch, setSch] = useState<Record<string, Schem>>({})
  const [namen, setNamen] = useState<Record<string, string>>({})
  const [planeten, setPlaneten] = useState<Record<string, [number, number, number][]>>({})
  const [systemen, setSystemen] = useState<Record<string, [string, number, number]>>({})
  const [sprongen, setSprongen] = useState<Record<string, number[]>>({})
  const [bezig, setBezig] = useState(true)

  const bewaard = (sleutel: string, leeg: string) =>
    localStorage.getItem('piopzet.' + sleutel) ?? leeg
  const [thuis, setThuis] = useState(bewaard('thuis', 'Q-02UL'))
  const [doel, setDoel] = useState(bewaard('doel', 'Neocoms'))
  /* Per karakter apart, want Interplanetary Consolidation verschilt: één plus
   * je skillniveau, dus V geeft zes planeten en IV vijf. "6,5,5,5" is vier
   * karakters met samen 21 slots. */
  const [perAcc, setPerAcc] = useState(bewaard('peraccount', '6,5,5,5'))
  const [maxSprong, setMaxSprong] = useState(Number(bewaard('maxsprong', '2')))
  const [oogst, setOogst] = useState(Number(bewaard('oogst', '12000')))
  const [perFabriekPlaneet, setPerFabriekPlaneet] = useState(Number(bewaard('perplaneet', '5')))

  useEffect(() => {
    const w = { thuis, doel, peraccount: perAcc, maxsprong: maxSprong, oogst,
                perplaneet: perFabriekPlaneet }
    for (const [k, v] of Object.entries(w)) localStorage.setItem('piopzet.' + k, String(v))
  }, [thuis, doel, perAcc, maxSprong, oogst, perFabriekPlaneet])

  useEffect(() => {
    let leeft = true
    Promise.all([laadSchematics(), laadNamen(), laadPlaneten(), laadSystemen(), laadSprongen()])
      .then(([s, n, p, sy, sp]) => {
        if (!leeft) return
        setSch(s); setNamen(n); setPlaneten(p); setSystemen(sy); setSprongen(sp)
        setBezig(false)
      })
    return () => { leeft = false }
  }, [])
  usePageLoading(bezig)
  const { tokens } = useAuth()

  const accountSlots = useMemo(() => perAcc.split(/[,;\s]+/)
    .map(x => Math.max(0, Math.min(6, parseInt(x) || 0))).filter(Boolean), [perAcc])

  const producten = useMemo(() =>
    Object.values(sch).map(s => s.schematic_name).sort((a, b) => a.localeCompare(b)),
    [sch])

  const thuisId = useMemo(() => Object.entries(systemen)
    .find(([, v]) => v[0].toLowerCase() === thuis.toLowerCase())?.[0], [systemen, thuis])

  /* De systemen binnen bereik, met hun planeten. */
  const buurt = useMemo(() => {
    if (!thuisId || !Object.keys(sprongen).length) return []
    const afst: Record<number, number> = { [Number(thuisId)]: 0 }
    let rand = [Number(thuisId)]
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

  const kandidaten = useMemo(() => buurt.map(s => {
    const perType: Record<string, number> = {}
    for (const p of s.planeten) if (PLANEET_P0[p.type]) perType[p.type] = (perType[p.type] ?? 0) + 1
    return { naam: s.naam, sprongen: s.sprongen, slots: 0, kar: 1, perType }
  }), [buurt])

  /* Wat er nu écht in de grond staat.
   *
   * Zonder dit rekende de planner elke keer een verse opzet uit: zet je de
   * kolonies neer en verandert er daarna iets aan de verdeling, dan schoof het
   * plan naar andere planeten en klopte het niet meer met het spel. De planeten
   * waar je al staat krijgen nu voorrang. */
  /* De async-lus hieronder leest namen en recepten; via een ref, anders zou hij
   * opnieuw moeten draaien zodra die data binnen is. */
  const namenRef = useRef(namen)
  namenRef.current = namen
  const schRef = useRef(sch)
  schRef.current = sch
  const [bezet, setBezet] = useState<Set<string>>(new Set())
  const [staatEr, setStaatEr] = useState<
    { naam: string; planeten: { naam: string; wat: string }[] }[]>([])
  const charSleutel = tokens.map(t => t.characterId).join(',')
  useEffect(() => {
    let leeft = true
    if (!tokens.length) { setBezet(new Set()); setStaatEr([]); return }
    ;(async () => {
      const per: { naam: string; planeten: { naam: string; wat: string }[] }[] = []
      const alle = new Set<string>()
      for (const t of tokens) {
        try {
          const kolonies = await getPlanets(t.characterId, t.accessToken)
          const lijst: { naam: string; wat: string }[] = []
          for (const k of kolonies) {
            const info = await getPlanetInfo(k.planet_id)
            if (!info?.name) continue
            alle.add(info.name)
            /* Wat er op die planeet draait: de ECU zegt welke grondstof hij
             * haalt, elke fabriek welk recept erin zit. Zo zie je in één regel
             * of de planeet doet wat het plan ervan verwacht. */
            let wat = ''
            try {
              const detail = await getPlanetDetail(t.characterId, k.planet_id, t.accessToken)
              const telling = new Map<string, number>()
              let haalt = ''
              for (const pin of detail.pins ?? []) {
                const grondstof = pin.extractor_details?.product_type_id
                if (grondstof) {
                  haalt = namenRef.current[String(grondstof)] ?? `type ${grondstof}`
                } else if (pin.schematic_id) {
                  const recept = schRef.current[String(pin.schematic_id)]?.schematic_name
                    ?? `recept ${pin.schematic_id}`
                  telling.set(recept, (telling.get(recept) ?? 0) + 1)
                }
              }
              const fabrieken = [...telling.entries()].map(([n2, aantal]) => `${aantal}× ${n2}`)
              wat = [haalt && `haalt ${haalt}`, ...fabrieken].filter(Boolean).join(', ')
            } catch { /* detail mag missen; de planeetnaam is het belangrijkst */ }
            lijst.push({ naam: info.name, wat })
          }
          if (lijst.length) {
            per.push({ naam: t.characterName,
                       planeten: lijst.sort((a, b) => a.naam.localeCompare(b.naam)) })
          }
        } catch { /* geen PI-scope of geen kolonies: dan telt hij niet mee */ }
      }
      if (leeft) { setBezet(alle); setStaatEr(per) }
    })()
    return () => { leeft = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charSleutel])

  const keten = useMemo<Keten | null>(
    () => (Object.keys(sch).length ? bouwKeten(sch, namen, doel, 1) : null),
    [sch, namen, doel])

  const plan = useMemo(
    () => (keten ? pasInSystemen(keten, kandidaten, accountSlots, oogst, perFabriekPlaneet) : null),
    [keten, kandidaten, accountSlots, oogst, perFabriekPlaneet])

  const rijen = useMemo(() => {
    if (!plan || !keten || !plan.lijnen) return []
    return perAccount(kiesPlaneten(plan as PasvormSys, keten, buurt, bezet), accountSlots)
  }, [plan, keten, buurt, accountSlots, bezet])

  /* Hoeveel eindproduct er per dag uit komt: de bovenste stap maal het aantal
   * lijnen dat past. */
  const perDag = useMemo(() => {
    if (!keten || !plan?.lijnen) return 0
    /* Op `doelId` zoeken en niet op de laatste stap: `stappen` staat op tier
     * gesorteerd met het eindproduct vóóraan, dus achteraan staat een P1. */
    const top = keten.stappen.find(s => s.typeId === keten.doelId)
    return (top?.perUur ?? 0) * plan.lijnen * 24
  }, [keten, plan])

  /* Welke P1 er van een grondstof gemaakt wordt. Op de extractieplaneet staat
   * naast de extractor een Basic Industry Facility, en die maakt dít. */
  const p1Van = useMemo(() => {
    const uit = new Map<string, string>()
    if (!keten) return uit
    const maakt = new Set(Object.values(sch)
      .map(x => x.pins.find(pin => !pin.is_input)?.type_id).filter(Boolean) as number[])
    for (const x of Object.values(sch)) {
      const eruit = x.pins.find(pin => !pin.is_input)
      const erin = x.pins.filter(pin => pin.is_input)
      if (!eruit || erin.some(pin => maakt.has(pin.type_id))) continue   // geen P1
      for (const pin of erin) {
        const grondstof = namen[String(pin.type_id)]
        if (grondstof) uit.set(grondstof, namen[String(eruit.type_id)] ?? x.schematic_name)
      }
    }
    return uit
  }, [sch, namen, keten])

  /* Alle fabrieken die het plan vraagt, op een rijtje en op niveau gesorteerd:
   * eerst de P2's, dan de P3's, dan de P4. Wélke fabriek op wélke planeet komt
   * is hier pas een vraag; de planner telt alleen hoeveel planeten je nodig
   * hebt. */
  const fabriekenLos = useMemo(() => {
    if (!keten || !plan?.lijnen) return [] as string[]
    const los: string[] = []
    for (const st of [...keten.stappen].filter(x => !x.opExtractie)
      .sort((x, y) => x.niveau - y.niveau)) {
      for (let i = 0; i < Math.ceil(st.fabrieken * plan.lijnen); i++) los.push(st.naam)
    }
    return los
  }, [keten, plan])

  /* Uitsmeren over de fabrieksplaneten die er in het plan staan.
   *
   * Vaste groepjes van `perFabriekPlaneet` leken logisch, maar het plan rondt
   * per systeem en per account naar boven af — er staan dus vaak méér
   * fabrieksplaneten dan er volle groepjes zijn, en dan kreeg de laatste er
   * geen: een regel die alleen "fabriek" zei, zonder één fabriek erachter.
   * Nu krijgt elke planeet een eerlijk deel, nooit meer dan hij aankan. */
  const fabriekVan = useMemo(() => {
    const kaart = new Map<string, string[]>()
    const cap = Math.max(1, perFabriekPlaneet)
    let i = 0
    for (const acc of rijen) {
      for (const r of acc.rijen) {
        if (!(r.rol.includes('Facility') || r.rol.includes('Plant'))) continue
        kaart.set(`${acc.nr}:${r.planeet}:${r.rol}`, fabriekenLos.slice(i, i + cap))
        i += cap
      }
    }
    return kaart
  }, [rijen, fabriekenLos, perFabriekPlaneet])

  /* Planeten vol maken kan er eentje overhouden.
   *
   * Het plan reserveert de fabrieksplaneten per systeem en per account, en
   * rondt daarbij elke keer naar boven af — samen dus soms één meer dan er
   * fabrieken zijn. Die lege planeet hoort niet in het overzicht: hij kost je
   * een slot en een command center voor niets. */
  const getoond = useMemo(() => rijen
    .map(a => ({ ...a, rijen: a.rijen.filter(r =>
      !(r.rol.includes('Facility') || r.rol.includes('Plant'))
      || (fabriekVan.get(`${a.nr}:${r.planeet}:${r.rol}`)?.length ?? 0) > 0) }))
    .filter(a => a.rijen.length), [rijen, fabriekVan])

  /* Hoeveel Basic Industry Facilities er op zo'n extractieplaneet komen: de
   * P1-fabrieken van die grondstof, verdeeld over de planeten die hem oogsten. */
  const p1PerPlaneet = useMemo(() => {
    const uit = new Map<string, number>()
    if (!keten || !plan?.lijnen) return uit
    const planeten = new Map<string, number>()
    for (const acc of getoond) for (const r of acc.rijen) {
      if (r.rol.includes('Facility') || r.rol.includes('Plant')) continue
      const g = r.rol.replace(' → P1', '')
      planeten.set(g, (planeten.get(g) ?? 0) + 1)
    }
    for (const [grondstof, n] of planeten) {
      const p1 = p1Van.get(grondstof)
      const stap = keten.stappen.find(st => st.naam === p1)
      if (!stap) continue
      uit.set(grondstof, Math.max(1, Math.ceil(Math.ceil(stap.fabrieken * plan.lijnen) / n)))
    }
    return uit
  }, [keten, plan, getoond, p1Van])

  /* Wat elk eindproduct in Jita doet. Eén keer ophalen voor alle recepten:
   * daarmee kan de pagina zowel de opbrengst van je keuze tonen als zeggen wat
   * er hier méér oplevert. */
  const typeIdVan = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of Object.values(sch)) {
      const uit = x.pins.find(pin => !pin.is_input)
      if (uit) m.set(x.schematic_name, uit.type_id)
    }
    return m
  }, [sch])

  /* Je skills uitlezen: dan hoef je de slots niet te tellen. */
  const [skills, setSkills] = useState<{ naam: string; planeten: number; cc: number }[]>([])
  const [skillBezig, setSkillBezig] = useState(false)
  const [skillFout, setSkillFout] = useState('')

  const haalSkills = async () => {
    if (!tokens.length) { setSkillFout('Log in om je skills te kunnen lezen.'); return }
    setSkillBezig(true); setSkillFout('')
    try {
      const uit = await Promise.all(tokens.map(async t => {
        const info = await getSkillsInfo(t.characterId, t.accessToken)
        const niveau = (id: number) =>
          info?.skills?.find(sk => sk.skill_id === id)?.active_skill_level ?? 0
        return { naam: t.characterName, planeten: 1 + niveau(SKILL_PLANETEN),
                 cc: niveau(SKILL_CC) }
      }))
      /* Zonder Interplanetary Consolidation heb je één planeet - dat is geen
       * fout, maar zo'n karakter hoort niet in de verdeling. */
      const bruikbaar = uit.filter(x => x.planeten > 1)
      setSkills(uit.sort((a, b) => b.planeten - a.planeten))
      if (bruikbaar.length) {
        setPerAcc(bruikbaar.map(x => x.planeten).sort((a, b) => b - a).join(','))
      } else {
        setSkillFout('Geen van je karakters heeft Interplanetary Consolidation.')
      }
    } catch {
      setSkillFout('Skills ophalen mislukte — token verlopen of scope ontbreekt.')
    } finally { setSkillBezig(false) }
  }

  const [prijzen, setPrijzen] = useState<Map<number, number>>(new Map())
  useEffect(() => {
    const ids = [...typeIdVan.values(), ...Object.values(CC_TYPE)]
    if (ids.length) jitaPrijzen(ids).then(setPrijzen)
  }, [typeIdVan])

  const iskDag = perDag * (prijzen.get(keten?.doelId ?? 0) ?? 0)

  /* Wat levert hier nog meer op? Dezelfde som voor elk recept. Dat kost een
   * seconde rekenen, dus het gebeurt pas als de prijzen binnen zijn. */
  const beter = useMemo(() => {
    if (!Object.keys(sch).length || !prijzen.size || !kandidaten.length) return []
    const uit: { naam: string; perDag: number; isk: number; lijnen: number }[] = []
    for (const naam of producten) {
      const k = bouwKeten(sch, namen, naam, 1)
      if (!k) continue
      const pl = pasInSystemen(k, kandidaten, accountSlots, oogst, perFabriekPlaneet)
      if (!pl.lijnen || pl.tekort.length) continue
      const stap = k.stappen.find(x => x.typeId === k.doelId)
      if (!stap) continue
      const d = stap.perUur * 24 * pl.lijnen
      const isk = d * (prijzen.get(k.doelId) ?? 0)
      if (isk > 0) uit.push({ naam, perDag: d, isk, lijnen: pl.lijnen })
    }
    return uit.sort((a, b) => b.isk - a.isk)
  }, [sch, namen, producten, kandidaten, accountSlots, oogst, perFabriekPlaneet, prijzen])

  /* De planeetsoorten per systeem. `PLANEET_P0` bepaalt de volgorde van de
   * kolommen, zodat er nooit een soort tussenuit valt die wél bestaat. */
  const soorten = useMemo(() => Object.keys(PLANEET_P0), [])
  const telling = useMemo(() => buurt.map(sys => ({
    naam: sys.naam,
    sprongen: sys.sprongen,
    totaal: sys.planeten.length,
    per: Object.fromEntries(soorten.map(t =>
      [t, sys.planeten.filter(pl => pl.type === t).length])) as Record<string, number>,
  })), [buurt, soorten])

  /**
   * Welk character hoort bij welk accountnummer?
   *
   * De nummers komen uit het slots-veld en zijn op zichzelf naamloos. Twee
   * manieren om er een naam bij te vinden, in deze volgorde:
   *
   *  1. **Aan de planeten.** Staat een account grotendeels op planeten waar een
   *     bepaald character al een kolonie heeft, dan is hij het. Dat is de
   *     betrouwbaarste, want die data komt uit het spel.
   *  2. **Aan de skills.** Is het slots-veld met de knop "uit skills" gevuld,
   *     dan staat het rijtje in dezelfde volgorde als de accounts.
   */
  const naamVanAcc = useMemo(() => {
    const uit = new Map<number, string>()
    const vergeven = new Set<string>()
    for (const acc of getoond) {
      let beste = '', raak = 0
      for (const k of staatEr) {
        if (vergeven.has(k.naam)) continue
        const n = acc.rijen.filter(r => k.planeten.some(pl => pl.naam === r.planeet)).length
        if (n > raak) { raak = n; beste = k.naam }
      }
      if (beste) { uit.set(acc.nr, beste); vergeven.add(beste) }
    }
    /* Wat er dan nog leeg is: op volgorde uit de skills, want daar is het
     * slots-veld ook mee gevuld. */
    const over = skills.filter(sk => !vergeven.has(sk.naam) && sk.planeten > 1)
    let i = 0
    for (const acc of getoond) {
      if (uit.has(acc.nr)) continue
      const sk = over[i++]
      if (sk) uit.set(acc.nr, sk.naam)
    }
    return uit
  }, [getoond, staatEr, skills])

  /**
   * De vrachtlijst: wat sleep je van welke planeet naar welke?
   *
   * PI routeert alleen bínnen een planeet. Alles wat een fabriek nodig heeft en
   * niet op diezelfde planeet gemaakt wordt, haal jij op bij de customs office
   * en breng je naar de volgende. Eén regel per rit.
   */
  const logistiek = useMemo(() => {
    if (!getoond.length) return []
    /* Invoer per recept, op naam. De schematics staan op type-id, dus eerst een
     * kaart naam → schematic. */
    const opNaam = new Map<string, Schem>()
    for (const x of Object.values(sch)) opNaam.set(x.schematic_name, x)
    const naamVan = (id: number) => namen[String(id)] ?? `type ${id}`

    /* Stap 1: wat maakt elke planeet? */
    const maakt = new Map<string, Set<string>>()   // planeet → producten
    const bron = new Map<string, string[]>()       // product → planeten
    const zet = (planeet: string, product: string) => {
      if (!maakt.has(planeet)) maakt.set(planeet, new Set())
      maakt.get(planeet)!.add(product)
      const lijst = bron.get(product) ?? []
      if (!lijst.includes(planeet)) lijst.push(planeet)
      bron.set(product, lijst)
    }
    for (const acc of getoond) {
      for (const r of acc.rijen) {
        if (r.rol.includes('Facility') || r.rol.includes('Plant')) {
          for (const recept of fabriekVan.get(`${acc.nr}:${r.planeet}:${r.rol}`) ?? []) {
            zet(r.planeet, recept)
          }
        } else {
          const p1 = p1Van.get(r.rol.replace(' → P1', ''))
          if (p1) zet(r.planeet, p1)
        }
      }
    }

    /* Stap 2: wat heeft elke planeet nodig, en waar komt dat vandaan? Meteen
     * ook de andere kant op onthouden - vanaf een extractieplaneet wil je juist
     * weten waar je je P1 naartoe brengt. */
    const binnen = new Map<string, Map<string, string[]>>()  // planeet → wat ← van
    const heen = new Map<string, Map<string, string[]>>()    // planeet → wat → naar
    const planeten: string[] = []
    /* Wie zit er op die planeet? Een gedeelde planeet heeft er twee, en dan
     * moet je weten wie van de twee dit spul moet ophalen. */
    const accVan = new Map<string, number[]>()
    for (const acc of getoond) {
      for (const r of acc.rijen) {
        if (!planeten.includes(r.planeet)) planeten.push(r.planeet)
        const lijst = accVan.get(r.planeet) ?? []
        if (!lijst.includes(acc.nr)) lijst.push(acc.nr)
        accVan.set(r.planeet, lijst)
      }
    }
    for (const planeet of planeten) {
      const eigen = maakt.get(planeet) ?? new Set<string>()
      for (const product of eigen) {
        const recept = opNaam.get(product)
        if (!recept) continue
        for (const pin of recept.pins.filter(x => x.is_input)) {
          const grondstof = naamVan(pin.type_id)
          if (eigen.has(grondstof)) continue    // maakt hij zelf: niet slepen
          const van = (bron.get(grondstof) ?? []).filter(x => x !== planeet)
          if (!van.length) continue
          if (!binnen.has(planeet)) binnen.set(planeet, new Map())
          binnen.get(planeet)!.set(grondstof, van)
          for (const leverancier of van) {
            if (!heen.has(leverancier)) heen.set(leverancier, new Map())
            const lijst = heen.get(leverancier)!.get(grondstof) ?? []
            if (!lijst.includes(planeet)) lijst.push(planeet)
            heen.get(leverancier)!.set(grondstof, lijst)
          }
        }
      }
    }
    /* Eén regel per rit: waar je het ophaalt, wat het is, waar het heen moet.
     * Dat is de vorm waarin je het werk doet - een planeet met vier pijlen
     * eronder las niemand. */
    const vrachten: { van: string; vanAcc: number[]; wat: string;
                      naar: string; naarAcc: number[] }[] = []
    for (const [naar, watKaart] of binnen) {
      for (const [wat, vanaf] of watKaart) {
        for (const van of vanaf) {
          vrachten.push({ van, vanAcc: accVan.get(van) ?? [], wat,
                          naar, naarAcc: accVan.get(naar) ?? [] })
        }
      }
    }
    vrachten.sort((a, b) => a.van.localeCompare(b.van) || a.wat.localeCompare(b.wat))
    return vrachten
  }, [getoond, fabriekVan, p1Van, sch, namen, naamVanAcc])

  /* Wat je moet inkopen: één command center per kolonie, in de soort van de
   * planeet waar hij op komt. */
  const commandCenters = useMemo(() => {
    const per = new Map<string, number>()
    for (const acc of getoond) for (const r of acc.rijen) {
      per.set(r.type, (per.get(r.type) ?? 0) + 1)
    }
    return [...per.entries()]
      .map(([type, n]) => ({ type, n, typeId: CC_TYPE[type] ?? 0,
                             isk: n * (prijzen.get(CC_TYPE[type] ?? 0) ?? 0) }))
      .sort((a, b) => b.n - a.n)
  }, [getoond, prijzen])

  const heeftP4 = rijen.some(a => a.rijen.some(r => r.rol.startsWith('High-Tech')))

  const kaart: React.CSSProperties = {
    background: 'var(--card, #151b24)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '0.9rem 1rem', marginBottom: '1rem',
  }
  const invoer: React.CSSProperties = {
    background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4,
    color: '#fff', padding: '0.3rem 0.45rem', fontSize: '0.78rem', width: 92,
  }
  const label: React.CSSProperties = {
    fontSize: '0.64rem', letterSpacing: '0.08em', color: 'var(--text-dim)',
    textTransform: 'uppercase', display: 'block', marginBottom: 3,
  }

  return (
    <Layout header={<PageHeader title="PI-opzet"
      sub={bezig ? 'Laden…' : `${doel} vanuit ${thuis} · ${accountSlots.length} accounts`} />}>
    <div style={{ maxWidth: '82rem' }}>

      <div style={{ ...kaart, display: 'flex', gap: '0.9rem', flexWrap: 'wrap',
        alignItems: 'flex-end' }}>
        <div>
          <label style={label} htmlFor="doel">Product</label>
          <select id="doel" value={doel} onChange={e => setDoel(e.target.value)}
            style={{ ...invoer, width: 230 }}>
            {producten.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="thuis">Thuissysteem</label>
          <input id="thuis" value={thuis} onChange={e => setThuis(e.target.value.toUpperCase())}
            style={invoer} />
        </div>
        <div>
          <label style={label} htmlFor="slots">Slots per account</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input id="slots" value={perAcc} onChange={e => setPerAcc(e.target.value)}
              style={{ ...invoer, width: 110 }} title="Eén getal per karakter, bv. 6,5,5,5" />
            <button onClick={haalSkills} disabled={skillBezig}
              style={{ ...invoer, width: 'auto', cursor: 'pointer',
                color: 'var(--accent, #6cf)' }}
              title="Interplanetary Consolidation van al je karakters uitlezen">
              {skillBezig ? '…' : 'uit skills'}</button>
          </div>
        </div>
        <details style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
          <summary style={{ cursor: 'pointer', padding: '0.35rem 0' }}>meer</summary>
          <div style={{ display: 'flex', gap: '0.9rem', marginTop: '0.5rem' }}>
            <div>
              <label style={label} htmlFor="sprong">Max sprongen</label>
              <input id="sprong" type="number" min={0} max={6} value={maxSprong}
                onChange={e => setMaxSprong(Number(e.target.value))} style={{ ...invoer, width: 70 }} />
            </div>
            <div>
              <label style={label} htmlFor="oogst">P0/uur per planeet</label>
              <input id="oogst" type="number" step={1000} value={oogst}
                onChange={e => setOogst(Number(e.target.value))} style={invoer} />
            </div>
            <div>
              <label style={label} htmlFor="fab">Fabrieken/planeet</label>
              <input id="fab" type="number" min={1} max={12} value={perFabriekPlaneet}
                onChange={e => setPerFabriekPlaneet(Number(e.target.value))}
                style={{ ...invoer, width: 70 }} />
            </div>
          </div>
        </details>
      </div>

      {(skills.length > 0 || skillFout) && (
        <div style={{ ...kaart, marginTop: '-0.5rem', fontSize: '0.78rem' }}>
          {skillFout
            ? <span style={{ color: 'var(--red,#e05555)' }}>{skillFout}</span>
            : (
              <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
                {skills.map(sk => (
                  <span key={sk.naam}>
                    <b>{sk.naam}</b>{' '}
                    <span style={{ color: 'var(--text-dim)' }}>
                      {sk.planeten} planeten · CC {sk.cc} → hoogstens{' '}
                      {maxFabrieken(sk.cc)} fabrieken/planeet</span>
                  </span>
                ))}
                {skills.length > 0 && (() => {
                  const laagste = Math.min(...skills.map(sk => maxFabrieken(sk.cc)))
                  return laagste > 0 && laagste !== perFabriekPlaneet ? (
                    <button onClick={() => setPerFabriekPlaneet(laagste)}
                      style={{ ...invoer, width: 'auto', cursor: 'pointer',
                        color: 'var(--accent, #6cf)', fontSize: '0.74rem' }}>
                      neem {laagste} over
                    </button>
                  ) : null
                })()}
              </div>
            )}
          {skills.length > 0 && (
            <div style={{ marginTop: '0.4rem', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
              Dat maximum telt alleen CPU en powergrid van een launchpad plus fabrieken.
              Links en routes kosten ook, dus in de praktijk passen er minder.
            </div>
          )}
        </div>
      )}

      {!bezig && plan && !plan.lijnen && (
        <div style={{ ...kaart, borderColor: 'var(--red, #e05555)' }}>
          <b>{doel}</b> past hier niet: {plan.rem || 'geen verdeling die past'}.
          {plan.tekort.length > 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
              Geen planeet in de buurt levert {plan.tekort.map(t => t.naam).join(', ')}.
            </div>
          )}
          {plan.voorEenLijn > 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
              Eén lijn kost {plan.voorEenLijn} planeten; je hebt er{' '}
              {accountSlots.reduce((a, b) => a + b, 0)}.
            </div>
          )}
        </div>
      )}

      {getoond.length > 0 && (
        <>
          <div style={{ ...kaart, display: 'flex', gap: '1.6rem', flexWrap: 'wrap',
            alignItems: 'baseline' }}>
            <div>
              <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold,#f0c040)' }}>
                {fmt(perDag)}</span>
              <span style={{ marginLeft: 6 }}>{doel}/dag</span>
            </div>
            {iskDag > 0 && (
              <div>
                <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--green,#3ecf6e)' }}>
                  {fmtISK(iskDag)}</span>
                <span style={{ marginLeft: 6 }}>per dag</span>
                <span style={{ marginLeft: 8, fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                  {fmtISK(iskDag * 30)} per maand</span>
              </div>
            )}
            <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>
              {getoond.length} account{getoond.length === 1 ? '' : 's'} ·{' '}
              {getoond.reduce((n, a) => n + a.rijen.length, 0)} kolonies ·{' '}
              {getoond.reduce((n, a) => n + a.rijen.filter(r =>
                r.rol.includes('Facility') || r.rol.includes('Plant')).length, 0)} daarvan fabriek
            </div>
          </div>

          {staatEr.length > 0 && (
            <div style={{ ...kaart, marginTop: '1rem' }}>
              <div style={{ fontSize: '0.68rem', letterSpacing: '0.08em',
                color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: '0.45rem' }}>
                Wat je nu al hebt staan
              </div>
              {staatEr.map(k => (
                <div key={k.naam} style={{ padding: '0.25rem 0' }}>
                  <b style={{ fontSize: '0.82rem' }}>{k.naam}</b>
                  {k.planeten.map(pl => (
                    <div key={pl.naam} style={{ display: 'flex', gap: 8, fontSize: '0.78rem',
                      padding: '0.1rem 0 0.1rem 0.8rem' }}>
                      <span style={{ width: 92, fontWeight: 600 }}>{pl.naam}</span>
                      <span style={{ color: 'var(--text-dim)' }}>{pl.wat || '—'}</span>
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ marginTop: '0.4rem', fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                Deze planeten krijgen voorrang in het plan hieronder, en staan daar met een
                &#10003;. Zo blijft de opzet staan waar je al gebouwd hebt.
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gap: '0.7rem',
            gridTemplateColumns: 'repeat(auto-fill, minmax(23rem, 1fr))' }}>
            {getoond.map((a, i) => (
              <div key={`${a.nr}:${i}`} style={{ ...kaart, marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8,
                  marginBottom: '0.5rem' }}>
                  <b style={{ color: 'var(--gold,#f0c040)' }}>
                    {naamVanAcc.get(a.nr) ?? `ACCOUNT ${a.nr}`}</b>
                  <span style={{ color: 'var(--text-dim)' }}>vliegt naar</span>
                  <b>{a.systeem}</b>
                  {(() => {
                    const spr = buurt.find(b2 => b2.naam === a.systeem)?.sprongen
                    return spr === undefined ? null : (
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                        {spr === 0 ? '(thuis)' : `(${spr} sprong${spr === 1 ? '' : 'en'})`}</span>
                    )
                  })()}
                  <span style={{ marginLeft: 'auto', fontSize: '0.74rem',
                    color: 'var(--text-dim)' }}>{a.rijen.length} van {a.slots} slots</span>
                </div>
                {/* Eén regel is één kolonie: nummer, planeet, en wat je er neerzet.
                    Gegroepeerd op rol las korter maar verborg juist dat. */}
                {a.rijen.map((r, j) => {
                  const fabriek = r.rol.includes('Facility') || r.rol.includes('Plant')
                  return (
                    <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'baseline',
                      fontSize: '0.8rem', padding: '0.2rem 0',
                      borderTop: j ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                      <span style={{ width: 16, color: 'var(--text-dim)',
                        fontSize: '0.72rem' }}>{j + 1}</span>
                      <span style={{ width: 92, fontWeight: 600 }}>
                        {r.planeet}
                        {r.gedeeld && <span style={{ color: 'var(--gold,#f0c040)' }}
                          title="Een ander account zet ook een kolonie op deze planeet. Dat mag, maar de extractors delen de hotspots.">+</span>}
                        {bezet.has(r.planeet) && <span style={{ color: 'var(--ok,#4ec9a0)',
                          marginLeft: 4, fontSize: '0.7rem' }}
                          title="Hier staat al een kolonie van je">&#10003;</span>}
                      </span>
                      <span style={{ width: 64, fontSize: '0.74rem',
                        color: PLANEETKLEUR[r.type] ?? '#8a93a8' }}>{r.type}</span>
                      <span style={{ flex: 1 }}>
                        {fabriek ? (() => {
                          const wat = fabriekVan.get(`${a.nr}:${r.planeet}:${r.rol}`) ?? []
                          const geteld = [...new Set(wat)]
                            .map(n2 => `${wat.filter(x => x === n2).length}× ${n2}`)
                          return (
                            <>
                              <span style={{ color: 'var(--accent, #6cf)' }}>fabriek</span>
                              {geteld.length > 0 && <> — {geteld.join(', ')}</>}
                            </>
                          )
                        })() : (() => {
                          const grondstof = r.rol.replace(' → P1', '')
                          const p1 = p1Van.get(grondstof)
                          return (
                            <>
                              <span style={{ color: 'var(--gold,#f0c040)' }}>extractor</span>
                              {' '}— {grondstof}{p1 && <span style={{ color: 'var(--text-dim)' }}>
                                {' '}→ {p1PerPlaneet.get(grondstof) ?? 1}× {p1}</span>}
                            </>
                          )
                        })()}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {logistiek.length > 0 && (
            <div style={{ ...kaart, marginTop: '1rem' }}>
              <div style={{ fontSize: '0.68rem', letterSpacing: '0.08em',
                color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: '0.45rem' }}>
                Wat moet waarheen — {logistiek.length} ritten
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%',
                  fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-dim)', fontSize: '0.68rem',
                      letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      <th style={{ textAlign: 'left', padding: '0.2rem 0.6rem 0.35rem 0' }}>
                        ophalen bij</th>
                      <th style={{ textAlign: 'left', padding: '0.2rem 0.6rem 0.35rem 0' }}>
                        wat</th>
                      <th style={{ textAlign: 'left', padding: '0.2rem 0 0.35rem 0' }}>
                        afleveren bij</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logistiek.map((v2, i) => {
                      const wie = (nrs: number[]) =>
                        nrs.map(nr => naamVanAcc.get(nr) ?? `account ${nr}`).join(' + ')
                      /* Blijft het bij hetzelfde character, dan is het een rondje
                       * dat je in één keer doet; gaat het naar een ander, dan moet
                       * je omloggen. Dat verschil is het enige wat hier telt. */
                      const zelfde = v2.vanAcc.join() === v2.naarAcc.join()
                      return (
                        <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '0.25rem 0.6rem 0.25rem 0',
                            whiteSpace: 'nowrap' }}>
                            <b>{v2.van}</b>{' '}
                            <span style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>
                              {wie(v2.vanAcc)}</span>
                          </td>
                          <td style={{ padding: '0.25rem 0.6rem 0.25rem 0',
                            color: 'var(--accent,#6cf)' }}>{v2.wat}</td>
                          <td style={{ padding: '0.25rem 0', whiteSpace: 'nowrap' }}>
                            <b>{v2.naar}</b>{' '}
                            <span style={{ fontSize: '0.72rem',
                              color: zelfde ? 'var(--text-dim)' : 'var(--gold,#f0c040)' }}>
                              {wie(v2.naarAcc)}{zelfde ? '' : ' ← ander character'}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: '0.4rem', fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                PI routeert alleen binnen een planeet: elke regel hierboven is een rit langs de
                customs office. Staat er twee keer hetzelfde spul met een andere bron, dan
                maken twee planeten het en mag je de dichtstbijzijnde pakken.
              </div>
            </div>
          )}

          {commandCenters.length > 0 && (
            <div style={{ ...kaart, marginTop: '1rem' }}>
              <div style={{ fontSize: '0.68rem', letterSpacing: '0.08em',
                color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: '0.45rem' }}>
                Command centers kopen — één per kolonie
              </div>
              <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap',
                fontSize: '0.86rem' }}>
                {commandCenters.map(c => (
                  <span key={c.type}>
                    <b>{c.n}×</b>{' '}
                    <span style={{ color: PLANEETKLEUR[c.type] ?? '#fff' }}>{c.type}</span>
                    {c.isk > 0 && <span style={{ color: 'var(--text-dim)' }}>
                      {' '}({fmtISK(c.isk)})</span>}
                  </span>
                ))}
              </div>
              <div style={{ marginTop: '0.4rem', fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                Samen {commandCenters.reduce((n, c) => n + c.n, 0)} stuks ·{' '}
                {fmt(commandCenters.reduce((n, c) => n + c.n, 0) * CC_M3)} m³ ·{' '}
                {fmtISK(commandCenters.reduce((n, c) => n + c.isk, 0))} in Jita.
                Ze zijn niet te bouwen, dus dit moet mee in de vracht.
              </div>
            </div>
          )}

          {beter.length > 1 && (
            <div style={{ ...kaart, marginTop: '1rem' }}>
              <div style={{ fontSize: '0.68rem', letterSpacing: '0.08em',
                color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: '0.45rem' }}>
                Wat levert hier het meeste op — klik om te kiezen
              </div>
              {beter.slice(0, 6).map(b => (
                <button key={b.naam} onClick={() => setDoel(b.naam)}
                  style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'baseline',
                    background: b.naam === doel ? 'rgba(255,255,255,0.05)' : 'none',
                    border: 0, borderRadius: 6, color: 'inherit', cursor: 'pointer',
                    padding: '0.25rem 0.4rem', textAlign: 'left', font: 'inherit',
                    fontSize: '0.82rem' }}>
                  <span style={{ flex: 1, fontWeight: b.naam === doel ? 700 : 400 }}>{b.naam}</span>
                  <span style={{ width: 104, textAlign: 'right', color: 'var(--text-dim)',
                    whiteSpace: 'nowrap' }}>{fmt(b.perDag)}/dag</span>
                  <span style={{ width: 96, textAlign: 'right', whiteSpace: 'nowrap',
                    color: 'var(--green,#3ecf6e)' }}>{fmtISK(b.isk)}</span>
                  <span style={{ width: 104, textAlign: 'right', color: 'var(--text-dim)',
                    fontSize: '0.74rem', whiteSpace: 'nowrap' }}>{fmtISK(b.isk * 30)}/mnd</span>
                </button>
              ))}
            </div>
          )}

          {getoond.some(a => a.systeem !== thuis) && (
            <div style={{ marginTop: '0.8rem', fontSize: '0.78rem',
              color: 'var(--gold,#f0c040)' }}>
              Niet alles staat in {thuis}: daar liggen niet de planeetsoorten die dit
              recept vraagt. In de tabel onderaan zie je welke soorten waar liggen.
            </div>
          )}
          <div style={{ marginTop: '0.8rem', fontSize: '0.76rem', color: 'var(--text-dim)' }}>
            Elke kolonie krijgt een Command Center en een Launchpad. Bij een{' '}
            <b>extractor</b> hoort ook een Extractor Control Unit en de Basic Industry
            Facilities die je P1 maken
            {heeftP4 && '; een High-Tech Production Plant kan alleen op Barren of Temperate'}.
            {' '}Een <b>+</b> achter de planeet betekent dat een ander account daar ook
            een kolonie zet — dat mag, maar de extractors delen dan de hotspots.
          </div>
        </>
      )}

      {telling.length > 0 && (
        <div style={{ ...kaart, marginTop: '1rem' }}>
          <div style={{ fontSize: '0.68rem', letterSpacing: '0.08em', color: 'var(--text-dim)',
            textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            Planeten binnen {maxSprong} sprong{maxSprong === 1 ? '' : 'en'} van {thuis}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem',
              fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '0.2rem 0.6rem 0.35rem 0',
                    color: 'var(--text-dim)', fontWeight: 600 }}>Systeem</th>
                  <th style={{ textAlign: 'right', padding: '0.2rem 0.8rem 0.35rem 0',
                    color: 'var(--text-dim)', fontWeight: 600 }}>spr</th>
                  {soorten.map(t => (
                    <th key={t} style={{ textAlign: 'right', padding: '0.2rem 0.7rem 0.35rem 0',
                      color: PLANEETKLEUR[t] ?? 'var(--text-dim)', fontWeight: 600 }}>{t}</th>
                  ))}
                  <th style={{ textAlign: 'right', padding: '0.2rem 0 0.35rem 0',
                    color: 'var(--text-dim)', fontWeight: 600 }}>totaal</th>
                </tr>
              </thead>
              <tbody>
                {telling.map(r => (
                  <tr key={r.naam} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '0.22rem 0.6rem 0.22rem 0',
                      fontWeight: r.naam === thuis ? 700 : 400 }}>{r.naam}</td>
                    <td style={{ textAlign: 'right', padding: '0.22rem 0.8rem 0.22rem 0',
                      color: 'var(--text-dim)' }}>{r.sprongen === 0 ? 'thuis' : r.sprongen}</td>
                    {soorten.map(t => (
                      <td key={t} style={{ textAlign: 'right', padding: '0.22rem 0.7rem 0.22rem 0',
                        color: r.per[t] ? (PLANEETKLEUR[t] ?? '#fff') : 'rgba(255,255,255,0.12)' }}>
                        {r.per[t] || '·'}</td>
                    ))}
                    <td style={{ textAlign: 'right', padding: '0.22rem 0',
                      color: 'var(--text-dim)' }}>{r.totaal}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid rgba(255,255,255,0.15)', fontWeight: 700 }}>
                  <td style={{ padding: '0.3rem 0.6rem 0 0' }}>samen</td>
                  <td />
                  {soorten.map(t => (
                    <td key={t} style={{ textAlign: 'right', padding: '0.3rem 0.7rem 0 0',
                      color: PLANEETKLEUR[t] ?? '#fff' }}>
                      {telling.reduce((n, r) => n + r.per[t], 0) || '·'}</td>
                  ))}
                  <td style={{ textAlign: 'right', padding: '0.3rem 0 0 0' }}>
                    {telling.reduce((n, r) => n + r.totaal, 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
    </Layout>
  )
}
