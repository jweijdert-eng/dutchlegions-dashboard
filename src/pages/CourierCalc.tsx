import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { getRoute } from '../api/esi'

type Sys = [string, number, number]  // [naam, security, regionId]

const PRESETS = {
  high: { label: 'Highsec', perM3: 700, perJump: 500_000, collPct: 0.5, base: 100_000 },
  low:  { label: 'Lowsec',  perM3: 1200, perJump: 1_000_000, collPct: 1, base: 500_000 },
  null: { label: 'Nullsec', perM3: 1000, perJump: 1_500_000, collPct: 1.5, base: 1_000_000 },
} as const
type Tier = keyof typeof PRESETS

// Vracht-capaciteit (m³) voor de "hoeveel ritten"-indicatie.
const HOLDS = [
  { label: 'DST', m3: 62_500 },
  { label: 'Blockade Runner', m3: 11_500 },
  { label: 'Freighter', m3: 1_125_000 },
  { label: 'Jump Freighter', m3: 360_000 },
]

function fmtISK(v: number) {
  if (!isFinite(v)) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} mrd`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} mln`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}
const secColor = (s: number) => { const r = Math.round(s * 10) / 10; return r >= 0.5 ? '#3ecf6e' : r > 0 ? '#f0a030' : '#e05555' }

export default function CourierCalc() {
  const [systems, setSystems] = useState<Record<string, Sys>>({})
  const [tier, setTier] = useState<Tier>('high')
  const [rate, setRate] = useState(PRESETS.high)
  const [m3, setM3] = useState(330_000)
  const [collateral, setCollateral] = useState(1_000_000_000)
  const [jumps, setJumps] = useState(10)
  const [routing, setRouting] = useState(false)
  const [origin, setOrigin] = useState<{ id: number; name: string } | null>(null)
  const [dest, setDest] = useState<{ id: number; name: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { fetch('/systems.json').then(r => r.json()).then(setSystems).catch(() => {}) }, [])
  const applyTier = (t: Tier) => { setTier(t); setRate(PRESETS[t]) }

  // Route ophalen zodra origin én dest gekozen zijn
  useEffect(() => {
    if (!origin || !dest) return
    setRouting(true)
    getRoute(origin.id, dest.id).then(r => { if (Array.isArray(r) && r.length) setJumps(Math.max(0, r.length - 1)) }).catch(() => {}).finally(() => setRouting(false))
  }, [origin, dest])

  const reward = rate.base + rate.perM3 * m3 + rate.perJump * jumps + (rate.collPct / 100) * collateral
  const ratio = collateral > 0 ? (reward / collateral) * 100 : 0
  const copyText = `Reward: ${Math.round(reward).toLocaleString('en-US')} ISK | Collateral: ${Math.round(collateral).toLocaleString('en-US')} ISK | Volume: ${Math.round(m3).toLocaleString('en-US')} m3${origin && dest ? ` | ${origin.name} → ${dest.name} (${jumps} jumps)` : ''}`
  const copy = () => { navigator.clipboard?.writeText(copyText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }

  return (
    <Layout header={<PageHeader title="Courier-calculator" />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem', alignItems: 'start' }}>

        {/* Invoer */}
        <div style={card}>
          <div style={cardTitle}>Opdracht</div>
          <Field label="Volume (m³)"><input type="number" min={0} value={m3} onChange={e => setM3(Math.max(0, parseInt(e.target.value) || 0))} style={input} /></Field>
          <Field label="Collateral (ISK)"><input type="number" min={0} value={collateral} onChange={e => setCollateral(Math.max(0, parseInt(e.target.value) || 0))} style={input} /></Field>
          <Field label="Sprongen"><input type="number" min={0} value={jumps} onChange={e => setJumps(Math.max(0, parseInt(e.target.value) || 0))} style={input} /></Field>

          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', margin: '0.6rem 0 0.3rem' }}>Sprongen automatisch via route (optioneel):</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <SystemPicker systems={systems} value={origin} onPick={setOrigin} placeholder="Van…" />
            <SystemPicker systems={systems} value={dest} onPick={setDest} placeholder="Naar…" />
          </div>
          {routing && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: 4 }}>route berekenen…</div>}
          {origin && dest && !routing && <div style={{ fontSize: '0.62rem', color: 'var(--blue)', marginTop: 4 }}>{origin.name} → {dest.name}: {jumps} sprongen</div>}
        </div>

        {/* Tarieven */}
        <div style={card}>
          <div style={cardTitle}>Tarieven</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: '0.6rem' }}>
            {(Object.keys(PRESETS) as Tier[]).map(t => <button key={t} onClick={() => applyTier(t)} style={pill(tier === t)}>{PRESETS[t].label}</button>)}
          </div>
          <Field label="ISK per m³"><input type="number" min={0} value={rate.perM3} onChange={e => setRate({ ...rate, perM3: Math.max(0, parseInt(e.target.value) || 0) })} style={input} /></Field>
          <Field label="ISK per sprong"><input type="number" min={0} value={rate.perJump} onChange={e => setRate({ ...rate, perJump: Math.max(0, parseInt(e.target.value) || 0) })} style={input} /></Field>
          <Field label="% van collateral"><input type="number" min={0} step={0.1} value={rate.collPct} onChange={e => setRate({ ...rate, collPct: Math.max(0, parseFloat(e.target.value) || 0) })} style={input} /></Field>
          <Field label="Basis-fee (ISK)"><input type="number" min={0} value={rate.base} onChange={e => setRate({ ...rate, base: Math.max(0, parseInt(e.target.value) || 0) })} style={input} /></Field>
        </div>

        {/* Resultaat */}
        <div style={{ ...card, borderColor: 'var(--blue)' }}>
          <div style={cardTitle}>Beloning</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#3ecf6e', lineHeight: 1.1 }}>{fmtISK(reward)}</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginBottom: '0.8rem' }}>ISK · {Math.round(reward).toLocaleString('nl-NL')}</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.68rem' }}>
            <Line label={`Volume (${m3.toLocaleString('nl-NL')} m³ × ${fmtISK(rate.perM3)})`} value={fmtISK(rate.perM3 * m3)} />
            <Line label={`Sprongen (${jumps} × ${fmtISK(rate.perJump)})`} value={fmtISK(rate.perJump * jumps)} />
            <Line label={`Collateral (${rate.collPct}%)`} value={fmtISK((rate.collPct / 100) * collateral)} />
            <Line label="Basis-fee" value={fmtISK(rate.base)} />
          </div>

          <div style={{ marginTop: '0.7rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)', fontSize: '0.66rem', color: 'var(--text-dim)' }}>
            <div>Reward/collateral: <strong style={{ color: ratio > 3 ? 'var(--gold)' : '#fff' }}>{ratio.toFixed(2)}%</strong></div>
            <div>≈ {fmtISK(m3 > 0 ? reward / m3 : 0)} ISK/m³</div>
            <div style={{ marginTop: 4 }}>Past in: {HOLDS.filter(h => m3 <= h.m3).map(h => h.label).join(', ') || `geen enkel ruim — ${Math.ceil(m3 / 1_125_000)} freighter-ritten`}</div>
          </div>

          <button onClick={copy} style={{ ...pill(false), marginTop: '0.8rem', width: '100%', padding: '0.5rem', background: 'rgba(0,180,216,0.15)', color: 'var(--blue)', borderColor: 'var(--blue)' }}>{copied ? '✓ gekopieerd' : '📋 Kopieer contract-tekst'}</button>
        </div>
      </div>

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Beloning = basis-fee + (ISK/m³ × volume) + (ISK/sprong × sprongen) + (% × collateral). De tarieven zijn richtwaarden — pas ze aan naar je corp-afspraken. Collateral betaal je niet zelf; het is de garantie die de koerier inlegt en terugkrijgt bij levering.
      </div>
    </Layout>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', marginBottom: '0.5rem' }}><div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>{children}</label>
}
function Line({ label, value }: { label: string; value: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ color: 'var(--text-dim)' }}>{label}</span><span style={{ color: '#fff' }}>{value}</span></div>
}

