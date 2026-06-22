import { useEffect, useMemo, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { getKillmailDetail, resolveNames, type Killmail } from '../api/esi'
import { usePageLoading } from '../hooks/usePageLoading'

const CORP_ID = 98652891       // Dutch Legions
// Begin van de huidige kalendermaand (lokale tijd).
function monthStart(): number {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime()
}

interface ZkbKill { killmail_id: number; zkb?: { hash: string; totalValue?: number } }
interface Enriched { km: Killmail; value: number; hash: string }
interface TopKiller { characterID: number; characterName: string; kills: number }

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
  const [kills, setKills] = useState<Enriched[]>([])
  const [killers, setKillers] = useState<TopKiller[]>([])
  const [names, setNames] = useState<Map<number, string>>(new Map())
  const [systems, setSystems] = useState<Record<string, [string, number, number]>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  usePageLoading(loading)

  useEffect(() => { fetch('/systems.json').then(r => r.json()).then(setSystems).catch(() => {}) }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(''); setKills([]); setKillers([])

    // Alleen voor de corp. Eén schone request: de proxy levert kills én topKillers samen.
    fetch(`/api/zkill.php?type=corporationID&id=${CORP_ID}`)
      .then(r => r.json())
      .then(async (data: { kills?: ZkbKill[]; topKillers?: TopKiller[] }) => {
        if (cancelled) return
        setKillers((data?.topKillers ?? []).slice(0, 10))
        const list = data?.kills
        if (!Array.isArray(list)) { setErr('zKillboard gaf geen lijst terug.'); setLoading(false); return }
        // sorteer op waarde, verrijk de top met ESI-killmaildetails
        const top = list.filter(k => k.zkb?.hash).sort((a, b) => (b.zkb!.totalValue ?? 0) - (a.zkb!.totalValue ?? 0)).slice(0, 14)
        const detailed: Enriched[] = []
        for (const k of top) {
          const km = await getKillmailDetail(k.killmail_id, k.zkb!.hash)
          if (km) detailed.push({ km, value: k.zkb!.totalValue ?? 0, hash: k.zkb!.hash })
        }
        if (cancelled) return
        // hou kills van DEZE maand; val terug op recent als er geen zijn
        const ms = monthStart()
        const recent = detailed.filter(d => +new Date(d.km.killmail_time) >= ms)
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
  }, [])

  const nameOf = (id?: number) => (id ? names.get(id) ?? `#${id}` : '—')
  const sysName = (id: number) => systems[String(id)]?.[0] ?? `Systeem ${id}`
  const top = kills[0]
  const rest = useMemo(() => kills.slice(1), [kills])

  return (
    <Layout header={<PageHeader title="Kills van de maand" sub={loading ? 'zKillboard laden…' : `top ${kills.length} · Dutch Legions · deze maand`} />}>
      {killers.length > 0 && (
        <div style={{ ...card, marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.14em', marginBottom: '0.7rem' }}>⚔️ TOP KILLERS</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
            {killers.map((k, i) => (
              <a key={k.characterID} href={`https://zkillboard.com/character/${k.characterID}/`} target="_blank" rel="noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', padding: '0.25rem' }}>
                <span style={{ width: 16, textAlign: 'right', fontSize: '0.72rem', fontWeight: 800, color: i === 0 ? 'var(--gold)' : i < 3 ? '#fff' : 'var(--text-dim)', flexShrink: 0 }}>{i + 1}</span>
                <img src={`https://images.evetech.net/characters/${k.characterID}/portrait?size=32`} width={26} height={26} style={{ borderRadius: '50%', flexShrink: 0 }} alt="" />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '0.7rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.characterName}</span>
                  <span style={{ fontSize: '0.6rem', color: '#3ecf6e' }}>{k.kills} kills</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {err && <div style={{ ...card, color: 'var(--red)' }}>{err}</div>}
      {!loading && !err && kills.length === 0 && <div style={card}>Geen kills gevonden voor de corp deze maand.</div>}

      {top && (
        <a href={`https://zkillboard.com/kill/${top.km.killmail_id}/`} target="_blank" rel="noreferrer"
          style={{ ...card, display: 'block', textDecoration: 'none', borderColor: 'var(--gold)', marginBottom: '1rem', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 10, right: 12, fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.16em', color: 'var(--gold)' }}>🏆 KILL VAN DE MAAND</div>
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
        De duurste corp-kills van deze maand (valt terug op recent als er deze maand nog niets is). Bron: zKillboard. Klik een kaart voor de volledige killmail.
      </div>
    </Layout>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.9rem 1rem' }
