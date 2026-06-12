import { useState, useEffect } from 'react'
import SolarSystem from './SolarSystem'
import EveImage from './EveImage'
import { getTypesMeta } from '../api/esi'

export interface KillEntry {
  id: number
  ship: string
  shipTypeId: number
  victimCharId?: number
  victimCharName?: string
  victimCorpId?: number
  victimCorpName?: string
  victimAllianceId?: number
  victimAllianceName?: string
  finalBlowCharId?: number
  finalBlowCharName?: string
  finalBlowCorpId?: number
  finalBlowCorpName?: string
  finalBlowAllianceId?: number
  finalBlowAllianceName?: string
  type: 'kill' | 'loss'
  solo?: boolean
  isk: number
  system: string
  systemId?: number
  time: Date | null
}

interface Props {
  entries: KillEntry[]
  characterId?: number
  loading?: boolean
}

const META_BADGE: Record<number, { label: string; color: string }> = {
  2:  { label: 'T2',      color: '#00b4d8' },
  3:  { label: 'Story',   color: '#a78bfa' },
  4:  { label: 'Faction', color: '#f0c040' },
  5:  { label: 'Officer', color: '#f97316' },
  6:  { label: 'DS',      color: '#e05555' },
  14: { label: 'T3',      color: '#3ecf6e' },
  15: { label: 'T3D',     color: '#3ecf6e' },
}

function MetaBadge({ metaId }: { metaId?: number }) {
  if (!metaId || !META_BADGE[metaId]) return null
  const { label, color } = META_BADGE[metaId]
  return (
    <span style={{
      display: 'inline-block', padding: '0.05rem 0.28rem',
      borderRadius: 2, fontSize: '0.54rem', fontWeight: 800, lineHeight: 1.5,
      background: `${color}22`, border: `1px solid ${color}55`, color,
      letterSpacing: '0.03em', flexShrink: 0,
    }}>
      {label}
    </span>
  )
}

const TH: React.CSSProperties = {
  fontSize: '0.65rem', color: 'var(--text-dim)', fontWeight: 700,
  letterSpacing: '0.12em', padding: '0.5rem 1rem', textAlign: 'left',
}
const TD: React.CSSProperties = {
  padding: '0.75rem 1rem', borderTop: '1px solid rgba(28,28,53,0.5)', verticalAlign: 'middle',
}

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  return `${(v / 1e3).toFixed(2)}K`
}

function fmtTime(d: Date | null): string {
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m geleden`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}u geleden`
  return `${Math.floor(h / 24)}d geleden`
}

function EntityStack({
  charId, charName, corpId, corpName, allianceId, allianceName,
}: {
  charId?: number; charName?: string
  corpId?: number; corpName?: string
  allianceId?: number; allianceName?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', minWidth: 0 }}>
      {charId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <EveImage category="characters" id={charId} variation="portrait" size={64} px={40} round />
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charName}</span>
        </div>
      )}
      {corpId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <EveImage category="corporations" id={corpId} variation="logo" size={32} px={28} />
          <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{corpName}</span>
        </div>
      )}
      {allianceId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <EveImage category="alliances" id={allianceId} variation="logo" size={32} px={28} />
          <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{allianceName}</span>
        </div>
      )}
    </div>
  )
}

export default function KillsTable({ entries, characterId, loading }: Props) {
  const kills  = entries.filter(e => e.type === 'kill').length
  const losses = entries.filter(e => e.type === 'loss').length

  const [metaMap, setMetaMap] = useState(new Map<number, number>())
  useEffect(() => {
    const ids = [...new Set(entries.map(e => e.shipTypeId).filter(Boolean))]
    if (ids.length === 0) return
    getTypesMeta(ids).then(setMetaMap)
  }, [entries.map(e => e.shipTypeId).join(',')])

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ padding: '0.7rem 0.875rem 0.4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.18em' }}>RECENTE KILLS & LOSSES</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
            {loading ? 'Laden...' : `${kills}K / ${losses}L`}
          </span>
          {characterId && (
            <a
              href={`https://zkillboard.com/character/${characterId}/`}
              target="_blank"
              rel="noreferrer"
              title="zkillboard"
              style={{ display: 'flex', alignItems: 'center', opacity: 0.6, transition: 'opacity 0.15s' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
            >
              <img src="https://zkillboard.com/favicon.ico" alt="zkillboard" style={{ width: 14, height: 14 }} />
            </a>
          )}
        </div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderTop: '1px solid var(--border)' }}>
            {['Tijd', 'Ship', 'Systeem', 'Victim', 'Final Blow'].map(h => (
              <th key={h} style={TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && !loading && (
            <tr><td colSpan={5} style={{ ...TD, color: 'var(--text-dim)', textAlign: 'center', padding: '1.5rem' }}>Geen recente kills</td></tr>
          )}
          {entries.map((k, i) => (
            <tr
              key={k.id}
              onClick={() => window.open(`https://zkillboard.com/kill/${k.id}/`, '_blank')}
              style={{ background: i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,180,216,0.05)')}
              onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 1 ? 'rgba(15,15,34,0.5)' : 'transparent')}
            >
              {/* Time + ISK */}
              <td style={{ ...TD, minWidth: 90 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
                  <span style={{ fontSize: '1.1rem', color: k.type === 'kill' ? 'var(--green)' : 'var(--red)', lineHeight: 1 }}>
                    {k.type === 'kill' ? '✓' : '✗'}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{fmtTime(k.time)}</span>
                  {k.solo && (
                    <span style={{
                      padding: '0.05rem 0.28rem', borderRadius: 2, fontSize: '0.54rem',
                      fontWeight: 800, lineHeight: 1.5, background: '#f0c04022',
                      border: '1px solid #f0c04055', color: '#f0c040', letterSpacing: '0.03em',
                    }}>SOLO</span>
                  )}
                </div>
                <div style={{ fontSize: '0.8rem', color: k.type === 'kill' ? 'var(--green)' : 'var(--red)', fontWeight: 700, paddingLeft: '1.35rem' }}>
                  {fmtISK(k.isk)}
                </div>
              </td>

              {/* Ship */}
              <td style={TD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <EveImage category="types" id={k.shipTypeId} variation="icon" size={64} px={58} />
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#f8fafc' }}>{k.ship}</span>
                      <MetaBadge metaId={metaMap.get(k.shipTypeId)} />
                    </div>
                  </div>
                </div>
              </td>

              {/* System */}
              <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                <SolarSystem name={k.system} systemId={k.systemId} fontSize="0.78rem" />
              </td>

              {/* Victim */}
              <td style={TD}>
                <EntityStack
                  charId={k.victimCharId} charName={k.victimCharName}
                  corpId={k.victimCorpId} corpName={k.victimCorpName}
                  allianceId={k.victimAllianceId} allianceName={k.victimAllianceName}
                />
              </td>

              {/* Final Blow */}
              <td style={TD}>
                <EntityStack
                  charId={k.finalBlowCharId} charName={k.finalBlowCharName}
                  corpId={k.finalBlowCorpId} corpName={k.finalBlowCorpName}
                  allianceId={k.finalBlowAllianceId} allianceName={k.finalBlowAllianceName}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
