import { useEffect, useState } from 'react'

type MotdType = 'info' | 'warning' | 'success' | 'event'

interface Motd { text: string; enabled: boolean; type: MotdType; until?: string; link?: string }

// Stijl per mededeling-type (kleur + icoon).
const MOTD_STYLE: Record<MotdType, { color: string; icon: string }> = {
  info:    { color: '0,180,216',  icon: '📢' },
  warning: { color: '240,192,64', icon: '⚠️' },
  success: { color: '62,207,110', icon: '✓' },
  event:   { color: '167,139,250', icon: '📅' },
}

// Toont de admin-mededeling (MOTD) bovenaan; dismissbaar, en verschijnt opnieuw
// zodra de tekst verandert.
export default function MotdBanner() {
  const [motd, setMotd] = useState<Motd | null>(null)
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    fetch('/api/motd.php')
      .then(r => (r.ok ? r.json() : null))
      .then((d: Motd | null) => {
        if (!d || !d.enabled || !d.text.trim()) return
        // Auto-verloop: verberg als de einddatum verstreken is.
        if (d.until && d.until.trim()) {
          const end = new Date(d.until).getTime()
          if (!isNaN(end) && end < Date.now()) return
        }
        setMotd({ ...d, type: d.type ?? 'info' })
        setDismissed(localStorage.getItem('motd_dismissed') === d.text)
      })
      .catch(() => {})
  }, [])

  if (!motd || dismissed) return null

  const { color, icon } = MOTD_STYLE[motd.type] ?? MOTD_STYLE.info

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
      padding: '0.55rem 1rem',
      background: `linear-gradient(90deg, rgba(${color},0.16), rgba(${color},0.05))`,
      borderBottom: `1px solid rgba(${color},0.4)`,
      fontSize: '0.78rem', lineHeight: 1.5, flexShrink: 0,
    }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
        {motd.text}
      </div>
      {motd.link && motd.link.trim() && (
        <a
          href={motd.link}
          target="_blank"
          rel="noopener noreferrer"
          style={{ flexShrink: 0, alignSelf: 'center', fontSize: '0.7rem', fontWeight: 700, color: `rgb(${color})`, border: `1px solid rgba(${color},0.5)`, borderRadius: 3, padding: '0.15rem 0.5rem', textDecoration: 'none', whiteSpace: 'nowrap' }}
        >Bekijk →</a>
      )}
      <button
        onClick={() => { localStorage.setItem('motd_dismissed', motd.text); setDismissed(true) }}
        aria-label="Mededeling sluiten"
        style={{ flexShrink: 0, background: 'none', border: 'none', color: `rgb(${color})`, cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 0.2rem' }}
      >×</button>
    </div>
  )
}
