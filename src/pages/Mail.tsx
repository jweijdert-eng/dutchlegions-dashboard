import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getMail, getMailBody, sendMail, deleteMail, resolveNames, type MailHeader, type MailBody } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedMail extends MailHeader {
  senderName: string
  charId: number
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fmtDate(ts: string): string {
  const d = new Date(ts)
  const diff = Date.now() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString('nl', { hour: '2-digit', minute: '2-digit' })
  if (days < 7)  return `${days}d geleden`
  return d.toLocaleDateString('nl', { day: 'numeric', month: 'short' })
}

export default function Mail() {
  const { activeTokens, tokens } = useAuth()
  const [mails, setMails]             = useState<ResolvedMail[]>([])
  const [loading, setLoading]         = useState(true)
  usePageLoading(loading)
  const [selected, setSelected]       = useState<ResolvedMail | null>(null)
  const [body, setBody]               = useState<MailBody | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [replyOpen, setReplyOpen]     = useState(false)
  const [replyBody, setReplyBody]     = useState('')
  const [replySending, setReplySending] = useState(false)
  const [replyResult, setReplyResult] = useState<'ok' | 'err' | null>(null)
  const [deletingId, setDeletingId]   = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const fetchId = useRef(0)
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens

  const mailTokens = activeTokens.length > 0 ? [activeTokens[0]] : tokens.length > 0 ? [tokens[0]] : []

  function getToken(charId: number): string | null {
    return tokensRef.current.find(t => t.characterId === charId)?.accessToken ?? null
  }

  useEffect(() => {
    if (mailTokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setMails([])

    async function load() {
      const allMails: ResolvedMail[] = []

      // Resolve the selected account's mail only
      const rawWithMeta: (MailHeader & { charId: number })[] = []

      await Promise.all(mailTokens.map(async t => {
        const list = await getMail(t.characterId, t.accessToken).catch(() => [] as MailHeader[])
        for (const m of list) {
          rawWithMeta.push({ ...m, charId: t.characterId })
        }
      }))

      if (myId !== fetchId.current) return

      const senderIds = [...new Set(rawWithMeta.map(m => m.from).filter(Boolean))]
      const nameMap   = await resolveNames(senderIds)

      if (myId !== fetchId.current) return

      for (const m of rawWithMeta) {
        allMails.push({
          ...m,
          senderName: nameMap.get(m.from) ?? `ID ${m.from}`,
        })
      }

      allMails.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      setMails(allMails)
      setLoading(false)
    }

    load()
  }, [mailTokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  async function openMail(mail: ResolvedMail) {
    setSelected(mail)
    setBody(null)
    setBodyLoading(true)
    setReplyOpen(false)
    setReplyBody('')
    setReplyResult(null)
    const token = getToken(mail.charId)
    const b = token ? await getMailBody(mail.charId, mail.mail_id, token).catch(() => null) : null
    setBody(b)
    setBodyLoading(false)
  }

  async function handleDeleteMail(mail: ResolvedMail) {
    setDeletingId(mail.mail_id)
    setDeleteError(null)
    const token = getToken(mail.charId)
    if (!token) { setDeleteError('Token niet gevonden — herlaad de pagina'); setDeletingId(null); return }
    const { ok, status, error } = await deleteMail(mail.charId, mail.mail_id, token)
    if (ok) {
      setMails(prev => prev.filter(m => m.mail_id !== mail.mail_id))
      if (selected?.mail_id === mail.mail_id) {
        setSelected(null)
        setBody(null)
        setReplyOpen(false)
        setReplyBody('')
      }
    } else {
      const detail = error ? ` — ${error}` : ''
      setDeleteError(`Mislukt (${status || 'netwerk fout'})${detail}`)
      setTimeout(() => setDeleteError(null), 10000)
    }
    setDeletingId(null)
  }

  async function handleSendReply() {
    if (!selected || !replyBody.trim()) return
    setReplySending(true)
    const token = getToken(selected.charId)
    if (!token) { setReplySending(false); setReplyResult('err'); return }
    const ok = await sendMail(
      selected.charId,
      token,
      `Re: ${selected.subject}`,
      replyBody.replace(/\n/g, '<br>'),
      [{ recipient_id: selected.from, recipient_type: 'character' }]
    )
    setReplySending(false)
    setReplyResult(ok ? 'ok' : 'err')
    if (ok) {
      setReplyBody('')
      setReplyOpen(false)
      setTimeout(() => setReplyResult(null), 3000)
    } else {
      setTimeout(() => setReplyResult(null), 5000)
    }
  }

  const unread = mails.filter(m => m.is_read === false).length

  return (
    <Layout
      header={<PageHeader title="Mail" sub={loading ? 'Laden...' : `${mails.length} mails · ${unread} ongelezen`} />}
      mainStyle={{ padding: 0, overflow: 'hidden' }}
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        {/* Mail list */}
        <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          {deleteError && (
            <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(224,85,85,0.1)', borderBottom: '1px solid rgba(224,85,85,0.3)', fontSize: '0.65rem', color: 'var(--red)', lineHeight: 1.4 }}>
              {deleteError}
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Laden...</div>
          )}
          {!loading && mails.length === 0 && (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen mails gevonden</div>
          )}
          {mails.map(m => {
            const isSelected = selected?.charId === m.charId && selected?.mail_id === m.mail_id
            return (
              <div
                key={`${m.charId}-${m.mail_id}`}
                onClick={() => openMail(m)}
                style={{
                  padding: '0.75rem 1rem',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: isSelected ? 'rgba(0,180,216,0.08)' : m.is_read === false ? 'rgba(0,180,216,0.04)' : 'transparent',
                  borderLeft: `3px solid ${isSelected ? 'var(--blue)' : m.is_read === false ? 'var(--blue)' : 'transparent'}`,
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
                onMouseLeave={e => { e.currentTarget.style.background = isSelected ? 'rgba(0,180,216,0.08)' : m.is_read === false ? 'rgba(0,180,216,0.04)' : 'transparent' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                    {m.is_read === false && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0, display: 'inline-block' }} />}
                    <img
                      src={`https://images.evetech.net/characters/${m.from}/portrait?size=32`}
                      alt=""
                      style={{ width: 22, height: 22, borderRadius: '50%', border: '1px solid var(--border)', flexShrink: 0 }}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <span style={{ fontSize: '0.72rem', fontWeight: m.is_read === false ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.senderName}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', whiteSpace: 'nowrap', marginLeft: '0.5rem', flexShrink: 0 }}>{fmtDate(m.timestamp)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <div style={{ flex: 1, fontSize: '0.72rem', color: m.is_read === false ? 'var(--text)' : 'var(--text-dim)', fontWeight: m.is_read === false ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: m.is_read === false ? '1.7rem' : '1.1rem' }}>
                    {m.subject || '(geen onderwerp)'}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteMail(m) }}
                    disabled={deletingId === m.mail_id}
                    title="Verwijder mail"
                    style={{ flexShrink: 0, background: 'none', border: 'none', color: 'rgba(224,85,85,0.4)', fontSize: '0.85rem', cursor: 'pointer', padding: '0.1rem 0.25rem', lineHeight: 1, opacity: deletingId === m.mail_id ? 0.5 : 1 }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)' }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'rgba(224,85,85,0.4)' }}
                  >🗑</button>
                </div>
              </div>
            )
          })}
          </div>
        </div>

        {/* Mail detail */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '1.5rem' }}>
          {!selected && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60%', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Selecteer een mail om te lezen
            </div>
          )}
          {selected && (
            <div>
              <div style={{ marginBottom: '1.25rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.65rem' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 700 }}>{selected.subject || '(geen onderwerp)'}</div>
                  <button
                    onClick={() => handleDeleteMail(selected)}
                    disabled={deletingId === selected.mail_id}
                    title="Verwijder mail"
                    style={{ background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.2)', borderRadius: 3, color: 'var(--red)', fontSize: '0.7rem', padding: '0.3rem 0.6rem', cursor: 'pointer', flexShrink: 0, marginLeft: '1rem', opacity: deletingId === selected.mail_id ? 0.5 : 1 }}
                  >{deletingId === selected.mail_id ? '...' : '🗑 Verwijder'}</button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <img
                    src={`https://images.evetech.net/characters/${selected.from}/portrait?size=64`}
                    alt=""
                    style={{ width: 36, height: 36, borderRadius: '50%', border: '1px solid var(--border)', flexShrink: 0 }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600 }}>{selected.senderName}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>{new Date(selected.timestamp).toLocaleString('nl')}</div>
                  </div>
                </div>
              </div>

              {bodyLoading && (
                <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>Mail ophalen...</div>
              )}

              {!bodyLoading && !body && (
                <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>Kon mail niet ophalen.</div>
              )}

              {body && (
                <pre style={{ fontSize: '0.83rem', lineHeight: 1.8, whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--text)', margin: 0 }}>
                  {stripHtml(body.body) || '(leeg)'}
                </pre>
              )}

              {body && !bodyLoading && (
                <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  {replyResult === 'ok' && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--green)', marginBottom: '0.5rem' }}>✓ Verzonden!</div>
                  )}
                  {!replyOpen ? (
                    <button
                      onClick={() => setReplyOpen(true)}
                      style={{ background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.25)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.75rem', cursor: 'pointer' }}
                    >↩ Beantwoorden</button>
                  ) : (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.08em' }}>
                          AAN: {selected.senderName.toUpperCase()}
                        </span>
                        <button onClick={() => setReplyOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '1rem', cursor: 'pointer', lineHeight: 1 }}>×</button>
                      </div>
                      <textarea
                        value={replyBody}
                        onChange={e => setReplyBody(e.target.value)}
                        placeholder="Typ je bericht..."
                        rows={6}
                        style={{ width: '100%', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.82rem', padding: '0.75rem', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                        onFocus={e => { e.currentTarget.style.borderColor = 'var(--blue)' }}
                        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                        {replyResult === 'err'
                          ? <span style={{ fontSize: '0.65rem', color: 'var(--red)' }}>Mislukt — scope esi-mail.send_mail.v1 vereist (opnieuw inloggen)</span>
                          : <span />
                        }
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button
                            onClick={() => { setReplyOpen(false); setReplyBody('') }}
                            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.72rem', padding: '0.35rem 0.75rem', cursor: 'pointer' }}
                          >Annuleer</button>
                          <button
                            onClick={handleSendReply}
                            disabled={replySending || !replyBody.trim()}
                            style={{ background: replySending || !replyBody.trim() ? 'rgba(0,180,216,0.05)' : 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.3)', borderRadius: 3, color: replySending || !replyBody.trim() ? 'rgba(0,180,216,0.4)' : 'var(--blue)', fontSize: '0.72rem', fontWeight: 600, padding: '0.35rem 0.75rem', cursor: replySending || !replyBody.trim() ? 'default' : 'pointer' }}
                          >{replySending ? 'Verzenden...' : '↩ Verstuur'}</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}

