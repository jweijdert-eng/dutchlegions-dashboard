import { useEffect, useMemo, useState } from 'react'
import { getKillmailDetail, resolveNames, type Killmail } from '../api/esi'
import { secColor } from '../utils/secColor'

const CORP_ID = 98652891       // Dutch Legions
const ALLIANCE_ID = 99013537   // Insidious

interface ZkbKill { killmail_id: number; zkb?: { hash: string; totalValue?: number } }
interface FeedItem { km: Killmail; value: number; loss: boolean }

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}b`
  if (v >= 1e6) return `${Math.round(v / 1e6)}m`
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`
  return `${Math.round(v)}`
}
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - +new Date(iso)) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}u`
  return `${Math.round(s / 86400)}d`
}

export default function KillFeed({ systems }: { systems: Record<string, [string, number, number]> }) {
  const [scope, setScope] = useState<'corp' | 'alliance'>('corp')
  const [items, setItems] = useState<FeedItem[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setItems([])
    const type = scope === 'corp' ? 'corporationID' : 'allianceID'
    const id = scope === 'corp' ? CORP_ID : ALLIANCE_ID
    const ownId = id
    fetch(`/api/zkill.php?feed=1&type=${type}&id=${id}`)
      .then(r => r.json())
      .then(async (list: ZkbKill[]) => {
        if (!Array.isArray(list)) { setLoading(false); return }
        const recent = list.filter(k => k.zkb?.hash).slice(0, 14)
        const out: FeedItem[] = []
        for (const k of recent) {
          const km = await getKillmailDetail(k.killmail_id, k.zkb!.hash)
          if (!km) continue
          const loss = scope === 'corp' ? km.victim.corporation_id === ownId : km.victim.alliance_id === ownId
          out.push({ km, value: k.zkb!.totalValue ?? 0, loss })
        }
        if (cancelled) return
        const ids = new Set<number>()
        for (const it of out) {
          ids.add(it.km.victim.ship_type_id)
          if (it.km.victim.character_id) ids.add(it.km.victim.character_id)
          if (it.km.victim.corporation_id) ids.add(it.km.victim.corporation_id)
          const fb = it.km.attackers.find(a => a.final_blow)
          if (fb?.character_id) ids.add(fb.character_id)
        }
        const nm = await resolveNames([...ids]).catch(() => new Map<number, string>())
        if (cancelled) return
        setNames(nm); setItems(out); setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [scope])

  const nameOf = (id?: number) => (id ? names.get(id) ?? `#${id}` : '—')
  const sysName = (id: number) => systems[String(id)]?.[0] ?? `${id}`
  const sysSec = (id: number) => systems[String(id)]?.[1] ?? 0
  const stats = useMemo(() => ({ kills: items.filter(i => !i.loss).length, losses: items.filter(i => i.loss).length }), [items])

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: 760, minWidth: 250 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.7rem', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
        <span style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text)' }}>⚔️ KILLS & LOSSES</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['corp', 'alliance'] as const).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{
              padding: '2px 8px', borderRadius: 10, fontSize: '0.58rem', cursor: 'pointer',
              border: `1px solid ${scope === s ? 'var(--blue)' : 'var(--border)'}`,
              background: scope === s ? 'rgba(0,180,216,0.16)' : 'transparent', color: scope === s ? '#fff' : 'var(--text-dim)',
            }}>{s === 'corp' ? 'Corp' : 'Alli'}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: '0.3rem 0.7rem', borderBottom: '1px solid var(--border)', fontSize: '0.58rem', color: 'var(--text-dim)' }}>
        {loading ? 'laden…' : <><span style={{ color: '#3ecf6e' }}>{stats.kills} kills</span> · <span style={{ color: 'var(--red)' }}>{stats.losses} losses</span></>}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {items.map(it => {
          const fb = it.km.attackers.find(a => a.final_blow)
          const col = it.loss ? '#e05555' : '#3ecf6e'
          const sec = sysSec(it.km.solar_system_id)
          return (
            <a key={it.km.killmail_id} href={`https://zkillboard.com/kill/${it.km.killmail_id}/`} target="_blank" rel="noreferrer"
              style={{ display: 'block', textDecoration: 'none', borderLeft: `3px solid ${col}`, borderBottom: '1px solid var(--border)', padding: '0.4rem 0.6rem', background: it.loss ? 'rgba(224,85,85,0.06)' : 'rgba(62,207,110,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700 }}>
                  <span style={{ color: secColor(sec) }}>{(Math.round(sec * 10) / 10).toFixed(1)}</span>{' '}
                  <span style={{ color: '#fff' }}>{sysName(it.km.solar_system_id)}</span>
                </span>
                <span style={{ fontSize: '0.55rem', color: 'var(--text-dim)' }}>{ago(it.km.killmail_time)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <img src={`https://images.evetech.net/types/${it.km.victim.ship_type_id}/icon?size=32`} width={26} height={26} style={{ borderRadius: 3, flexShrink: 0 }} alt="" />
                {it.km.victim.character_id
                  ? <img src={`https://images.evetech.net/characters/${it.km.victim.character_id}/portrait?size=32`} width={26} height={26} style={{ borderRadius: '50%', flexShrink: 0 }} alt="" />
                  : null}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.66rem', color: col, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.loss ? '▼ ' : '▲ '}{nameOf(it.km.victim.ship_type_id)}
                  </div>
                  <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {nameOf(it.km.victim.character_id)} · {fmtISK(it.value)}
                  </div>
                </div>
              </div>
              {!it.loss && fb?.character_id && (
                <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  final blow: {nameOf(fb.character_id)}
                </div>
              )}
            </a>
          )
        })}
        {!loading && items.length === 0 && <div style={{ padding: '1.5rem 0.7rem', fontSize: '0.62rem', color: 'var(--text-dim)', textAlign: 'center' }}>Geen recente killmails.</div>}
      </div>
    </div>
  )
}
