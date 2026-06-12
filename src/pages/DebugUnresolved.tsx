import { useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import { getStructureInfo } from '../api/esi'

export default function DebugUnresolved() {
  const [data, setData] = useState<Record<string, { chars: number[]; lastSeen: number }> | null>(null)
  const [resolving, setResolving] = useState(false)
  const [results, setResults] = useState<Record<string, { name?: string | null; resolvedBy?: number[] }>>({})
  const { tokens } = useAuth()

  useEffect(() => {
    try {
      const raw = localStorage.getItem('unresolved_structures')
      setData(raw ? JSON.parse(raw) : {})
    } catch { setData({}) }
  }, [])

  async function attemptResolveWithAccounts() {
    setResolving(true)
    try {
      const structSet = new Set<string>()
      // fetch assets/locations for each token's character
      for (const t of tokens) {
        try {
          const res = await fetch(`https://esi.evetech.net/latest/characters/${t.characterId}/assets/locations/?datasource=tranquility`, {
            headers: { Authorization: `Bearer ${t.accessToken}` },
          })
          if (!res.ok) continue
          const body = await res.json()
          if (Array.isArray(body)) {
            for (const e of body) {
              const lid = e.location_id ?? null
              const ltype = e.location_type ?? null
              if (ltype === 'structure' || (typeof lid === 'number' && lid > 2_147_483_647)) structSet.add(String(lid))
            }
          } else if (body && typeof body === 'object') {
            for (const v of Object.values(body)) {
              const lid = (v && v.location_id) || v
              if (typeof lid === 'number' && lid > 2_147_483_647) structSet.add(String(lid))
            }
          }
        } catch { continue }
      }

      const ids = Array.from(structSet)
      const resMap: Record<string, { name?: string | null; resolvedBy?: number[] }> = {}
      for (const idStr of ids) {
        const id = parseInt(idStr, 10)
        const info = await getStructureInfo(id, tokens)
        resMap[idStr] = { name: info?.name ?? null, resolvedBy: info ? tokens.map(t => t.characterId) : [] }
      }
      setResults(resMap)
    } finally { setResolving(false) }
  }

  return (
    <Layout header={<PageHeader title="Debug: Unresolved Structures" />}>
      <div style={{ padding: '1rem' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <button onClick={attemptResolveWithAccounts} disabled={resolving || tokens.length === 0}>
            {resolving ? 'Resolving...' : tokens.length ? 'Attempt resolve with logged accounts' : 'No logged accounts available'}
          </button>
        </div>

        {!data && <div>Loading...</div>}
        {data && Object.keys(data).length === 0 && <div>No unresolved structures recorded.</div>}

        {Object.keys(results).length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <h3>Resolution results</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '0.5rem' }}>Structure ID</th>
                  <th style={{ padding: '0.5rem' }}>Resolved name</th>
                  <th style={{ padding: '0.5rem' }}>Tried with chars</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(results).map(([id, v]) => (
                  <tr key={id} style={{ borderTop: '1px solid rgba(28,28,53,0.5)' }}>
                    <td style={{ padding: '0.5rem' }}>{id}</td>
                    <td style={{ padding: '0.5rem' }}>{v.name ?? '(unresolved)'}</td>
                    <td style={{ padding: '0.5rem' }}>{v.resolvedBy?.length ? v.resolvedBy.join(', ') : '(none)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && Object.keys(data).length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '0.5rem' }}>Structure ID</th>
                <th style={{ padding: '0.5rem' }}>Character IDs attempted</th>
                <th style={{ padding: '0.5rem' }}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data).map(([id, v]) => (
                <tr key={id} style={{ borderTop: '1px solid rgba(28,28,53,0.5)' }}>
                  <td style={{ padding: '0.5rem' }}>{id}</td>
                  <td style={{ padding: '0.5rem' }}>{v.chars.length ? v.chars.join(', ') : '(no account info)'}</td>
                  <td style={{ padding: '0.5rem' }}>{new Date(v.lastSeen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  )
}
