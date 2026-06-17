import { useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { secColor } from '../utils/secColor'
import {
  resolveCharacterIds, resolveNames, getCharacterInfo, getCorpHistory,
  type CharacterInfo, type CorpHistoryEntry,
} from '../api/esi'
import { getCharacterStats, type ZkillStats, type ZkillTopValue } from '../api/zkillboard'

function fmtISK(v: number) {
  const abs = Math.abs(v), neg = v < 0 ? '-' : ''
  if (abs >= 1e12) return `${neg}${(abs / 1e12).toFixed(1)}T`
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}
const DAY = 86400000
function daysBetween(a: number, b: number) { return Math.max(0, Math.round((b - a) / DAY)) }
function fmtDate(s: string) { return new Date(s).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) }
// NPC-corps hebben lage id's; speler-corps zijn ≥ ~98.000.000.
const isNpcCorp = (id: number) => id < 2_000_000

interface HistRow extends CorpHistoryEntry { corpName: string; end: number | null; days: number; npc: boolean }
interface Report {
  id: number
  info: CharacterInfo
  name: string
  corpName: string
  allianceName: string | null
  ageDays: number
  history: HistRow[]
  stats: ZkillStats | null
  flags: { level: 'red' | 'orange' | 'info'; text: string }[]
  score: { label: string; color: string }
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.9rem 1rem' }
const hdr: React.CSSProperties = { fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-dim)', marginBottom: '0.5rem' }

function topByField<K extends keyof ZkillTopValue>(stats: ZkillStats | null, field: K): ZkillTopValue[] {
  const list = stats?.topLists?.find(l => l.values?.some(v => v[field] != null))
  return list?.values ?? []
}

export default function Recruiter() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<Report | null>(null)

  async function run() {
    const name = query.trim()
    if (!name) return
    setLoading(true); setError(null); setReport(null)
    try {
      const idMap = await resolveCharacterIds([name])
      const id = idMap.get(name) ?? [...idMap.values()][0]
      if (!id) { setError(`Character "${name}" niet gevonden.`); setLoading(false); return }

      const [info, histRaw, stats] = await Promise.all([
        getCharacterInfo(id),
        getCorpHistory(id).catch(() => [] as CorpHistoryEntry[]),
        getCharacterStats(id),
      ])

      // Namen resolven (alle corps in historie + huidige corp/alliance).
      const corpIds = [...new Set([info.corporation_id, ...histRaw.map(h => h.corporation_id)])]
      const nameMap = await resolveNames([...corpIds, ...(info.alliance_id ? [info.alliance_id] : [])]).catch(() => new Map<number, string>())

      // Corp-historie chronologisch + duur per corp.
      const sorted = [...histRaw].sort((a, b) => +new Date(a.start_date) - +new Date(b.start_date))
      const now = Date.now()
      const history: HistRow[] = sorted.map((h, i) => {
        const start = +new Date(h.start_date)
        const end = i < sorted.length - 1 ? +new Date(sorted[i + 1].start_date) : null
        return { ...h, corpName: nameMap.get(h.corporation_id) ?? `Corp ${h.corporation_id}`, end, days: daysBetween(start, end ?? now), npc: isNpcCorp(h.corporation_id) }
      }).reverse()  // nieuwste bovenaan

      const ageDays = daysBetween(+new Date(info.birthday), now)

      // ── Rode vlaggen ──
      const flags: Report['flags'] = []
      const yearAgo = now - 365 * DAY
      const recentMoves = sorted.filter(h => +new Date(h.start_date) > yearAgo && !isNpcCorp(h.corporation_id)).length
      const playerStays = history.filter(h => !h.npc)
      const avgStay = playerStays.length ? playerStays.reduce((s, h) => s + h.days, 0) / playerStays.length : 0

      if (recentMoves >= 5) flags.push({ level: 'red', text: `Corp-hoppen: ${recentMoves} corp-wissels in het laatste jaar` })
      else if (recentMoves >= 3) flags.push({ level: 'orange', text: `${recentMoves} corp-wissels in het laatste jaar` })
      if (avgStay > 0 && avgStay < 45 && playerStays.length >= 3) flags.push({ level: 'orange', text: `Korte gemiddelde verblijfsduur (${Math.round(avgStay)} dagen per corp)` })
      if (ageDays < 90) flags.push({ level: 'red', text: `Jong character (${ageDays} dagen oud)` })
      else if (ageDays < 365) flags.push({ level: 'orange', text: `Relatief jong character (${Math.round(ageDays / 30)} maanden)` })
      if (isNpcCorp(info.corporation_id)) flags.push({ level: 'orange', text: 'Zit nu in een NPC-corp (geparkeerd / net vertrokken)' })
      const totalPvp = (stats?.shipsDestroyed ?? 0) + (stats?.shipsLost ?? 0)
      if (stats && totalPvp < 10) flags.push({ level: 'orange', text: `Weinig PvP-footprint (${totalPvp} kills+losses op zKill)` })
      if (!stats) flags.push({ level: 'info', text: 'Geen zKillboard-data gevonden' })

      const redN = flags.filter(f => f.level === 'red').length
      const orangeN = flags.filter(f => f.level === 'orange').length
      const score = redN > 0
        ? { label: 'VERHOOGD RISICO', color: 'var(--red)' }
        : orangeN >= 2
          ? { label: 'LET OP', color: '#f0a030' }
          : { label: 'LAAG RISICO', color: 'var(--green)' }

      setReport({
        id, info, name: nameMap.get(id) ?? name,
        corpName: nameMap.get(info.corporation_id) ?? `Corp ${info.corporation_id}`,
        allianceName: info.alliance_id ? (nameMap.get(info.alliance_id) ?? null) : null,
        ageDays, history, stats, flags, score,
      })
    } catch (e) {
      setError(`Fout bij ophalen: ${(e as Error).message ?? 'onbekend'}`)
    }
    setLoading(false)
  }

