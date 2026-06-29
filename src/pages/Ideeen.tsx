import { useState, useEffect, useCallback } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'

interface Reply {
  id: number
  author: string
  isAdmin: boolean
  body: string
  createdAt: string
}
interface Idea {
  id: number
  author: string
  title: string
  body: string
  status: 'open' | 'gepland' | 'klaar'
  createdAt: string
  replies: Reply[]
}

type Status = Idea['status']
const STATUSES: Status[] = ['open', 'gepland', 'klaar']
const STATUS_META: Record<Status, { label: string; color: string }> = {
  open:    { label: 'Open',    color: 'var(--blue)' },
  gepland: { label: 'Gepland', color: 'var(--gold)' },
  klaar:   { label: 'Klaar',   color: 'var(--green)' },
}

function fmt(ts: string) {
  const d = new Date(ts.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ts
  return d.toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─── Statuslabel ────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: Status }) {
  const m = STATUS_META[status]
  return (
    <span style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: m.color, border: `1px solid ${m.color}`, borderRadius: 3, padding: '0.1rem 0.4rem', background: 'rgba(0,0,0,0.2)' }}>
      {m.label}
    </span>
  )
}

// ─── Eén idee-kaart (met reacties + reageren; admin: status + verwijderen) ────
function IdeaCard({ idea, isAdmin, token, charName, onChanged }: {
  idea: Idea; isAdmin: boolean; token: string; charName: string; onChanged: () => void
}) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)

  async function post(payload: object) {
    setBusy(true)
    try {
      await fetch('/api/ideeen.php', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, characterName: charName, ...payload }) })
      onChanged()
    } finally { setBusy(false) }
  }

  async function sendReply() {
    const body = reply.trim()
    if (!body) return
    setReply('')
    await post({ action: 'reply', ideaId: idea.id, body })
  }

  async function setStatus(status: Status) { await post({ action: 'status', ideaId: idea.id, status }) }

  async function remove() {
    if (!confirm('Dit idee verwijderen?')) return
    setBusy(true)
    try {
      await fetch('/api/ideeen.php', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ideaId: idea.id }) })
      onChanged()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.85rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>{idea.title || 'Idee'}</span>
            <StatusBadge status={idea.status} />
          </div>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>
            {isAdmin && <span style={{ color: 'var(--blue)' }}>{idea.author} · </span>}{fmt(idea.createdAt)}
          </div>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
            {STATUSES.map(s => (
              <button key={s} onClick={() => setStatus(s)} disabled={busy || s === idea.status} title={`Status: ${STATUS_META[s].label}`}
                style={{ padding: '0.15rem 0.4rem', borderRadius: 2, fontSize: '0.58rem', fontWeight: 700, cursor: s === idea.status ? 'default' : 'pointer',
                  background: s === idea.status ? 'rgba(0,0,0,0.25)' : 'transparent',
                  border: `1px solid ${s === idea.status ? STATUS_META[s].color : 'var(--border)'}`,
                  color: s === idea.status ? STATUS_META[s].color : 'var(--text-dim)', opacity: s === idea.status ? 1 : 0.7 }}>
                {STATUS_META[s].label}
              </button>
            ))}
            <button onClick={remove} disabled={busy} title="Verwijderen"
              style={{ background: 'transparent', border: 'none', color: 'rgba(224,85,85,0.5)', cursor: 'pointer', fontSize: '0.8rem', padding: '0.1rem 0.25rem' }}>✕</button>
          </div>
        )}
      </div>

      <div style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.6, marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>{idea.body}</div>

      {/* Reacties */}
      {idea.replies.length > 0 && (
        <div style={{ marginTop: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', borderLeft: '2px solid var(--border)', paddingLeft: '0.7rem' }}>
          {idea.replies.map(r => (
            <div key={r.id}>
              <div style={{ fontSize: '0.6rem', marginBottom: '0.1rem' }}>
                <span style={{ fontWeight: 700, color: r.isAdmin ? 'var(--gold)' : 'var(--blue)' }}>{r.author}</span>
                {r.isAdmin && <span style={{ color: 'var(--gold)', marginLeft: '0.3rem' }}>· admin</span>}
                <span style={{ color: 'var(--text-dim)', marginLeft: '0.3rem' }}>{fmt(r.createdAt)}</span>
              </div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{r.body}</div>
            </div>
          ))}
        </div>
      )}

      {/* Reageren */}
      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
        <input value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendReply()}
          placeholder={isAdmin ? 'Reageer als admin…' : 'Reactie toevoegen…'}
          style={{ flex: 1, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.35rem 0.6rem', outline: 'none' }} />
        <button onClick={sendReply} disabled={busy || !reply.trim()}
          style={{ padding: '0.35rem 0.7rem', borderRadius: 2, fontSize: '0.68rem', cursor: reply.trim() ? 'pointer' : 'not-allowed',
            background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.35)', color: 'var(--blue)', opacity: reply.trim() ? 1 : 0.5 }}>
          Stuur
        </button>
      </div>
    </div>
  )
}

// ─── Hoofdpagina ──────────────────────────────────────────────────────────────
export default function Ideeen() {
  const { tokens, mainCharId } = useAuth()
  const tok = tokens.find(t => t.characterId === mainCharId) ?? tokens[0]
  const token = tok?.accessToken ?? ''
  const charName = tok?.characterName ?? ''

  const [ideas, setIdeas] = useState<Idea[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [filter, setFilter] = useState<'alle' | Status>('alle')

  const load = useCallback(() => {
    if (!token) { setLoading(false); return }
    fetch(`/api/ideeen.php?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { isAdmin?: boolean; ideas?: Idea[] }) => {
        setIsAdmin(!!d.isAdmin)
        setIdeas(Array.isArray(d.ideas) ? d.ideas : [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [token])

  useEffect(() => { load() }, [load])

  async function submit() {
    const b = body.trim()
    if (!b || !token) return
    setSending(true)
    try {
      const r = await fetch('/api/ideeen.php', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, characterName: charName, title: title.trim(), body: b }) })
      if (r.ok) {
        setTitle(''); setBody(''); setSent(true); setTimeout(() => setSent(false), 2500)
        load()
      }
    } finally { setSending(false) }
  }

  const shown = isAdmin && filter !== 'alle' ? ideas.filter(i => i.status === filter) : ideas
  const counts = STATUSES.reduce((acc, s) => { acc[s] = ideas.filter(i => i.status === s).length; return acc }, {} as Record<Status, number>)

  return (
    <Layout header={
      <PageHeader title="💡 Ideeënbus"
        sub={isAdmin ? `${ideas.length} idee(ën) · ${counts.open} open` : 'Stuur je idee in — alleen de leiding leest mee'} />
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', maxWidth: 760 }}>

        {/* Insturen */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.85rem 1rem' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.5rem' }}>NIEUW IDEE</div>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Titel (optioneel)"
            style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.78rem', padding: '0.4rem 0.6rem', outline: 'none', boxSizing: 'border-box', marginBottom: '0.4rem' }} />
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={4} placeholder="Beschrijf je idee of suggestie…"
            style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.78rem', padding: '0.5rem', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '0.5rem' }}>
            {sent && <span style={{ fontSize: '0.66rem', color: 'var(--green)', marginRight: 'auto' }}>✓ Verstuurd — bedankt!</span>}
            <button onClick={submit} disabled={sending || !body.trim() || !token}
              style={{ padding: '0.4rem 0.9rem', borderRadius: 2, fontSize: '0.72rem', fontWeight: 600, cursor: body.trim() && token ? 'pointer' : 'not-allowed',
                background: 'rgba(62,207,110,0.12)', border: '1px solid var(--green)', color: 'var(--green)', opacity: body.trim() && token ? 1 : 0.5 }}>
              {sending ? 'Versturen…' : 'Insturen'}
            </button>
          </div>
        </div>

        {/* Admin-filter */}
        {isAdmin && ideas.length > 0 && (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {(['alle', ...STATUSES] as const).map(f => {
              const active = filter === f
              const label = f === 'alle' ? `Alle (${ideas.length})` : `${STATUS_META[f].label} (${counts[f]})`
              return (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ padding: '0.25rem 0.6rem', borderRadius: 2, fontSize: '0.66rem', cursor: 'pointer',
                    background: active ? 'rgba(0,180,216,0.1)' : 'transparent',
                    border: `1px solid ${active ? 'var(--blue)' : 'var(--border)'}`, color: active ? 'var(--blue)' : 'var(--text-dim)' }}>
                  {label}
                </button>
              )
            })}
          </div>
        )}

        {/* Lijst */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Laden…</div>
        ) : shown.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-dim)', fontSize: '0.82rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.6rem', opacity: 0.5 }}>💡</div>
            {isAdmin ? 'Nog geen ideeën ingestuurd.' : 'Je hebt nog geen idee ingestuurd. Deel je eerste idee hierboven!'}
          </div>
        ) : (
          shown.map(idea => (
            <IdeaCard key={idea.id} idea={idea} isAdmin={isAdmin} token={token} charName={charName} onChanged={load} />
          ))
        )}
      </div>
    </Layout>
  )
}