function SystemPicker({ systems, value, onPick, placeholder }: { systems: Record<string, Sys>; value: { id: number; name: string } | null; onPick: (v: { id: number; name: string } | null) => void; placeholder: string }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s.length < 2) return [] as { id: number; name: string; sec: number }[]
    const out: { id: number; name: string; sec: number }[] = []
    for (const [id, v] of Object.entries(systems)) {
      if (v[0].toLowerCase().includes(s)) out.push({ id: +id, name: v[0], sec: v[1] })
      if (out.length > 30) break
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12)
  }, [q, systems])
  return (
    <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
      <input value={value ? value.name : q} placeholder={placeholder}
        onChange={e => { setQ(e.target.value); onPick(null); setOpen(true) }} onFocus={() => setOpen(true)}
        style={{ ...input, marginBottom: 0 }} />
      {open && !value && results.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, maxHeight: 200, overflowY: 'auto', background: '#0b0b1a', border: '1px solid var(--border)', borderRadius: 4 }}>
          {results.map(r => (
            <div key={r.id} onClick={() => { onPick({ id: r.id, name: r.name }); setOpen(false); setQ('') }}
              style={{ padding: '0.3rem 0.5rem', cursor: 'pointer', fontSize: '0.7rem', display: 'flex', gap: 6 }}>
              <span style={{ color: secColor(r.sec) }}>{(Math.round(r.sec * 10) / 10).toFixed(1)}</span>{r.name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.9rem 1rem' }
const cardTitle: React.CSSProperties = { fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.16em', marginBottom: '0.7rem' }
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', padding: '0.4rem 0.55rem', fontSize: '0.78rem' }
const pill = (on: boolean): React.CSSProperties => ({
  padding: '4px 12px', borderRadius: 12, fontSize: '0.66rem', cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? 'var(--blue)' : 'var(--text-dim)'}`, background: on ? 'rgba(0,180,216,0.18)' : 'rgba(255,255,255,0.05)', color: on ? '#fff' : 'var(--text)',
})
