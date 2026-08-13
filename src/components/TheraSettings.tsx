import { useCallback, useEffect, useState, type CSSProperties } from 'react'

// Instellingen voor de Thera-wachtpost (api/thera.php): Discord-webhook,
// waaklijst en het ijkpunt voor de afstand. Wordt op twee plekken getoond —
// in Admin → Instellingen en achter de ⚙-knop op /thera — dus staat het hier
// één keer, zodat de twee niet uit elkaar kunnen lopen.

export interface TheraCfg {
  enabled: boolean
  webhook: string
  ping: string
  home: number
  maxJumps: number
  regions: number[]
  systems: string[]
  pollUrl: string
}

const VELD: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: '#05050e', border: '1px solid var(--border)',
  borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.5rem',
  outline: 'none', fontFamily: 'inherit',
}
const KOP: CSSProperties = {
  fontSize: '0.62rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '0.25rem',
}
const KNOP: CSSProperties = {
  background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)',
  fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.95rem', cursor: 'pointer',
}
const KNOP2: CSSProperties = {
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)',
  fontSize: '0.72rem', padding: '0.35rem 0.8rem', cursor: 'pointer',
}

export default function TheraSettings({ token, onSaved }: { token: string; onSaved?: () => void }) {
  const [cfg, setCfg] = useState<TheraCfg | null>(null)
  const [fout, setFout] = useState('')
  const [melding, setMelding] = useState('')

  const zeg = useCallback((t: string) => { setMelding(t); setTimeout(() => setMelding(''), 3500) }, [])

  useEffect(() => {
    if (!token) return
    let weg = false
    void (async () => {
      try {
        const res = await fetch(`/api/thera.php?action=config&token=${encodeURIComponent(token)}`)
        const d = await res.json()
        if (weg) return
        if (res.ok && d.ok) setCfg(d as TheraCfg)
        else setFout('Instellingen ophalen mislukt — ben je ingelogd met je admin-character?')
      } catch { if (!weg) setFout('Kon de instellingen niet ophalen.') }
    })()
    return () => { weg = true }
  }, [token])

  const bewaar = useCallback(async () => {
    if (!cfg) return
    try {
      const res = await fetch('/api/thera.php?action=config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cfg, token }),
      })
      const d = await res.json().catch(() => ({}))
      zeg(res.ok && d.ok ? '✅ Opgeslagen' : `⚠ ${d.error || 'Opslaan mislukt'}`)
      if (res.ok && d.ok) onSaved?.()
    } catch { zeg('⚠ Opslaan mislukt') }
  }, [cfg, token, zeg, onSaved])

  const test = useCallback(async () => {
    try {
      const res = await fetch(`/api/thera.php?action=test&token=${encodeURIComponent(token)}`)
      const d = await res.json().catch(() => ({}))
      zeg(d.ok ? '✅ Testbericht verstuurd — kijk in Discord' : `⚠ ${d.error || 'Versturen mislukt'}`)
    } catch { zeg('⚠ Versturen mislukt') }
  }, [token, zeg])

  if (fout) return <div style={{ fontSize: '0.7rem', color: 'var(--red)' }}>{fout}</div>
  if (!cfg) return <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Instellingen laden…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      <div>
        <div style={KOP}>DISCORD-WEBHOOK-URL</div>
        <input
          value={cfg.webhook}
          onChange={e => setCfg({ ...cfg, webhook: e.target.value })}
          placeholder="https://discord.com/api/webhooks/…"
          style={{ ...VELD, fontFamily: 'monospace' }}
        />
        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
          In Discord: rechtermuisknop op het kanaal → <em>Kanaal bewerken</em> → <em>Integraties</em> → <em>Webhooks</em> →
          <em> Nieuwe webhook</em> → <em>Webhook-URL kopiëren</em>. Plak die hier en druk op Opslaan.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <div style={KOP}>PING BIJ MELDING (LEEG = GEEN)</div>
          <input value={cfg.ping} onChange={e => setCfg({ ...cfg, ping: e.target.value })}
            placeholder="@here" style={VELD} />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <div style={KOP}>IJKPUNT AFSTAND (SYSTEEM-ID)</div>
          <input value={cfg.home} onChange={e => setCfg({ ...cfg, home: Number(e.target.value) || 0 })} style={VELD} />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <div style={KOP}>OOK MELDEN BINNEN … SPRONGEN (0 = UIT)</div>
          <input type="number" min={0} max={25} value={cfg.maxJumps}
            onChange={e => setCfg({ ...cfg, maxJumps: Number(e.target.value) })} style={VELD} />
        </div>
      </div>

      <div>
        <div style={KOP}>WAAKLIJST — {cfg.systems.length} SYSTEMEN</div>
        <textarea
          value={cfg.systems.join(' ')}
          onChange={e => setCfg({ ...cfg, systems: e.target.value.split(/[\s,]+/).filter(Boolean) })}
          rows={3}
          style={{ ...VELD, fontFamily: 'monospace', lineHeight: 1.6, resize: 'vertical' }}
        />
        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
          Namen of id's, gescheiden door spatie of komma. Een naam die niet bestaat wordt geweigerd bij het opslaan.
        </div>
      </div>

      <div>
        <div style={KOP}>HELE REGIO'S ERBIJ (LEEG = ALLEEN DE WAAKLIJST)</div>
        <input
          value={cfg.regions.join(', ')}
          onChange={e => setCfg({ ...cfg, regions: e.target.value.split(',').map(s => Number(s.trim())).filter(Boolean) })}
          placeholder="10000060 = Delve · 10000050 = Querious · 10000063 = Period Basis"
          style={VELD}
        />
      </div>

      <label style={{ fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
        <input type="checkbox" checked={cfg.enabled} onChange={e => setCfg({ ...cfg, enabled: e.target.checked })} />
        Meldingen aan
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button onClick={() => void test()} style={KNOP2}>Testbericht sturen</button>
        {melding && <span style={{ fontSize: '0.7rem', color: melding.startsWith('✅') ? 'var(--green)' : 'var(--red)' }}>{melding}</span>}
        <button onClick={() => void bewaar()} style={{ ...KNOP, marginLeft: 'auto' }}>Opslaan</button>
      </div>

      <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', wordBreak: 'break-all', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
        Zonder cron meldt de server alleen terwijl iemand de pagina open heeft. Laat dit adres elke 5 minuten
        aantikken (bijvoorbeeld vanaf de Pi):<br />
        <code style={{ color: 'var(--text)' }}>{cfg.pollUrl}</code>
      </div>
    </div>
  )
}
