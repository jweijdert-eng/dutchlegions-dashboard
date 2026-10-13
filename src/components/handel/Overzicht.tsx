import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { openMarketWindow } from '../../api/esi'
import EveImage from '../EveImage'
import { DAG, dagVan, fmtISK, kleur, nettoWinst, plus } from '../../utils/handel'
import { CARD, DOF, KNOP, LABEL, TD, TH, type Gegevens, type OrderStatus } from './delen'

// Het overzicht leest van boven naar beneden: waar staat je geld, hoe gaat het,
// wat moet je nu doen, en daaronder je orders en posities als echte tabellen.

const KLEUR = { wallet: '#3a6ea5', koop: '#4cc9f0', verkoop: '#f4a261', voorraad: '#a78bfa' }
const datumKort = (t: number) => new Date(t).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' })

function Badge({ tekst, kleur: k, achter }: { tekst: string; kleur: string; achter: string }) {
  return <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '0.12rem 0.45rem', borderRadius: 10, color: k, background: achter, whiteSpace: 'nowrap' }}>{tekst}</span>
}
function statusBadge(s: OrderStatus) {
  if (s.overboden === null) return <Badge tekst="onbekend" kleur="var(--text-dim)" achter="var(--surface2)" />
  if (s.overboden) return <Badge tekst={s.boven > 1 ? `${s.boven} boven je` : 'overboden'} kleur="#ffce54" achter="rgba(255,206,84,0.12)" />
  return <Badge tekst="bovenaan" kleur="#4ade80" achter="rgba(74,222,128,0.12)" />
}

