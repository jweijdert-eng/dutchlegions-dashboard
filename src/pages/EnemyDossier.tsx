import { useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { getKillmailDetail, resolveNames } from '../api/esi'
import { getCorpLossesViaProxy } from '../api/zkillboard'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

const CORP_ID = 98652891   // Dutch Legions
const SAMPLE = 80          // hoeveel recente losses we analyseren

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} mrd`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} mln`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}
function agoStr(t: number) {
  const d = (Date.now() - t) / 86400000
  if (d < 1) return `${Math.round(d * 24)}u geleden`
  return `${Math.round(d)}d geleden`
}
// NPC-corps (rats/CONCORD/faction) vallen in dit id-bereik → uit het dossier.
const isNpcCorp = (id?: number) => id != null && id >= 1000000 && id < 2000000

interface Enemy {
  corpId: number
  allianceId?: number
  kills: number              // aantal van onze losses waar ze bij waren
  isk: number                // ISK van ons die ze vernietigden
  last: number               // laatste keer (ms)
  hours: number[]            // 24-uurs histogram (UTC)
  ships: Map<number, number> // ship_type_id → aantal
}

// Piek-tijdvenster (3 aaneengesloten UTC-uren met de meeste activiteit).
function peakWindow(hours: number[]): string {
  let best = -1, bestH = 0
  for (let h = 0; h < 24; h++) {
    const s = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24]
    if (s > best) { best = s; bestH = h }
  }
  if (best <= 0) return '—'
  const end = (bestH + 3) % 24
  return `${String(bestH).padStart(2, '0')}–${String(end).padStart(2, '0')} UTC`
}

function HourBars({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 26 }}>
      {hours.map((c, h) => (
        <div key={h} title={`${String(h).padStart(2, '0')}:00 UTC · ${c}×`}
          style={{ flex: 1, height: `${Math.max(c ? 12 : 0, (c / max) * 100)}%`,
            background: c ? 'var(--red)' : 'rgba(255,255,255,0.05)', borderRadius: 1, minHeight: 2 }} />
      ))}
    </div>
  )
}

