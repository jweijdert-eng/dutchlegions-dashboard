import { useMemo, useState } from 'react'
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DAG, dagVan, fmtISK, hubKey, HUBS, kleur, nettoWinst, plus } from '../../utils/handel'
import { CARD, DOF, ItemKnop, KnopGroep, KOP, RIJ, TD, TH, Tegel, type Gegevens } from './delen'

type Periode = '7' | '30' | '90' | 'alles'
type ItemSort = 'winst' | 'omzet' | 'aantal'

const datumKort = (t: number) => new Date(t).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })

export default function Statistiek({ g, onItem }: { g: Gegevens; onItem: (typeId: number, locationId?: number) => void }) {
  const [periode, setPeriode] = useState<Periode>('30')
  const [itemSort, setItemSort] = useState<ItemSort>('winst')
  const echteKosten = g.hub === 'alle'

  const s = useMemo(() => {
    const nu = Date.now()
    const vanaf = periode === 'alles' ? 0 : dagVan(nu - (Number(periode) - 1) * DAG)
    const sales = g.verkocht.filter(v => v.tijd >= vanaf)
    const kosten = echteKosten ? g.kosten.filter(k => k.tijd >= vanaf) : []
    const bruto = sales.reduce((t, v) => t + v.opbrengst - v.kosten, 0)
    const omzet = sales.reduce((t, v) => t + v.opbrengst, 0)
    const inkoop = sales.reduce((t, v) => t + v.kosten, 0)
    const broker = kosten.filter(k => k.soort === 'broker').reduce((t, k) => t + k.bedrag, 0)
    const tax = kosten.filter(k => k.soort === 'tax').reduce((t, k) => t + k.bedrag, 0)
    const geschat = sales.reduce((t, v) => t + nettoWinst(v, g.fee), 0)
    const netto = echteKosten ? bruto - broker - tax : geschat
    const winstgevend = sales.filter(v => nettoWinst(v, g.fee) > 0).length

    // Per dag: winst, omzet, kosten en opgeteld.
    const eerste = sales.length ? Math.min(...sales.map(v => v.tijd)) : nu
    const start = Math.max(dagVan(periode === 'alles' ? eerste : vanaf), dagVan(nu - 400 * DAG))
    const dagen = new Map<number, { winst: number; omzet: number; broker: number; tax: number }>()
    for (let d = start; d <= dagVan(nu); d = dagVan(d + DAG * 1.5)) dagen.set(d, { winst: 0, omzet: 0, broker: 0, tax: 0 })
    for (const v of sales) {
      const r = dagen.get(dagVan(v.tijd)); if (!r) continue
      r.omzet += v.opbrengst
      r.winst += echteKosten ? v.opbrengst - v.kosten : nettoWinst(v, g.fee)
    }
    for (const k of kosten) {
      const r = dagen.get(dagVan(k.tijd)); if (!r) continue
      r[k.soort] += k.bedrag
      r.winst -= k.bedrag
    }
    let opgeteld = 0
    const reeks = [...dagen.entries()].map(([d, r]) => {
      opgeteld += r.winst
      return { dag: datumKort(d), ...r, kosten: r.broker + r.tax, opgeteld }
    })
    const besteDag = reeks.reduce((b, r) => (r.winst > b.winst ? r : b), { dag: '–', winst: 0 })

    const metWinst = sales.map(v => ({ v, w: nettoWinst(v, g.fee) }))
    const beste = [...metWinst].sort((a, b) => b.w - a.w).filter(x => x.w > 0).slice(0, 8)
    const slechtste = [...metWinst].sort((a, b) => a.w - b.w).filter(x => x.w < 0).slice(0, 8)

    const perItem = new Map<number, { aantal: number; omzet: number; winst: number; inkoop: number; trades: number }>()
    for (const { v, w } of metWinst) {
      const r = perItem.get(v.typeId) ?? { aantal: 0, omzet: 0, winst: 0, inkoop: 0, trades: 0 }
      r.aantal += v.qty; r.omzet += v.opbrengst; r.winst += w; r.inkoop += v.kosten; r.trades++
      perItem.set(v.typeId, r)
    }
    const items = [...perItem.entries()].map(([typeId, r]) => ({ typeId, ...r, marge: r.inkoop > 0 ? (r.winst / r.inkoop) * 100 : 0 }))

    const perHub = new Map<string, { omzet: number; winst: number; trades: number }>()
    for (const { v, w } of metWinst) {
      const k = hubKey(v.locationId)
      const r = perHub.get(k) ?? { omzet: 0, winst: 0, trades: 0 }
      r.omzet += v.opbrengst; r.winst += w; r.trades++
      perHub.set(k, r)
    }
    const kostenSinds = g.kosten.length ? Math.min(...g.kosten.map(k => k.tijd)) : null
    return { sales, bruto, omzet, inkoop, broker, tax, netto, geschat, winstgevend, reeks, besteDag, beste, slechtste, items, perHub, kostenSinds, vanaf }
  }, [g.verkocht, g.kosten, g.fee, periode, echteKosten])

  const items = [...s.items].sort((a, b) =>
    itemSort === 'omzet' ? b.omzet - a.omzet : itemSort === 'aantal' ? b.trades - a.trades : b.winst - a.winst).slice(0, 20)
  const kostenOnvolledig = echteKosten && s.kostenSinds !== null && s.kostenSinds > s.vanaf + DAG

  return (
    <>
      <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center', marginBottom: '0.9rem', flexWrap: 'wrap' }}>
        <KnopGroep<Periode> waarde={periode} onKies={setPeriode}
          opties={[{ key: '7', label: '7 dagen' }, { key: '30', label: '30 dagen' }, { key: '90', label: '90 dagen' }, { key: 'alles', label: 'Alles' }]} />
        <span style={DOF}>{s.sales.length} verkopen{g.sinds && <> · handel bewaard sinds {new Date(g.sinds).toLocaleDateString('nl-NL')}</>}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.7rem', marginBottom: '1rem' }}>
        <Tegel label="Netto winst" waarde={plus(s.netto)} kleurWaarde={kleur(s.netto)}
          sub={echteKosten ? 'bruto min échte kosten' : 'met geschatte kosten'} />
        <Tegel label="Bruto winst" waarde={plus(s.bruto)} kleurWaarde={kleur(s.bruto)} sub="verkoop min inkoop" />
        <Tegel label="Omzet" waarde={fmtISK(s.omzet)} sub={<>inkoop {fmtISK(s.inkoop)}</>} />
        {echteKosten && <Tegel label="Betaalde kosten" waarde={fmtISK(s.broker + s.tax)} kleurWaarde="#f4a261"
          sub={<>broker {fmtISK(s.broker)} · tax {fmtISK(s.tax)}</>} />}
        <Tegel label="Marge" waarde={s.inkoop > 0 ? `${((s.netto / s.inkoop) * 100).toFixed(1)}%` : '–'} sub="netto winst ÷ inkoop" />
        <Tegel label="Winstgevend" waarde={s.sales.length ? `${Math.round((s.winstgevend / s.sales.length) * 100)}%` : '–'}
          sub={<>{s.winstgevend} van {s.sales.length} verkopen</>} />
        <Tegel label="Beste dag" waarde={plus(s.besteDag.winst)} kleurWaarde={kleur(s.besteDag.winst)} sub={s.besteDag.dag} />
      </div>
      {kostenOnvolledig && (
        <div style={{ ...DOF, whiteSpace: 'normal', marginTop: '-0.5rem', marginBottom: '0.8rem' }}>
          Let op: de échte kosten zijn pas bekend vanaf {new Date(s.kostenSinds!).toLocaleDateString('nl-NL')}; daarvoor tellen ze nog niet mee.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
        <div style={CARD}>
          <div style={KOP}>📊 Winst per dag en opgeteld</div>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={s.reeks} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="dag" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} minTickGap={24} />
              <YAxis yAxisId="dag" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtISK(v)} />
              <YAxis yAxisId="som" orientation="right" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtISK(v)} />
              <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: '0.7rem', borderRadius: 4 }}
                formatter={(v: number, n: string) => [plus(v), n === 'winst' ? 'winst die dag' : 'opgeteld']} />
              <Bar yAxisId="dag" dataKey="winst">
                {s.reeks.map((r, i) => <Cell key={i} fill={r.winst >= 0 ? '#4ade80' : '#ff5c6c'} />)}
              </Bar>
              <Line yAxisId="som" dataKey="opgeteld" stroke="#00b4d8" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div style={CARD}>
          <div style={KOP}>💸 Omzet {echteKosten ? 'en betaalde kosten ' : ''}per dag</div>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={s.reeks} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="dag" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} minTickGap={24} />
              <YAxis yAxisId="omzet" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtISK(v)} />
              {echteKosten && <YAxis yAxisId="kosten" orientation="right" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} width={52} tickFormatter={(v: number) => fmtISK(v)} />}
              <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: '0.7rem', borderRadius: 4 }}
                formatter={(v: number, n: string) => [fmtISK(v), n]} />
              <Legend wrapperStyle={{ fontSize: '0.68rem' }} />
              <Bar yAxisId="omzet" dataKey="omzet" name="omzet" fill="#3a6ea5" />
              {echteKosten && <Line yAxisId="kosten" dataKey="broker" name="broker fee" stroke="#f4a261" strokeWidth={2} dot={false} />}
              {echteKosten && <Line yAxisId="kosten" dataKey="tax" name="sales tax" stroke="#ff5c6c" strokeWidth={2} dot={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
        <div style={CARD}>
          <div style={KOP}>🏆 Beste trades</div>
          {!s.beste.length && <div style={DOF}>Nog geen winstgevende verkopen in deze periode.</div>}
          {s.beste.map(({ v, w }) => (
            <div key={v.charId + ':' + v.transactionId} style={RIJ}>
              <ItemKnop id={v.typeId} namen={g.namen} onItem={onItem} plek={v.locationId} />
              <span style={DOF}>{datumKort(v.tijd)} · {v.qty.toLocaleString('nl-NL')} st · <b style={{ color: kleur(w) }}>{plus(w)}</b></span>
            </div>
          ))}
        </div>
        <div style={CARD}>
          <div style={KOP}>📉 Slechtste trades</div>
          {!s.slechtste.length && <div style={DOF}>Geen verliesgevende verkopen in deze periode. 👍</div>}
          {s.slechtste.map(({ v, w }) => (
            <div key={v.charId + ':' + v.transactionId} style={RIJ}>
              <ItemKnop id={v.typeId} namen={g.namen} onItem={onItem} plek={v.locationId} />
              <span style={DOF}>{datumKort(v.tijd)} · {v.qty.toLocaleString('nl-NL')} st · <b style={{ color: kleur(w) }}>{plus(w)}</b></span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: g.hub === 'alle' ? 'minmax(0, 2fr) minmax(0, 1fr)' : '1fr', gap: '1rem' }}>
        <div style={CARD}>
          <div style={{ ...KOP, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span>📦 Per item</span>
            <KnopGroep<ItemSort> waarde={itemSort} onKies={setItemSort}
              opties={[{ key: 'winst', label: 'Winst' }, { key: 'omzet', label: 'Omzet' }, { key: 'aantal', label: 'Aantal trades' }]} />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...TH, textAlign: 'left' }}>Item</th><th style={TH}>Trades</th><th style={TH}>Stuks</th>
                <th style={TH}>Omzet</th><th style={TH}>Marge</th><th style={TH}>Winst</th>
              </tr></thead>
              <tbody>
                {items.map(i => (
                  <tr key={i.typeId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...TD, textAlign: 'left', maxWidth: 260, overflow: 'hidden' }}><ItemKnop id={i.typeId} namen={g.namen} onItem={onItem} /></td>
                    <td style={TD}>{i.trades}</td>
                    <td style={TD}>{i.aantal.toLocaleString('nl-NL')}</td>
                    <td style={TD}>{fmtISK(i.omzet)}</td>
                    <td style={{ ...TD, color: kleur(i.marge) }}>{i.marge.toFixed(1)}%</td>
                    <td style={{ ...TD, color: kleur(i.winst), fontWeight: 700 }}>{plus(i.winst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && <div style={DOF}>Nog geen verkopen in deze periode.</div>}
          </div>
        </div>
        {g.hub === 'alle' && (
          <div style={CARD}>
            <div style={KOP}>🗺️ Per hub</div>
            {[...HUBS.map(h => ({ key: h.key, naam: h.naam })), { key: 'overig', naam: 'Overig' }]
              .filter(h => s.perHub.has(h.key)).map(h => {
                const r = s.perHub.get(h.key)!
                return (
                  <div key={h.key} style={RIJ}>
                    <b style={{ fontSize: '0.8rem' }}>{h.naam}</b>
                    <span style={DOF}>{r.trades} · omzet {fmtISK(r.omzet)} · <b style={{ color: kleur(r.winst) }}>{plus(r.winst)}</b></span>
                  </div>
                )
              })}
            {!s.perHub.size && <div style={DOF}>Nog geen verkopen in deze periode.</div>}
          </div>
        )}
      </div>
    </>
  )
}
