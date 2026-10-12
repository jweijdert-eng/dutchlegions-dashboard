import { useMemo, useState } from 'react'
import { DAG, fmtISK, kleur, nettoWinst, plus } from '../../utils/handel'
import { CARD, DOF, INPUT, ItemKnop, KnopGroep, KNOP, TD, TH, type Gegevens } from './delen'

type Soort = 'alle' | 'koop' | 'verkoop'
type Periode = '7' | '30' | '90' | 'alles'
const PER_KEER = 100

const datumTijd = (s: string) => new Date(s).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const getal = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')

export default function Logboek({ g, onItem, plekNaam }: {
  g: Gegevens
  onItem: (typeId: number, locationId?: number) => void
  plekNaam: (locationId: number) => string
}) {
  const [zoek, setZoek] = useState('')
  const [soort, setSoort] = useState<Soort>('alle')
  const [periode, setPeriode] = useState<Periode>('30')
  const [char, setChar] = useState<string>('alle')
  const [toon, setToon] = useState(PER_KEER)

  // Winst per verkoop-transactie, uit dezelfde FIFO als de rest van de pagina.
  const winstVan = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of g.verkocht) m.set(v.charId + ':' + v.transactionId, nettoWinst(v, g.fee))
    return m
  }, [g.verkocht, g.fee])

  const rijen = useMemo(() => {
    const vanaf = periode === 'alles' ? 0 : Date.now() - Number(periode) * DAG
    const z = zoek.trim().toLowerCase()
    return g.txs
      .filter(t => +new Date(t.date) >= vanaf)
      .filter(t => soort === 'alle' || (soort === 'koop') === t.is_buy)
      .filter(t => char === 'alle' || String(t.charId) === char)
      .filter(t => !z || (g.namen.get(t.type_id) ?? '').toLowerCase().includes(z))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date))
  }, [g.txs, g.namen, zoek, soort, periode, char])

  const totaal = useMemo(() => ({
    koop: rijen.filter(t => t.is_buy).reduce((s, t) => s + t.quantity * t.unit_price, 0),
    verkoop: rijen.filter(t => !t.is_buy).reduce((s, t) => s + t.quantity * t.unit_price, 0),
    winst: rijen.filter(t => !t.is_buy).reduce((s, t) => s + (winstVan.get(t.charId + ':' + t.transaction_id) ?? 0), 0),
  }), [rijen, winstVan])

  function downloadCsv() {
    const kop = ['Datum', 'Character', 'Plek', 'Item', 'Soort', 'Aantal', 'Prijs', 'Totaal', 'Winst']
    const regels = rijen.map(t => {
      const w = t.is_buy ? null : winstVan.get(t.charId + ':' + t.transaction_id)
      return [new Date(t.date).toISOString().replace('T', ' ').slice(0, 16), g.chars.get(t.charId) ?? t.charId, plekNaam(t.location_id),
              g.namen.get(t.type_id) ?? t.type_id, t.is_buy ? 'koop' : 'verkoop', t.quantity, getal(t.unit_price),
              getal(t.quantity * t.unit_price), w === null || w === undefined ? '' : getal(w)]
        .map(x => `"${String(x).replace(/"/g, '""')}"`).join(';')
    })
    // Puntkomma en een komma als decimaalteken: zo opent Excel het in het Nederlands meteen goed.
    const blob = new Blob(['﻿' + [kop.join(';'), ...regels].join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `handel-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
        <input value={zoek} onChange={e => { setZoek(e.target.value); setToon(PER_KEER) }} placeholder="Zoek item…" style={{ ...INPUT, width: 200 }} />
        <KnopGroep<Soort> waarde={soort} onKies={k => { setSoort(k); setToon(PER_KEER) }}
          opties={[{ key: 'alle', label: 'Alles' }, { key: 'koop', label: 'Koop' }, { key: 'verkoop', label: 'Verkoop' }]} />
        <KnopGroep<Periode> waarde={periode} onKies={k => { setPeriode(k); setToon(PER_KEER) }}
          opties={[{ key: '7', label: '7 d' }, { key: '30', label: '30 d' }, { key: '90', label: '90 d' }, { key: 'alles', label: 'Alles' }]} />
        {g.chars.size > 1 && (
          <select value={char} onChange={e => { setChar(e.target.value); setToon(PER_KEER) }} style={{ ...INPUT, cursor: 'pointer' }}>
            <option value="alle">Alle characters</option>
            {[...g.chars.entries()].map(([id, n]) => <option key={id} value={String(id)}>{n}</option>)}
          </select>
        )}
        <button onClick={downloadCsv} disabled={!rijen.length} style={{ ...KNOP, marginLeft: 'auto' }}>⬇ CSV (Excel)</button>
      </div>
      <div style={{ ...DOF, marginBottom: '0.6rem', whiteSpace: 'normal' }}>
        {rijen.length} transacties · gekocht {fmtISK(totaal.koop)} · verkocht {fmtISK(totaal.verkoop)} · winst op verkopen{' '}
        <b style={{ color: kleur(totaal.winst) }}>{plus(totaal.winst)}</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...TH, textAlign: 'left' }}>Datum</th>
            {g.chars.size > 1 && <th style={{ ...TH, textAlign: 'left' }}>Character</th>}
            <th style={{ ...TH, textAlign: 'left' }}>Plek</th><th style={{ ...TH, textAlign: 'left' }}>Item</th>
            <th style={TH}></th><th style={TH}>Aantal</th><th style={TH}>Prijs</th><th style={TH}>Totaal</th><th style={TH}>Winst</th>
          </tr></thead>
          <tbody>
            {rijen.slice(0, toon).map(t => {
              const w = t.is_buy ? null : winstVan.get(t.charId + ':' + t.transaction_id)
              return (
                <tr key={t.charId + ':' + t.transaction_id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...TD, textAlign: 'left', color: 'var(--text-dim)' }}>{datumTijd(t.date)}</td>
                  {g.chars.size > 1 && <td style={{ ...TD, textAlign: 'left' }}>{g.chars.get(t.charId) ?? t.charId}</td>}
                  <td style={{ ...TD, textAlign: 'left', color: 'var(--text-dim)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{plekNaam(t.location_id)}</td>
                  <td style={{ ...TD, textAlign: 'left', maxWidth: 260, overflow: 'hidden' }}><ItemKnop id={t.type_id} namen={g.namen} onItem={onItem} plek={t.location_id} /></td>
                  <td style={{ ...TD, fontWeight: 700, fontSize: '0.62rem', color: t.is_buy ? '#4cc9f0' : '#f4a261' }}>{t.is_buy ? 'KOOP' : 'VERK.'}</td>
                  <td style={TD}>{t.quantity.toLocaleString('nl-NL')}</td>
                  <td style={TD}>{fmtISK(t.unit_price)}</td>
                  <td style={TD}>{fmtISK(t.quantity * t.unit_price)}</td>
                  <td style={{ ...TD, color: w === null || w === undefined ? 'var(--text-dim)' : kleur(w), fontWeight: 700 }}>
                    {t.is_buy ? '' : w === undefined || w === null ? <span title="Aankoop onbekend">–</span> : plus(w)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!rijen.length && <div style={DOF}>Geen transacties met deze filters.</div>}
      {rijen.length > toon && (
        <button onClick={() => setToon(n => n + PER_KEER)} style={{ ...KNOP, marginTop: '0.7rem' }}>
          Meer laden ({rijen.length - toon} over)
        </button>
      )}
    </div>
  )
}
