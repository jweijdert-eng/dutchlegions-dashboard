import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'

interface Miner { character_id: number; name: string; m3: number; isk: number; updated_at: string }

const MEDAL = (r: number) =>
  r === 1 ? { c: '#f5c518', glow: 'rgba(245,197,24,0.55)', grad: 'linear-gradient(150deg, rgba(245,197,24,0.28), rgba(245,197,24,0.04))', m: '🥇' }
  : r === 2 ? { c: '#cbd5e1', glow: 'rgba(203,213,225,0.45)', grad: 'linear-gradient(150deg, rgba(203,213,225,0.22), rgba(203,213,225,0.03))', m: '🥈' }
  : { c: '#cd7f32', glow: 'rgba(205,127,50,0.45)', grad: 'linear-gradient(150deg, rgba(205,127,50,0.24), rgba(205,127,50,0.03))', m: '🥉' }

function fmtM3(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${Math.round(v)}`
}
function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} mrd`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} mln`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}

export default function TopMiners() {
  const [rows, setRows] = useState<Miner[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  usePageLoading(loading)

  useEffect(() => {
    let cancelled = false
    fetch('/api/miners.php')
      .then(r => r.json())
      .then((d: Miner[]) => {
        if (cancelled) return
        if (!Array.isArray(d)) { setErr('Kon de ranglijst niet laden.'); setLoading(false); return }
        setRows(d.map(m => ({ ...m, m3: +m.m3, isk: +m.isk }))); setLoading(false)
      })
      .catch(() => { if (!cancelled) { setErr('Netwerkfout.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const maxM3 = useMemo(() => Math.max(1, ...rows.map(r => r.m3)), [rows])
  const totals = useMemo(() => rows.reduce((a, r) => ({ m3: a.m3 + r.m3, isk: a.isk + r.isk }), { m3: 0, isk: 0 }), [rows])
  const podium = rows.slice(0, 3)
  const rest = rows.slice(3)

  return (
    <Layout header={<PageHeader title="Top Miners" sub={loading ? 'laden…' : `Dutch Legions · deze maand · ${rows.length} miners`} />}>
      {err && <div style={{ ...card, color: 'var(--red)', marginBottom: '1rem' }}>{err}</div>}

      {!loading && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.6rem', marginBottom: '1.1rem' }}>
          <Stat label="TOTAAL m³" value={fmtM3(totals.m3)} color="#4ade80" grad="linear-gradient(150deg, rgba(74,222,128,0.18), rgba(74,222,128,0.02))" />
          <Stat label="GESCHATTE WAARDE" value={`${fmtISK(totals.isk)} ISK`} color="var(--gold)" grad="linear-gradient(150deg, rgba(240,192,64,0.18), rgba(240,192,64,0.02))" />
          <Stat label="MINERS" value={String(rows.length)} color="var(--blue)" grad="linear-gradient(150deg, rgba(0,180,216,0.18), rgba(0,180,216,0.02))" />
        </div>
      )}

      {podium.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.1rem' }}>
          {podium.map((r, i) => {
            const md = MEDAL(i + 1)
            return (
              <div key={r.character_id} style={{ background: md.grad, border: `1px solid ${md.c}`, borderRadius: 10, padding: '0.9rem 0.7rem', textAlign: 'center', position: 'relative', boxShadow: `0 0 20px ${md.glow}` }}>
                <div style={{ position: 'absolute', top: 8, left: 10, fontSize: '1.2rem' }}>{md.m}</div>
                <img src={`https://images.evetech.net/characters/${r.character_id}/portrait?size=128`} width={64} height={64}
                  style={{ borderRadius: '50%', border: `3px solid ${md.c}`, boxShadow: `0 0 14px ${md.glow}` }} alt="" />
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: md.c, lineHeight: 1.1, marginTop: 4 }}>{fmtM3(r.m3)}</div>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.12em' }}>m³</div>
                <div style={{ fontSize: '0.66rem', color: 'var(--gold)', marginTop: 6 }}>{fmtISK(r.isk)} ISK</div>
              </div>
            )
          })}
        </div>
      )}

      {rest.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          {rest.map((r, idx) => {
            const i = idx + 3
            return (
              <div key={r.character_id} style={{ ...row, borderBottom: idx < rest.length - 1 ? '1px solid var(--border)' : 'none', position: 'relative' }}>
                <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(r.m3 / maxM3) * 100}%`, background: 'linear-gradient(90deg, rgba(74,222,128,0.12), rgba(0,180,216,0.08))', pointerEvents: 'none' }} />
                <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.74rem', color: 'var(--text-dim)', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', zIndex: 1 }}>{i + 1}</span>
                <img src={`https://images.evetech.net/characters/${r.character_id}/portrait?size=32`} width={26} height={26} style={{ borderRadius: '50%', flexShrink: 0, zIndex: 1 }} alt="" />
                <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', zIndex: 1 }}>{r.name}</span>
                <span style={{ width: 80, textAlign: 'right', color: '#4ade80', fontWeight: 700, zIndex: 1 }}>{fmtM3(r.m3)} m³</span>
                <span style={{ width: 80, textAlign: 'right', color: 'var(--gold)', fontSize: '0.72rem', zIndex: 1 }}>{fmtISK(r.isk)}</span>
              </div>
            )
          })}
        </div>
      )}

      {!loading && rows.length === 0 && !err && (
        <div style={{ ...card, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Nog geen mining-data deze maand. De ranglijst vult zich zodra leden hun <strong>Mining</strong>-pagina openen — dan wordt hun maand-mining automatisch bijgedragen.
        </div>
      )}

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Top miners van deze maand (m³ + geschatte Jita-waarde). Mining is privé, dus alleen leden die hun Mining-pagina openen dragen bij. Waarde = ruwe erts @Jita-buy.
      </div>
    </Layout>
  )
}

function Stat({ label, value, color, grad }: { label: string; value: string; color: string; grad: string }) {
  return (
    <div style={{ background: grad, border: '1px solid var(--border)', borderRadius: 8, padding: '0.6rem 0.8rem' }}>
      <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.14em' }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, color }}>{value}</div>
    </div>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.5rem 0.7rem', fontSize: '0.78rem' }
