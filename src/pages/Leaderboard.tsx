import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'
import { resolveNames, type Killmail } from '../api/esi'

const CORP_ID = 98652891   // Dutch Legions

interface TopKiller { characterID: number; characterName: string; kills: number; losses?: number }
interface ArchiveMonth { ym: string; rows: TopKiller[]; frozenAt: string }

const MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december']
const monthLabel = (ym: string) => {
  const y = ym.slice(0, 4), m = parseInt(ym.slice(4, 6), 10) - 1
  const naam = MAAND[m] ?? ''
  return `${naam.charAt(0).toUpperCase()}${naam.slice(1)} ${y}`
}

const MEDAL = (r: number) =>
  r === 1 ? { c: '#f5c518', glow: 'rgba(245,197,24,0.55)', grad: 'linear-gradient(150deg, rgba(245,197,24,0.28), rgba(245,197,24,0.04))', m: '🥇' }
  : r === 2 ? { c: '#cbd5e1', glow: 'rgba(203,213,225,0.45)', grad: 'linear-gradient(150deg, rgba(203,213,225,0.22), rgba(203,213,225,0.03))', m: '🥈' }
  : { c: '#cd7f32', glow: 'rgba(205,127,50,0.45)', grad: 'linear-gradient(150deg, rgba(205,127,50,0.24), rgba(205,127,50,0.03))', m: '🥉' }
const kd = (k: number, l: number) => l === 0 ? (k > 0 ? '∞' : '0.0') : (k / l).toFixed(1)
const kdColor = (k: number, l: number) => { const r = l === 0 ? (k > 0 ? 99 : 0) : k / l; return r >= 2 ? '#3ecf6e' : r >= 1 ? 'var(--gold)' : '#ff7676' }

