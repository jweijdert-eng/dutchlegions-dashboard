import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'

const CORP_ID = 98652891   // Dutch Legions

interface TopKiller { characterID: number; characterName: string; kills: number; losses?: number }

const rank = (r: number) => r === 1 ? { c: '#f5c518', m: '🥇' } : r === 2 ? { c: '#cbd5e1', m: '🥈' } : r === 3 ? { c: '#cd7f32', m: '🥉' } : { c: 'var(--text-dim)', m: `#${r}` }
const kd = (k: number, l: number) => l === 0 ? (k > 0 ? '∞' : '0.0') : (k / l).toFixed(1)

export default function Leaderboard() {
  const [rows, setRows] = useState<TopKiller[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  usePageLoading(loading)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/zkill.php?type=corporationID&id=${CORP_ID}`)
      .then(r => r.json())
      .then((d: { topKillers?: TopKiller[] }) => {
        if (cancelled) return
        const list = (d?.topKillers ?? []).map(k => ({ ...k, losses: k.losses ?? 0 }))
        if (!list.length) setErr('Geen data van zKillboard.')
        setRows(list); setLoading(false)
      })
      .catch(() => { if (!cancelled) { setErr('Kon zKillboard niet bereiken.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const maxKills = useMemo(() => Math.max(1, ...rows.map(r => r.kills)), [rows])
  const totals = useMemo(() => rows.reduce((a, r) => ({ k: a.k + r.kills, l: a.l + (r.losses ?? 0) }), { k: 0, l: 0 }), [rows])

  return (
    <Layout header={<PageHeader title="Leaderboard" sub={loading ? 'zKillboard laden…' : `Dutch Legions · deze maand · top ${rows.length}`} />}>
      {err && <div style={{ ...card, color: 'var(--red)', marginBottom: '1rem' }}>{err}</div>}

      {/* Samenvatting */}
      {!loading && rows.length > 0 && (
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.78rem' }}>
          <span><span style={{ color: 'var(--text-dim)' }}>Totaal kills: </span><strong style={{ color: '#3ecf6e' }}>{totals.k}</strong></span>
          <span><span style={{ color: 'var(--text-dim)' }}>Totaal losses: </span><strong style={{ color: 'var(--red)' }}>{totals.l}</strong></span>
          <span><span style={{ color: 'var(--text-dim)' }}>K/D: </span><strong>{kd(totals.k, totals.l)}</strong></span>
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {/* Kop */}
        <div style={{ ...row, fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
          <span style={{ width: 40, textAlign: 'center', flexShrink: 0 }}>#</span>
          <span style={{ width: 30, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>PILOT</span>
          <span style={{ width: 60, textAlign: 'right' }}>KILLS</span>
          <span style={{ width: 60, textAlign: 'right' }}>LOSSES</span>
          <span style={{ width: 50, textAlign: 'right' }}>K/D</span>
        </div>
        {rows.map((r, i) => {
          const rk = rank(i + 1)
          return (
            <a key={r.characterID} href={`https://zkillboard.com/character/${r.characterID}/`} target="_blank" rel="noreferrer"
              style={{ ...row, textDecoration: 'none', borderBottom: '1px solid var(--border)', background: i < 3 ? 'rgba(240,192,64,0.04)' : 'transparent', position: 'relative' }}>
              {/* kills-balk als subtiele achtergrond */}
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(r.kills / maxKills) * 100}%`, background: 'rgba(62,207,110,0.07)', pointerEvents: 'none' }} />
              <span style={{ width: 40, textAlign: 'center', flexShrink: 0, fontWeight: 800, fontSize: i < 3 ? '0.95rem' : '0.78rem', color: rk.c, zIndex: 1 }}>{rk.m}</span>
              <img src={`https://images.evetech.net/characters/${r.characterID}/portrait?size=32`} width={26} height={26} style={{ borderRadius: '50%', flexShrink: 0, zIndex: 1 }} alt="" />
              <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: i < 3 ? 700 : 400, zIndex: 1 }}>{r.characterName}</span>
              <span style={{ width: 60, textAlign: 'right', color: '#3ecf6e', fontWeight: 700, zIndex: 1 }}>{r.kills}</span>
              <span style={{ width: 60, textAlign: 'right', color: 'var(--red)', zIndex: 1 }}>{r.losses}</span>
              <span style={{ width: 50, textAlign: 'right', color: 'var(--text-dim)', zIndex: 1 }}>{kd(r.kills, r.losses ?? 0)}</span>
            </a>
          )
        })}
        {!loading && rows.length === 0 && !err && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>Nog geen kills deze maand.</div>}
      </div>

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Top corp-killers van deze maand (kills & losses uit zKillboard). K/D = kills ÷ losses. Klik een rij voor de zKillboard van die pilot.
      </div>
    </Layout>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem' }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.45rem 0.7rem', fontSize: '0.78rem' }
