import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import { usePageLoading } from '../hooks/usePageLoading'
import { useIntelSystems, INTEL_SUPPORTED } from '../hooks/useIntelSystems'
import { getSystems, getSystemJumps, getCharacterLocation, getCharacterShip, resolveNames } from '../api/esi'

// Ratting-alarm: waarschuwt zo vroeg mogelijk als er gevaar opduikt bij een
// character dat je aangevinkt hebt. Het kijkt naar waar je characters zitten
// (ESI-locatie, eigen token) en legt dat naast de intel uit de chatlogs en de
// open Thera/Turnur-gaten.
//
// Het alarm wáárschuwt alleen — warpen doe je zelf. Automatisch handelen namens
// de speler is botting en in strijd met de EVE-EULA; dat zit hier dus niet in,
// en moet er ook niet in komen.

const LOC_SCOPE = 'esi-location.read_location.v1'
const SHIP_SCOPE = 'esi-location.read_ship_type.v1'
const POLL_MS = 6000            // ESI cachet de locatie 5s; sneller vragen heeft geen zin
const THERA_MS = 60_000
const LS_CHARS = 'alarm_chars_v1'
const LS_SET = 'alarm_settings_v1'

const LABEL: CSSProperties = {
  fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.25rem',
}
const TH: CSSProperties = {
  textAlign: 'left', padding: '0.4rem 0.7rem', color: 'var(--text-dim)', fontSize: '0.58rem',
  fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const TD: CSSProperties = { textAlign: 'left', padding: '0.45rem 0.7rem', fontSize: '0.78rem', whiteSpace: 'nowrap' }
const INPUT: CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  color: 'var(--text)', fontSize: '0.75rem', padding: '0.35rem 0.5rem', outline: 'none',
}
const KNOP: CSSProperties = { ...INPUT, cursor: 'pointer', fontWeight: 600, fontSize: '0.66rem' }

function pil(kleur: string, bg: string): CSSProperties {
  return {
    fontSize: '0.56rem', fontWeight: 800, letterSpacing: '0.05em', padding: '0.1rem 0.4rem',
    borderRadius: 999, whiteSpace: 'nowrap', color: kleur, background: bg, border: `1px solid ${kleur}`,
  }
}

/** Scopes uit een EVE-JWT (om te melden dat iemand opnieuw moet inloggen). */
function scopesVan(token: string): string[] {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return Array.isArray(p.scp) ? p.scp : p.scp ? [p.scp] : []
  } catch { return [] }
}

/** Sprongen vanaf één systeem via poorten, tot maximaal `max` diep. */
function afstanden(map: Record<string, number[]>, van: number, max: number): Map<number, number> {
  const dist = new Map<number, number>([[van, 0]])
  let laag = [van]
  for (let d = 1; d <= max && laag.length; d++) {
    const volgende: number[] = []
    for (const sid of laag) {
      for (const buur of map[String(sid)] ?? []) {
        if (dist.has(buur)) continue
        dist.set(buur, d)
        volgende.push(buur)
      }
    }
    laag = volgende
  }
  return dist
}

interface Dreiging {
  key: string
  sysId: number
  systeem: string
  soort: 'intel' | 'gat'
  tekst: string
  tijd: number
}

interface Locatie { sysId: number; systeem: string; schip?: string }

interface Instellingen { jumps: number; geluid: boolean; intel: boolean; gaten: boolean }
const STANDAARD: Instellingen = { jumps: 3, geluid: true, intel: true, gaten: true }

