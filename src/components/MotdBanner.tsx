import { useEffect, useState } from 'react'

// Toont de admin-mededeling (MOTD) bovenaan; dismissbaar, en verschijnt opnieuw
// zodra de tekst verandert.
export default function MotdBanner() {
  const [motd, setMotd] = useState<{ text: string; enabled: boolean } | null>(null)
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    fetch('/api/motd.php')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { text: string; enabled: boolean } | null) => {
        if (!d || !d.enabled || !d.text.trim()) return
        setMotd(d)
        setDismissed(localStorage.getItem('motd_dismissed') === d.text)
      })
      .catch(() => {})
  }, [])

  if (!motd || dismissed) return null

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
      padding: '0.55rem 1rem',
      background: 'linear-gradient(90deg, rgba(240,192,64,0.14), rgba(240,192,64,0.06))',
      borderBottom: '1px solid rgba(240,192,64,0.35)',
      color: 'var(--gold)', fontSize: '0.78rem', lineHeight: 1.5, flexShrink: 0,
    }}>
      <span style={{ flexShrink: 0 }}>📢</span>
      <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
        {motd.text}
      </div>
      <button
        onClick={() => { localStorage.setItem('motd_dismissed', motd.text); setDismissed(true) }}
        aria-label="Mededeling sluiten"
        style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--gold)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 0.2rem' }}
      >×</button>
    </div>
  )
}
