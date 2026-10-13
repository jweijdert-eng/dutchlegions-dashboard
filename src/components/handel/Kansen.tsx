import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAllRegionOrders, getRegionHistory, getRegionOrders, resolveNames, resolveTypeIds } from '../../api/esi'
import { historyStats, scanJita } from '../../pages/JitaScanner'
import { fmtISK, JITA, kleur, leesVolg, nettoWinst, plus, zetVolg, type Fees } from '../../utils/handel'
import { CARD, DOF, INPUT, ItemKnop, KNOP, KOP, TD, TH, type Gegevens } from './delen'

interface Kans { typeId: number; bestBuy: number; bestSell: number; netMargin: number; netMarginPct: number; dayVolume: number; dayProfit: number }
interface Markt { bestBuy: number | null; bestSell: number | null; margePct: number | null; dayVolume: number | null }

// De laatste scan blijft bewaard zolang de pagina open is: wisselen van tabblad
// hoeft geen minuut opnieuw scannen te kosten.
let laatsteScan: { tijd: number; rijen: Kans[] } | null = null
// En de namen die we hier opzochten ook: anders staat de bewaarde scan er na een
// tabwissel met #nummers in plaats van namen.
const bekendeNamen = new Map<number, string>()
// Een scan die nog loopt als je van tabblad wisselt: bij terugkomst pakken we hem weer op.
let lopendeScan: Promise<void> | null = null

async function namenErbij(ids: number[]) {
  const missen = [...new Set(ids)].filter(id => !bekendeNamen.has(id))
  if (!missen.length) return
  for (const [id, n] of await resolveNames(missen)) bekendeNamen.set(id, n)
}

/** Koop op de beste buy + 1 cent, verkoop op de beste sell − 1 cent, met fees. */
function margeNu(bestBuy: number | null, bestSell: number | null, f: Fees) {
  if (!bestBuy || !bestSell) return null
  const kost = bestBuy * (1 + f.broker), opbrengst = bestSell * (1 - f.broker - f.tax)
  return ((opbrengst - kost) / kost) * 100
}

async function marktInJita(typeId: number, f: Fees): Promise<Markt> {
  const [boek, hist] = await Promise.all([
    getRegionOrders(JITA.regio, typeId).catch(() => []),
    getRegionHistory(JITA.regio, typeId).catch(() => []),
  ])
  const hier = boek.filter(o => o.location_id === JITA.station)
  const buys = hier.filter(o => o.is_buy_order).map(o => o.price)
  const sells = hier.filter(o => !o.is_buy_order).map(o => o.price)
  const bestBuy = buys.length ? Math.max(...buys) : null
  const bestSell = sells.length ? Math.min(...sells) : null
  return { bestBuy, bestSell, margePct: margeNu(bestBuy, bestSell, f), dayVolume: hist.length ? historyStats(hist).dayVolume : null }
}