export default function Alarm() {
  const { activeTokens } = useAuth()

  const [scherp, setScherp] = useState(false)
  const [gekozen, setGekozen] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_CHARS) || '[]') } catch { return [] }
  })
  const [set, setSet] = useState<Instellingen>(() => {
    try { return { ...STANDAARD, ...JSON.parse(localStorage.getItem(LS_SET) || '{}') } } catch { return STANDAARD }
  })
  const [locs, setLocs] = useState<Record<number, Locatie>>({})
  const [systems, setSystems] = useState<Record<string, [string, number, number]>>({})
  const [jumpMap, setJumpMap] = useState<Record<string, number[]>>({})
  const [gaten, setGaten] = useState<Dreiging[]>([])
  const [laden, setLaden] = useState(true)

  const audio = useRef<AudioContext | null>(null)
  const gemeld = useRef<Set<string>>(new Set())
  const oudeTitel = useRef<string>('')

  const intelHook = useIntelSystems(scherp && set.intel)
  const { systems: intel, status: intelStatus, connect: intelConnect, chooseFolder: intelKies } = intelHook

  usePageLoading(laden)

  useEffect(() => { localStorage.setItem(LS_CHARS, JSON.stringify(gekozen)) }, [gekozen])
  useEffect(() => { localStorage.setItem(LS_SET, JSON.stringify(set)) }, [set])

  // Statische kaartdata (systeemnamen + poortverbindingen) uit de meegedeployde bundels.
  useEffect(() => {
    void (async () => {
      const [s, j] = await Promise.all([getSystems(), getSystemJumps()])
      setSystems(s); setJumpMap(j); setLaden(false)
    })()
  }, [])

  const naamNaarId = useMemo(() => {
    const m = new Map<string, number>()
    for (const [id, v] of Object.entries(systems)) m.set(v[0].toUpperCase(), Number(id))
    return m
  }, [systems])

  // ── Waar zitten mijn characters? ──────────────────────────────────────────
  const haalLocaties = useCallback(async () => {
    const toDo = activeTokens.filter(t => gekozen.includes(t.characterId))
    if (!toDo.length) return
    const uit: Record<number, Locatie> = {}
    await Promise.all(toDo.map(async t => {
      const loc = await getCharacterLocation(t.characterId, t.accessToken)
      if (!loc?.solar_system_id) return
      const sys = systems[String(loc.solar_system_id)]
      let schip: string | undefined
      if (scopesVan(t.accessToken).includes(SHIP_SCOPE)) {
        const s = await getCharacterShip(t.characterId, t.accessToken)
        if (s?.ship_type_id) schip = (await resolveNames([s.ship_type_id])).get(s.ship_type_id)
      }
      uit[t.characterId] = { sysId: loc.solar_system_id, systeem: sys?.[0] ?? `#${loc.solar_system_id}`, schip }
    }))
    setLocs(prev => ({ ...prev, ...uit }))
  }, [activeTokens, gekozen, systems])

  useEffect(() => {
    if (!scherp) return
    void haalLocaties()
    const t = setInterval(() => void haalLocaties(), POLL_MS)
    return () => clearInterval(t)
  }, [scherp, haalLocaties])

  // ── Open wormholes als dreiging ───────────────────────────────────────────
  useEffect(() => {
    if (!scherp || !set.gaten) { setGaten([]); return }
    const haal = async () => {
      try {
        const r = await fetch('/api/thera.php?action=list')
        const d = await r.json()
        setGaten((d.rows ?? []).map((x: { sig_id: string; system_id: number; system: string; out_system: string; maat: string; first_seen: string }) => ({
          key: `gat:${x.sig_id}`, sysId: x.system_id, systeem: x.system, soort: 'gat' as const,
          tekst: `gat vanuit ${x.out_system} · ${x.maat}`, tijd: Date.parse(x.first_seen),
        })))
      } catch { /* stil */ }
    }
    void haal()
    const t = setInterval(() => void haal(), THERA_MS)
    return () => clearInterval(t)
  }, [scherp, set.gaten])

  // ── Alle dreigingen op een rij ────────────────────────────────────────────
  const dreigingen = useMemo<Dreiging[]>(() => {
    const uit: Dreiging[] = []
    if (set.intel) {
      for (const g of Object.values(intel)) {
        if (g.threat === 'clear') continue
        const sysId = naamNaarId.get(g.system.toUpperCase())
        if (!sysId) continue
        uit.push({
          key: `intel:${g.system}:${g.time}`, sysId, systeem: g.system, soort: 'intel',
          tekst: g.entries[0]?.message ?? 'gemeld in intel', tijd: g.time,
        })
      }
    }
    if (set.gaten) uit.push(...gaten)
    return uit
  }, [intel, gaten, set.intel, set.gaten, naamNaarId])

  // ── Wie loopt er gevaar? ──────────────────────────────────────────────────
  const alarmen = useMemo(() => {
    if (!scherp || !Object.keys(jumpMap).length) return []
    const uit: { charId: number; naam: string; locatie: Locatie; dreiging: Dreiging; jumps: number }[] = []
    for (const t of activeTokens) {
      if (!gekozen.includes(t.characterId)) continue
      const loc = locs[t.characterId]
      if (!loc) continue
      const dist = afstanden(jumpMap, loc.sysId, set.jumps)
      for (const d of dreigingen) {
        const j = dist.get(d.sysId)
        if (j === undefined) continue
        uit.push({ charId: t.characterId, naam: t.characterName, locatie: loc, dreiging: d, jumps: j })
      }
    }
    return uit.sort((a, b) => a.jumps - b.jumps)
  }, [scherp, activeTokens, gekozen, locs, dreigingen, jumpMap, set.jumps])

  // ── Herrie maken ──────────────────────────────────────────────────────────
  const piep = useCallback(() => {
    const ctx = audio.current
    if (!ctx || !set.geluid) return
    const nu = ctx.currentTime
    // Twee tonen achter elkaar — klinkt als een alarm, niet als een notificatie.
    for (const [i, f] of [880, 660].entries()) {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'square'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, nu + i * 0.22)
      g.gain.exponentialRampToValueAtTime(0.18, nu + i * 0.22 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, nu + i * 0.22 + 0.2)
      o.connect(g); g.connect(ctx.destination)
      o.start(nu + i * 0.22); o.stop(nu + i * 0.22 + 0.21)
    }
  }, [set.geluid])

  useEffect(() => {
    if (!scherp || !alarmen.length) return
    piep()
    const t = setInterval(piep, 1400)
    return () => clearInterval(t)
  }, [scherp, alarmen.length, piep])

  // Titel laten knipperen zodat je het ook ziet met het tabblad op de achtergrond.
  useEffect(() => {
    if (!alarmen.length) return
    if (!oudeTitel.current) oudeTitel.current = document.title
    let aan = false
    const t = setInterval(() => { aan = !aan; document.title = aan ? '⚠⚠ GEVAAR ⚠⚠' : (oudeTitel.current || 'EVE Dashboard') }, 700)
    return () => { clearInterval(t); document.title = oudeTitel.current || 'EVE Dashboard' }
  }, [alarmen.length])

  // Systeemmelding, één keer per dreiging per character.
  useEffect(() => {
    if (!scherp || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    for (const a of alarmen) {
      const k = `${a.charId}:${a.dreiging.key}`
      if (gemeld.current.has(k)) continue
      gemeld.current.add(k)
      new Notification(`⚠ ${a.jumps === 0 ? 'IN JOUW SYSTEEM' : `${a.jumps} sprongen`} — ${a.naam}`, {
        body: `${a.dreiging.systeem}: ${a.dreiging.tekst}`,
      })
    }
  }, [alarmen, scherp])

  // ── Scherp zetten (hier mag het geluid aan van de browser) ────────────────
  const zetScherp = useCallback(async () => {
    if (scherp) { setScherp(false); audio.current?.close().catch(() => {}); audio.current = null; return }
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audio.current = new Ctx()
      await audio.current.resume()
    } catch { /* geen geluid, de rest werkt wel */ }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    gemeld.current.clear()
    setScherp(true)
  }, [scherp])

  const zonderScope = activeTokens.filter(t => gekozen.includes(t.characterId) && !scopesVan(t.accessToken).includes(LOC_SCOPE))
  const dichtste = alarmen[0]

  return (
    <Layout header={
      <PageHeader
        title="🚨 Ratting-alarm"
        sub="Waarschuwt als er gevaar opduikt bij je aangevinkte characters — jij warpt zelf, dit alarm koopt je de seconden."
      />
    }>
      <style>{`@keyframes alarmFlits{0%,100%{background:rgba(224,85,85,.20)}50%{background:rgba(224,85,85,.06)}}`}</style>

      {/* Het alarm zelf */}
      {!!alarmen.length && dichtste && (
        <div style={{
          border: '2px solid var(--red)', borderRadius: 4, padding: '0.9rem 1.1rem', marginBottom: '0.8rem',
          animation: 'alarmFlits 0.9s ease-in-out infinite',
        }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--red)', letterSpacing: '0.02em' }}>
            ⚠ {dichtste.jumps === 0 ? 'GEVAAR IN JE EIGEN SYSTEEM' : `GEVAAR OP ${dichtste.jumps} SPRONG${dichtste.jumps === 1 ? '' : 'EN'}`}
          </div>
          <div style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>
            <strong>{dichtste.naam}</strong> zit in <strong>{dichtste.locatie.systeem}</strong>
            {dichtste.locatie.schip ? ` (${dichtste.locatie.schip})` : ''} — {dichtste.dreiging.systeem}: {dichtste.dreiging.tekst}
          </div>
          {alarmen.length > 1 && (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
              en nog {alarmen.length - 1} melding{alarmen.length - 1 === 1 ? '' : 'en'} — zie de lijst hieronder
            </div>
          )}
        </div>
      )}

      {/* Aan/uit + instellingen */}
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
        <button onClick={() => void zetScherp()} style={{
          ...KNOP, fontSize: '0.8rem', padding: '0.5rem 1.1rem', borderRadius: 3,
          background: scherp ? 'var(--red)' : 'var(--surface2)',
          color: scherp ? '#0a0a12' : 'var(--text)',
          borderColor: scherp ? 'var(--red)' : 'var(--border)',
        }}>
          {scherp ? '■ Alarm uitzetten' : '▶ Alarm scherp zetten'}
        </button>

        <div>
          <div style={LABEL}>WAARSCHUW BINNEN … SPRONGEN</div>
          <input type="number" min={0} max={10} value={set.jumps}
            onChange={e => setSet(s => ({ ...s, jumps: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }))}
            style={{ ...INPUT, width: 70 }} />
        </div>

        <label style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.35rem', paddingBottom: '0.4rem' }}>
          <input type="checkbox" checked={set.geluid} onChange={e => setSet(s => ({ ...s, geluid: e.target.checked }))} />
          geluid
        </label>
        <label style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.35rem', paddingBottom: '0.4rem' }}>
          <input type="checkbox" checked={set.intel} onChange={e => setSet(s => ({ ...s, intel: e.target.checked }))} />
          intel uit chatlogs
        </label>
        <label style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.35rem', paddingBottom: '0.4rem' }}>
          <input type="checkbox" checked={set.gaten} onChange={e => setSet(s => ({ ...s, gaten: e.target.checked }))} />
          wormholes (Thera-wachtpost)
        </label>

        <span style={{ flex: 1 }} />
        <span style={{ ...pil(scherp ? 'var(--green)' : 'var(--text-dim)', scherp ? 'rgba(62,207,110,.12)' : 'rgba(255,255,255,.04)'), alignSelf: 'center' }}>
          {scherp ? 'SCHERP' : 'UIT'}
        </span>
      </div>

      {/* Chatlog-koppeling */}
      {scherp && set.intel && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '0.8rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {!INTEL_SUPPORTED
            ? <span style={{ color: 'var(--red)' }}>Deze browser kan geen chatlogs lezen — gebruik Chrome of Edge.</span>
            : intelStatus === 'live'
              ? <span style={{ color: 'var(--green)' }}>✓ Intel-kanalen worden gelezen</span>
              : <>
                  <span>Intel komt uit je EVE-chatlogs; geef de map <code>…\EVE\logs\Chatlogs\</code> vrij.</span>
                  <button onClick={() => void intelConnect()} style={KNOP}>Map koppelen</button>
                  <button onClick={() => void intelKies()} style={KNOP}>📁 andere map</button>
                </>}
        </div>
      )}

      {!!zonderScope.length && (
        <div style={{ fontSize: '0.72rem', color: 'var(--red)', marginBottom: '0.8rem' }}>
          Geen locatie-toestemming voor: {zonderScope.map(t => t.characterName).join(', ')} — log opnieuw in met dit character.
        </div>
      )}

      {/* Characters aanvinken */}
      <div style={LABEL}>CHARACTERS BEWAKEN</div>
      <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ ...TH, width: 40 }}>Aan</th>
              <th style={TH}>Character</th>
              <th style={TH}>Systeem</th>
              <th style={TH}>Schip</th>
              <th style={TH}>Dichtstbijzijnde dreiging</th>
            </tr>
          </thead>
          <tbody>
            {activeTokens.map(t => {
              const aan = gekozen.includes(t.characterId)
              const loc = locs[t.characterId]
              const mijn = alarmen.filter(a => a.charId === t.characterId)
              const eerste = mijn[0]
              return (
                <tr key={t.characterId} style={{
                  borderBottom: '1px solid var(--border)',
                  borderLeft: `2px solid ${eerste ? 'var(--red)' : aan ? 'var(--green)' : 'transparent'}`,
                  background: eerste ? 'rgba(224,85,85,.07)' : undefined,
                  opacity: aan ? 1 : 0.55,
                }}>
                  <td style={TD}>
                    <input type="checkbox" checked={aan}
                      onChange={e => setGekozen(g => e.target.checked ? [...g, t.characterId] : g.filter(x => x !== t.characterId))} />
                  </td>
                  <td style={{ ...TD, fontWeight: 600 }}>{t.characterName}</td>
                  <td style={TD}>{loc ? loc.systeem : (aan && scherp ? 'ophalen…' : '—')}</td>
                  <td style={{ ...TD, color: 'var(--text-dim)' }}>{loc?.schip ?? '—'}</td>
                  <td style={TD}>
                    {eerste
                      ? <span style={pil('var(--red)', 'rgba(224,85,85,.14)')}>
                          {eerste.jumps === 0 ? 'IN DIT SYSTEEM' : `${eerste.jumps} SPRONG${eerste.jumps === 1 ? '' : 'EN'}`} · {eerste.dreiging.systeem}
                        </span>
                      : <span style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>{aan && scherp ? 'rustig' : '—'}</span>}
                  </td>
                </tr>
              )
            })}
            {!activeTokens.length && (
              <tr><td style={{ ...TD, color: 'var(--text-dim)' }} colSpan={5}>Geen ingelogde characters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Wat er nu aan dreigingen bekend is */}
      <div style={LABEL}>DREIGINGEN IN BEELD ({dreigingen.length})</div>
      {!dreigingen.length && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          {scherp ? 'Niets gemeld op dit moment.' : 'Zet het alarm scherp om mee te kijken.'}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {dreigingen.slice(0, 25).map(d => (
          <div key={d.key} style={{ fontSize: '0.74rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={pil(d.soort === 'gat' ? 'var(--blue)' : 'var(--gold)',
                             d.soort === 'gat' ? 'rgba(0,180,216,.12)' : 'rgba(240,192,64,.12)')}>
              {d.soort === 'gat' ? 'WORMHOLE' : 'INTEL'}
            </span>
            <strong>{d.systeem}</strong>
            <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.tekst}</span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '1rem', lineHeight: 1.6 }}>
        Dit alarm <strong>waarschuwt alleen</strong> — warpen doe je zelf. Software die handelingen in het spel
        overneemt is botting en in strijd met de EVE-EULA. Locaties komen uit ESI met je eigen token
        (<code>{LOC_SCOPE}</code>), intel uit je eigen chatlogs; er wordt niets naar de client geschreven.
        Werkt zolang dit tabblad open staat, en ziet alleen wat er in de intel-kanalen gemeld wordt.
      </div>
    </Layout>
  )
}