export default function Overzicht({ g, onItem, plekNaam, naarTab }: {
  g: Gegevens
  onItem: (typeId: number, locationId?: number) => void
  plekNaam: (locationId: number) => string
  naarTab: (t: 'statistiek' | 'kansen') => void
}) {
  const [gekopieerd, setGekopieerd] = useState<number | null>(null)

  const winst = useMemo(() => {
    const som = (vanaf: number) => g.verkocht.filter(v => v.tijd >= vanaf).reduce((s, v) => s + nettoWinst(v, g.fee), 0)
    const dagen: Array<{ dag: number; winst: number }> = []
    for (let i = 13; i >= 0; i--) dagen.push({ dag: dagVan(Date.now() - i * DAG), winst: 0 })
    for (const v of g.verkocht) {
      const d = dagen.find(x => x.dag === dagVan(v.tijd))
      if (d) d.winst += nettoWinst(v, g.fee)
    }
    return { vandaag: som(dagVan(Date.now())), week: som(Date.now() - 7 * DAG), maand: som(Date.now() - 30 * DAG), dagen }
  }, [g.verkocht, g.fee])

  const overboden = g.status.filter(s => s.overboden)
  const verkoopbaar = g.posities.filter(p => p.vrij > 0 && (p.pnlVrij ?? 0) > 0)
  const teDoen = overboden.length + verkoopbaar.length

  // Waar staat je geld? Voorraad alleen voor wat níet al in een verkooporder staat,
  // anders tel je het dubbel.
  const geld = useMemo(() => {
    const koop = g.status.filter(s => s.isBuy).reduce((t, s) => t + s.waarde, 0)
    const verkoop = g.status.filter(s => !s.isBuy).reduce((t, s) => t + s.waarde, 0)
    const voorraad = g.posities.reduce((t, p) => t + (p.sell !== null ? p.vrij * p.sell : p.vrij * p.buyPrice), 0)
    const wallet = g.wallet ?? 0
    return { wallet, koop, verkoop, voorraad, totaal: wallet + koop + verkoop + voorraad }
  }, [g.status, g.posities, g.wallet])
  const posPnl = g.posities.reduce((s, p) => s + (p.pnl ?? 0), 0)

  async function openInEve(typeId: number) {
    const t = g.tokens[0]; if (!t) return
    try { await openMarketWindow(typeId, t.accessToken) } catch { /* client niet open */ }
  }
  async function kopieer(sleutel: number, prijs: number) {
    try { await navigator.clipboard.writeText(prijs.toFixed(2)); setGekopieerd(sleutel); setTimeout(() => setGekopieerd(null), 1800) } catch { /* geen klembord */ }
  }

  const icoon = (id: number, px = 22) => (
    <EveImage category="types" id={id} size={32} px={px}
      variation={/(Blueprint|Reaction Formula)$/.test(g.namen.get(id) ?? '') ? 'bp' : 'icon'} />
  )
  const itemCel = (id: number, plek?: number) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
      {icoon(id)}
      <button onClick={() => onItem(id, plek)} title="Details bekijken"
        style={{ background: 'none', border: 0, padding: 0, color: 'var(--text)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {g.namen.get(id) ?? `#${id}`}
      </button>
    </span>
  )
  const maxDag = Math.max(1, ...winst.dagen.map(d => Math.abs(d.winst)))

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {/* 1. Waar staat je geld */}
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          <div style={LABEL}>Waar staat je geld</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{fmtISK(geld.totaal)} <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontWeight: 400 }}>totaal</span></div>
        </div>
        <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--surface2)' }}>
          {(['wallet', 'koop', 'verkoop', 'voorraad'] as const).map(k => geld[k] > 0 && (
            <div key={k} title={`${k}: ${fmtISK(geld[k])}`} style={{ width: `${(geld[k] / (geld.totaal || 1)) * 100}%`, background: KLEUR[k] }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginTop: '0.7rem' }}>
          {([['wallet', 'Wallet'], ['koop', 'In koop-orders'], ['verkoop', 'In verkoop-orders'], ['voorraad', 'Voorraad (niet te koop)']] as const).map(([k, label]) => (
            <div key={k} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: KLEUR[k], flex: 'none' }} />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{label}</span>
              <b style={{ fontSize: '0.82rem', marginLeft: 'auto' }}>{fmtISK(geld[k])}</b>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Hoe gaat het */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.7rem' }}>
        {([['Winst vandaag', winst.vandaag], ['Winst 7 dagen', winst.week], ['Winst 30 dagen', winst.maand]] as const).map(([label, v]) => (
          <button key={label} onClick={() => naarTab('statistiek')} title="Naar de statistiek"
            style={{ ...CARD, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
            <div style={LABEL}>{label}</div>
            <div style={{ fontSize: '1.45rem', fontWeight: 800, color: kleur(v) }}>{plus(v)}</div>
          </button>
        ))}
        <div style={CARD}>
          <div style={LABEL}>Winst per dag · 14 dagen</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 44 }}>
            {winst.dagen.map(d => (
              <div key={d.dag} title={`${datumKort(d.dag)}: ${plus(d.winst)}`} style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ height: '50%', display: 'flex', alignItems: 'flex-end' }}>
                  {d.winst > 0 && <div style={{ width: '100%', height: `${(d.winst / maxDag) * 100}%`, minHeight: 2, background: '#4ade80', borderRadius: 2 }} />}
                </div>
                <div style={{ height: '50%', display: 'flex', alignItems: 'flex-start', borderTop: '1px solid var(--border)' }}>
                  {d.winst < 0 && <div style={{ width: '100%', height: `${(-d.winst / maxDag) * 100}%`, minHeight: 2, background: '#ff5c6c', borderRadius: 2 }} />}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ ...CARD, borderColor: teDoen ? 'rgba(255,206,84,0.5)' : 'rgba(74,222,128,0.4)' }}>
          <div style={LABEL}>Te doen</div>
          <div style={{ fontSize: '1.45rem', fontWeight: 800, color: teDoen ? '#ffce54' : '#4ade80' }}>{teDoen || '✓'}</div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{overboden.length} overboden · {verkoopbaar.length} verkoopbaar</div>
        </div>
      </div>

      {/* 3. Wat nu */}
      {teDoen === 0 ? (
        <div style={{ ...CARD, borderColor: 'rgba(74,222,128,0.4)', color: '#4ade80', fontWeight: 700, fontSize: '0.9rem' }}>
          👍 Alles staat goed: je orders staan bovenaan en er ligt niets dat nu met winst weg kan.
        </div>
      ) : (
        <div style={CARD}>
          <div style={{ fontSize: '0.9rem', fontWeight: 800, marginBottom: '0.7rem', color: '#ffce54' }}>⚠️ Nu doen ({teDoen})</div>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {overboden.map(s => (
              <ActieRij key={'o' + s.order.order_id} rand="#ffce54" item={itemCel(s.order.type_id, s.order.location_id)}
                plek={plekNaam(s.order.location_id) + ' · ' + (g.chars.get(s.order.charId) ?? 'character ' + s.order.charId)}
                tekst={<>{s.isBuy ? 'Verhoog je koopprijs' : 'Verlaag je verkoopprijs'}: {fmtISK(s.order.price)} → <b style={{ color: 'var(--text)', fontSize: '0.95rem' }}>{fmtISK(s.voorstel ?? s.order.price)}</b>
                  <span style={{ color: 'var(--text-dim)' }}> · {s.boven > 1 ? `${s.boven} orders boven je` : 'overboden'}</span></>}
                knoppen={<>
                  {s.voorstel !== null && <button onClick={() => kopieer(s.order.order_id, s.voorstel!)} style={KNOP}>{gekopieerd === s.order.order_id ? '✓ Gekopieerd' : '📋 Kopieer prijs'}</button>}
                  <button onClick={() => openInEve(s.order.type_id)} style={KNOP}>Open in EVE</button>
                </>} />
            ))}
            {verkoopbaar.map(p => (
              <ActieRij key={'p' + p.bron + p.locationId + ':' + p.typeId} rand="#4ade80" item={itemCel(p.typeId, p.locationId)}
                plek={plekNaam(p.locationId)}
                tekst={<>Verkoop {p.vrij.toLocaleString('nl-NL')} st voor {p.sell !== null ? fmtISK(p.sell) : '–'}{p.prijsVan === 'jita' ? ' (Jita)' : ''} ·{' '}
                  <b style={{ color: '#4ade80', fontSize: '0.95rem' }}>{plus(p.pnlVrij ?? 0)}</b> winst</>}
                knoppen={<>
                  {p.sell !== null && <button onClick={() => kopieer(-p.typeId - p.locationId, p.sell! - 0.01)} style={KNOP}>{gekopieerd === -p.typeId - p.locationId ? '✓ Gekopieerd' : '📋 Kopieer prijs'}</button>}
                  <button onClick={() => openInEve(p.typeId)} style={KNOP}>Open in EVE</button>
                </>} />
            ))}
          </div>
        </div>
      )}

      {/* 4. Orders en posities */}
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>📋 Mijn orders <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: '0.75rem' }}>({g.status.length}{g.hub !== 'alle' ? ` in ${g.hub === 'overig' ? 'overige plekken' : g.hub}` : ''})</span></div>
          {/* Per character wat er van EVE binnenkwam: zo zie je meteen of er iets mist. */}
          <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap', fontSize: '0.7rem' }}>
            {g.bronnen.map(b => (
              <span key={b.charId} title={b.fout ? `Ophalen mislukt: ${b.fout}` : `${b.orders} open orders bij EVE`}
                style={{ color: b.fout ? '#ff5c6c' : 'var(--text-dim)' }}>
                {b.naam}: <b style={{ color: b.fout ? '#ff5c6c' : 'var(--text)' }}>{b.fout ? 'fout' : b.orders}</b>
              </span>
            ))}
          </div>
        </div>
        {(g.nietGekozen.length > 0 || g.bronnen.some(b => b.fout)) && (
          <div style={{ fontSize: '0.72rem', color: '#ffce54', marginBottom: '0.6rem' }}>
            {g.nietGekozen.length > 0 && <>Alleen het gekozen character wordt getoond; {g.nietGekozen.join(', ')} {g.nietGekozen.length === 1 ? 'staat' : 'staan'} uit. Kies bovenin "alle characters" om alles te zien. </>}
            {g.bronnen.some(b => b.fout) && <>Bij een character lukte het ophalen niet: log dat character opnieuw in.</>}
          </div>
        )}
        {!g.status.length ? <div style={DOF}>Geen open orders{g.hub === 'alle' ? '' : ' in deze markt'}.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th><th style={{ ...TH, textAlign: 'left' }}>Character</th><th style={{ ...TH, textAlign: 'left' }}>Plek</th><th style={TH}>Soort</th>
                <th style={TH}>Prijs</th><th style={{ ...TH, textAlign: 'left' }}>Gevuld</th><th style={TH}>Status</th><th style={TH}>Loopt nog</th><th style={TH}>Waarde</th>
              </tr></thead>
              <tbody>
                {g.status.map(s => {
                  const gevuld = s.order.volume_total > 0 ? 1 - s.order.volume_remain / s.order.volume_total : 0
                  return (
                    <tr key={s.order.order_id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...TD, textAlign: 'left', maxWidth: 280 }}>{itemCel(s.order.type_id, s.order.location_id)}</td>
                      <td style={{ ...TD, textAlign: 'left', maxWidth: 170 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', maxWidth: '100%' }}>
                          <EveImage category="characters" id={s.order.charId} variation="portrait" size={32} px={18} round />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.chars.get(s.order.charId) ?? s.order.charId}</span>
                        </span>
                      </td>
                      <td style={{ ...TD, textAlign: 'left', color: 'var(--text-dim)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{plekNaam(s.order.location_id)}</td>
                      <td style={TD}>{s.isBuy ? <Badge tekst="KOOP" kleur={KLEUR.koop} achter="rgba(76,201,240,0.12)" /> : <Badge tekst="VERKOOP" kleur={KLEUR.verkoop} achter="rgba(244,162,97,0.12)" />}</td>
                      <td style={{ ...TD, fontWeight: 700 }}>{fmtISK(s.order.price)}</td>
                      <td style={{ ...TD, textAlign: 'left', minWidth: 120 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden', minWidth: 50 }}>
                            <div style={{ width: `${gevuld * 100}%`, height: '100%', background: s.isBuy ? KLEUR.koop : KLEUR.verkoop }} />
                          </div>
                          <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>{(s.order.volume_total - s.order.volume_remain).toLocaleString('nl-NL')}/{s.order.volume_total.toLocaleString('nl-NL')}</span>
                        </div>
                      </td>
                      <td style={TD}>{statusBadge(s)}</td>
                      <td style={{ ...TD, color: s.dagenOver < 3 ? '#ffce54' : 'var(--text-dim)' }}>{s.dagenOver < 1 ? '< 1 dag' : `${Math.floor(s.dagenOver)} d`}</td>
                      <td style={TD}>{fmtISK(s.waarde)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <details style={{ marginTop: '0.7rem' }}>
          <summary style={{ fontSize: '0.7rem', color: 'var(--text-dim)', cursor: 'pointer' }}>Zie je een order niet die je in EVE wel hebt staan?</summary>
          <ul style={{ fontSize: '0.72rem', color: 'var(--text-dim)', margin: '0.4rem 0 0', paddingLeft: '1.1rem', lineHeight: 1.6 }}>
            <li><b style={{ color: 'var(--text)' }}>Net geplaatst of aangepast?</b> EVE geeft orders met tot 20 minuten vertraging door. Druk later op Ververs.</li>
            <li><b style={{ color: 'var(--text)' }}>Ander character?</b> Alleen de characters hierboven tellen mee. Staat er één niet tussen, voeg hem toe of kies "alle characters".</li>
            <li><b style={{ color: 'var(--text)' }}>Voor je corporation geplaatst</b> (corp-wallet)? Die orders geeft EVE alleen met corp-rechten; die toont deze pagina (nog) niet.</li>
            <li><b style={{ color: 'var(--text)' }}>Markt gefilterd?</b> Bovenin staat de markt op "{g.hub === 'alle' ? 'Alle hubs' : g.hub}".</li>
          </ul>
        </details>
      </div>

      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.6rem', gap: '0.6rem', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 800 }}>💼 Open posities <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: '0.75rem' }}>({g.posities.length})</span></div>
          {!!g.posities.length && <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>nu alles verkocht: <b style={{ color: kleur(posPnl) }}>{plus(posPnl)}</b></span>}
        </div>
        {!g.posities.length ? <div style={DOF}>Geen open posities. <Link to="/jita-positions" style={{ color: 'var(--blue)' }}>Handmatig toevoegen</Link></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th><th style={{ ...TH, textAlign: 'left' }}>Plek</th><th style={TH}>Aantal</th>
                <th style={TH}>Ingekocht</th><th style={TH}>Nu</th><th style={TH}>Winst / verlies</th><th style={TH}>%</th><th style={TH}></th>
              </tr></thead>
              <tbody>
                {g.posities.map(p => {
                  const pct = p.kosten > 0 && p.pnl !== null ? (p.pnl / p.kosten) * 100 : null
                  return (
                    <tr key={p.bron + p.locationId + ':' + p.typeId} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...TD, textAlign: 'left', maxWidth: 280 }}>{itemCel(p.typeId, p.locationId)}</td>
                      <td style={{ ...TD, textAlign: 'left', color: 'var(--text-dim)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{plekNaam(p.locationId)}</td>
                      <td style={TD}>{p.qty.toLocaleString('nl-NL')}</td>
                      <td style={TD}>{fmtISK(p.buyPrice)}</td>
                      <td style={TD}>{p.sell !== null ? fmtISK(p.sell) : '–'}{p.prijsVan === 'jita' && <span style={{ color: 'var(--text-dim)', fontSize: '0.62rem' }} title="Hier geen markt bekend: Jita-prijs"> J</span>}</td>
                      <td style={{ ...TD, fontWeight: 700, color: kleur(p.pnl ?? 0) }}>{p.pnl === null ? '–' : plus(p.pnl)}</td>
                      <td style={{ ...TD, color: kleur(pct ?? 0) }}>{pct === null ? '–' : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`}</td>
                      <td style={TD}>
                        {p.inOrder > 0 && <Badge tekst={p.inOrder === p.qty ? 'te koop' : `${p.inOrder} te koop`} kleur={KLEUR.verkoop} achter="rgba(244,162,97,0.12)" />}
                        {p.bron === 'handmatig' && <span title="handmatig toegevoegd" style={{ marginLeft: 4 }}>✎</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.72rem' }}>
        <button onClick={() => naarTab('kansen')} style={{ background: 'none', border: 0, padding: 0, color: 'var(--blue)', cursor: 'pointer', fontSize: '0.72rem' }}>🔎 Nieuwe kansen zoeken →</button>
        <Link to="/jita-scanner" style={{ color: 'var(--blue)' }}>📈 Jita Scanner</Link>
        <Link to="/gap-scanner" style={{ color: 'var(--blue)' }}>🕳️ Gap Scanner</Link>
        <Link to="/hub-arbitrage" style={{ color: 'var(--blue)' }}>🔀 Hub-arbitrage</Link>
      </div>
    </div>
  )
}

/** Eén actie: links het item en waar, in het midden wat je moet doen, rechts de knoppen. */
function ActieRij({ rand, item, plek, tekst, knoppen }: { rand: string; item: React.ReactNode; plek: string; tekst: React.ReactNode; knoppen: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 0.9rem', alignItems: 'center',
                  padding: '0.55rem 0.7rem', background: 'var(--surface2)', borderRadius: 4, borderLeft: `3px solid ${rand}` }}>
      <div style={{ minWidth: 0, flex: '1 1 220px' }}>
        {item}
        <div style={{ fontSize: '0.64rem', color: 'var(--text-dim)', marginLeft: 30 }}>{plek}</div>
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', flex: '2 1 280px' }}>{tekst}</div>
      <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap', flex: '0 0 auto' }}>{knoppen}</div>
    </div>
  )
}
