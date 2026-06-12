import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { getBlueprints, resolveNames, type Blueprint } from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import { usePageLoading } from '../hooks/usePageLoading'

interface ResolvedBlueprint extends Blueprint {
  typeName: string
}

function MEBar({ value }: { value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
      <div style={{ flex: 1, height: 3, background: 'var(--border)', borderRadius: 2 }}>
        <div style={{ height: '100%', width: `${value * 10}%`, background: '#3ecf6e', borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', width: 20, textAlign: 'right' }}>{value}%</span>
    </div>
  )
}

export default function Blueprints() {
  const { activeTokens: tokens } = useAuth()
  const [blueprints, setBlueprints] = useState<ResolvedBlueprint[]>([])
  const [loading, setLoading]       = useState(true)
  usePageLoading(loading)
  const [search, setSearch]         = useState('')
  const [filter, setFilter]         = useState<'all' | 'bpo' | 'bpc'>('all')
  const fetchId = useRef(0)

  useEffect(() => {
    if (tokens.length === 0) return
    const myId = ++fetchId.current
    setLoading(true); setBlueprints([])

    async function load() {
      const all: Blueprint[] = []
      await Promise.all(tokens.map(async t => {
        const bps = await getBlueprints(t.characterId, t.accessToken).catch(() => [] as Blueprint[])
        all.push(...bps)
      }))
      if (myId !== fetchId.current) return

      const typeIds = [...new Set(all.map(b => b.type_id))]
      const nameMap = await resolveNames(typeIds)
      if (myId !== fetchId.current) return

      setBlueprints(
        all.map(b => ({ ...b, typeName: nameMap.get(b.type_id) ?? `Type ${b.type_id}` }))
           .sort((a, b) => a.typeName.localeCompare(b.typeName))
      )
      setLoading(false)
    }
    load()
  }, [tokens.map(t => `${t.characterId}:${t.expiresAt}`).join(',')])

  const filtered = blueprints.filter(b => {
    if (filter === 'bpo' && b.quantity !== -1) return false
    if (filter === 'bpc' && b.quantity === -1) return false
    if (search && !b.typeName.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const bpoCount = blueprints.filter(b => b.quantity === -1).length
  const bpcCount = blueprints.filter(b => b.quantity !== -1).length

  return (
    <Layout header={
      <PageHeader
        title="Blueprints"
        sub={loading ? 'Laden...' : `${bpoCount} BPO · ${bpcCount} BPC`}
        right={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {(['all', 'bpo', 'bpc'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                background: filter === f ? 'rgba(0,180,216,0.15)' : 'none',
                border: `1px solid ${filter === f ? 'var(--blue)' : 'var(--border)'}`,
                color: filter === f ? 'var(--blue)' : 'var(--text-dim)',
                borderRadius: 2, fontSize: '0.65rem', fontWeight: 700,
                padding: '0.2rem 0.5rem', cursor: 'pointer', letterSpacing: '0.08em',
              }}>
                {f.toUpperCase()}
              </button>
            ))}
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Zoek blueprint..."
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.3rem 0.6rem', color: 'var(--text)', fontSize: '0.72rem', outline: 'none', width: 180 }}
            />
          </div>
        }
      />
    }>
      {loading && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Blueprints laden...</div>}
      {!loading && filtered.length === 0 && <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>Geen blueprints gevonden</div>}

      {!loading && filtered.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Blueprint', 'Type', 'ME', 'TE', 'Runs'].map(h => (
                  <th key={h} style={{ fontSize: '0.63rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', padding: '0.5rem 0.875rem', textAlign: h === 'Runs' ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((b, i) => {
                const isBPO = b.quantity === -1
                return (
                  <tr key={b.item_id} style={{ borderTop: '1px solid rgba(28,28,53,0.5)', background: i % 2 === 1 ? 'rgba(15,15,34,0.4)' : 'transparent' }}>
                    <td style={{ padding: '0.5rem 0.875rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <EveImage category="types" id={b.type_id} variation={isBPO ? 'bp' : 'bpc'} size={32} px={28} />
                        <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>{b.typeName}</span>
                      </div>
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem' }}>
                      <span style={{
                        fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em',
                        color: isBPO ? '#f0c040' : '#00b4d8',
                        background: isBPO ? 'rgba(240,192,64,0.1)' : 'rgba(0,180,216,0.1)',
                        border: `1px solid ${isBPO ? 'rgba(240,192,64,0.3)' : 'rgba(0,180,216,0.3)'}`,
                        borderRadius: 2, padding: '0.1rem 0.4rem',
                      }}>
                        {isBPO ? 'BPO' : 'BPC'}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', minWidth: 100 }}>
                      <MEBar value={b.material_efficiency} />
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', minWidth: 100 }}>
                      <MEBar value={b.time_efficiency} />
                    </td>
                    <td style={{ padding: '0.5rem 0.875rem', textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                      {isBPO ? '∞' : b.runs.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  )
}
