import { useState, useEffect, useMemo } from 'react'
import Layout, { PageHeader } from '../components/Layout'

interface NewsItem {
  title: string
  link: string
  date: string | null
  categories: string[]
  author: string
  summary: string
}

// Bekende categorieën → nette NL-labels + kleur. Onbekende vallen terug op grijs.
const CAT_META: Record<string, { label: string; color: string }> = {
  'patch-notes':    { label: 'Patch Notes',   color: 'var(--green)' },
  'expansion':      { label: 'Expansion',     color: 'var(--blue)' },
  'in-game-events': { label: 'Events',        color: 'var(--gold)' },
  'community':      { label: 'Community',     color: '#a78bfa' },
  'offers':         { label: 'Aanbieding',    color: '#f472b6' },
  'dev-blog':       { label: 'Dev Blog',      color: '#22d3ee' },
  'devblog':        { label: 'Dev Blog',      color: '#22d3ee' },
  'scope':          { label: 'The Scope',     color: '#f0a030' },
}
const catMeta = (c: string) => CAT_META[c] ?? { label: c.replace(/-/g, ' '), color: 'var(--text-dim)' }

function fmtDate(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

function CatChip({ cat, active, onClick }: { cat: string; active?: boolean; onClick?: () => void }) {
  const m = catMeta(cat)
  return (
    <span onClick={onClick}
      style={{ fontSize: '0.56rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
        color: m.color, border: `1px solid ${m.color}`, borderRadius: 3, padding: '0.1rem 0.4rem',
        background: active ? `color-mix(in srgb, ${m.color} 18%, transparent)` : 'rgba(0,0,0,0.2)',
        cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

export default function EveNews() {
  const [items, setItems] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [filter, setFilter] = useState<string>('alle')
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/evenews.php', { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { items?: NewsItem[] }) => {
        if (Array.isArray(d.items) && d.items.length) setItems(d.items)
        else setError(true)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  // Categorieën die daadwerkelijk voorkomen (op volgorde van CAT_META, rest erachter).
  const cats = useMemo(() => {
    const present = new Set<string>()
    items.forEach(i => i.categories.forEach(c => present.add(c)))
    const known = Object.keys(CAT_META).filter(c => present.has(c))
    const extra = [...present].filter(c => !(c in CAT_META)).sort()
    return [...new Set([...known, ...extra])]
  }, [items])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(i =>
      (filter === 'alle' || i.categories.includes(filter)) &&
      (!q || i.title.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q))
    )
  }, [items, filter, search])

  return (
    <Layout header={
      <PageHeader title="📰 EVE Nieuws"
        sub={loading ? 'laden…' : `${items.length} berichten · officiële feed`}
        right={
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Zoeken…"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.6rem', outline: 'none', minWidth: 160 }} />
        } />
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', maxWidth: 820 }}>

        {/* Categorie-filter */}
        {!loading && !error && (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button onClick={() => setFilter('alle')}
              style={{ padding: '0.25rem 0.6rem', borderRadius: 2, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer',
                background: filter === 'alle' ? 'rgba(0,180,216,0.12)' : 'transparent',
                border: `1px solid ${filter === 'alle' ? 'var(--blue)' : 'var(--border)'}`, color: filter === 'alle' ? 'var(--blue)' : 'var(--text-dim)' }}>
              Alles
            </button>
            {cats.map(c => <CatChip key={c} cat={c} active={filter === c} onClick={() => setFilter(filter === c ? 'alle' : c)} />)}
          </div>
        )}

        {/* Lijst */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Nieuws laden…</div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-dim)', fontSize: '0.82rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.6rem', opacity: 0.5 }}>📡</div>
            De EVE-nieuwsfeed is even niet bereikbaar. Probeer het later opnieuw.
          </div>
        ) : shown.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-dim)', fontSize: '0.82rem' }}>Geen berichten voor dit filter.</div>
        ) : (
          shown.map((it, i) => (
            <a key={it.link || i} href={it.link} target="_blank" rel="noreferrer"
              style={{ textDecoration: 'none', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.85rem 1rem', display: 'block', transition: 'border-color 0.15s' }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--blue)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
                {it.categories.map(c => <CatChip key={c} cat={c} />)}
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>{fmtDate(it.date)}</span>
              </div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text)', lineHeight: 1.35, marginBottom: '0.3rem' }}>
                {it.title} <span style={{ color: 'var(--blue)', fontSize: '0.72rem' }}>↗</span>
              </div>
              {it.summary && <div style={{ fontSize: '0.76rem', color: 'var(--text-dim)', lineHeight: 1.55 }}>{it.summary}</div>}
            </a>
          ))
        )}
      </div>
    </Layout>
  )
}
