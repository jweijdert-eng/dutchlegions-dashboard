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
import { useEffect, useMemo, useState } from 'react'
import { usePageLoading } from '../hooks/usePageLoading'
import {
  PLANEETKLEUR, PLANEETTYPE, PLANEET_P0,
  bouwKeten, kiesPlaneten, laadNamen, laadPlaneten, laadSchematics, laadSprongen,
  laadSystemen, pasInSystemen, perAccount,
  type Keten, type PasvormSys, type Schem,
} from '../lib/pi'

const fmt = (n: number, d = 0) =>
  n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d })

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

  const keten = useMemo<Keten | null>(
    () => (Object.keys(sch).length ? bouwKeten(sch, namen, doel, 1) : null),
    [sch, namen, doel])

  const plan = useMemo(
    () => (keten ? pasInSystemen(keten, kandidaten, accountSlots, oogst, perFabriekPlaneet) : null),
    [keten, kandidaten, accountSlots, oogst, perFabriekPlaneet])

  const rijen = useMemo(() => {
    if (!plan || !keten || !plan.lijnen) return []
    return perAccount(kiesPlaneten(plan as PasvormSys, keten, buurt, new Set()), accountSlots)
  }, [plan, keten, buurt, accountSlots])

  /* Hoeveel eindproduct er per dag uit komt: de bovenste stap maal het aantal
   * lijnen dat past. */
  const perDag = useMemo(() => {
    if (!keten || !plan?.lijnen) return 0
    /* Op `doelId` zoeken en niet op de laatste stap: `stappen` staat op tier
     * gesorteerd met het eindproduct vóóraan, dus achteraan staat een P1. */
    const top = keten.stappen.find(s => s.typeId === keten.doelId)
    return (top?.perUur ?? 0) * plan.lijnen * 24
  }, [keten, plan])

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
    <div style={{ padding: '1rem 1.2rem 3rem', maxWidth: '82rem' }}>
      <h2 style={{ margin: '0 0 0.15rem', fontSize: '1.05rem' }}>PI-opzet</h2>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginBottom: '0.9rem' }}>
        Wat zet je per account neer, en welk gebouw komt erin.
      </div>

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
          <input id="slots" value={perAcc} onChange={e => setPerAcc(e.target.value)}
            style={{ ...invoer, width: 110 }} title="Eén getal per karakter, bv. 6,5,5,5" />
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

      {rijen.length > 0 && (
        <>
          <div style={{ ...kaart, display: 'flex', gap: '1.6rem', flexWrap: 'wrap',
            alignItems: 'baseline' }}>
            <div>
              <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold,#f0c040)' }}>
                {fmt(perDag)}</span>
              <span style={{ marginLeft: 6 }}>{doel}/dag</span>
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>
              {plan?.lijnen} lijn{plan?.lijnen === 1 ? '' : 'en'} ·{' '}
              {rijen.reduce((n, a) => n + a.rijen.length, 0)} kolonies ·{' '}
              {rijen.length} account{rijen.length === 1 ? '' : 's'}
            </div>
          </div>

          <div style={{ display: 'grid', gap: '0.7rem',
            gridTemplateColumns: 'repeat(auto-fill, minmax(21rem, 1fr))' }}>
            {rijen.map((a, i) => {
              /* Op rol groeperen: "4× Base Metals" leest sneller dan vier losse
               * regels met dezelfde tekst erachter. */
              const groepen = new Map<string, typeof a.rijen>()
              for (const r of a.rijen) {
                const lijst = groepen.get(r.rol) ?? []
                lijst.push(r)
                groepen.set(r.rol, lijst)
              }
              return (
                <div key={`${a.nr}:${i}`} style={{ ...kaart, marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8,
                    marginBottom: '0.45rem' }}>
                    <b style={{ color: 'var(--gold,#f0c040)' }}>ACCOUNT {a.nr}</b>
                    <span>{a.systeem}</span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.74rem',
                      color: 'var(--text-dim)' }}>{a.rijen.length}/{a.slots} slots</span>
                  </div>
                  {[...groepen.entries()].map(([rol, rs]) => (
                    <div key={rol} style={{ display: 'flex', gap: 8, alignItems: 'baseline',
                      fontSize: '0.8rem', padding: '0.16rem 0' }}>
                      <span style={{ minWidth: 20, color: 'var(--text-dim)' }}>{rs.length}×</span>
                      <span style={{ flex: 1,
                        color: rol.includes('Facility') || rol.includes('Plant')
                          ? 'var(--accent, #6cf)' : '#fff' }}>
                        {rol.replace(' → P1', '')}</span>
                      <span style={{ minWidth: 62, fontSize: '0.74rem',
                        color: PLANEETKLEUR[rs[0].type] ?? '#8a93a8' }}>{rs[0].type}</span>
                      <span style={{ minWidth: 92, textAlign: 'right', color: 'var(--text-dim)' }}>
                        {rs.map((r, j) => (
                          <span key={j} title={`${r.planeet} · ${r.type}`}>
                            {j > 0 && ', '}{r.planeet.replace(a.systeem + ' ', '')}
                            {r.gedeeld && <span style={{ color: 'var(--gold,#f0c040)' }}
                              title="Tweede kolonie op deze planeet; de extractors delen de hotspots en halen dus minder.">+</span>}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: '0.8rem', fontSize: '0.76rem', color: 'var(--text-dim)' }}>
            Op een <b>extractieplaneet</b>: Extractor Control Unit plus de Basic Industry
            Facilities die je P1 maken. Op een <b>fabrieksplaneet</b>: {perFabriekPlaneet}×
            {' '}Advanced Industry Facility
            {heeftP4 && '; de High-Tech Production Plant kan alleen op Barren of Temperate'}.
            {' '}Elke planeet heeft daarnaast een Command Center en een Launchpad. Een{' '}
            <b>+</b> betekent een tweede kolonie op dezelfde planeet — dat mag, maar de
            extractors delen dan de hotspots.
          </div>
        </>
      )}
    </div>
  )
}