export default function Leaderboard() {
  const [rows, setRows] = useState<TopKiller[]>([])
  const [archive, setArchive] = useState<ArchiveMonth[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  usePageLoading(loading)

  // Bouw de leaderboard van DEZE MAAND direct uit de kill-/loss-feed. De feed (via
  // zkill.php) bevat al de VOLLEDIGE killmails (attackers, victim, tijd) → we tellen
  // per corp-lid meteen de kills/losses, zonder elke killmail apart op te halen.
  useEffect(() => {
    let cancelled = false
    const ym = new Date().toISOString().slice(0, 7) // "2026-07"
    const getFeed = (q: string): Promise<Killmail[]> =>
      fetch(`/api/zkill.php?type=corporationID&id=${CORP_ID}&${q}`).then(r => (r.ok ? r.json() : [])).catch(() => [])

    ;(async () => {
      try {
        const [killFeed, lossFeed] = await Promise.all([getFeed('feed'), getFeed('losses')])
        if (cancelled) return

        const kills = new Map<number, number>(), losses = new Map<number, number>()
        for (const km of killFeed) {
          if (km.killmail_time?.slice(0, 7) !== ym) continue
          const seen = new Set<number>()
          for (const a of (km.attackers ?? [])) {
            if (a.corporation_id === CORP_ID && a.character_id && !seen.has(a.character_id)) {
              seen.add(a.character_id); kills.set(a.character_id, (kills.get(a.character_id) ?? 0) + 1)
            }
          }
        }
        for (const km of lossFeed) {
          if (km.killmail_time?.slice(0, 7) !== ym) continue
          const v = km.victim
          if (v?.corporation_id === CORP_ID && v.character_id) losses.set(v.character_id, (losses.get(v.character_id) ?? 0) + 1)
        }

        const ids = [...new Set([...kills.keys(), ...losses.keys()])]
        const names = await resolveNames(ids)
        if (cancelled) return
        const list: TopKiller[] = ids
          .map(id => ({ characterID: id, characterName: names.get(id) ?? `#${id}`, kills: kills.get(id) ?? 0, losses: losses.get(id) ?? 0 }))
          .filter(r => r.kills > 0) // leaderboard = killers
          .sort((a, b) => b.kills - a.kills || (a.losses ?? 0) - (b.losses ?? 0))
        if (!list.length) setErr('Nog geen kills deze maand gevonden in de feed.')
        setRows(list); setLoading(false)
      } catch {
        if (!cancelled) { setErr('Kon de killboard niet opbouwen.'); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/leaderboard_archive.php?id=${CORP_ID}`)
      .then(r => r.json())
      .then((d: { months?: ArchiveMonth[] }) => { if (!cancelled) setArchive(d?.months ?? []) })
      .catch(() => { /* archief is optioneel */ })
    return () => { cancelled = true }
  }, [])

  const maxKills = useMemo(() => Math.max(1, ...rows.map(r => r.kills)), [rows])
  const totals = useMemo(() => rows.reduce((a, r) => ({ k: a.k + r.kills, l: a.l + (r.losses ?? 0) }), { k: 0, l: 0 }), [rows])
  const podium = rows.slice(0, 3)
  const rest = rows.slice(3)

  return (
    <Layout header={<PageHeader title="Leaderboard" sub={loading ? 'killboard laden…' : `Dutch Legions · deze maand · ${rows.length} killers`} />}>
      {err && <div style={{ ...card, color: 'var(--red)', marginBottom: '1rem' }}>{err}</div>}

      {/* Gekleurde totaal-kaarten */}
      {!loading && rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.6rem', marginBottom: '1.1rem' }}>
          <Stat label="KILLS" value={totals.k} color="#3ecf6e" grad="linear-gradient(150deg, rgba(62,207,110,0.18), rgba(62,207,110,0.02))" />
          <Stat label="LOSSES" value={totals.l} color="#ff7676" grad="linear-gradient(150deg, rgba(224,85,85,0.18), rgba(224,85,85,0.02))" />
          <Stat label="K/D" value={kd(totals.k, totals.l)} color="var(--gold)" grad="linear-gradient(150deg, rgba(240,192,64,0.18), rgba(240,192,64,0.02))" />
          <Stat label="PILOTS" value={rows.length} color="var(--blue)" grad="linear-gradient(150deg, rgba(0,180,216,0.18), rgba(0,180,216,0.02))" />
        </div>
      )}

      {/* Podium top 3 */}
      {podium.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(160px, 1fr))`, gap: '0.75rem', marginBottom: '1.1rem' }}>
          {podium.map((r, i) => {
            const md = MEDAL(i + 1)
            return (
              <a key={r.characterID} href={`https://zkillboard.com/character/${r.characterID}/`} target="_blank" rel="noreferrer"
                style={{ textDecoration: 'none', background: md.grad, border: `1px solid ${md.c}`, borderRadius: 10, padding: '0.9rem 0.7rem', textAlign: 'center', position: 'relative', boxShadow: `0 0 20px ${md.glow}` }}>
                <div style={{ position: 'absolute', top: 8, left: 10, fontSize: '1.2rem' }}>{md.m}</div>
                <img src={`https://images.evetech.net/characters/${r.characterID}/portrait?size=128`} width={64} height={64}
                  style={{ borderRadius: '50%', border: `3px solid ${md.c}`, boxShadow: `0 0 14px ${md.glow}` }} alt="" />
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#fff', marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.characterName}</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 800, color: md.c, lineHeight: 1.1, marginTop: 4 }}>{r.kills}</div>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.12em' }}>KILLS</div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 6, fontSize: '0.66rem' }}>
                  <span style={{ color: '#ff7676' }}>▼ {r.losses}</span>
                  <span style={{ color: kdColor(r.kills, r.losses ?? 0), fontWeight: 700 }}>K/D {kd(r.kills, r.losses ?? 0)}</span>
                </div>
              </a>
            )
          })}
        </div>
      )}

      {/* Rest (#4+) */}
      {rest.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          {rest.map((r, idx) => {
            const rank = idx + 4 // rest begint bij de 4e plek
            return (
              <a key={r.characterID} href={`https://zkillboard.com/character/${r.characterID}/`} target="_blank" rel="noreferrer"
                style={{ ...row, textDecoration: 'none', borderBottom: idx < rest.length - 1 ? '1px solid var(--border)' : 'none', position: 'relative' }}>
                <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(r.kills / maxKills) * 100}%`, background: 'linear-gradient(90deg, rgba(0,180,216,0.12), rgba(62,207,110,0.10))', pointerEvents: 'none' }} />
                <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.74rem', color: 'var(--text-dim)', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', zIndex: 1 }}>{rank}</span>
                <img src={`https://images.evetech.net/characters/${r.characterID}/portrait?size=32`} width={26} height={26} style={{ borderRadius: '50%', flexShrink: 0, zIndex: 1 }} alt="" />
                <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', zIndex: 1 }}>{r.characterName}</span>
                <span style={{ width: 56, textAlign: 'right', color: '#3ecf6e', fontWeight: 700, zIndex: 1 }}>{r.kills}</span>
                <span style={{ width: 56, textAlign: 'right', color: '#ff7676', zIndex: 1 }}>{r.losses}</span>
                <span style={{ width: 50, textAlign: 'right', color: kdColor(r.kills, r.losses ?? 0), fontWeight: 700, zIndex: 1 }}>{kd(r.kills, r.losses ?? 0)}</span>
              </a>
            )
          })}
        </div>
      )}

      {!loading && rows.length === 0 && !err && <div style={{ ...card, textAlign: 'center', color: 'var(--text-dim)' }}>Nog geen kills deze maand.</div>}

      {/* Archief: afgelopen maanden (bevroren top 10) */}
      {archive.length > 0 && (
        <div style={{ marginTop: '1.6rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.14em', color: 'var(--text-dim)', marginBottom: '0.7rem', textTransform: 'uppercase' }}>
            📜 Afgelopen maanden
          </div>
          {archive.map((mo, mi) => (
            <ArchiveCard key={mo.ym} month={mo} defaultOpen={mi === 0} />
          ))}
        </div>
      )}

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Top corp-killers van deze maand (kills & losses uit zKillboard). K/D = kills ÷ losses (groen ≥2 · goud ≥1 · rood &lt;1). Klik een pilot voor zijn zKillboard.
        Afgelopen maanden worden aan het einde van elke maand automatisch als top-10 vastgelegd.
      </div>
    </Layout>
  )
}

