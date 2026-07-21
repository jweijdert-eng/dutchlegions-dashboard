import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { useAuth } from '../auth/AuthContext'
import { getCharacterFleet, getFleetMembers, resolveNames, getAssets } from '../api/esi'

// Fleet-payout: verdeel de winst van een ESS/skyhook-op eerlijk over de fleet.
// De FC-tokenhouder pollt live de fleet-leden; per lid houden we de meedoen-tijd
// bij (join_time + aanwezigheid), zodat wie later komt of eerder stopt naar rato
// minder krijgt. Verdeling naar tijd (pro-rata) of gelijk, met optionele corp-cut.
// Alles client-side; de sessie blijft in localStorage staan (refresh-proof).

const LS_KEY = 'fleet_payout_v1'
const POLL_MS = 20_000
const WP_SCOPE = 'esi-fleets.read_fleet.v1'
const ASSETS_SCOPE = 'esi-assets.read_assets.v1'
// ESS-buit komt als "Bounty SCC Encrypted Bond"-items met vaste nominale waarde.
const BOND_VALUE: Record<number, number> = {
  55931: 10_000, 55930: 100_000, 55933: 1_000_000, 55932: 10_000_000,
}
// Skyhook-loot: Magmatic Gas + Superionic Ice — tegen Jita (Fuzzwork) waarderen.
const REAGENTS: Record<number, string> = { 81143: 'Magmatic Gas', 81144: 'Superionic Ice' }

interface Member {
  name: string
  joinTime: number        // ms — laatste join in deze fleet
  shipTypeId: number
  totalMs: number         // gebankte tijd uit afgeronde aanwezigheids-intervallen
  presentSince: number | null  // ms sinds huidige aanwezigheid telt (null = weg)
}

interface Session {
  running: boolean
  fleetId: number | null
  opStart: number
  members: Record<string, Member>
  potRaw: string
  taxPct: number
  mode: 'time' | 'even'
}

function emptySession(): Session {
  return { running: false, fleetId: null, opStart: 0, members: {}, potRaw: '', taxPct: 0, mode: 'time' }
}
function load(): Session {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY) || ''); return s && s.members ? s : emptySession() }
  catch { return emptySession() }
}
function save(s: Session) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch { /* vol */ } }

