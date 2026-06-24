import { useEffect, useState } from 'react'
import { getKillmailDetail, resolveNames, type Killmail } from '../api/esi'
import EveImage from './EveImage'

const CORP_ID = 98652891   // Dutch Legions

interface ZkbKill { killmail_id: number; zkb?: { hash: string; totalValue?: number } }
interface Kod { km: Killmail; value: number }

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} mrd`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} mln`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}
function ago(iso: string) {
  const h = (Date.now() - +new Date(iso)) / 3600000
  if (h < 1) return `${Math.round(h * 60)} min geleden`
  return `${Math.round(h)} uur geleden`
}

// Grootste corp-kill (ISK) van de laatste 24 uur — compacte banner bovenaan het Dashboard.
export default function KillOfDay() {
  const [kod, setKod] = useState<Kod | null>(null)
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [systems, setSystems] = useState<Record<string, [string, number, number]>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { fetch('/systems.json').then(r => r.json()).then(setSystems).catch(() => {}) }, [])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/zkill.php?type=corporationID&id=${CORP_ID}`)
      .then(r => r.json())
      .then(async (data: { kills?: ZkbKill[] }) => {
        if (cancelled) return
        // Nieuwste 25 kills verrijken (kills-lijst is newest-first, killmail_id ~ chronologisch).
        const recent = (data?.kills ?? []).filter(k => k.zkb?.hash).slice(0, 25)
        const dayAgo = Date.now() - 24 * 3600000
        const detailed = await Promise.all(recent.map(async k => {
          const km = await getKillmailDetail(k.killmail_id, k.zkb!.hash)
          return km ? { km, value: k.zkb!.totalValue ?? 0 } : null
        }))
        if (cancelled) return
        const inDay = detailed.filter((d): d is Kod => !!d && +new Date(d.km.killmail_time) >= dayAgo)
        const best = inDay.reduce<Kod | null>((b, d) => (!b || d.value > b.value ? d : b), null)
        if (best) {
          const ids = new Set<number>([best.km.victim.ship_type_id])
          if (best.km.victim.character_id) ids.add(best.km.victim.character_id)
          if (best.km.victim.corporation_id) ids.add(best.km.victim.corporation_id)
          const fb = best.km.attackers.find(a => a.final_blow)
          if (fb?.character_id) ids.add(fb.character_id)
          const nm = await resolveNames([...ids]).catch(() => new Map<number, string>())
          if (!cancelled) setNames(nm)
        }
        if (!cancelled) { setKod(best); setLoaded(true) }
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  if (!loaded) return null
  const nameOf = (id?: number) => (id ? names.get(id) ?? `#${id}` : '—')
  const sysName = (id?: number) => (id ? systems[String(id)]?.[0] ?? `Systeem ${id}` : '—')

  // Geen kill in 24u → slanke gedempte strook (blijft vindbaar, weinig ruis).
  if (!kod) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', marginBottom: '0.75rem',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.72rem', color: 'var(--text-dim)' }}>
        🏆 <span style={{ fontWeight: 700, letterSpacing: '0.04em', color: 'var(--text)' }}>Kill van de dag</span>
        <span>— geen corp-kill in de laatste 24 uur</span>
      </div>
    )
  }

  const v = kod.km.victim
  const fb = kod.km.attackers.find(a => a.final_blow)
  return (
    <a href={`https://zkillboard.com/kill/${kod.km.killmail_id}/`} target="_blank" rel="noreferrer"
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.65rem 1rem', marginBottom: '0.75rem',
        background: 'radial-gradient(120% 160% at 8% 0%, #1d1733 0%, #0a0a22 52%, #06060f 100%)',
        border: '1px solid rgba(240,192,64,0.22)', borderRadius: 6, overflow: 'hidden', textDecoration: 'none', color: 'var(--text)' }}>
      {/* subtiele gouden gloed rechts — sluit aan bij de hero-stijl */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(55% 140% at 93% 50%, rgba(240,192,64,0.12) 0%, transparent 60%)' }} />
      <EveImage category="types" id={v.ship_type_id} variation="icon" size={64} px={46} style={{ position: 'relative', flexShrink: 0, borderRadius: 4 }} />
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <span style={{ display: 'inline-block', fontSize: '0.5rem', fontWeight: 800, letterSpacing: '0.12em', color: 'var(--gold)',
          background: 'rgba(240,192,64,0.12)', border: '1px solid rgba(240,192,64,0.3)', borderRadius: 3, padding: '0.12rem 0.42rem', marginBottom: '0.28rem' }}>
          🏆 KILL VAN DE DAG
        </span>
        <div style={{ fontSize: '0.92rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nameOf(v.ship_type_id)} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {nameOf(v.character_id)}</span>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nameOf(v.corporation_id)} · {sysName(kod.km.solar_system_id)} · {ago(kod.km.killmail_time)}
          {fb?.character_id && <> · final blow: {nameOf(fb.character_id)}</>}
        </div>
      </div>
      <div style={{ position: 'relative', textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--gold)', lineHeight: 1 }}>{fmtISK(kod.value)}</div>
        <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginTop: '0.2rem' }}>ISK</div>
      </div>
    </a>
  )
}