  const r = report
  const ships = topByField(r?.stats ?? null, 'shipTypeID').slice(0, 6)
  const assoc = topByField(r?.stats ?? null, 'characterID').filter(v => v.characterID !== r?.info.corporation_id).slice(0, 8)
  const regions = topByField(r?.stats ?? null, 'regionID').slice(0, 5)

  return (
    <Layout header={<PageHeader title="Recruiter" sub="Vetting & veiligheidscheck (publieke data)" />}>
      <div style={{ maxWidth: 920 }}>
        {/* Zoek */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run() }}
            placeholder="Character-naam invoeren…"
            style={{ flex: 1, maxWidth: 380, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: '0.8rem', padding: '0.5rem 0.7rem', outline: 'none' }}
          />
          <button onClick={run} disabled={loading || !query.trim()}
            style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 4, color: 'var(--blue)', fontSize: '0.78rem', fontWeight: 600, padding: '0.5rem 1.1rem', cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? 'Bezig…' : 'Vetten'}
          </button>
        </div>

        {error && <div style={{ ...card, color: 'var(--red)', fontSize: '0.78rem' }}>{error}</div>}

        {r && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            {/* Kop + risico */}
            <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <a href={`https://zkillboard.com/character/${r.id}/`} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                <EveImage category="characters" id={r.id} variation="portrait" size={128} px={72} round style={{ border: '2px solid var(--border)' }} />
              </a>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>{r.name}</div>
                <div style={{ fontSize: '0.74rem', display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.15rem' }}>
                  <EveImage category="corporations" id={r.info.corporation_id} variation="logo" size={32} px={18} style={{ borderRadius: 2 }} />
                  <span style={{ color: '#f97316' }}>{r.corpName}</span>
                  {r.allianceName && r.info.alliance_id && <>
                    <EveImage category="alliances" id={r.info.alliance_id} variation="logo" size={32} px={18} style={{ borderRadius: 2 }} />
                    <span style={{ color: 'var(--blue)' }}>{r.allianceName}</span>
                  </>}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.25rem', display: 'flex', gap: '0.9rem', flexWrap: 'wrap' }}>
                  <span>Leeftijd: <strong style={{ color: 'var(--text)' }}>{r.ageDays >= 365 ? `${(r.ageDays / 365).toFixed(1)} jaar` : `${r.ageDays} dagen`}</strong></span>
                  <span>Sec: <strong style={{ color: secColor(r.info.security_status) }}>{r.info.security_status.toFixed(2)}</strong></span>
                  <span>Aangemaakt: {fmtDate(r.info.birthday)}</span>
                </div>
              </div>
              <div style={{ flexShrink: 0, textAlign: 'center' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem' }}>RISICO</div>
                <div style={{ fontSize: '0.8rem', fontWeight: 800, color: r.score.color, border: `2px solid ${r.score.color}`, borderRadius: 6, padding: '0.4rem 0.7rem' }}>{r.score.label}</div>
              </div>
            </div>

            {/* Flags */}
            <div style={card}>
              <div style={hdr}>BEVINDINGEN</div>
              {r.flags.length === 0 ? (
                <div style={{ fontSize: '0.74rem', color: 'var(--green)' }}>✓ Geen rode vlaggen gevonden.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {r.flags.map((f, i) => (
                    <div key={i} style={{ fontSize: '0.74rem', display: 'flex', gap: '0.5rem', alignItems: 'center', color: f.level === 'red' ? 'var(--red)' : f.level === 'orange' ? '#f0a030' : 'var(--text-dim)' }}>
                      <span>{f.level === 'red' ? '⛔' : f.level === 'orange' ? '⚠' : 'ℹ'}</span>{f.text}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap' }}>
              {/* zKill-stats */}
              <div style={{ ...card, flex: '1 1 360px' }}>
                <div style={hdr}>ZKILLBOARD</div>
                {r.stats ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem 1rem', fontSize: '0.74rem' }}>
                      <Stat label="Kills" value={String(r.stats.shipsDestroyed ?? 0)} color="var(--green)" />
                      <Stat label="Losses" value={String(r.stats.shipsLost ?? 0)} color="var(--red)" />
                      <Stat label="ISK vernietigd" value={fmtISK(r.stats.iskDestroyed ?? 0)} color="var(--green)" />
                      <Stat label="ISK verloren" value={fmtISK(r.stats.iskLost ?? 0)} color="var(--red)" />
                      <Stat label="Danger" value={`${r.stats.dangerRatio ?? 0}%`} color="var(--gold)" />
                      <Stat label="Gang" value={`${r.stats.gangRatio ?? 0}%`} color="var(--blue)" />
                      <Stat label="Solo kills" value={String(r.stats.soloKills ?? 0)} color="var(--text)" />
                      <Stat label="Actief (recent)" value={String(r.stats.activepvp?.kills?.count ?? 0)} color="var(--text)" />
                    </div>
                    {ships.length > 0 && (
                      <div style={{ marginTop: '0.7rem' }}>
                        <div style={{ ...hdr, marginBottom: '0.35rem' }}>MEESTGEVLOGEN SCHEPEN</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {ships.map(s => (
                            <span key={s.shipTypeID} title={`${s.shipName} — ${s.kills}`} style={{ position: 'relative' }}>
                              <EveImage category="types" id={s.shipTypeID!} variation="icon" size={64} px={34} />
                              <span style={{ position: 'absolute', right: -2, bottom: -2, fontSize: '0.5rem', fontWeight: 700, color: '#fff', background: 'rgba(0,0,0,0.75)', borderRadius: 2, padding: '0 2px' }}>{s.kills}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {regions.length > 0 && (
                      <div style={{ marginTop: '0.7rem', fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                        <span style={hdr as React.CSSProperties}>ACTIEFSTE REGIO'S</span>{' '}
                        {regions.map(rg => `${rg.regionName} (${rg.kills})`).join(' · ')}
                      </div>
                    )}
                    <a href={`https://zkillboard.com/character/${r.id}/`} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: '0.6rem', fontSize: '0.68rem', color: 'var(--blue)', textDecoration: 'none' }}>Open op zKillboard ↗</a>
                  </>
                ) : <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>Geen zKillboard-data (mogelijk nooit op een killmail verschenen).</div>}
              </div>

              {/* Associates */}
              <div style={{ ...card, flex: '1 1 280px' }}>
                <div style={hdr}>VLIEGT VAAK MET</div>
                {assoc.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {assoc.map(a => (
                      <a key={a.characterID} href={`https://zkillboard.com/character/${a.characterID}/`} target="_blank" rel="noreferrer"
                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', textDecoration: 'none', color: 'var(--text)', fontSize: '0.74rem' }}>
                        <EveImage category="characters" id={a.characterID!} variation="portrait" size={32} px={22} round style={{ flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.characterName}</span>
                        <span style={{ color: 'var(--text-dim)' }}>{a.kills}×</span>
                      </a>
                    ))}
                  </div>
                ) : <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>Geen associates gevonden.</div>}
              </div>
            </div>

            {/* Corp-historie */}
            <div style={card}>
              <div style={hdr}>CORP-HISTORIE ({r.history.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                {r.history.map(h => (
                  <div key={h.record_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0', borderBottom: '1px solid rgba(28,28,53,0.4)', fontSize: '0.72rem' }}>
                    <EveImage category="corporations" id={h.corporation_id} variation="logo" size={32} px={20} style={{ borderRadius: 2, flexShrink: 0, opacity: h.npc ? 0.5 : 1 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: h.npc ? 'var(--text-dim)' : 'var(--text)' }}>
                      {h.corpName}{h.npc && <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}> (NPC)</span>}
                    </span>
                    <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>{fmtDate(h.start_date)}{h.end === null ? ' → nu' : ''}</span>
                    <span style={{ flexShrink: 0, width: 64, textAlign: 'right', color: h.days < 30 && !h.npc ? '#f0a030' : 'var(--text-dim)' }}>{h.days}d</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
              ⚠ Indicatie op basis van publieke ESI + zKillboard. Geen bewijs van spionage — gebruik als hulpmiddel naast een gesprek/API-check.
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span style={{ fontWeight: 700, color }}>{value}</span>
    </div>
  )
}
