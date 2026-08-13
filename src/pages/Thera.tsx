import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'
import { useMyRole } from '../hooks/useMyRole'
import { useAuth } from '../auth/AuthContext'
import { setWaypoint } from '../api/esi'

// Thera/Turnur-wachtpost: welke wormhole-verbindingen komen er nú uit in de
// bewaakte systemen? Data uit EVE-Scout via api/thera.php, die nieuwe gaten ook
// meteen naar Discord stuurt. Waaklijst en webhook staan in het ⚙-paneel.

interface Row {
  op_lijst: boolean
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
  op_lijst?: number
  in_regio?: number
  waaklijst?: string[]
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
  systems: string[]
  pollUrl: string
}

// ── Stijl (zelfde look als de andere pagina's) ──
const INPUT: CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none',
}
const LABEL: CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem',
}
const TH: CSSProperties = {
  textAlign: 'left', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: CSSProperties = { textAlign: 'left', padding: '0.4rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }
const KNOP: CSSProperties = { ...INPUT, cursor: 'pointer', fontWeight: 600, fontSize: '0.66rem' }
// Alleen panelen die écht een kader nodig hebben (instellingen, foutmelding).
const PANEL: CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.6rem 0.8rem',
}
// Pil zoals op de sov-pagina: kleine hoofdletters in een gekleurd randje.
function pil(kleur: string, bg: string): CSSProperties {
  return {
    fontSize: '0.56rem', fontWeight: 800, letterSpacing: '0.05em', padding: '0.1rem 0.4rem',
    borderRadius: 999, whiteSpace: 'nowrap', color: kleur, background: bg, border: `1px solid ${kleur}`,
  }
}
// Hoe groter het gat, hoe zwaarder wat erdoor kan: capital rood, battleship goud.
function maatKleur(size: string) {
  return size === 'xlarge' ? 'var(--red)' : size === 'large' ? 'var(--gold)' : 'var(--text-dim)'
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
  if (j <= 6) return 'var(--gold)'
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
  const [zoneOpen, setZoneOpen] = useState(false)

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
  const waaklijst = feed?.waaklijst ?? []
  const regioTekst = useMemo(() => (feed?.regios ?? []).map(r => r.naam).join(', '), [feed])
  // Waar kijken we naar? Waaklijst, hele regio's, of beide.
  const zoneTekst = waaklijst.length
    ? `${waaklijst.length} bewaakte systemen${regioTekst ? ` + ${regioTekst}` : ''}`
    : (regioTekst || 'niets — stel een waaklijst in')

  return (
    <Layout header={
      <PageHeader
        title="🌀 Thera-wachtpost"
        sub={`Wormholes vanuit Thera & Turnur die uitkomen in ${zoneTekst}. Live uit EVE-Scout; nieuwe gaten gaan automatisch naar Discord.`}
      />
    }>
      {/* Zacht pulseren: trekt de aandacht zonder het getal onleesbaar te maken. */}
      <style>{`@keyframes theraPuls{0%,100%{opacity:1}50%{opacity:.72}}`}</style>

      {msg && (
        <div style={{
          position: 'fixed', right: 18, bottom: 18, zIndex: 50, padding: '0.5rem 0.8rem', borderRadius: 4,
          fontSize: '0.72rem', fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,.4)',
          background: msg.ok ? 'rgba(62,207,110,.14)' : 'rgba(224,85,85,.14)',
          border: `1px solid ${msg.ok ? 'var(--green)' : 'var(--red)'}`,
          color: msg.ok ? 'var(--green)' : 'var(--red)',
        }}>{msg.text}</div>
      )}

      {fout && (
        <div style={{ ...PANEL, color: 'var(--red)', fontSize: '0.75rem', marginBottom: '0.7rem' }}>{fout}</div>
      )}

      {/* Tellers */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.7rem' }}>
        <Tegel label="OPEN GATEN" waarde={feed?.aantal ?? 0} />
        <Tegel label="IN DE WAAKZONE" waarde={feed?.op_lijst ?? 0} kleur="var(--gold)"
               sub={waaklijst.length ? `${waaklijst.length} systemen bewaakt` : undefined} />
        <Tegel label="≤ 3 SPRONGEN" waarde={feed?.dichtbij ?? 0} kleur="var(--red)"
               alarm={!!feed?.dichtbij} sub={feed?.dichtbij ? 'vlak naast de deur' : undefined} />
        <Tegel label="DISCORD" waarde={feed?.discord ? 'aan' : 'uit'}
               kleur={feed?.discord ? 'var(--green)' : 'var(--text-dim)'} />
      </div>

      {/* Waakzone + acties */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {!!waaklijst.length && (
          <button onClick={() => setZoneOpen(o => !o)} style={{ ...KNOP, fontSize: '0.66rem' }}>
            {zoneOpen ? '▾' : '▸'} Waakzone ({waaklijst.length})
          </button>
        )}
        <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>
          Afstanden vanaf <strong style={{ color: 'var(--text)' }}>{feed?.home_naam ?? '—'}</strong>
        </span>
        <span style={{ flex: 1 }} />
        {feed?.bijgewerkt && (
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
            bijgewerkt {new Date(feed.bijgewerkt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        <button onClick={() => void haal(true)} disabled={laden} style={{ ...KNOP, fontSize: '0.66rem' }}>↻ Ververs</button>
        {isAdmin && (
          <button onClick={() => setCfgOpen(o => !o)}
            style={{ ...KNOP, fontSize: '0.66rem', borderColor: cfgOpen ? 'var(--blue)' : 'var(--border)' }}>
            ⚙ Meldingen
          </button>
        )}
      </div>

      {zoneOpen && !!waaklijst.length && (
        <div style={{ ...PANEL, display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.7rem' }}>
          {waaklijst.map(s => (
            <span key={s} style={{
              fontSize: '0.66rem', padding: '0.1rem 0.4rem', borderRadius: 2, fontFamily: 'monospace',
              background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-dim)',
            }}>{s}</span>
          ))}
        </div>
      )}

      {!laden && !rows.length && (
        <div style={{ ...PANEL, color: 'var(--text-dim)', fontSize: '0.75rem' }}>
          Op dit moment geen bekende Thera/Turnur-verbinding naar {zoneTekst}. Rustig aan het front — of nog niet gescout.
        </div>
      )}

      {!!rows.length && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={TH}>Status</th>
                <th style={TH}>Systeem</th>
                <th style={TH}>Afstand</th>
                <th style={TH}>Vanuit</th>
                <th style={TH}>Signatures</th>
                <th style={TH}>Max schip</th>
                <th style={TH}>Verloopt</th>
                <th style={TH}>Gezien</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const dichtbij = r.jumps !== null && r.jumps <= 3
                // Minder dan een uur te gaan: het gat is bijna weg.
                const eindigtBijna = !!r.expires_at && Date.parse(r.expires_at) - now < 3600_000
                return (
                  <tr key={r.sig_id} style={{
                    borderBottom: '1px solid var(--border)',
                    borderLeft: `2px solid ${dichtbij ? 'var(--red)' : r.op_lijst ? 'var(--gold)' : 'transparent'}`,
                    background: dichtbij ? 'rgba(224,85,85,.06)' : undefined,
                  }}>
                    <td style={TD}>
                      {dichtbij
                        ? <span style={pil('var(--red)', 'rgba(224,85,85,.14)')}>⚠ VLAKBIJ</span>
                        : r.op_lijst
                          ? <span style={pil('var(--gold)', 'rgba(240,192,64,.12)')}>WAAKZONE</span>
                          : <span style={pil('var(--text-dim)', 'rgba(255,255,255,.04)')}>buiten zone</span>}
                    </td>
                    <td style={TD}>
                      <span style={{ color: secClass(r.sec), fontWeight: 700, marginRight: '0.35rem',
                                     fontVariantNumeric: 'tabular-nums' }}>{r.sec.toFixed(1)}</span>
                      <button onClick={() => void zetRoute(r)} title={`Route naar ${r.system} zetten (Set Destination)`}
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
                                 fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }}>{r.system}</button>
                      <a href={`https://evemaps.dotlan.net/system/${encodeURIComponent(r.system.replace(/ /g, '_'))}`}
                         target="_blank" rel="noopener" title={`${r.system} op dotlan`}
                         style={{ marginLeft: '0.35rem', textDecoration: 'none', fontSize: '0.72rem', opacity: .6 }}>🗺</a>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.62rem' }}>{r.region}</div>
                    </td>
                    <td style={{ ...TD, fontWeight: 700, color: jumpKleur(r.jumps),
                                 animation: dichtbij ? 'theraPuls 1.6s ease-in-out infinite' : undefined }}>
                      {r.jumps === null ? '—' : `${r.jumps} spr.`}
                    </td>
                    <td style={TD}>
                      <span style={{ ...pil('var(--blue)', 'rgba(0,180,216,.12)'), color: '#7fe0ff' }}>
                        {r.out_system.toUpperCase()}
                      </span>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.62rem' }}>{r.wh_type || '—'}</div>
                    </td>
                    <td style={{ ...TD, fontFamily: 'monospace', fontSize: '0.72rem' }}>
                      <button onClick={() => kopieer(r.in_sig)} title="kopieer sig-id"
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
                                 color: 'var(--text)', cursor: 'pointer' }}>{r.in_sig || '???'}</button>
                      <span style={{ color: 'var(--text-dim)' }}> · hier</span>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.66rem' }}>{r.out_sig || '???'} · {r.out_system}</div>
                    </td>
                    <td style={TD}>
                      <span style={{ fontWeight: 700, color: maatKleur(r.max_size) }}>{r.maat || '—'}</span>
                    </td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                                 color: eindigtBijna ? 'var(--red)' : 'var(--text)' }}>
                      {fmtRest(r.expires_at, now)}
                      {eindigtBijna && <div style={{ fontSize: '0.6rem', fontWeight: 600, color: 'var(--red)' }}>sluit bijna</div>}
                    </td>
                    <td style={{ ...TD, color: 'var(--text-dim)', fontSize: '0.66rem' }}>
                      {fmtSinds(r.first_seen, now)}
                      {r.door && <div style={{ fontSize: '0.6rem' }}>door {r.door}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!!feed?.gesloten?.length && (
        <div style={{ marginTop: '0.7rem' }}>
          <div style={LABEL}>RECENT VERDWENEN (LAATSTE 3 UUR)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {feed.gesloten.map(r => (
              <span key={r.sig_id} style={{
                fontSize: '0.66rem', padding: '0.1rem 0.4rem', borderRadius: 2,
                background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-dim)',
              }}>
                {r.system} ← {r.out_system} · {r.closed_at ? `${fmtSinds(r.closed_at, now)} geleden` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {cfgOpen && isAdmin && (
        <div style={{ ...PANEL, marginTop: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={LABEL}>⚙ DISCORD-MELDING</div>
          {!cfg && <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Instellingen laden…</div>}
          {cfg && (
            <>
              <div>
                <div style={LABEL}>WEBHOOK-URL (DISCORD → KANAALINSTELLINGEN → INTEGRATIES)</div>
                <input value={cfg.webhook} onChange={e => setCfg({ ...cfg, webhook: e.target.value })}
                  placeholder="https://discord.com/api/webhooks/…" style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }} />
              </div>

              <div>
                <div style={LABEL}>WAAKLIJST — {cfg.systems.length} SYSTEMEN (NAAM OF ID, GESCHEIDEN DOOR SPATIE OF KOMMA)</div>
                <textarea value={cfg.systems.join(' ')}
                  onChange={e => setCfg({ ...cfg, systems: e.target.value.split(/[\s,]+/).filter(Boolean) })}
                  rows={4} style={{ ...INPUT, width: '100%', boxSizing: 'border-box', resize: 'vertical',
                                    fontFamily: 'monospace', lineHeight: 1.6 }} />
              </div>

              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 170px' }}>
                  <div style={LABEL}>PING BIJ MELDING (LEEG = GEEN)</div>
                  <input value={cfg.ping} onChange={e => setCfg({ ...cfg, ping: e.target.value })}
                    placeholder="@here" style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: '1 1 130px' }}>
                  <div style={LABEL}>IJKPUNT AFSTAND (SYSTEEM-ID)</div>
                  <input value={cfg.home} onChange={e => setCfg({ ...cfg, home: Number(e.target.value) || 0 })}
                    style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: '1 1 130px' }}>
                  <div style={LABEL}>OOK MELDEN BINNEN … SPRONGEN (0 = UIT)</div>
                  <input type="number" min={0} max={25} value={cfg.maxJumps}
                    onChange={e => setCfg({ ...cfg, maxJumps: Number(e.target.value) })}
                    style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }} />
                </div>
              </div>

              <div>
                <div style={LABEL}>HELE REGIO'S ERBIJ (ID'S; LEEG = ALLEEN DE WAAKLIJST)</div>
                <input value={cfg.regions.join(', ')}
                  onChange={e => setCfg({ ...cfg, regions: e.target.value.split(',').map(s => Number(s.trim())).filter(Boolean) })}
                  placeholder="10000060 = Delve · 10000050 = Querious · 10000063 = Period Basis"
                  style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }} />
              </div>

              <label style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" checked={cfg.enabled} onChange={e => setCfg({ ...cfg, enabled: e.target.checked })} />
                Meldingen aan
              </label>

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button onClick={() => void bewaar()}
                  style={{ ...KNOP, background: 'var(--blue)', color: '#0a0a12', borderColor: 'var(--blue)' }}>Opslaan</button>
                <button onClick={() => void testDiscord()} style={KNOP}>Testbericht</button>
              </div>

              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                Cron-URL (elke 5 min aantikken, bijvoorbeeld vanaf de Pi):<br />
                <code style={{ color: 'var(--text)' }}>{cfg.pollUrl}</code>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.8rem', lineHeight: 1.6 }}>
        Bron: <a href="https://www.eve-scout.com/" target="_blank" rel="noopener"
          style={{ color: 'var(--blue)' }}>EVE-Scout</a> (publieke API, geen token). Gaten worden gescout door
        vrijwilligers — wat hier níet staat, kan er wél zijn. Klik een systeem om in-game de route te zetten,
        klik een sig-id om het te kopiëren.
      </div>
    </Layout>
  )
}

// Teller: plat op de achtergrond, zoals op de andere pagina's. Alleen als er
// iets aan de hand is krijgt hij een rood kader — dat valt dan ook echt op.
function Tegel({ label, waarde, kleur, sub, alarm }: {
  label: string; waarde: string | number; kleur?: string; sub?: string; alarm?: boolean
}) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: 130, padding: alarm ? '0.5rem 0.7rem' : '0.5rem 0.1rem',
      border: alarm ? '1px solid var(--red)' : '1px solid transparent',
      borderRadius: alarm ? 4 : undefined,
      background: alarm ? 'rgba(224,85,85,.07)' : undefined,
    }}>
      <div style={LABEL}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, color: kleur, lineHeight: 1.15,
                    fontVariantNumeric: 'tabular-nums' }}>{waarde}</div>
      {sub && <div style={{ fontSize: '0.6rem', fontWeight: 600, color: alarm ? 'var(--red)' : 'var(--text-dim)' }}>{sub}</div>}
    </div>
  )
}
