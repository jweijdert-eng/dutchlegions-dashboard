import { useState, useEffect, useRef } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'

interface Note {
  id: string
  title: string
  content: string
  updatedAt: number
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function apiSave(charId: number, charName: string, note: Note) {
  await fetch('/api/notes.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: charId, characterName: charName, note }),
  }).catch(() => { /* ignore */ })
}

async function apiDelete(charId: number, id: string) {
  await fetch('/api/notes.php', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: charId, id }),
  }).catch(() => { /* ignore */ })
}

export default function Notes() {
  const { tokens, selectedCharId } = useAuth()
  const charId = selectedCharId ?? tokens[0]?.characterId ?? null
  const charName = tokens.find(t => t.characterId === charId)?.characterName ?? null

  const charNameRef = useRef<string>('')
  charNameRef.current = charName ?? ''

  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selected = notes.find(n => n.id === selectedId) ?? null

  useEffect(() => {
    if (!charId) return
    fetch(`/api/notes.php?characterId=${charId}`)
      .then(r => r.json())
      .then((data: Note[]) => {
        if (Array.isArray(data)) {
          setNotes(data)
          setSelectedId(data[0]?.id ?? null)
        }
      })
      .catch(() => { /* ignore */ })
  }, [charId])

  useEffect(() => {
    if (selected) {
      setEditTitle(selected.title)
      setEditContent(selected.content)
      setDirty(false)
    }
  }, [selectedId])

  function autosave(title: string, content: string) {
    if (!selectedId || !charId) return
    if (saveTimeout.current) clearTimeout(saveTimeout.current)
    saveTimeout.current = setTimeout(() => {
      setNotes(prev => {
        const updatedAt = Date.now()
        const updated = prev.map(n =>
          n.id === selectedId ? { ...n, title, content, updatedAt } : n
        )
        const note = updated.find(n => n.id === selectedId)
        if (note) apiSave(charId, charNameRef.current, note)
        return updated
      })
      setDirty(false)
    }, 600)
  }

  function handleTitleChange(v: string) {
    setEditTitle(v); setDirty(true); autosave(v, editContent)
  }

  function handleContentChange(v: string) {
    setEditContent(v); setDirty(true); autosave(editTitle, v)
  }

  function addNote() {
    if (!charId) return
    const note: Note = { id: crypto.randomUUID(), title: 'Nieuwe notitie', content: '', updatedAt: Date.now() }
    setNotes(prev => [note, ...prev])
    setSelectedId(note.id)
    apiSave(charId, charNameRef.current, note)
  }

  function deleteNote(id: string) {
    if (!charId) return
    setNotes(prev => prev.filter(n => n.id !== id))
    if (selectedId === id) setSelectedId(notes.find(n => n.id !== id)?.id ?? null)
    apiDelete(charId, id)
  }

  return (
    <Layout header={
      <PageHeader
        title={charName ? `NOTITIES — ${charName}` : 'NOTITIES'}
        right={
          <button
            onClick={addNote}
            style={{
              background: 'rgba(0,180,216,0.07)', border: '1px solid rgba(0,180,216,0.2)',
              borderRadius: 3, color: 'var(--blue)', padding: '0.3rem 0.75rem',
              fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', letterSpacing: '0.04em',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,180,216,0.15)'}
            onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,180,216,0.07)'}
          >
            + Nieuwe notitie
          </button>
        }
      />
    }>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>

        {/* Sidebar */}
        <div style={{
          width: 220, flexShrink: 0, borderRight: '1px solid var(--border)',
          overflowY: 'auto', display: 'flex', flexDirection: 'column',
        }}>
          {notes.length === 0 && (
            <div style={{ padding: '2rem 1rem', color: 'var(--text-dim)', fontSize: '0.72rem', textAlign: 'center' }}>
              Geen notities
            </div>
          )}
          {notes.map(n => {
            const active = n.id === selectedId
            return (
              <div key={n.id} style={{
                display: 'flex', alignItems: 'center',
                background: active ? 'rgba(0,180,216,0.07)' : 'transparent',
                borderLeft: `2px solid ${active ? 'var(--blue)' : 'transparent'}`,
                borderBottom: '1px solid var(--border)',
              }}>
                <button
                  onClick={() => setSelectedId(n.id)}
                  style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: '0.65rem 0.75rem', cursor: 'pointer' }}
                >
                  <div style={{ color: active ? 'var(--blue)' : 'var(--text)', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 155 }}>
                    {n.title || 'Naamloos'}
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: '0.62rem' }}>{fmt(n.updatedAt)}</div>
                </button>
                <button
                  onClick={() => deleteNote(n.id)}
                  title="Verwijderen"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: '0.5rem 0.6rem', lineHeight: 1, flexShrink: 0 }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            )
          })}
        </div>

        {/* Editor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!selected ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
              Selecteer of maak een notitie
            </div>
          ) : (
            <>
              <div style={{ borderBottom: '1px solid var(--border)', padding: '0.6rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)', flexShrink: 0 }}>
                <input
                  value={editTitle}
                  onChange={e => handleTitleChange(e.target.value)}
                  placeholder="Titel..."
                  style={{
                    flex: 1, background: 'none', border: 'none', outline: 'none',
                    color: 'var(--text)', fontSize: '0.85rem', fontWeight: 700,
                    fontFamily: 'inherit', letterSpacing: '0.04em',
                  }}
                />
                <span style={{ color: dirty ? 'var(--yellow, #f59e0b)' : 'var(--border)', fontSize: '0.62rem', flexShrink: 0, transition: 'color 0.2s' }}>
                  {dirty ? 'opslaan...' : 'opgeslagen'}
                </span>
              </div>
              <textarea
                value={editContent}
                onChange={e => handleContentChange(e.target.value)}
                placeholder="Schrijf hier je notitie..."
                style={{
                  flex: 1, background: 'none', border: 'none', outline: 'none',
                  color: 'var(--text)', fontSize: '0.82rem', lineHeight: 1.8,
                  padding: '1.25rem', resize: 'none', fontFamily: 'inherit',
                }}
              />
            </>
          )}
        </div>
      </div>
    </Layout>
  )
}
