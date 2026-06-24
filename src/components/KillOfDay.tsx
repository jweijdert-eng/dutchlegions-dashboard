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

// Trofee-icoon (SVG i.p.v. emoji → consistent op elk systeem, erft de tekstkleur).
function TrophyIcon({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  )
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
        <span style={{ color: 'var(--gold)', display: 'inline-flex' }}><TrophyIcon size={13} /></span>
        <span style={{ fontWeight: 700, letterSpacing: '0.04em', color: 'var(--text)' }}>Kill van de dag</span>
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.5rem', fontWeight: 800, letterSpacing: '0.12em', color: 'var(--gold)',
          background: 'rgba(240,192,64,0.12)', border: '1px solid rgba(240,192,64,0.3)', borderRadius: 3, padding: '0.14rem 0.45rem', marginBottom: '0.28rem' }}>
          <TrophyIcon size={10} />
          KILL VAN DE DAG
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', fontWeight: 700, minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>{nameOf(v.ship_type_id)}</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, flexShrink: 0 }}>·</span>
          {v.character_id && <EveImage category="characters" id={v.character_id} variation="portrait" size={32} px={18} style={{ borderRadius: '50%', flexShrink: 0 }} />}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(v.character_id)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.18rem', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{nameOf(v.corporation_id)} · {sysName(kod.km.solar_system_id)} · {ago(kod.km.killmail_time)}</span>
          {fb?.character_id && <>
            <span style={{ flexShrink: 0 }}>· final blow:</span>
            <EveImage category="characters" id={fb.character_id} variation="portrait" size={32} px={15} style={{ borderRadius: '50%', flexShrink: 0 }} />
            <span style={{ flexShrink: 0 }}>{nameOf(fb.character_id)}</span>
          </>}
        </div>
      </div>
      <div style={{ position: 'relative', textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--gold)', lineHeight: 1 }}>{fmtISK(kod.value)}</div>
        <div style={{ fontSize: '0.55rem', color: 'var(--text-dim)', letterSpacing: '0.1em', marginTop: '0.2rem' }}>ISK</div>
      </div>
    </a>
  )
}
