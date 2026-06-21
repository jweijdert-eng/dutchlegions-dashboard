import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { getKillmailDetail, resolveNames, type Killmail } from '../api/esi'
import { usePageLoading } from '../hooks/usePageLoading'

const CORP_ID = 98652891       // Dutch Legions
const ALLIANCE_ID = 99013537   // Insidious
const WEEK_MS = 7 * 24 * 3600 * 1000

interface ZkbKill { killmail_id: number; zkb?: { hash: string; totalValue?: number } }
interface Enriched { km: Killmail; value: number; hash: string }

function fmtISK(v: number) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} mrd`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} mln`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return `${Math.round(v)}`
}
function ago(iso: string) {
  const h = (Date.now() - +new Date(iso)) / 3600000
  if (h < 1) return `${Math.round(h * 60)} min geleden`
  if (h < 24) return `${Math.round(h)} uur geleden`
  return `${Math.round(h / 24)} dagen geleden`
}

export default function KillOfWeek() {
  const [scope, setScope] = useState<'corp' | 'alliance'>('corp')
  const [kills, setKills] = useState<Enriched[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [systems, setSystems] = useState<Record<string, [string, number, number]>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  usePageLoading(loading)

  useEffect(() => { fetch('/systems.json').then(r => r.json()).then(setSystems).catch(() => {}) }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(''); setKills([])
    const type = scope === 'corp' ? 'corporationID' : 'allianceID'
    const id = scope === 'corp' ? CORP_ID : ALLIANCE_ID
    fetch(`/api/zkill.php?type=${type}&id=${id}`)
      .then(r => r.json())
      .then(async (list: ZkbKill[]) => {
        if (!Array.isArray(list)) { setErr('zKillboard gaf geen lijst terug.'); setLoading(false); return }
        // sorteer op waarde, verrijk de top met ESI-killmaildetails
        const top = list.filter(k => k.zkb?.hash).sort((a, b) => (b.zkb!.totalValue ?? 0) - (a.zkb!.totalValue ?? 0)).slice(0, 14)
        const detailed: Enriched[] = []
        for (const k of top) {
          const km = await getKillmailDetail(k.killmail_id, k.zkb!.hash)
          if (km) detailed.push({ km, value: k.zkb!.totalValue ?? 0, hash: k.zkb!.hash })
        }
        if (cancelled) return
        // hou kills van de laatste 7 dagen; val terug op recent als er geen zijn
        const recent = detailed.filter(d => Date.now() - +new Date(d.km.killmail_time) <= WEEK_MS)
        const final = (recent.length ? recent : detailed).slice(0, 6)
        // namen oplossen
        const ids = new Set<number>()
        for (const d of final) {
          ids.add(d.km.victim.ship_type_id)
          if (d.km.victim.character_id) ids.add(d.km.victim.character_id)
          if (d.km.victim.corporation_id) ids.add(d.km.victim.corporation_id)
          const fb = d.km.attackers.find(a => a.final_blow)
          if (fb?.character_id) ids.add(fb.character_id)
        }
        const nm = await resolveNames([...ids]).catch(() => new Map<number, string>())
        if (cancelled) return
        setNames(nm); setKills(final); setLoading(false)
      })
      .catch(() => { if (!cancelled) { setErr('Kon zKillboard niet bereiken.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [scope])

  const nameOf = (id?: number) => (id ? names.get(id) ?? `#${id}` : '—')
  const sysName = (id: number) => systems[String(id)]?.[0] ?? `Systeem ${id}`
  const top = kills[0]
  const rest = useMemo(() => kills.slice(1), [kills])

  return (
    <Layout header={<PageHeader title="Kill of the Week" sub={loading ? 'zKillboard laden…' : `top ${kills.length} · ${scope === 'corp' ? 'Dutch Legions' : 'Insidious'}`} />}>
      <div style={{ display: 'flex', gap: 8, marginBottom: '1rem' }}>
        {(['corp', 'alliance'] as const).map(s => (
          <button key={s} onClick={() => setScope(s)} style={pill(scope === s)}>{s === 'corp' ? 'Corp' : 'Alliance'}</button>
        ))}
      </div>

      {err && <div style={{ ...card, color: 'var(--red)' }}>{err}</div>}
      {!loading && !err && kills.length === 0 && <div style={card}>Geen kills gevonden voor {scope === 'corp' ? 'de corp' : 'de alliance'}.</div>}

      {top && (
        <a href={`https://zkillboard.com/kill/${top.km.killmail_id}/`} target="_blank" rel="noreferrer"
          style={{ ...card, display: 'block', textDecoration: 'none', borderColor: 'var(--gold)', marginBottom: '1rem', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 10, right: 12, fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.16em', color: 'var(--gold)' }}>🏆 KILL VAN DE WEEK</div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <img src={`https://images.evetech.net/types/${top.km.victim.ship_type_id}/render?size=128`} width={96} height={96} style={{ borderRadius: 6, flexShrink: 0 }} alt="" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--gold)' }}>{fmtISK(top.value)} ISK</div>
              <div style={{ fontSize: '0.9rem', color: '#fff', marginTop: 2 }}>{nameOf(top.km.victim.ship_type_id)}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 4 }}>
                {nameOf(top.km.victim.character_id)} · {sysName(top.km.solar_system_id)} · {top.km.attackers.length} aanvallers
              </div>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-dim)', marginTop: 2 }}>
                final blow: {nameOf(top.km.attackers.find(a => a.final_blow)?.character_id)} · {ago(top.km.killmail_time)}
              </div>
            </div>
          </div>
        </a>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.75rem' }}>
        {rest.map(d => (
          <a key={d.km.killmail_id} href={`https://zkillboard.com/kill/${d.km.killmail_id}/`} target="_blank" rel="noreferrer"
            style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', textDecoration: 'none' }}>
            <img src={`https://images.evetech.net/types/${d.km.victim.ship_type_id}/icon?size=64`} width={48} height={48} style={{ borderRadius: 4, flexShrink: 0 }} alt="" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#3ecf6e' }}>{fmtISK(d.value)}</div>
              <div style={{ fontSize: '0.72rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(d.km.victim.ship_type_id)}</div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sysName(d.km.solar_system_id)} · {ago(d.km.killmail_time)}</div>
            </div>
          </a>
        ))}
      </div>

      <div style={{ marginTop: '1rem', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        De duurste corp-/alliance-kills, primair van de laatste 7 dagen (valt terug op recent als er deze week niets is). Bron: zKillboard. Klik een kaart voor de volledige killmail.
      </div>
    </Layout>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.9rem 1rem' }
const pill = (on: boolean): React.CSSProperties => ({
  padding: '5px 16px', borderRadius: 14, fontSize: '0.72rem', cursor: 'pointer',
  border: `1px solid ${on ? 'var(--gold)' : 'var(--text-dim)'}`, background: on ? 'rgba(240,160,48,0.18)' : 'rgba(255,255,255,0.05)', color: on ? '#fff' : 'var(--text)',
})
