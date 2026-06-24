import { useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'

// Plaktekst → unieke [A, B]-paren. Splitst op pijl/pipe-scheiders (GEEN kaal koppelteken —
// nullsec-namen als 5T-KM3 bevatten koppeltekens); A»B en B»A worden samengevoegd.
function parseLines(text: string): [string, string][] {
  const seen = new Set<string>()
  const out: [string, string][] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line) continue
    let parts = line.split(/\s*(?:»|›|→|↔|<->|->|=>|\||\t|,|;)\s*/).filter(Boolean)
    if (parts.length < 2) parts = line.split(/\s+(?:[-–—>])\s+/).filter(Boolean)
    if (parts.length < 2) continue
    const a = parts[0].trim().toUpperCase(), b = parts[1].trim().toUpperCase()
    if (!a || !b || a === b) continue
    const key = [a, b].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key); out.push([a, b])
  }
  return out
}
const toText = (pairs: [string, string][]) => pairs.map(([a, b]) => `${a} » ${b}`).join('\n')

export default function Ansiblex() {
  const { activeTokens, mainCharId } = useAuth()
  const token = (activeTokens.find(t => t.characterId === mainCharId) ?? activeTokens[0])?.accessToken
  const [text, setText]     = useState('')
  const [saved, setSaved]   = useState('')   // laatst opgeslagen versie (voor 'gewijzigd?')
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'err'>('idle')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/ansiblex.php', { cache: 'no-store' }).then(r => r.json())
      .then((d: { bridges?: [string, string][] }) => {
        const t = toText(Array.isArray(d?.bridges) ? d.bridges : [])
        setText(t); setSaved(t)
      }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const pairs = parseLines(text)
  const dirty = text.trim() !== saved.trim()

  function save() {
    if (!token) { setStatus('err'); return }
    setStatus('saving')
    fetch('/api/ansiblex.php', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, bridges: pairs }) })
      .then(r => r.json())
      .then(() => {
        const t = toText(pairs)            // genormaliseerd + gededupet
        setText(t); setSaved(t); setStatus('done'); setTimeout(() => setStatus('idle'), 1800)
      })
      .catch(() => setStatus('err'))
  }

  function copy() {
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => {})
  }

  return (
    <Layout header={<PageHeader title="Ansiblex-lijst" sub={`${pairs.length} verbindingen · gedeeld met de corp`} />}>
      <div style={{ maxWidth: 560 }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={18} spellCheck={false}
          placeholder={loading ? 'Laden…' : 'LXWN-W » AH-B84\n15W-GC » UMI-KK\n…'}
          style={{ width: '100%', boxSizing: 'border-box', background: '#05050e', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: '0.8rem', fontFamily: 'monospace', lineHeight: 1.6, padding: '0.7rem 0.9rem', outline: 'none', resize: 'vertical' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
          <button onClick={save} disabled={!dirty || status === 'saving'}
            style={{ padding: '0.4rem 1rem', borderRadius: 4, fontSize: '0.74rem', fontWeight: 600, cursor: dirty && status !== 'saving' ? 'pointer' : 'not-allowed',
              background: 'rgba(62,207,110,0.12)', border: '1px solid var(--green)', color: 'var(--green)', opacity: dirty ? 1 : 0.5 }}>
            {status === 'saving' ? 'Opslaan…' : status === 'done' ? '✓ Opgeslagen' : '💾 Opslaan'}
          </button>
          <button onClick={copy}
            style={{ padding: '0.4rem 1rem', borderRadius: 4, fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer',
              background: copied ? 'rgba(62,207,110,0.12)' : 'transparent', border: `1px solid ${copied ? 'var(--green)' : 'var(--border)'}`, color: copied ? 'var(--green)' : 'var(--text)' }}>
            {copied ? '✓ Gekopieerd' : '📋 Kopiëren'}
          </button>
          {status === 'err' && <span style={{ fontSize: '0.68rem', color: 'var(--red)' }}>Opslaan mislukt — ben je ingelogd?</span>}
          {dirty && status !== 'err' && <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>niet-opgeslagen wijzigingen</span>}
        </div>
      </div>
    </Layout>
  )
}
