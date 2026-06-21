import { useEffect, useState } from 'react'

const CORP_ID = 98652891   // Dutch Legions

interface TopKiller { characterID: number; characterName: string; kills: number }

// Scrollende balk met de top killers van de corp (uit zkill.php). Pauzeert bij hover.
export default function TopKillersTicker() {
  const [killers, setKillers] = useState<TopKiller[]>([])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/zkill.php?type=corporationID&id=${CORP_ID}`)
      .then(r => r.json())
      .then((d: { topKillers?: TopKiller[] }) => { if (!cancelled) setKillers((d?.topKillers ?? []).slice(0, 10)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!killers.length) return null
  const loop = [...killers, ...killers]  // dupliceren → naadloze loop bij translateX(-50%)
  const dur = Math.max(20, killers.length * 4.5)

  return (
    <div className="tk-bar" style={{
      display: 'flex', alignItems: 'center', overflow: 'hidden', marginBottom: '0.5rem',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3,
    }}>
      <style>{`
        @keyframes tk-scroll { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        .tk-bar:hover .tk-track { animation-play-state: paused }
      `}</style>
      <span style={{
        flexShrink: 0, padding: '0.3rem 0.7rem', fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em',
        color: 'var(--gold)', borderRight: '1px solid var(--border)', background: 'rgba(240,160,48,0.08)', whiteSpace: 'nowrap',
      }}>⚔️ TOP KILLERS</span>
      <div style={{ overflow: 'hidden', flex: 1 }}>
        <div className="tk-track" style={{ display: 'inline-flex', alignItems: 'center', animation: `tk-scroll ${dur}s linear infinite`, willChange: 'transform' }}>
          {loop.map((k, i) => {
            const rank = (i % killers.length) + 1
            return (
              <a key={i} href={`https://zkillboard.com/character/${k.characterID}/`} target="_blank" rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.25rem 0.85rem', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: '0.66rem', fontWeight: 800, color: rank === 1 ? 'var(--gold)' : 'var(--text-dim)' }}>#{rank}</span>
                <img src={`https://images.evetech.net/characters/${k.characterID}/portrait?size=32`} width={20} height={20} style={{ borderRadius: '50%' }} alt="" />
                <span style={{ fontSize: '0.72rem', color: '#fff' }}>{k.characterName}</span>
                <span style={{ fontSize: '0.64rem', color: '#3ecf6e', fontWeight: 700 }}>{k.kills}</span>
                <span style={{ color: 'var(--border)', marginLeft: 4 }}>·</span>
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}