export default function EnemyDossier() {
  const [enemies, setEnemies] = useState<Enemy[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [stats, setStats] = useState({ losses: 0, isk: 0 })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  usePageLoading(loading)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr('')
    getCorpLossesViaProxy(CORP_ID).then(async raw => {
      if (cancelled) return
      const list = raw.filter(k => k.zkb?.hash).slice(0, SAMPLE)
      if (!list.length) { setErr('Geen recente losses gevonden op zKillboard.'); setLoading(false); return }
      const valueOf = new Map(list.map(k => [k.killmail_id, k.zkb.totalValue ?? 0]))
      const detailed = await Promise.all(list.map(k => getKillmailDetail(k.killmail_id, k.zkb.hash)))
      if (cancelled) return

      const map = new Map<number, Enemy>()
      let totalIsk = 0, lossCount = 0
      for (const km of detailed) {
        if (!km) continue
        lossCount++
        const value = valueOf.get(km.killmail_id) ?? 0
        totalIsk += value
        const hour = new Date(km.killmail_time).getUTCHours()
        const t = +new Date(km.killmail_time)
        const seenCorp = new Set<number>()
        for (const a of km.attackers) {
          const cid = a.corporation_id
          if (cid == null || cid === CORP_ID || isNpcCorp(cid)) continue
          let e = map.get(cid)
          if (!e) { e = { corpId: cid, allianceId: a.alliance_id, kills: 0, isk: 0, last: 0, hours: new Array(24).fill(0), ships: new Map() }; map.set(cid, e) }
          if (a.alliance_id && !e.allianceId) e.allianceId = a.alliance_id
          if (a.ship_type_id) e.ships.set(a.ship_type_id, (e.ships.get(a.ship_type_id) ?? 0) + 1)
          if (!seenCorp.has(cid)) {   // per killmail één keer tellen voor kills/isk/uur
            seenCorp.add(cid)
            e.kills++; e.isk += value; e.hours[hour]++
            if (t > e.last) e.last = t
          }
        }
      }
      const ranked = [...map.values()].sort((a, b) => b.kills - a.kills || b.isk - a.isk).slice(0, 20)
      const ids = new Set<number>()
      for (const e of ranked) {
        ids.add(e.corpId); if (e.allianceId) ids.add(e.allianceId)
        ;[...e.ships.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([sid]) => ids.add(sid))
      }
      const nm = await resolveNames([...ids]).catch(() => new Map<number, string>())
      if (cancelled) return
      setNames(nm); setEnemies(ranked); setStats({ losses: lossCount, isk: totalIsk }); setLoading(false)
    }).catch(() => { if (!cancelled) { setErr('Kon zKillboard niet bereiken.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const nameOf = (id?: number) => (id ? names.get(id) ?? `#${id}` : '—')
  const maxKills = enemies[0]?.kills ?? 1

  return (
    <Layout header={<PageHeader title="Vijand-dossier"
      sub={loading ? 'zKillboard laden…' : `${stats.losses} losses geanalyseerd · ${fmtISK(stats.isk)} ISK verloren · ${enemies.length} vijand-corps`} />}>

      {err && <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '1rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>{err}</div>}

      {!loading && !err && enemies.length > 0 && (
        <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginBottom: '0.8rem', lineHeight: 1.5 }}>
          Corps die jullie het vaakst hebben gekild (uit de laatste {stats.losses} corp-losses). Activiteitsbalken in <b>UTC</b> → schat de tijdzone in.
        </div>
      )}

      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {enemies.map((e, i) => {
          const topShips = [...e.ships.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          return (
            <div key={e.corpId} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.7rem 0.9rem',
              display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '0.85rem', alignItems: 'center' }}>

              {/* rang + corp-logo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ width: 20, textAlign: 'right', fontSize: '0.8rem', fontWeight: 800, color: i < 3 ? 'var(--gold)' : 'var(--text-dim)' }}>{i + 1}</span>
                <a href={`https://zkillboard.com/corporation/${e.corpId}/`} target="_blank" rel="noreferrer">
                  <EveImage category="corporations" id={e.corpId} variation="logo" size={48} px={40} style={{ borderRadius: 4, display: 'block' }} />
                </a>
              </div>

              {/* naam + alliance + schepen + activiteit */}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(e.corpId)}</div>
                <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginBottom: '0.35rem' }}>
                  {e.allianceId ? nameOf(e.allianceId) : 'geen alliance'} · laatst {agoStr(e.last)} · piek {peakWindow(e.hours)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    {topShips.length === 0 && <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>geen schipdata</span>}
                    {topShips.map(([sid, n]) => (
                      <span key={sid} title={`${nameOf(sid)} · ${n}×`} style={{ display: 'inline-flex', alignItems: 'center' }}>
                        <EveImage category="types" id={sid} variation="icon" size={32} px={24} style={{ borderRadius: 3 }} />
                      </span>
                    ))}
                  </div>
                  <div style={{ flex: 1, minWidth: 120, maxWidth: 320 }}><HourBars hours={e.hours} /></div>
                </div>
              </div>

              {/* stats */}
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--red)', lineHeight: 1 }}>{e.kills}×</div>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.08em', margin: '0.15rem 0 0.3rem' }}>TEGEN ONS</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{fmtISK(e.isk)} ISK</div>
                {/* dreigingsbalk t.o.v. de #1 */}
                <div style={{ height: 3, width: 70, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginTop: '0.35rem', marginLeft: 'auto' }}>
                  <div style={{ height: '100%', width: `${Math.max(6, (e.kills / maxKills) * 100)}%`, background: 'var(--red)', borderRadius: 2 }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </Layout>
  )
}
