import { useEffect, useMemo, useRef, useState } from 'react'
import { getSystemCoords, getSystemJumps } from '../api/esi'

// Regiokaart in de stijl van DL Intel: een vaste kaart die nooit verspringt, met
// poortlijnen, grijze bolletjes en kleine namen. Systemen waar een lid zit lichten
// op in de eigen kleur, met de portretten van wie er zit. Geen zoom of pan: je
// leert waar de systemen liggen, en een lid hoeft alleen op te lichten.

export interface KaartLid { character_id: number; name: string; solar_system_id: number; actief: boolean }

interface Props {
  systemen: Record<string, [string, number, number]>   // id → [naam, sec, regio-id]
  regios: Record<string, string>                        // regio-id → naam
  leden: KaartLid[]
  regioId: number | null                                // welke regio tekenen
  hoogte?: number
  gekozen?: number | null                               // aangeklikt systeem
  onKies?: (systemId: number | null) => void
}

const NS_KLEUR = { lijn: '#2b3a3f', bol: '#4a4a4a', naam: '#7d7d7d', eigen: '#71bed3', nadruk: '#c3e9ff', stil: '#41707f' }

interface Punt { id: number; naam: string; x: number; y: number }

export default function WaarKaart({ systemen, regios, leden, regioId, hoogte = 440, gekozen = null, onKies }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<Record<string, [number, number]>>({})
  const [adj, setAdj] = useState<Record<string, number[]>>({})
  const [breed, setBreed] = useState(900)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    getSystemCoords().then(setCoords).catch(() => {})
    getSystemJumps().then(setAdj).catch(() => {})
  }, [])

  // Breedte volgen (de kaart vult zijn vak, de projectie rekent in echte pixels).
  useEffect(() => {
    const el = wrap.current; if (!el) return
    const meet = () => setBreed(Math.max(320, el.getBoundingClientRect().width))
    meet()
    const ro = new ResizeObserver(meet); ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Punten van de regio + projectie (fit in het vak, y omgedraaid zoals in het spel).
  const kaart = useMemo(() => {
    if (!regioId) return null
    const punten: Punt[] = []
    for (const [id, meta] of Object.entries(systemen)) {
      if (meta[2] !== regioId) continue
      const c = coords[id]; if (!c) continue
      punten.push({ id: +id, naam: meta[0], x: c[0], y: -c[1] })
    }
    if (!punten.length) return null
    const hoog = hoogte
    const xs = punten.map(p => p.x), ys = punten.map(p => p.y)
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys)
    const rand = Math.max(14, Math.min(90, Math.min(breed, hoog) * 0.08))
    const s = Math.min((breed - rand * 2) / Math.max(1, maxx - minx), (hoog - rand * 2) / Math.max(1, maxy - miny))
    const dx = rand - minx * s + (breed - rand * 2 - (maxx - minx) * s) / 2
    const dy = rand - miny * s + (hoog - rand * 2 - (maxy - miny) * s) / 2
    const plek = new Map<number, [number, number]>()
    for (const p of punten) plek.set(p.id, [p.x * s + dx, p.y * s + dy])

    // Lettergrootte uit de afstand tot de dichtstbijzijnde buur (5e percentiel), zoals DL Intel.
    const xy = [...plek.values()]
    const buren = xy.map((a, i) => {
      let kortste = Infinity
      for (let j = 0; j < xy.length; j++) { if (i === j) continue; const d = Math.hypot(a[0] - xy[j][0], a[1] - xy[j][1]); if (d < kortste) kortste = d }
      return kortste
    }).sort((a, b) => a - b)
    const krap = buren[Math.floor(buren.length * 0.05)] || 40
    const letter = Math.max(8, Math.min(14, krap / 3.2))

    const lijnen: [number, number, number, number][] = []
    const inRegio = new Set(punten.map(p => p.id))
    for (const p of punten) {
      for (const b of adj[String(p.id)] ?? []) {
        if (!inRegio.has(b) || b < p.id) continue
        const a = plek.get(p.id)!, c = plek.get(b)!
        lijnen.push([a[0], a[1], c[0], c[1]])
      }
    }
    return { punten, plek, lijnen, letter, hoog }
  }, [systemen, coords, adj, regioId, breed, hoogte])

  // Leden per systeem (alleen die in deze regio).
  const perSysteem = useMemo(() => {
    const m = new Map<number, KaartLid[]>()
    for (const l of leden) { const g = m.get(l.solar_system_id) ?? []; g.push(l); m.set(l.solar_system_id, g) }
    return m
  }, [leden])

  // Namen die elkaar overlappen weglaten: bezette systemen eerst, dan van boven naar beneden.
  const labels = useMemo(() => {
    if (!kaart) return new Map<number, { x: number; y: number; anker: 'middle' | 'start' | 'end' } | null>()
    const L = kaart.letter
    const uit = new Map<number, { x: number; y: number; anker: 'middle' | 'start' | 'end' } | null>()
    const bezet: { l: number; r: number; t: number; b: number }[] = []
    const raakt = (a: typeof bezet[0], b: typeof bezet[0]) => !(a.r < b.l || a.l > b.r || a.b < b.t || a.t > b.b)
    const ids = [...kaart.punten].sort((a, b) => {
      const va = perSysteem.has(a.id) ? 1 : 0, vb = perSysteem.has(b.id) ? 1 : 0
      if (va !== vb) return vb - va
      return kaart.plek.get(a.id)![1] - kaart.plek.get(b.id)![1]
    })
    // Bolletjes en portretten zijn ook bezet.
    for (const p of kaart.punten) {
      const [x, y] = kaart.plek.get(p.id)!
      const r = perSysteem.has(p.id) ? L + 4 : Math.max(3, L / 2.2) + 1
      bezet.push({ l: x - r, r: x + r, t: y - r, b: y + r })
    }
    const PLEKKEN: { x: number; y: number; anker: 'middle' | 'start' | 'end' }[] = [
      { x: 0, y: -L - 4, anker: 'middle' }, { x: 0, y: L + 14, anker: 'middle' },
      { x: L + 2, y: L / 3, anker: 'start' }, { x: -L - 2, y: L / 3, anker: 'end' },
    ]
    for (const p of ids) {
      const [x, y] = kaart.plek.get(p.id)!
      const w = p.naam.length * L * 0.62, h = L
      const bezetLid = perSysteem.has(p.id)
      let gelukt: typeof PLEKKEN[0] | null = null
      for (const pk of PLEKKEN) {
        const off = bezetLid && pk.anker === 'middle' && pk.y < 0 ? -6 : 0
        const cx = x + pk.x, cy = y + pk.y + off
        const vak = pk.anker === 'middle' ? { l: cx - w / 2, r: cx + w / 2, t: cy - h, b: cy }
          : pk.anker === 'start' ? { l: cx, r: cx + w, t: cy - h, b: cy } : { l: cx - w, r: cx, t: cy - h, b: cy }
        if (vak.l < 2 || vak.r > breed - 2 || vak.t < 1 || vak.b > kaart.hoog - 1) continue
        if (bezet.some(z => raakt(vak, z))) continue
        gelukt = { ...pk, y: pk.y + off }; bezet.push(vak); break
      }
      uit.set(p.id, gelukt)
    }
    return uit
  }, [kaart, perSysteem, breed])

  const regioNaam = regioId ? (regios[String(regioId)] ?? '') : ''
  const buiten = leden.filter(l => (systemen[String(l.solar_system_id)]?.[2] ?? 0) !== regioId)

  return (
    <div ref={wrap} style={{ position: 'relative', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden',
      background: 'radial-gradient(1200px 800px at 50% 40%, #0d1417 0%, #070707 70%)', height: hoogte }}
      onClick={() => onKies?.(null)}>
      {!kaart && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          {regioId ? 'Kaart laden…' : 'Nog geen regio: zodra iemand gezien is, verschijnt zijn regio hier.'}
        </div>
      )}
      {kaart && (
        <svg width={breed} height={kaart.hoog} style={{ display: 'block' }}>
          <g stroke={NS_KLEUR.lijn} strokeWidth={1}>
            {kaart.lijnen.map((l, i) => <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} />)}
          </g>
          {kaart.punten.map(p => {
            const [x, y] = kaart.plek.get(p.id)!
            const hier = perSysteem.get(p.id)
            const L = kaart.letter
            const lab = labels.get(p.id)
            const actief = hier?.some(l => l.actief)
            const kleur = hier ? (actief ? NS_KLEUR.eigen : NS_KLEUR.stil) : NS_KLEUR.bol
            const isGekozen = gekozen === p.id || hover === p.id
            return (
              <g key={p.id} transform={`translate(${x},${y})`} style={{ cursor: hier ? 'pointer' : 'default' }}
                onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(h => h === p.id ? null : h)}
                onClick={e => { e.stopPropagation(); onKies?.(gekozen === p.id ? null : p.id) }}>
                {hier && <circle r={L + 3} fill="none" stroke={kleur} strokeWidth={1.5} opacity={actief ? 0.9 : 0.5} className={actief ? 'waar-klopt' : undefined} />}
                {isGekozen && <circle r={L + 7} fill="none" stroke={NS_KLEUR.nadruk} strokeWidth={1} strokeDasharray="3 2" />}
                <circle r={hier ? Math.max(4, L / 1.8) : Math.max(3, L / 2.2)} fill={kleur} />
                {hier && hier.length > 0 && (
                  <g>
                    {hier.slice(0, 4).map((l, i) => {
                      const n = Math.min(hier.length, 4)
                      const hoek = -Math.PI / 2 + (i / n) * Math.PI * 2
                      const r = L + 12, px = Math.cos(hoek) * r, py = Math.sin(hoek) * r
                      return (
                        <g key={l.character_id} transform={`translate(${px},${py})`}>
                          <clipPath id={`wk-${p.id}-${l.character_id}`}><circle r={9} /></clipPath>
                          <image href={`https://images.evetech.net/characters/${l.character_id}/portrait?size=32`} x={-9} y={-9} width={18} height={18}
                            clipPath={`url(#wk-${p.id}-${l.character_id})`} opacity={l.actief ? 1 : 0.5} />
                          <circle r={9} fill="none" stroke={l.actief ? NS_KLEUR.eigen : NS_KLEUR.stil} strokeWidth={1} />
                        </g>
                      )
                    })}
                    {hier.length > 4 && <text x={L + 12} y={L + 22} fontSize={L} fill={NS_KLEUR.nadruk} fontWeight={700}>+{hier.length - 4}</text>}
                  </g>
                )}
                {(lab || hier) && (
                  <text x={lab?.x ?? 0} y={lab?.y ?? -L - 4} textAnchor={lab?.anker ?? 'middle'} fontSize={L}
                    fill={hier ? NS_KLEUR.nadruk : NS_KLEUR.naam} fontWeight={hier ? 700 : 400}
                    stroke="#070707" strokeWidth={hier ? L * 0.25 : 0} paintOrder="stroke" style={{ pointerEvents: 'none' }}>
                    {p.naam}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      {/* Kop: regio + wie er buiten deze kaart zit */}
      <div style={{ position: 'absolute', top: 8, left: 10, fontSize: '0.62rem', color: 'var(--text-dim)', pointerEvents: 'none' }}>
        <span style={{ color: NS_KLEUR.nadruk, fontWeight: 700, fontSize: '0.72rem' }}>{regioNaam}</span>
        {buiten.length > 0 && <span> · {buiten.length} {buiten.length === 1 ? 'lid' : 'leden'} buiten deze regio</span>}
      </div>
      {/* Kaartje bij hover/klik: wie zit hier */}
      {kaart && (() => {
        const sid = gekozen ?? hover
        if (!sid) return null
        const hier = perSysteem.get(sid); if (!hier) return null
        const [x, y] = kaart.plek.get(sid)!
        const links = x > breed / 2
        return (
          <div style={{ position: 'absolute', top: Math.min(y + 14, kaart.hoog - 40 - hier.length * 16), [links ? 'right' : 'left']: links ? breed - x + 16 : x + 16,
            background: '#0a1215', border: '1px solid #41707f', borderRadius: 4, padding: '0.35rem 0.6rem', fontSize: '0.68rem', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
            <div style={{ color: NS_KLEUR.nadruk, fontWeight: 700 }}>{systemen[String(sid)]?.[0]}</div>
            {hier.map(l => <div key={l.character_id} style={{ color: l.actief ? '#e8e8e8' : '#8a8a8a' }}>{l.actief ? '● ' : '○ '}{l.name}</div>)}
          </div>
        )
      })()}
      <style>{`@keyframes waarKlop{0%,100%{stroke-opacity:1}50%{stroke-opacity:.25}} .waar-klopt{animation:waarKlop 1.8s ease-in-out infinite}`}</style>
    </div>
  )
}
