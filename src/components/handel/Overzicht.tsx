import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { DAG, dagVan, fmtISK, kleur, nettoWinst, plus } from '../../utils/handel'
import { CARD, DOF, ItemKnop, KOP, LABEL, RIJ, Tegel, type Gegevens } from './delen'

const KANSEN_LINKS = [
  { pad: '/jita-scanner', icoon: '📈', naam: 'Jita Scanner', uitleg: 'De volledige scanner met koopplan' },
  { pad: '/gap-scanner', icoon: '🕳️', naam: 'Gap Scanner', uitleg: 'Prijsgaten in Jita en Amarr' },
  { pad: '/hub-arbitrage', icoon: '🔀', naam: 'Hub-arbitrage', uitleg: 'Goedkoop in de ene hub, duurder in de andere' },
]

export default function Overzicht({ g, onItem, plekNaam, naarTab }: {
  g: Gegevens
  onItem: (typeId: number, locationId?: number) => void
  plekNaam: (locationId: number) => string
  naarTab: (t: 'statistiek' | 'kansen') => void
}) {
  const winst = useMemo(() => {
    const som = (vanaf: number) => g.verkocht.filter(v => v.tijd >= vanaf).reduce((s, v) => s + nettoWinst(v, g.fee), 0)
    const perItem = new Map<number, { qty: number; winst: number; kosten: number }>()
    for (const v of g.verkocht) {
      if (v.tijd < Date.now() - 30 * DAG) continue
      const r = perItem.get(v.typeId) ?? { qty: 0, winst: 0, kosten: 0 }
      r.qty += v.qty; r.winst += nettoWinst(v, g.fee); r.kosten += v.kosten
      perItem.set(v.typeId, r)
    }
    return {
      vandaag: som(dagVan(Date.now())), week: som(Date.now() - 7 * DAG), maand: som(Date.now() - 30 * DAG),
      items: [...perItem.entries()].map(([typeId, r]) => ({ typeId, ...r, marge: r.kosten > 0 ? (r.winst / r.kosten) * 100 : 0 }))
        .sort((a, b) => b.winst - a.winst),
    }
  }, [g.verkocht, g.fee])

  const overboden = g.status.filter(s => s.overboden)
  const verkoopbaar = g.posities.filter(p => p.vrij > 0 && (p.pnlVrij ?? 0) > 0)
  const inBuy = g.status.filter(s => s.isBuy).reduce((s, o) => s + o.waarde, 0)
  const inSell = g.status.filter(s => !s.isBuy).reduce((s, o) => s + o.waarde, 0)
  const posWaarde = g.posities.reduce((s, p) => s + (p.nu ?? 0), 0)
  const posPnl = g.posities.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const teDoen = overboden.length + verkoopbaar.length
  const toonPlek = g.hub !== 'jita'
  const plek = (loc: number) => toonPlek ? <span style={{ color: 'var(--text-dim)', fontSize: '0.66rem' }}> · {plekNaam(loc)}</span> : null

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.7rem', marginBottom: '1rem' }}>
        <Tegel label="Wallet" waarde={g.wallet !== null ? fmtISK(g.wallet) : '–'} sub={`${g.tokens.length} character${g.tokens.length === 1 ? '' : 's'}`} />
        <Tegel label="In orders" waarde={fmtISK(inBuy + inSell)} sub={<>koop {fmtISK(inBuy)} · verkoop {fmtISK(inSell)}</>} />
        <Tegel label="Open posities" waarde={fmtISK(posWaarde)} sub={<>nu verkocht: <b style={{ color: kleur(posPnl) }}>{plus(posPnl)}</b></>} />
        <Tegel label="Winst vandaag" waarde={plus(winst.vandaag)} kleurWaarde={kleur(winst.vandaag)}
          sub={<>7 d: <b style={{ color: kleur(winst.week) }}>{fmtISK(winst.week)}</b> · 30 d: <b style={{ color: kleur(winst.maand) }}>{fmtISK(winst.maand)}</b></>} />
        <Tegel label="Te doen" waarde={String(teDoen)} kleurWaarde={teDoen ? '#ffce54' : '#4ade80'}
          sub={<>{overboden.length} overboden · {verkoopbaar.length} verkoopbaar</>} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1rem', alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={CARD}>
            <div style={{ ...KOP, color: teDoen ? '#ffce54' : '#4ade80' }}>{teDoen ? '⚠️ Nu doen' : '👍 Niks te doen'}</div>
            {!teDoen && <div style={DOF}>Al je orders staan bovenaan en er is geen positie die nu met winst weg kan.</div>}
            {overboden.map(s => (
              <div key={s.order.order_id} style={RIJ}>
                <span style={{ minWidth: 0, overflow: 'hidden' }}><ItemKnop id={s.order.type_id} namen={g.namen} onItem={onItem} plek={s.order.location_id} />{plek(s.order.location_id)}</span>
                <span style={DOF}>{s.isBuy ? 'koop' : 'verkoop'} · {fmtISK(s.order.price)} → <b style={{ color: 'var(--text)' }}>{fmtISK(s.voorstel ?? s.order.price)}</b></span>
              </div>
            ))}
            {verkoopbaar.map(p => (
              <div key={p.bron + p.locationId + ':' + p.typeId} style={RIJ}>
                <span style={{ minWidth: 0, overflow: 'hidden' }}><ItemKnop id={p.typeId} namen={g.namen} onItem={onItem} plek={p.locationId} />{plek(p.locationId)}</span>
                <span style={DOF}>verkoop {p.vrij.toLocaleString('nl-NL')} st · <b style={{ color: '#4ade80' }}>{plus(p.pnlVrij ?? 0)}</b></span>
              </div>
            ))}
          </div>

          <div style={CARD}>
            <div style={KOP}>📋 Mijn orders ({g.status.length})</div>
            {!g.status.length && <div style={DOF}>Geen open orders{g.hub === 'alle' ? '' : ' hier'}.</div>}
            {g.status.map(s => (
              <div key={s.order.order_id} style={RIJ}>
                <span style={{ display: 'flex', gap: '0.45rem', alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, color: s.isBuy ? '#4cc9f0' : '#f4a261', width: 34, flex: 'none' }}>{s.isBuy ? 'KOOP' : 'VERK.'}</span>
                  <ItemKnop id={s.order.type_id} namen={g.namen} onItem={onItem} plek={s.order.location_id} />{plek(s.order.location_id)}
                </span>
                <span style={DOF}>
                  {s.order.volume_remain.toLocaleString('nl-NL')}/{s.order.volume_total.toLocaleString('nl-NL')} · {fmtISK(s.order.price)} ·{' '}
                  {s.overboden === null ? <b style={{ color: 'var(--text-dim)' }}>onbekend</b>
                    : s.overboden ? <b style={{ color: '#ffce54' }}>{s.boven > 1 ? `${s.boven} boven je` : 'overboden'}</b>
                    : <b style={{ color: '#4ade80' }}>bovenaan</b>}
                  {' '}· {s.dagenOver < 1 ? '<1' : Math.floor(s.dagenOver)} d
                </span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: '1rem' }}>
          <div style={CARD}>
            <div style={KOP}>💼 Open posities ({g.posities.length})</div>
            {!g.posities.length && <div style={DOF}>Geen open posities. <Link to="/jita-positions" style={{ color: 'var(--blue)' }}>Handmatig toevoegen</Link></div>}
            {g.posities.map(p => (
              <div key={p.bron + p.locationId + ':' + p.typeId} style={RIJ}>
                <span style={{ minWidth: 0, overflow: 'hidden' }}><ItemKnop id={p.typeId} namen={g.namen} onItem={onItem} plek={p.locationId} />{plek(p.locationId)}</span>
                <span style={DOF}>
                  {p.qty.toLocaleString('nl-NL')} st{p.inOrder > 0 && <> ({p.inOrder === p.qty ? 'alles' : p.inOrder.toLocaleString('nl-NL')} te koop)</>}
                  {' '}· kocht {fmtISK(p.buyPrice)} · nu {p.sell !== null ? fmtISK(p.sell) : '–'}
                  {p.prijsVan === 'jita' && <span title="Hier geen markt bekend: gewaardeerd tegen de Jita-prijs"> (Jita)</span>} ·{' '}
                  <b style={{ color: kleur(p.pnl ?? 0) }}>{p.pnl === null ? '–' : plus(p.pnl)}</b>
                  {p.bron === 'handmatig' && <span title="handmatig toegevoegd"> ✎</span>}
                </span>
              </div>
            ))}
          </div>

          <div style={CARD}>
            <div style={{ ...KOP, display: 'flex', justifyContent: 'space-between' }}>
              <span>💰 Verdiend in 30 dagen: <span style={{ color: kleur(winst.maand) }}>{fmtISK(winst.maand)}</span></span>
              <button onClick={() => naarTab('statistiek')} style={{ background: 'none', border: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.7rem' }}>alle statistiek →</button>
            </div>
            {!winst.items.length && <div style={DOF}>Nog niets verkocht waarvan de aankoop bekend is.</div>}
            {winst.items.slice(0, 10).map(i => (
              <div key={i.typeId} style={RIJ}>
                <ItemKnop id={i.typeId} namen={g.namen} onItem={onItem} />
                <span style={DOF}>{i.qty.toLocaleString('nl-NL')} st · {i.marge.toFixed(0)}% · <b style={{ color: kleur(i.winst) }}>{plus(i.winst)}</b></span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ ...LABEL, marginTop: '1.2rem', display: 'flex', justifyContent: 'space-between' }}>
        <span>Nieuwe kansen zoeken</span>
        <button onClick={() => naarTab('kansen')} style={{ background: 'none', border: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em' }}>KANSEN IN DEZE PAGINA →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.7rem' }}>
        {KANSEN_LINKS.map(k => (
          <Link key={k.pad} to={k.pad} style={{ ...CARD, textDecoration: 'none', color: 'var(--text)', display: 'block' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{k.icoon} {k.naam}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{k.uitleg}</div>
          </Link>
        ))}
      </div>
    </>
  )
}