// Eén afgelopen maand: inklapbare kaart met de bevroren top 10 (medailles voor top 3).
function ArchiveCard({ month, defaultOpen }: { month: ArchiveMonth; defaultOpen: boolean }) {
  const rows = [...month.rows].sort((a, b) => b.kills - a.kills).slice(0, 50)
  const winner = rows[0]
  return (
    <details open={defaultOpen} style={{ ...card, padding: 0, overflow: 'hidden', marginBottom: '0.6rem' }}>
      <summary style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0.6rem 0.8rem', cursor: 'pointer', listStyle: 'none', userSelect: 'none' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#fff' }}>{monthLabel(month.ym)}</span>
        {winner && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: 'var(--text-dim)' }}>
            🥇
            <span style={{ color: '#f5c518', fontWeight: 700 }}>{winner.characterName}</span>
            <span style={{ color: '#3ecf6e' }}>{winner.kills} kills</span>
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: 'var(--text-dim)' }}>top {rows.length}</span>
      </summary>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {rows.map((r, idx) => {
          const medal = idx < 3 ? MEDAL(idx + 1) : null
          return (
            <a key={r.characterID} href={`https://zkillboard.com/character/${r.characterID}/`} target="_blank" rel="noreferrer"
              style={{ ...row, textDecoration: 'none', borderBottom: idx < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ width: 24, textAlign: 'center', fontWeight: 800, fontSize: '0.74rem', color: medal ? medal.c : 'var(--text-dim)', flexShrink: 0 }}>{medal ? medal.m : idx + 1}</span>
              <img src={`https://images.evetech.net/characters/${r.characterID}/portrait?size=32`} width={24} height={24} style={{ borderRadius: '50%', flexShrink: 0 }} alt="" />
              <span style={{ flex: 1, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.characterName}</span>
              <span style={{ width: 50, textAlign: 'right', color: '#3ecf6e', fontWeight: 700 }}>{r.kills}</span>
              <span style={{ width: 50, textAlign: 'right', color: '#ff7676' }}>{r.losses ?? 0}</span>
              <span style={{ width: 46, textAlign: 'right', color: kdColor(r.kills, r.losses ?? 0), fontWeight: 700 }}>{kd(r.kills, r.losses ?? 0)}</span>
            </a>
          )
        })}
      </div>
    </details>
  )
}

function Stat({ label, value, color, grad }: { label: string; value: number | string; color: string; grad: string }) {
  return (
    <div style={{ background: grad, border: '1px solid var(--border)', borderRadius: 8, padding: '0.6rem 0.8rem' }}>
      <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.14em' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 800, color }}>{value}</div>
    </div>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0.5rem 0.7rem', fontSize: '0.78rem' }