function parseIsk(raw: string): number {
  let s = (raw || '').trim().toLowerCase().replace(/\s/g, '')
  if (!s) return 0
  const suf = s.match(/([bmk])$/)
  let mult = 1
  if (suf) { mult = suf[1] === 'b' ? 1e9 : suf[1] === 'm' ? 1e6 : 1e3; s = s.slice(0, -1) }
  s = suf ? s.replace(',', '.') : s.replace(/[.,]/g, '')   // met suffix = decimaal, anders scheidingstekens strippen
  const n = parseFloat(s)
  return isFinite(n) ? n * mult : 0
}
function fmtIsk(v: number) {
  if (!isFinite(v) || v === 0) return '0'
  const a = Math.abs(v), s = v < 0 ? '−' : ''
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}K`
  return `${s}${Math.round(a)}`
}
function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const p = (n: number) => (n < 10 ? '0' : '') + n
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}

export default function FleetPayout() {
  const { activeTokens } = useAuth()
  const tok = activeTokens[0]
  const scopes = useMemo(() => {
    const tk = tok?.accessToken
    if (!tk) return [] as string[]
    try {
      const p = JSON.parse(atob(tk.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      return Array.isArray(p.scp) ? p.scp as string[] : p.scp ? [p.scp as string] : []
    } catch { return [] }
  }, [tok])
  const canFleet = scopes.includes(WP_SCOPE)
  const canAssets = scopes.includes(ASSETS_SCOPE)

  const sessRef = useRef<Session>(load())
  const [, setBump] = useState(0)
  const rerender = useCallback(() => setBump(x => x + 1), [])
  const [now, setNow] = useState(Date.now())
  const [msg, setMsg] = useState('')

  // Live klok voor de meedoen-tijden.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  const poll = useCallback(async () => {
    const s = sessRef.current
    if (!s.running || !s.fleetId || !tok) return
    let list
    try {
      list = await getFleetMembers(s.fleetId, tok.accessToken)
    } catch (e) {
      const m = String(e)
      setMsg(m.includes('403') ? 'Alleen de fleet-boss kan de leden uitlezen — laat de FC dit draaien.' : 'Fleet niet meer bereikbaar (opgelost?).')
      return
    }
    const T = Date.now()
    const cur = new Set(list.map(m => String(m.character_id)))
    for (const m of list) {
      const id = String(m.character_id)
      const joinMs = Date.parse(m.join_time) || s.opStart
      const ex = s.members[id]
      if (!ex) {
        s.members[id] = { name: '', joinTime: joinMs, shipTypeId: m.ship_type_id,
                          totalMs: 0, presentSince: Math.max(s.opStart, joinMs) }
      } else {
        ex.shipTypeId = m.ship_type_id
        if (ex.presentSince === null) ex.presentSince = Math.max(s.opStart, joinMs)   // (her)ingestapt
      }
    }
    // Wie weg is → z'n lopende interval bankieren.
    for (const [id, mem] of Object.entries(s.members)) {
      if (!cur.has(id) && mem.presentSince !== null) {
        mem.totalMs += Math.max(0, T - mem.presentSince)
        mem.presentSince = null
      }
    }
    // Namen (characters + schepen) aanvullen.
    const need = Object.entries(s.members).filter(([, m]) => !m.name).map(([id]) => Number(id))
    const shipIds = list.map(m => m.ship_type_id)
    if (need.length || shipIds.length) {
      const names = await resolveNames([...need, ...shipIds]).catch(() => new Map())
      for (const id of need) { const n = names.get(Number(id)); if (n) s.members[id].name = n }
      ;(s as Session & { _ships?: Record<number, string> })._ships = Object.fromEntries(shipIds.map(sid => [sid, names.get(sid) || '']))
    }
    save(s); rerender()
  }, [tok, rerender])

  // Poll-lus zolang de op loopt.
  useEffect(() => {
    if (!sessRef.current.running) return
    void poll()
    const t = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(t)
  }, [poll, sessRef.current.running])

  async function start() {
    setMsg('')
    if (!tok) { setMsg('Log in als FC om te starten.'); return }
    if (!canFleet) { setMsg('Log opnieuw in — de fleet-toestemming (read_fleet) ontbreekt.'); return }
    let cf
    try { cf = await getCharacterFleet(tok.characterId, tok.accessToken) }
    catch { setMsg('Je zit niet in een fleet (of ESI is even weg).'); return }
    if (!cf?.fleet_id) { setMsg('Geen actieve fleet gevonden op dit character.'); return }
    const s = sessRef.current
    s.running = true; s.fleetId = cf.fleet_id; s.opStart = Date.now(); s.members = {}
    save(s); rerender()
  }
  function stop() {
    const s = sessRef.current
    const T = Date.now()
    for (const mem of Object.values(s.members)) {
      if (mem.presentSince !== null) { mem.totalMs += Math.max(0, T - mem.presentSince); mem.presentSince = null }
    }
    s.running = false; save(s); rerender()
  }
  function reset() {
    sessRef.current = emptySession(); save(sessRef.current); setMsg(''); rerender()
  }
  // ESS-buit = de "Bounty SCC Encrypted Bond"-items in je cargo/hangar, op nominale waarde.
  async function readEss() {
    if (!tok) { setMsg('Log in om je items te lezen.'); return }
    if (!canAssets) { setMsg('Log opnieuw in — de assets-toestemming ontbreekt.'); return }
    setMsg('ESS Bonds uit je items lezen…')
    try {
      const assets = await getAssets(tok.characterId, tok.accessToken)
      let total = 0, count = 0
      for (const a of assets) {
        const val = BOND_VALUE[a.type_id]
        if (val) { const q = a.quantity || 1; total += val * q; count += q }
      }
      if (!total) { setMsg(`Geen ESS Bonds gevonden op ${tok.characterName}. Zit je op het character dat de ESS pakte (bonds in cargo/hangar)?`); return }
      setField('potRaw', String(total))
      setMsg(`ESS Bonds gevonden: ${fmtIsk(total)} — ${count} bond(s) op ${tok.characterName}.`)
    } catch { setMsg('Kon je items (assets) niet lezen.') }
  }
  // Skyhook-loot = Magmatic Gas + Superionic Ice in je cargo, tegen Jita-verkoopprijs.
  async function readSkyhook() {
    if (!tok) { setMsg('Log in om je items te lezen.'); return }
    if (!canAssets) { setMsg('Log opnieuw in — de assets-toestemming ontbreekt.'); return }
    setMsg('Skyhook-loot uit je items lezen…')
    try {
      const assets = await getAssets(tok.characterId, tok.accessToken)
      const qty: Record<number, number> = { 81143: 0, 81144: 0 }
      for (const a of assets) if (a.type_id in REAGENTS) qty[a.type_id] += a.quantity || 0
      if (!qty[81143] && !qty[81144]) { setMsg(`Geen Magmatic Gas / Superionic Ice gevonden op ${tok.characterName}.`); return }
      const r = await fetch('https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=81143,81144')
      const d = await r.json() as Record<string, { sell: { min: number } }>
      const total = qty[81143] * Number(d['81143']?.sell?.min || 0) + qty[81144] * Number(d['81144']?.sell?.min || 0)
      if (!total) { setMsg('Kon geen Jita-prijs voor de reagents ophalen.'); return }
      setField('potRaw', String(Math.round(total)))
      setMsg(`Skyhook-loot: ${fmtIsk(total)} — ${qty[81143].toLocaleString('nl-NL')} Magmatic Gas + ${qty[81144].toLocaleString('nl-NL')} Superionic Ice (Jita sell).`)
    } catch { setMsg('Kon de skyhook-loot niet waarderen.') }
  }
  function setField<K extends keyof Session>(k: K, v: Session[K]) {
    sessRef.current[k] = v; save(sessRef.current); rerender()
  }

  const s = sessRef.current
  const ships = (s as Session & { _ships?: Record<number, string> })._ships || {}
  const partMs = (m: Member) => m.totalMs + (m.presentSince !== null ? Math.max(0, now - m.presentSince) : 0)
  const rows = Object.entries(s.members).map(([id, m]) => ({ id, ...m, part: partMs(m) }))
    .sort((a, b) => b.part - a.part)
  const totalMs = rows.reduce((a, r) => a + r.part, 0)
  const pot = parseIsk(s.potRaw)
  const afterTax = pot * (1 - (s.taxPct || 0) / 100)
  const shareOf = (part: number) => {
    if (s.mode === 'even') return rows.length ? afterTax / rows.length : 0
    return totalMs > 0 ? afterTax * (part / totalMs) : 0
  }

  const copyPayouts = () => {
    const lines = rows.map(r => `${r.name || r.id}\t${Math.round(shareOf(r.part)).toLocaleString('nl-NL')}`)
    void navigator.clipboard?.writeText(lines.join('\n'))
    setMsg('Uitbetaallijst gekopieerd (naam + bedrag).')
    setTimeout(() => setMsg(''), 2500)
  }

  return (
    <Layout header={<PageHeader title="Fleet Payout" sub="verdeel ESS/skyhook-winst eerlijk over de fleet — naar meedoen-tijd" />}>
      {msg && <div className="card" style={{ padding: '.6rem .9rem', marginBottom: '.8rem',
        color: msg.startsWith('Uitbetaallijst') ? 'var(--green)' : 'var(--gold)' }}>{msg}</div>}

      {/* Bediening */}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
        {!s.running
          ? <button className="btn btn-sm" style={{ background: 'var(--green)', color: '#04121a', fontWeight: 700 }} onClick={() => void start()}>▶ Start op</button>
          : <button className="btn btn-sm" style={{ background: 'var(--red)', color: '#fff', fontWeight: 700 }} onClick={stop}>⏹ Stop op</button>}
        <button className="btn btn-sm" onClick={reset}>Reset</button>
        {s.running && <span style={{ color: 'var(--green)', fontSize: '.8rem' }}>● live · fleet {s.fleetId} · {rows.length} leden</span>}
        {!s.running && s.opStart > 0 && <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>op gestopt · {rows.length} leden</span>}
      </div>

      {/* Pot + verdeling */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', marginBottom: '1rem' }}>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '2 1 220px', minWidth: 200 }}>
          <label style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Totale buit (ISK)</label>
          <div style={{ display: 'flex', gap: '.35rem', marginTop: '.2rem' }}>
            <input value={s.potRaw} onChange={e => setField('potRaw', e.target.value)} placeholder="bijv. 1.5b of 300m of 250000000"
              style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,.05)', border: '1px solid var(--border)', borderRadius: 6, color: 'inherit', padding: '.3rem .5rem', fontSize: '.95rem' }} />
            {canAssets && (
              <button className="btn btn-sm" title="ESS Bonds uit je cargo/hangar optellen (nominale waarde)"
                onClick={() => void readEss()} style={{ whiteSpace: 'nowrap' }}>⭳ ESS Bonds</button>
            )}
            {canAssets && (
              <button className="btn btn-sm" title="Skyhook-loot (Magmatic Gas + Superionic Ice) uit je cargo tegen Jita"
                onClick={() => void readSkyhook()} style={{ whiteSpace: 'nowrap' }}>⭳ Skyhook</button>
            )}
          </div>
          <div style={{ color: 'var(--gold)', fontSize: '.72rem', marginTop: '.15rem' }}>= {fmtIsk(pot)} ISK</div>
        </div>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 120px', minWidth: 110 }}>
          <label style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Corp-cut %</label>
          <input type="number" value={s.taxPct} onChange={e => setField('taxPct', Math.max(0, Math.min(100, +e.target.value)))}
            style={{ width: '100%', background: 'rgba(255,255,255,.05)', border: '1px solid var(--border)', borderRadius: 6, color: 'inherit', padding: '.3rem .5rem', fontSize: '.95rem', marginTop: '.2rem' }} />
          <div style={{ color: 'var(--text-dim)', fontSize: '.72rem', marginTop: '.15rem' }}>te verdelen: {fmtIsk(afterTax)}</div>
        </div>
        <div className="card" style={{ padding: '.55rem .8rem', flex: '1 1 160px', minWidth: 150 }}>
          <label style={{ fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Verdeling</label>
          <div style={{ display: 'flex', gap: '.35rem', marginTop: '.25rem' }}>
            <button className="btn btn-sm" onClick={() => setField('mode', 'time')}
              style={s.mode === 'time' ? { background: 'var(--blue)', color: '#04121a', fontWeight: 700 } : undefined}>Naar tijd</button>
            <button className="btn btn-sm" onClick={() => setField('mode', 'even')}
              style={s.mode === 'even' ? { background: 'var(--blue)', color: '#04121a', fontWeight: 700 } : undefined}>Gelijk</button>
          </div>
        </div>
      </div>

      {!rows.length && (
        <div className="card" style={{ padding: '1rem', color: 'var(--text-dim)' }}>
          {s.running ? 'Fleet uitlezen…' : 'Klik ▶ Start op terwijl je in de fleet zit (als FC/boss). De meedoen-tijd loopt dan live mee.'}
        </div>
      )}

      {!!rows.length && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.86rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)' }}>
                {[['Piloot', 'left'], ['Schip', 'left'], ['Meedoen-tijd', 'right'], ['Aandeel', 'right'], ['Uitbetaling', 'right'], ['', 'right']].map(([h, al], i) => (
                  <th key={i} style={{ padding: '.6rem .7rem', fontSize: '.64rem', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', textAlign: al as 'left' | 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const share = shareOf(r.part)
                const pct = s.mode === 'even'
                  ? (rows.length ? 100 / rows.length : 0)
                  : (totalMs > 0 ? (r.part / totalMs) * 100 : (rows.length ? 100 / rows.length : 0))
                const gone = r.presentSince === null && s.running
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', opacity: gone ? .55 : 1 }}>
                    <td style={{ padding: '.4rem .7rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.45rem' }}>
                        <EveImage category="characters" id={Number(r.id)} variation="portrait" size={32} px={22} round />
                        <span>{r.name || r.id}{gone && <span style={{ color: 'var(--red)', fontSize: '.66rem' }}> · weg</span>}</span>
                      </span>
                    </td>
                    <td style={{ padding: '.4rem .7rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem', color: 'var(--text-dim)' }}>
                        {r.shipTypeId ? <EveImage category="types" id={r.shipTypeId} variation="icon" size={32} px={18} /> : null}
                        <span>{ships[r.shipTypeId] || ''}</span>
                      </span>
                    </td>
                    <td style={{ padding: '.4rem .7rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtDur(r.part)}</td>
                    <td style={{ padding: '.4rem .7rem', textAlign: 'right', color: 'var(--text-dim)' }}>{pct.toFixed(1)}%</td>
                    <td style={{ padding: '.4rem .7rem', textAlign: 'right', color: 'var(--green)', fontWeight: 700 }}>{fmtIsk(share)}</td>
                    <td style={{ padding: '.4rem .7rem', textAlign: 'right' }}>
                      <button className="btn btn-sm" title="Bedrag kopiëren"
                        onClick={() => { void navigator.clipboard?.writeText(String(Math.round(share))) }}>⧉</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.6rem .9rem', gap: '.6rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>
              {rows.length} leden · totale tijd {fmtDur(totalMs)} · uit te betalen {fmtIsk(afterTax)}
            </span>
            <button className="btn btn-sm" onClick={copyPayouts}>⧉ Kopieer uitbetaallijst</button>
          </div>
        </div>
      )}

      <p style={{ color: 'var(--text-dim)', fontSize: '.76rem', marginTop: '1rem' }}>
        De <strong>FC/fleet-boss</strong> start de op terwijl iedereen in de fleet zit; de meedoen-tijd wordt elke {POLL_MS / 1000}s live
        bijgewerkt via ESI. Wie <strong>later instapt of eerder stopt</strong> telt naar rato minder mee (verdeling “Naar tijd”).
        <strong> Buit:</strong> bij een <strong>ESS</strong> krijg je <strong>Bounty SCC Encrypted Bonds</strong> (10K/100K/1M/10M).
        De knop <em>⭳ ESS Bonds</em> telt die bonds in je cargo/hangar op nominale waarde op — draai 'm op het character dat de ESS
        pakte (geen verzilveren nodig). <strong>Skyhook-loot</strong> = Magmatic Gas + Superionic Ice; <em>⭳ Skyhook</em> telt die
        uit je cargo tegen Jita-verkoopprijs op (zelfde prijsbron als Janice).
        <strong>Skyhook-loot</strong> zijn items, geen ISK, dus die vul je zelf in (Jita-waarde). Fleet-broadcasts zitten
        niet in ESI, dus daar kan de buit niet uit. Houd de pagina open tijdens de op; de sessie blijft bij een refresh.
      </p>
    </Layout>
  )
}
