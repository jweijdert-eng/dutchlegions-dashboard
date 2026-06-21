import { useEffect, useRef, useState } from 'react'

const CORP_ID = 98652891   // Dutch Legions
const POS_KEY = 'tk_ticker_pos'
const SNAP_KEY = 'tk_kills_snapshot'   // vorige kill-stand per character → "nieuwe kill"-pijltje

interface TopKiller { characterID: number; characterName: string; kills: number; losses?: number }
interface Pos { top: number; left: number }

// #1 goud, #2 zilver, #3 brons, rest gedimd.
const rankColor = (r: number) => r === 1 ? '#f5c518' : r === 2 ? '#cbd5e1' : r === 3 ? '#cd7f32' : 'var(--text-dim)'

function loadPos(): Pos | null {
  try { const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); return p && typeof p.top === 'number' ? p : null } catch { return null }
}

// Scrollende balk met de top killers van de corp (uit zkill.php). Pauzeert bij hover.
// floating=true → zwevend + versleepbaar (positie onthouden per browser).
export default function TopKillersTicker({ floating = false }: { floating?: boolean }) {
  const [killers, setKillers] = useState<TopKiller[]>([])
  const [upIds, setUpIds] = useState<Set<number>>(new Set())   // killers met een nieuwe kill
  const [pos, setPos] = useState<Pos | null>(floating ? loadPos() : null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/zkill.php?type=corporationID&id=${CORP_ID}`)
      .then(r => r.json())
      .then((d: { topKillers?: TopKiller[] }) => {
        if (cancelled) return
        const list = (d?.topKillers ?? []).slice(0, 10)
        try {
          // Vergelijk met de vorige stand: meer kills dan toen → groen pijltje.
          const snap = JSON.parse(localStorage.getItem(SNAP_KEY) || '{}') as Record<string, number>
          const ups = new Set<number>()
          for (const k of list) { const prev = snap[k.characterID]; if (prev != null && k.kills > prev) ups.add(k.characterID) }
          setUpIds(ups)
          const next: Record<string, number> = {}
          for (const k of list) next[k.characterID] = k.kills
          localStorage.setItem(SNAP_KEY, JSON.stringify(next))
        } catch { /* ignore */ }
        setKillers(list)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Standaardpositie (bovenaan, gecentreerd) als er nog niets opgeslagen is.
  useEffect(() => {
    if (floating && !pos) setPos({ top: 70, left: Math.max(12, Math.round(window.innerWidth / 2 - 320)) })
  }, [floating, pos])

  const onPointerDown = (e: React.PointerEvent) => {
    if (!floating || !pos) return
    e.preventDefault()
    dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top }
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return
      const left = Math.min(Math.max(4, ev.clientX - dragRef.current.dx), window.innerWidth - 120)
      const top  = Math.min(Math.max(4, ev.clientY - dragRef.current.dy), window.innerHeight - 30)
      setPos({ top, left })
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setPos(p => { if (p) localStorage.setItem(POS_KEY, JSON.stringify(p)); return p })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!killers.length) return null
  const loop = [...killers, ...killers]  // dupliceren → naadloze loop bij translateX(-50%)
  const dur = Math.max(20, killers.length * 4.5)

  const wrapStyle: React.CSSProperties = floating
    ? { position: 'fixed', top: pos?.top ?? 70, left: pos?.left ?? 12, zIndex: 120, width: 'min(640px, 94vw)', boxShadow: '0 6px 24px rgba(0,0,0,0.5)' }
    : { marginBottom: '0.5rem' }

  return (
    <div className="tk-bar" style={{
      display: 'flex', alignItems: 'center', overflow: 'hidden',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, ...wrapStyle,
    }}>
      <style>{`
        @keyframes tk-scroll { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        .tk-bar:hover .tk-track { animation-play-state: paused }
      `}</style>
      <span
        onPointerDown={onPointerDown}
        title={floating ? 'Sleep om te verplaatsen' : undefined}
        style={{
          flexShrink: 0, padding: '0.3rem 0.7rem', fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em',
          color: 'var(--gold)', borderRight: '1px solid var(--border)', background: 'rgba(240,160,48,0.08)', whiteSpace: 'nowrap',
          cursor: floating ? 'grab' : 'default', userSelect: 'none', touchAction: 'none',
        }}>{floating ? '⠿ ' : ''}⚔️ TOP KILLERS · DEZE MAAND</span>
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div className="tk-track" style={{ display: 'inline-flex', alignItems: 'center', animation: `tk-scroll ${dur}s linear infinite`, willChange: 'transform' }}>
          {loop.map((k, i) => {
            const rank = (i % killers.length) + 1
            return (
              <a key={i} href={`https://zkillboard.com/character/${k.characterID}/`} target="_blank" rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.25rem 0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: '0.66rem', fontWeight: 800, color: rankColor(rank) }}>#{rank}</span>
                <img src={`https://images.evetech.net/characters/${k.characterID}/portrait?size=32`} width={20} height={20} style={{ borderRadius: '50%' }} alt="" />
                <span style={{ fontSize: '0.72rem', color: '#fff' }}>{k.characterName}</span>
                <span title="kills" style={{ fontSize: '0.64rem', color: '#3ecf6e', fontWeight: 700 }}>▲{k.kills}</span>
                {upIds.has(k.characterID) && <span title="nieuwe kill sinds je vorige bezoek" style={{ fontSize: '0.6rem', color: '#3ecf6e' }}>↑</span>}
                {k.losses != null && <span title="losses (totaal)" style={{ fontSize: '0.64rem', color: 'var(--red)', fontWeight: 700 }}>▼{k.losses}</span>}
                <span style={{ color: 'var(--border)', marginLeft: 4 }}>·</span>
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}
