import { useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'

function fmtISK(v: number) {
  if (!isFinite(v)) return '—'
  const abs = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`
  return `${sign}${abs.toFixed(2)}`
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/[.,\s]/g, '').replace(',', '.')) || 0
}

interface Preset { label: string; broker: number; tax: number }
const PRESETS: Preset[] = [
  { label: 'Geen skills',    broker: 5.00, tax: 8.00 },
  { label: 'Basis skills',   broker: 3.00, tax: 7.20 },
  { label: 'Max skills',     broker: 2.00, tax: 3.60 },
  { label: 'Corp/NPC hub',   broker: 0.30, tax: 3.60 },
]

const INPUT: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.8rem', padding: '0.4rem 0.6rem', width: '100%', outline: 'none',
}
const LABEL: React.CSSProperties = {
  fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.3rem',
}

function ResultRow({ label, value, color, big }: { label: string; value: string; color?: string; big?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: big ? '0.5rem 0' : '0.3rem 0', borderTop: '1px solid rgba(28,28,53,0.4)' }}>
      <span style={{ fontSize: big ? '0.78rem' : '0.72rem', color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontSize: big ? '1rem' : '0.8rem', fontWeight: big ? 700 : 500, color: color ?? 'var(--text)' }}>{value}</span>
    </div>
  )
}

export default function Margin() {
  const [buyPrice,  setBuyPrice]  = useState('')
  const [sellPrice, setSellPrice] = useState('')
  const [qty,       setQty]       = useState('1')
  const [broker,    setBroker]    = useState('3.00')
  const [tax,       setTax]       = useState('7.20')
  const [preset,    setPreset]    = useState(1)

  function applyPreset(p: Preset, idx: number) {
    setBroker(p.broker.toFixed(2))
    setTax(p.tax.toFixed(2))
    setPreset(idx)
  }

  const buy    = parseNum(buyPrice)
  const sell   = parseNum(sellPrice)
  const q      = Math.max(1, Math.round(parseNum(qty)))
  const br     = parseFloat(broker) / 100
  const tx     = parseFloat(tax) / 100

  const revenue      = sell * q
  const brokerCost   = sell * br * q
  const taxCost      = sell * tx * q
  const cogs         = buy * q
  const netProfit    = revenue - brokerCost - taxCost - cogs
  const profitPerUnit = netProfit / q
  const roi          = cogs > 0 ? (netProfit / cogs) * 100 : 0
  const breakEven    = cogs > 0 ? (buy + buy * br) / (1 - br - tx) : 0
  const margin       = sell > 0 ? (netProfit / revenue) * 100 : 0

  const profitColor = netProfit >= 0 ? 'var(--green)' : 'var(--red)'

  return (
    <Layout header={<PageHeader title="Margin Calculator" sub="EVE Online handel winstberekening" />}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', maxWidth: 860 }}>
        {/* Input panel */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.25rem' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '1rem' }}>INVOER</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div>
              <div style={LABEL}>INKOOPPRIJS (ISK)</div>
              <input type="text" inputMode="decimal" placeholder="0.00" value={buyPrice} onChange={e => setBuyPrice(e.target.value)} style={INPUT} />
            </div>
            <div>
              <div style={LABEL}>VERKOOPPRIJS (ISK)</div>
              <input type="text" inputMode="decimal" placeholder="0.00" value={sellPrice} onChange={e => setSellPrice(e.target.value)} style={INPUT} />
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <div style={LABEL}>AANTAL</div>
            <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} style={{ ...INPUT, width: '50%' }} />
          </div>

          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.4rem' }}>PRESET</div>
          <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p, i)}
                style={{
                  padding: '0.2rem 0.5rem', borderRadius: 2, fontSize: '0.65rem', cursor: 'pointer', fontWeight: 600,
                  background: preset === i ? 'rgba(0,180,216,0.15)' : 'transparent',
                  border: `1px solid ${preset === i ? 'var(--blue)' : 'var(--border)'}`,
                  color: preset === i ? 'var(--blue)' : 'var(--text-dim)',
                }}
              >{p.label}</button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <div style={LABEL}>BROKER FEE (%)</div>
              <input type="number" step="0.01" min="0" max="100" value={broker} onChange={e => { setBroker(e.target.value); setPreset(-1) }} style={INPUT} />
            </div>
            <div>
              <div style={LABEL}>SALES TAX (%)</div>
              <input type="number" step="0.01" min="0" max="100" value={tax} onChange={e => { setTax(e.target.value); setPreset(-1) }} style={INPUT} />
            </div>
          </div>
        </div>

        {/* Result panel */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.25rem' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em', marginBottom: '1rem' }}>RESULTAAT</div>

          {sell > 0 && buy > 0 ? (
            <>
              <div style={{ textAlign: 'center', padding: '0.75rem 0 1rem', borderBottom: '1px solid rgba(28,28,53,0.5)', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.12em', marginBottom: '0.3rem' }}>NETTO WINST</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700, color: profitColor }}>
                  {fmtISK(netProfit)} ISK
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>
                  {fmtISK(profitPerUnit)} ISK per stuk
                </div>
              </div>

              <ResultRow label="Omzet"         value={`${fmtISK(revenue)} ISK`} />
              <ResultRow label="Inkoop"         value={`−${fmtISK(cogs)} ISK`} color="var(--red)" />
              <ResultRow label="Broker fee"     value={`−${fmtISK(brokerCost)} ISK`} color="var(--red)" />
              <ResultRow label="Sales tax"      value={`−${fmtISK(taxCost)} ISK`} color="var(--red)" />
              <ResultRow label="ROI"            value={`${roi.toFixed(1)}%`} color={roi >= 0 ? 'var(--green)' : 'var(--red)'} big />
              <ResultRow label="Marge"          value={`${margin.toFixed(1)}%`} color={margin >= 0 ? 'var(--green)' : 'var(--red)'} />
              <ResultRow label="Break-even sell" value={`${fmtISK(breakEven)} ISK`} color="var(--gold)" />

              <button
                onClick={() => navigator.clipboard?.writeText(sellPrice)}
                style={{
                  marginTop: '1rem', width: '100%', padding: '0.5rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                  background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.3)', color: 'var(--blue)',
                }}
              >⎘ Kopieer verkoopprijs</button>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Vul inkoop- en verkoopprijs in
            </div>
          )}
        </div>
      </div>

      {/* Sneltoets hint */}
      <div style={{ marginTop: '0.75rem', fontSize: '0.62rem', color: 'var(--border)' }}>
        Sneltoets: <kbd style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.05rem 0.3rem' }}>X</kbd> → Margin Calculator
      </div>
    </Layout>
  )
}