export default function Kansen({ g, onItem }: { g: Gegevens; onItem: (typeId: number, locationId?: number) => void }) {
  const [namen, setNamen] = useState<Map<number, string>>(() => new Map(bekendeNamen))
  const [scan, setScan] = useState(laatsteScan)
  const [bezig, setBezig] = useState<string | null>(null)
  const [fout, setFout] = useState<string | null>(null)
  const [volg, setVolg] = useState<number[]>(leesVolg)
  const [markten, setMarkten] = useState<Map<number, Markt>>(new Map())
  const [nieuw, setNieuw] = useState('')

  const naamMap = useMemo(() => new Map([...g.namen, ...namen]), [g.namen, namen])
  const extraNamen = useCallback(async (ids: number[]) => {
    await namenErbij(ids.filter(id => !g.namen.has(id)))
    setNamen(new Map(bekendeNamen))
  }, [g.namen])

  // Namen van een bewaarde scan altijd (opnieuw) zeker stellen.
  useEffect(() => { if (scan) extraNamen(scan.rijen.map(r => r.typeId)).catch(() => {}) }, [scan, extraNamen])

  // Liep er nog een scan toen je terugkwam? Dan wachten we gewoon mee.
  useEffect(() => {
    if (!lopendeScan) return
    let weg = false
    setBezig('De scan loopt nog…')
    lopendeScan.then(() => { if (!weg) setScan(laatsteScan) }).catch(() => {})
      .finally(() => { if (!weg) setBezig(null) })
    return () => { weg = true }
  }, [])

  // Favorieten: items waar je eerder netto winst op maakte, de beste eerst.
  const favorieten = useMemo(() => {
    const per = new Map<number, { winst: number; inkoop: number; trades: number }>()
    for (const v of g.verkocht) {
      const r = per.get(v.typeId) ?? { winst: 0, inkoop: 0, trades: 0 }
      r.winst += nettoWinst(v, g.fee); r.inkoop += v.kosten; r.trades++
      per.set(v.typeId, r)
    }
    return [...per.entries()].filter(([, r]) => r.winst > 0)
      .map(([typeId, r]) => ({ typeId, ...r, marge: r.inkoop > 0 ? (r.winst / r.inkoop) * 100 : 0 }))
      .sort((a, b) => b.winst - a.winst).slice(0, 12)
  }, [g.verkocht, g.fee])

  // Markt van nu ophalen voor favorieten en volglijst (één keer per item).
  useEffect(() => {
    const ids = [...new Set([...favorieten.map(f => f.typeId), ...volg])].filter(id => !markten.has(id))
    if (!ids.length) return
    let weg = false
    ;(async () => {
      await extraNamen(ids)
      const uit = new Map<number, Markt>()
      await Promise.all(ids.map(async id => uit.set(id, await marktInJita(id, g.fee))))
      if (!weg) setMarkten(m => new Map([...m, ...uit]))
    })()
    return () => { weg = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorieten, volg])

  async function scanNu() {
    if (lopendeScan) return
    setFout(null)
    lopendeScan = (async () => {
      setBezig('Orders van heel The Forge ophalen…')
      const orders = await getAllRegionOrders(JITA.regio, (done, total) => setBezig(`Orders ophalen… ${done}/${total}`))
      setBezig('Rekenen…')
      const kandidaten = scanJita(orders, g.fee)
        .filter(r => r.netMarginPct >= 5 && r.netMarginPct <= 40 && r.bestBuy >= 1000 && r.tradeVolume >= 20)
        .sort((a, b) => b.netMargin * Math.min(b.tradeVolume, 500) - a.netMargin * Math.min(a.tradeVolume, 500))
        .slice(0, 40)
      let klaar = 0
      const rijen: Kans[] = []
      await Promise.all(kandidaten.map(async r => {
        const st = historyStats(await getRegionHistory(JITA.regio, r.typeId).catch(() => []))
        setBezig(`Dagvolume bepalen… ${++klaar}/${kandidaten.length}`)
        if (st.avg30 > 0 && r.bestSell > st.avg30 * 1.3) return        // opgepompt: niet aan beginnen
        const pakbaar = Math.min(r.tradeVolume, Math.round(st.dayVolume * 0.3))
        rijen.push({ typeId: r.typeId, bestBuy: r.bestBuy, bestSell: r.bestSell, netMargin: r.netMargin,
                     netMarginPct: r.netMarginPct, dayVolume: st.dayVolume, dayProfit: r.netMargin * pakbaar })
      }))
      rijen.sort((a, b) => b.dayProfit - a.dayProfit)
      const top = rijen.slice(0, 15)
      // Namen vóórdat de scan klaar heet, en buiten dit tabblad bewaard.
      await namenErbij(top.map(r => r.typeId))
      laatsteScan = { tijd: Date.now(), rijen: top }
    })()
    try {
      await lopendeScan
      setNamen(new Map(bekendeNamen))
      setScan(laatsteScan)
    } catch (e) {
      setFout(e instanceof Error ? e.message : 'Scan mislukt')
    } finally { lopendeScan = null; setBezig(null) }
  }

  function wisselVolg(typeId: number) {
    const aan = !volg.includes(typeId)
    zetVolg(typeId, aan)
    setVolg(leesVolg())
  }

  async function voegToe() {
    const naam = nieuw.trim()
    if (!naam) return
    setFout(null)
    const ids = await resolveTypeIds([naam]).catch(() => new Map<string, number>())
    const id = ids.get(naam.toLowerCase())
    if (!id) { setFout(`Geen item gevonden voor "${naam}" (gebruik de exacte naam).`); return }
    zetVolg(id, true); setVolg(leesVolg()); setNieuw('')
  }

  const ster = (typeId: number) => (
    <button onClick={() => wisselVolg(typeId)} title={volg.includes(typeId) ? 'Niet meer volgen' : 'Volgen'}
      style={{ background: 'none', border: 0, cursor: 'pointer', color: volg.includes(typeId) ? '#ffce54' : 'var(--text-dim)', fontSize: '0.9rem' }}>
      {volg.includes(typeId) ? '★' : '☆'}
    </button>
  )
  const marktCellen = (id: number) => {
    const m = markten.get(id)
    if (!m) return <td colSpan={4} style={{ ...TD, color: 'var(--text-dim)' }}>laden…</td>
    return (<>
      <td style={TD}>{m.bestBuy !== null ? fmtISK(m.bestBuy) : '–'}</td>
      <td style={TD}>{m.bestSell !== null ? fmtISK(m.bestSell) : '–'}</td>
      <td style={{ ...TD, color: kleur(m.margePct ?? 0), fontWeight: 700 }}>{m.margePct !== null ? `${m.margePct.toFixed(1)}%` : '–'}</td>
      <td style={TD}>{m.dayVolume !== null ? m.dayVolume.toLocaleString('nl-NL') : '–'}</td>
    </>)
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {fout && <div style={{ color: '#ff5c6c', fontSize: '0.75rem' }}>{fout}</div>}

      <div style={CARD}>
        <div style={{ ...KOP, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span>🔎 Beste flips in Jita nu</span>
          <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            {scan && <span style={DOF}>gescand om {new Date(scan.tijd).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</span>}
            <button onClick={scanNu} disabled={!!bezig} style={{ ...KNOP, background: 'var(--blue)', color: '#0a0a12', borderColor: 'var(--blue)', fontWeight: 700 }}>
              {bezig ? 'Bezig…' : scan ? 'Opnieuw scannen' : 'Scan Jita (± 1 min)'}
            </button>
          </span>
        </div>
        {bezig && <div style={{ ...DOF, marginBottom: '0.4rem' }}>{bezig}</div>}
        {!scan && !bezig && <div style={DOF}>Zoekt in de hele Jita-markt naar items met een goede marge én genoeg handel per dag, zonder opgepompte prijzen.</div>}
        {scan && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...TH, width: 24 }}></th><th style={{ ...TH, textAlign: 'left' }}>Item</th><th style={TH}>Koop</th><th style={TH}>Verkoop</th>
                <th style={TH}>Marge</th><th style={TH}>Vol/dag</th><th style={TH} title="Winst per dag als je 30% van de dagelijkse handel pakt">~Winst/dag</th>
              </tr></thead>
              <tbody>
                {scan.rijen.map(r => (
                  <tr key={r.typeId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...TD, textAlign: 'center' }}>{ster(r.typeId)}</td>
                    <td style={{ ...TD, textAlign: 'left', maxWidth: 280, overflow: 'hidden' }}><ItemKnop id={r.typeId} namen={naamMap} onItem={onItem} plek={JITA.station} /></td>
                    <td style={TD}>{fmtISK(r.bestBuy)}</td>
                    <td style={TD}>{fmtISK(r.bestSell)}</td>
                    <td style={{ ...TD, color: '#4ade80', fontWeight: 700 }}>{r.netMarginPct.toFixed(1)}%</td>
                    <td style={TD}>{r.dayVolume.toLocaleString('nl-NL')}</td>
                    <td style={{ ...TD, fontWeight: 700 }}>{plus(r.dayProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!scan.rijen.length && <div style={DOF}>Niets gevonden dat aan de eisen voldoet.</div>}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <div style={CARD}>
          <div style={KOP}>⭐ Je favorieten — waar je eerder winst op maakte</div>
          {!favorieten.length && <div style={DOF}>Nog geen winstgevende verkopen bekend. Die komen vanzelf als je handelt.</div>}
          {!!favorieten.length && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...TH, width: 24 }}></th><th style={{ ...TH, textAlign: 'left' }}>Item</th><th style={TH} title="Jouw marge tot nu toe">Jij</th>
                  <th style={TH}>Koop</th><th style={TH}>Verkoop</th><th style={TH}>Marge nu</th><th style={TH}>Vol/dag</th>
                </tr></thead>
                <tbody>
                  {favorieten.map(f => (
                    <tr key={f.typeId} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...TD, textAlign: 'center' }}>{ster(f.typeId)}</td>
                      <td style={{ ...TD, textAlign: 'left', maxWidth: 220, overflow: 'hidden' }}><ItemKnop id={f.typeId} namen={naamMap} onItem={onItem} plek={JITA.station} /></td>
                      <td style={{ ...TD, color: 'var(--text-dim)' }} title={`${f.trades} trades, ${plus(f.winst)}`}>{f.marge.toFixed(0)}%</td>
                      {marktCellen(f.typeId)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={CARD}>
          <div style={KOP}>👁️ Volglijst</div>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
            <input value={nieuw} onChange={e => setNieuw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') voegToe() }}
              placeholder="Exacte itemnaam, bijv. Large Shield Extender II" style={{ ...INPUT, flex: 1 }} />
            <button onClick={voegToe} style={KNOP}>Volgen</button>
          </div>
          {!volg.length && <div style={DOF}>Nog niets. Voeg hierboven een item toe, of tik ☆ aan bij een kans of favoriet.</div>}
          {!!volg.length && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...TH, width: 24 }}></th><th style={{ ...TH, textAlign: 'left' }}>Item</th>
                  <th style={TH}>Koop</th><th style={TH}>Verkoop</th><th style={TH}>Marge</th><th style={TH}>Vol/dag</th>
                </tr></thead>
                <tbody>
                  {volg.map(id => (
                    <tr key={id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...TD, textAlign: 'center' }}>{ster(id)}</td>
                      <td style={{ ...TD, textAlign: 'left', maxWidth: 240, overflow: 'hidden' }}><ItemKnop id={id} namen={naamMap} onItem={onItem} plek={JITA.station} /></td>
                      {marktCellen(id)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
