import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'
import { useMyRole } from '../hooks/useMyRole'
import { useAuth } from '../auth/AuthContext'
import { setWaypoint } from '../api/esi'

// Thera/Turnur-wachtpost: welke wormhole-verbindingen komen er nú uit in Delve
// (of vlak bij de staging)? Data uit EVE-Scout via api/thera.php, die de nieuwe
// gaten ook meteen naar Discord stuurt. Zie de admin-kaart onderaan.

interface Row {
  sig_id: string
  system_id: number
  system: string
  region_id: number
  region: string
  sec: number
  jumps: number | null
  out_system: string
  in_sig: string
  out_sig: string
  wh_type: string
  max_size: string
  maat: string
  door: string
  expires_at: string | null
  first_seen: string
  closed_at: string | null
}

interface Feed {
  ok?: boolean
  rows?: Row[]
  gesloten?: Row[]
  aantal?: number
  dichtbij?: number
  in_regio?: number
  home?: number
  home_naam?: string
  max_jumps?: number
  regios?: { id: number; naam: string }[]
  discord?: boolean
  bijgewerkt?: string
}

interface Cfg {
  enabled: boolean
  webhook: string
  ping: string
  home: number
  maxJumps: number
  regions: number[]
  pollUrl: string
}

function fmtRest(iso: string | null, now: number) {
  if (!iso) return '—'
  const ms = Date.parse(iso) - now
  if (!isFinite(ms)) return '—'
  if (ms <= 0) return 'verlopen'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}u ${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtSinds(iso: string, now: number) {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (s < 90) return 'net'
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}u ${m % 60}m`
}

function secClass(sec: number) {
  return sec >= 0.5 ? '#5fd6a0' : sec > 0 ? 'var(--gold)' : 'var(--red)'
}

// Hoe dichterbij, hoe alarmerender — dezelfde schaal als de Discord-kleuren.
function jumpKleur(j: number | null) {
  if (j === null) return 'var(--text-dim)'
  if (j <= 3) return 'var(--red)'
  if (j <= 6) return '#f0932b'
  return 'var(--text-dim)'
}

export default function Thera() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [laden, setLaden] = useState(true)
  const [fout, setFout] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [cfgOpen, setCfgOpen] = useState(false)

  const isAdmin = useMyRole() === 'admin'
  const { activeTokens } = useAuth()
  const tok = activeTokens[0]

  const toon = useCallback((text: string, ok: boolean) => {
    setMsg({ text, ok }); setTimeout(() => setMsg(null), 3500)
  }, [])

  usePageLoading(laden)

  const haal = useCallback(async (ververs = false, stil = false) => {
    if (!stil) { setLaden(true); setFout('') }
    try {
      const res = await fetch(`/api/thera.php?action=list${ververs ? '&refresh=1' : ''}`)
      const data = await res.json() as Feed
      if (!res.ok || !data.ok) { if (!stil) setFout('Ophalen mislukt.') }
      else setFeed(data)
    } catch {
      if (!stil) setFout('Kon EVE-Scout niet bereiken.')
    } finally {
      if (!stil) setLaden(false)
    }
  }, [])

  useEffect(() => { void haal() }, [haal])
  // Feed zelf ververst server-side elke 2 min; hier elke minuut stil ophalen.
  useEffect(() => { const t = setInterval(() => void haal(false, true), 60_000); return () => clearInterval(t) }, [haal])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t) }, [])

  // Instellingen ophalen zodra een admin het paneel opent.
  useEffect(() => {
    if (!cfgOpen || cfg || !isAdmin || !tok) return
    void (async () => {
      const res = await fetch(`/api/thera.php?action=config&token=${encodeURIComponent(tok.accessToken)}`)
      if (res.ok) setCfg(await res.json() as Cfg)
      else toon('Instellingen ophalen mislukt (ben je ingelogd als admin?).', false)
    })()
  }, [cfgOpen, cfg, isAdmin, tok, toon])

  const bewaar = useCallback(async () => {
    if (!cfg || !tok) return
    const res = await fetch('/api/thera.php?action=config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, token: tok.accessToken }),
    })
    const d = await res.json().catch(() => ({}))
    toon(res.ok && d.ok ? '✅ Opgeslagen' : (d.error || 'Opslaan mislukt'), !!(res.ok && d.ok))
    if (res.ok) void haal(true, true)
  }, [cfg, tok, toon, haal])

  const testDiscord = useCallback(async () => {
    if (!tok) return
    const res = await fetch(`/api/thera.php?action=test&token=${encodeURIComponent(tok.accessToken)}`)
    const d = await res.json().catch(() => ({}))
    toon(d.ok ? '✅ Testbericht verstuurd naar Discord' : (d.error || 'Versturen mislukt'), !!d.ok)
  }, [tok, toon])

  const zetRoute = useCallback(async (r: Row) => {
    if (!tok) { toon('Log in om een route te zetten.', false); return }
    const res = await setWaypoint(r.system_id, tok.accessToken, true)
    toon(res.ok ? `✅ Route naar ${r.system} gezet op ${tok.characterName}` : `Kon de route niet zetten (ESI ${res.status}).`, res.ok)
  }, [tok, toon])

  const kopieer = useCallback((tekst: string) => {
    void navigator.clipboard?.writeText(tekst).then(() => toon(`${tekst} gekopieerd`, true), () => {})
  }, [toon])

  const rows = feed?.rows ?? []
  const regioTekst = useMemo(() => (feed?.regios ?? []).map(r => r.naam).join(', ') || 'Delve', [feed])

  return (
    <Layout header={
      <PageHeader
        title="Thera-wachtpost"
        sub={`wormholes vanuit Thera & Turnur die uitkomen in ${regioTekst} — live via EVE-Scout`}
      />
    }>
      <style>{`@keyframes theraPuls{0%,100%{opacity:1}50%{opacity:.45}}`}</style>
      {msg && (
        <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 50, padding: '.6rem .9rem',
          borderRadius: 8, fontSize: '.82rem', fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,.4)',
          background: msg.ok ? 'rgba(62,207,110,.16)' : 'rgba(224,85,85,.16)',
          border: `1px solid ${msg.ok ? 'rgba(62,207,110,.55)' : 'rgba(224,85,85,.55)'}`,
          color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>
      )}
      {fout && <div className="card" style={{ padding: '1rem', color: 'var(--red)' }}>{fout}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', marginBottom: '1rem' }}>
        <Stat label="Open gaten" waarde={String(feed?.aantal ?? 0)} />
        <Stat label={`In ${regioTekst}`} waarde={String(feed?.in_regio ?? 0)} kleur="var(--gold)" />
        <Stat label="≤ 3 sprongen" waarde={String(feed?.dichtbij ?? 0)} kleur="var(--red)"
              alert={!!feed?.dichtbij} sub={feed?.dichtbij ? '⚠ vlak naast de deur' : undefined} />
        <Stat label="Discord-melding" waarde={feed?.discord ? 'aan' : 'uit'}
              kleur={feed?.discord ? 'var(--green)' : 'var(--text-dim)'} />
      </div>

      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.8rem' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>
          Afstanden vanaf <strong style={{ color: 'var(--text)' }}>{feed?.home_naam ?? '—'}</strong>
        </span>
        <span style={{ flex: 1 }} />
        {feed?.bijgewerkt && (
          <span style={{ color: 'var(--text-dim)', fontSize: '.72rem' }}>
            bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <button className="btn btn-sm" onClick={() => void haal(true)} disabled={laden}>↻</button>
        {isAdmin && <button className="btn btn-sm" onClick={() => setCfgOpen(o => !o)}>⚙ Meldingen</button>}
      </div>

      {!laden && !rows.length && (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-dim)' }}>
          Op dit moment geen bekende Thera/Turnur-verbinding naar {regioTekst}. Rustig aan het front — of nog niet gescout.
        </div>
      )}

      {!!rows.length && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                {['Systeem', 'Afstand', 'Vanuit', 'Signatures', 'Max schip', 'Verloopt', 'Gezien'].map(h => (
                  <th key={h} style={{ padding: '.6rem .7rem', fontSize: '.64rem', fontWeight: 700,
                    letterSpacing: '.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const dichtbij = r.jumps !== null && r.jumps <= 3
                return (
                  <tr key={r.sig_id} style={{
                    borderBottom: '1px solid var(--border)',
                    borderLeft: `3px solid ${dichtbij ? 'var(--red)' : 'transparent'}`,
                    background: dichtbij ? 'rgba(224,85,85,.06)' : undefined,
                  }}>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap' }}>
                      <span style={{ color: secClass(r.sec), fontWeight: 700, marginRight: '.35rem',
                                     fontVariantNumeric: 'tabular-nums' }}>{r.sec.toFixed(1)}</span>
                      <button onClick={() => void zetRoute(r)} title={`Route naar ${r.system} zetten (Set Destination)`}
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
                                 fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }}>{r.system}</button>
                      <a href={`https://evemaps.dotlan.net/system/${encodeURIComponent(r.system.replace(/ /g, '_'))}`}
                         target="_blank" rel="noopener" title={`${r.system} op dotlan`}
                         style={{ marginLeft: '.4rem', textDecoration: 'none', fontSize: '.8rem', opacity: .65 }}>🗺</a>
                      <div style={{ color: 'var(--text-dim)', fontSize: '.66rem' }}>{r.region}</div>
                    </td>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap', fontWeight: 800,
                                 color: jumpKleur(r.jumps), animation: dichtbij ? 'theraPuls 1.6s ease-in-out infinite' : undefined }}>
                      {r.jumps === null ? `> ${feed?.max_jumps ?? 6}` : `${r.jumps} spr.`}
                    </td>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: '.62rem', fontWeight: 800, padding: '.12rem .4rem', borderRadius: 5,
                        background: 'rgba(0,180,216,.12)', border: '1px solid rgba(0,180,216,.4)',
                        color: '#7fe0ff' }}>{r.out_system}</span>
                      <div style={{ color: 'var(--text-dim)', fontSize: '.66rem' }}>{r.wh_type || '—'}</div>
                    </td>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '.78rem' }}>
                      <button onClick={() => kopieer(r.in_sig)} title="kopieer sig-id"
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
                                 color: 'var(--text)', cursor: 'pointer' }}>{r.in_sig || '???'}</button>
                      <span style={{ color: 'var(--text-dim)' }}> · hier</span>
                      <div style={{ color: 'var(--text-dim)' }}>{r.out_sig || '???'} · {r.out_system}</div>
                    </td>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap' }}>{r.maat || '—'}</td>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtRest(r.expires_at, now)}
                    </td>
                    <td style={{ padding: '.5rem .7rem', whiteSpace: 'nowrap', color: 'var(--text-dim)', fontSize: '.72rem' }}>
                      {fmtSinds(r.first_seen, now)}
                      {r.door && <div style={{ fontSize: '.64rem' }}>door {r.door}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!!feed?.gesloten?.length && (
        <div className="card" style={{ padding: '.8rem 1rem', marginTop: '1rem' }}>
          <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                        textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '.4rem' }}>
            Recent verdwenen (laatste 3 uur)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem' }}>
            {feed.gesloten.map(r => (
              <span key={r.sig_id} style={{ fontSize: '.72rem', padding: '.15rem .5rem', borderRadius: 999,
                background: 'rgba(255,255,255,.05)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                {r.system} ← {r.out_system} · {r.closed_at ? fmtSinds(r.closed_at, now) : ''} geleden
              </span>
            ))}
          </div>
        </div>
      )}

      {cfgOpen && isAdmin && (
        <div className="card" style={{ padding: '1rem', marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
          <div style={{ fontSize: '.85rem', fontWeight: 700 }}>⚙ Discord-melding</div>
          {!cfg && <div style={{ color: 'var(--text-dim)', fontSize: '.75rem' }}>Instellingen laden…</div>}
          {cfg && (
            <>
              <label style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>
                Webhook-URL (Discord → kanaalinstellingen → Integraties → Webhooks)
                <input value={cfg.webhook} onChange={e => setCfg({ ...cfg, webhook: e.target.value })}
                  placeholder="https://discord.com/api/webhooks/…"
                  style={inputStyle} />
              </label>
              <div style={{ display: 'flex', gap: '.7rem', flexWrap: 'wrap' }}>
                <label style={{ fontSize: '.7rem', color: 'var(--text-dim)', flex: '1 1 180px' }}>
                  Ping bij melding (leeg = geen)
                  <input value={cfg.ping} onChange={e => setCfg({ ...cfg, ping: e.target.value })}
                    placeholder="@here of &lt;@&amp;rolid&gt;" style={inputStyle} />
                </label>
                <label style={{ fontSize: '.7rem', color: 'var(--text-dim)', flex: '1 1 140px' }}>
                  Staging-systeem (id)
                  <input value={cfg.home} onChange={e => setCfg({ ...cfg, home: Number(e.target.value) || 0 })}
                    style={inputStyle} />
                </label>
                <label style={{ fontSize: '.7rem', color: 'var(--text-dim)', flex: '1 1 120px' }}>
                  Ook melden binnen … sprongen
                  <input type="number" min={0} max={15} value={cfg.maxJumps}
                    onChange={e => setCfg({ ...cfg, maxJumps: Number(e.target.value) })} style={inputStyle} />
                </label>
              </div>
              <label style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>
                Regio-id's (komma-gescheiden — 10000060 = Delve, 10000050 = Querious, 10000063 = Period Basis)
                <input value={cfg.regions.join(', ')}
                  onChange={e => setCfg({ ...cfg, regions: e.target.value.split(',').map(s => Number(s.trim())).filter(Boolean) })}
                  style={inputStyle} />
              </label>
              <label style={{ fontSize: '.75rem', display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <input type="checkbox" checked={cfg.enabled} onChange={e => setCfg({ ...cfg, enabled: e.target.checked })} />
                Meldingen aan
              </label>
              <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={() => void bewaar()}>Opslaan</button>
                <button className="btn btn-sm" onClick={() => void testDiscord()}>Testbericht</button>
              </div>
              <div style={{ fontSize: '.66rem', color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                Cron-URL (elke 5 min aantikken, bv. vanaf de Pi):<br />
                <code>{cfg.pollUrl}</code>
              </div>
            </>
          )}
        </div>
      )}

      <p style={{ color: 'var(--text-dim)', fontSize: '.72rem', marginTop: '1rem', lineHeight: 1.5 }}>
        Bron: <a href="https://www.eve-scout.com/" target="_blank" rel="noopener">EVE-Scout</a> (publieke API, geen token).
        Gaten worden gescout door vrijwilligers — wat hier níet staat kan er wél zijn. <strong>Klik een systeem</strong> om
        in-game de route te zetten, klik een sig-id om het te kopiëren. Nieuwe verbindingen gaan automatisch naar Discord.
      </p>
    </Layout>
  )
}

const inputStyle: CSSProperties = {
  display: 'block', width: '100%', marginTop: '.25rem', background: '#05050e',
  border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)',
  fontSize: '.72rem', padding: '.35rem .5rem', outline: 'none',
  boxSizing: 'border-box', fontFamily: 'inherit',
}

function Stat({ label, waarde, kleur, sub, alert }: {
  label: string; waarde: string; kleur?: string; sub?: string; alert?: boolean
}) {
  return (
    <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 130px', minWidth: 110,
      border: alert ? '1px solid rgba(224,85,85,.5)' : undefined,
      background: alert ? 'rgba(224,85,85,.08)' : undefined }}>
      <div style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em',
                    textTransform: 'uppercase', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 800, color: kleur }}>{waarde}</div>
      {sub && <div style={{ fontSize: '.64rem', fontWeight: 700, color: 'var(--red)' }}>{sub}</div>}
    </div>
  )
}
