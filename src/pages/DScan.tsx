import { useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { fetchDscanItems, type DscanGroup } from '../utils/dscan'

interface ParsedItem {
  typeName: string
  typeId: number | null
}

function parseRaw(text: string): ParsedItem[] {
  return text.split('\n')
    .map(l => l.split('\t').map(c => c.trim()))
    .filter(p => p.length >= 2)
    .map(p => {
      if (/^\d+$/.test(p[0]) && p.length >= 3) return { typeId: parseInt(p[0]), typeName: p[2] }
      return { typeId: null, typeName: p[1] }
    })
    .filter(item => item.typeName.length > 1)
}

async function resolveTypeIds(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  await Promise.all([...new Set(names)].filter(n => n.length > 1).map(async name => {
    try {
      const res = await fetch(`https://esi.evetech.net/latest/search/?categories=inventory_type&search=${encodeURIComponent(name)}&strict=true&datasource=tranquility`)
      if (!res.ok) return
      const data = await res.json()
      const ids: number[] = data.inventory_type ?? []
      if (ids.length > 0) out.set(name, ids[0])
    } catch { /* ignore */ }
  }))
  return out
}

function groupRaw(items: ParsedItem[], nameMap: Map<string, number>): DscanGroup[] {
  const counts = new Map<string, DscanGroup>()
  for (const item of items) {
    const typeId = item.typeId ?? nameMap.get(item.typeName) ?? null
    const key    = typeId != null ? `id:${typeId}` : `name:${item.typeName}`
    const g      = counts.get(key)
    if (g) g.count++
    else counts.set(key, { typeName: item.typeName, typeId, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName))
}

export default function DScan() {
  const [input, setInput]     = useState('')
  const [rows, setRows]       = useState<DscanGroup[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [source, setSource]   = useState('')

  async function analyze() {
    const val = input.trim()
    if (!val) return
    setLoading(true); setError(''); setRows(null)
    try {
      let groups: DscanGroup[]
      if (val.includes('dscan.info')) {
        groups = await fetchDscanItems(val)
        setSource('dscan.info URL')
      } else {
        const items = parseRaw(val)
        if (items.length === 0) throw new Error('Geen schepen gevonden')
        const nameMap = await resolveTypeIds(items.filter(i => i.typeId == null).map(i => i.typeName))
        groups = groupRaw(items, nameMap)
        setSource('Raw D-Scan')
      }
      if (groups.length === 0) throw new Error('Geen schepen gevonden in de invoer')
      setRows(groups)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const total    = rows ? rows.reduce((s, r) => s + r.count, 0) : 0
  const resolved = rows ? rows.filter(r => r.typeId).length : 0

  return (
    <Layout header={
      <PageHeader
        title="D-Scan"
        sub={rows ? `${total} objecten · ${rows.length} types · ${resolved} herkend` : 'Plak D-Scan tekst of dscan.info URL'}
      />
    }>
      <div style={{ marginBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={'Plak hier je D-Scan (uit EVE game client)\nOf plak een dscan.info URL\n\nRaw formaat: TypeID[TAB]Name[TAB]Type[TAB]Distance'}
          rows={6}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3,
            color: 'var(--text)', fontSize: '0.72rem', padding: '0.6rem 0.75rem',
            outline: 'none', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button onClick={analyze} disabled={loading || !input.trim()} style={{
            background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.3)',
            color: 'var(--blue)', borderRadius: 3, fontSize: '0.72rem',
            padding: '0.4rem 1rem', cursor: loading ? 'default' : 'pointer', fontWeight: 600,
          }}>
            {loading ? 'Laden...' : 'Analyseer'}
          </button>
          {input && (
            <button onClick={() => { setInput(''); setRows(null); setError('') }}
              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.75rem' }}>
              ✕ Wis
            </button>
          )}
          {source && rows && <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{source}</span>}
        </div>
      </div>

      {error && (
        <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(224,85,85,0.08)', border: '1px solid rgba(224,85,85,0.2)', borderRadius: 3, color: 'var(--red)', fontSize: '0.72rem', marginBottom: '0.75rem' }}>
          {error}
        </div>
      )}

      {rows && rows.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ padding: '0.6rem 0.875rem', borderBottom: '1px solid var(--border)', fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.15em' }}>
            RESULTATEN — {total} OBJECTEN
          </div>
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {rows.map(r => (
              <div key={r.typeId ?? r.typeName} style={{
                display: 'grid', gridTemplateColumns: '52px 1fr 40px',
                alignItems: 'center', gap: '0.75rem',
                padding: '0.4rem 0.875rem',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {r.typeId ? (
                    <EveImage category="types" id={r.typeId} variation="icon" size={64} px={44} />
                  ) : (
                    <div style={{ width: 44, height: 44, borderRadius: 3, background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: '1rem', color: 'var(--border)' }}>?</span>
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{r.typeName}</div>
                  {!r.typeId && <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>niet herkend</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: r.count >= 5 ? 'var(--red)' : r.count >= 2 ? 'var(--gold)' : 'var(--text)' }}>
                    ×{r.count}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Layout>
  )
}
