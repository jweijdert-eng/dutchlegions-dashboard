import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getCharacterFleet, getFleetInfo, getFleetMembers, getFleetWings,
  resolveNames,
  type CharacterFleet, type FleetInfo, type FleetMember, type FleetWing,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'

function sanitizeMotd(html: string): string {
  return html
    .replace(/<(?!\/?(a|b|i|br|font|span|p|ul|li|strong|em)\b)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '')
}

const ROLE_LABEL: Record<string, string> = {
  fleet_commander: 'FC',
  wing_commander:  'WC',
  squad_commander: 'SC',
  squad_member:    'Member',
}

const ROLE_COLOR: Record<string, string> = {
  fleet_commander: '#f0c040',
  wing_commander:  '#00b4d8',
  squad_commander: '#3ecf6e',
  squad_member:    'var(--text-dim)',
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span style={{
      fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.08em',
      color: ROLE_COLOR[role] ?? 'var(--text-dim)',
      background: `${ROLE_COLOR[role] ?? 'var(--border)'}18`,
      border: `1px solid ${ROLE_COLOR[role] ?? 'var(--border)'}44`,
      borderRadius: 2, padding: '0.1rem 0.35rem',
    }}>
      {ROLE_LABEL[role] ?? role}
    </span>
  )
}

interface ResolvedMember extends FleetMember {
  characterName: string
  shipName: string
  systemName: string
}

export default function Fleet() {
  const { activeTokens: tokens } = useAuth()
  const token = tokens[0]

  const [charFleet, setCharFleet]     = useState<CharacterFleet | null>(null)
  const [fleetInfo, setFleetInfo]     = useState<FleetInfo | null>(null)
  const [members, setMembers]         = useState<ResolvedMember[]>([])
  const [wings, setWings]             = useState<FleetWing[]>([])
  const [loading, setLoading]         = useState(true)
  const [notInFleet, setNotInFleet]   = useState(false)
  const [myRole, setMyRole]           = useState<string | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function load(t: typeof token) {
    if (!t) return

    let cf: CharacterFleet
    try {
      cf = await getCharacterFleet(t.characterId, t.accessToken)
    } catch {
      setNotInFleet(true)
      setLoading(false)
      return
    }

    setCharFleet(cf)
    setMyRole(cf.role)
    setNotInFleet(false)
    setAccessError(null)

    const [info, memberList, wingList] = await Promise.allSettled([
      getFleetInfo(cf.fleet_id, t.accessToken),
      getFleetMembers(cf.fleet_id, t.accessToken),
      getFleetWings(cf.fleet_id, t.accessToken),
    ])

    if (info.status     === 'fulfilled') setFleetInfo(info.value)
    if (wingList.status === 'fulfilled') setWings(wingList.value)

    if (memberList.status === 'fulfilled') {
      const raw = memberList.value
      const ids = [
        ...raw.map(m => m.character_id),
        ...raw.map(m => m.ship_type_id),
        ...raw.map(m => m.solar_system_id),
      ]
      const nameMap = await resolveNames([...new Set(ids)]).catch(() => new Map<number, string>())
      setMembers(raw.map(m => ({
        ...m,
        characterName: nameMap.get(m.character_id) ?? `Character ${m.character_id}`,
        shipName:      nameMap.get(m.ship_type_id)  ?? `Ship ${m.ship_type_id}`,
        systemName:    nameMap.get(m.solar_system_id) ?? `System ${m.solar_system_id}`,
      })).sort((a, b) => {
        const order = ['fleet_commander', 'wing_commander', 'squad_commander', 'squad_member']
        return order.indexOf(a.role) - order.indexOf(b.role)
      }))
    } else {
      const err = memberList.reason as Error
      if (err?.message?.includes('403')) {
        setAccessError('Ledenlijst is alleen zichtbaar voor de Fleet Commander.')
      } else {
        setAccessError(`Kan ledenlijst niet laden: ${err?.message ?? 'onbekende fout'}`)
      }
    }

    setLoading(false)
  }

  useEffect(() => {
    if (!token) return
    setLoading(true)
    load(token)
    intervalRef.current = setInterval(() => load(token), 15_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [token?.characterId])

  const fc    = members.find(m => m.role === 'fleet_commander')
  const myChar = members.find(m => m.character_id === token?.characterId)

  return (
    <Layout header={
      <PageHeader
        title="Fleet"
        sub={
          loading ? 'Laden...' :
          notInFleet ? 'Niet in fleet' :
          `${members.length} leden · ${myRole ? ROLE_LABEL[myRole] : ''}`
        }
      />
    }>
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          Fleet data laden...
        </div>
      )}

      {!loading && notInFleet && (
        <div style={{ textAlign: 'center', padding: '4rem 2rem', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          <div style={{ fontSize: '2rem', color: 'var(--border)', marginBottom: '1rem' }}>⊞</div>
          Je zit momenteel niet in een fleet.
        </div>
      )}

      {!loading && !notInFleet && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

          {/* Fleet info balk — altijd zichtbaar als in fleet */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem' }}>
            {/* FC — alleen zichtbaar als ledenlijst beschikbaar */}
            {fc && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>FLEET COMMANDER</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <EveImage category="characters" id={fc.character_id} variation="portrait" size={32} px={24} round />
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--gold)' }}>{fc.characterName}</span>
                </div>
              </div>
            )}

            {/* Mijn rol — valt terug op charFleet als ledenlijst niet beschikbaar */}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>MIJN ROL</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {myRole && <RoleBadge role={myRole} />}
                {myChar && <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{myChar.shipName}</span>}
              </div>
            </div>

            {/* Leden — alleen als beschikbaar */}
            {members.length > 0 && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>LEDEN</div>
                <span style={{ fontSize: '1rem', fontWeight: 700 }}>{members.length}</span>
              </div>
            )}

            {/* Flags — alleen als fleetInfo beschikbaar */}
            {fleetInfo && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.35rem' }}>STATUS</div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.62rem', color: fleetInfo.is_free_move ? 'var(--green)' : 'var(--text-dim)' }}>
                    {fleetInfo.is_free_move ? '✓' : '✗'} Free Move
                  </span>
                  <span style={{ fontSize: '0.62rem', color: fleetInfo.is_registered ? 'var(--green)' : 'var(--text-dim)' }}>
                    {fleetInfo.is_registered ? '✓' : '✗'} Registered
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* MOTD */}
          {fleetInfo?.motd && fleetInfo.motd.trim() && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '3px solid var(--blue)', borderRadius: 3, padding: '0.6rem 1rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.3rem' }}>MOTD</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
                dangerouslySetInnerHTML={{ __html: sanitizeMotd(fleetInfo.motd) }} />
            </div>
          )}

          {/* Wing structuur */}
          {wings.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em', marginBottom: '0.5rem' }}>WING / SQUAD STRUCTUUR</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {wings.map(w => {
                  const wingMembers = members.filter(m => m.wing_id === w.id)
                  return (
                    <div key={w.id}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                        <span style={{ fontSize: '0.68rem', color: 'var(--blue)', fontWeight: 600 }}>◈ {w.name}</span>
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>{wingMembers.length} leden</span>
                      </div>
                      {w.squads.map(s => {
                        const squadMembers = members.filter(m => m.squad_id === s.id)
                        return (
                          <div key={s.id} style={{ marginLeft: '1rem', marginBottom: '0.15rem' }}>
                            <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                              └ {s.name} <span style={{ color: 'var(--border)' }}>({squadMembers.length})</span>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Ledenlijst of foutmelding */}
          {accessError ? (
            <div style={{ background: 'rgba(240,192,64,0.06)', border: '1px solid rgba(240,192,64,0.25)', borderRadius: 3, padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--gold)' }}>
              {accessError}
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1fr 160px 160px 60px', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>KARAKTER</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>SHIP</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>LOCATIE</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>ROL</span>
              </div>
              {members.map(m => {
                const isMe = m.character_id === token?.characterId
                return (
                  <div
                    key={m.character_id}
                    style={{
                      display: 'grid', gridTemplateColumns: '1fr 160px 160px 60px',
                      gap: '0.5rem', alignItems: 'center',
                      padding: '0.45rem 1rem',
                      borderBottom: '1px solid rgba(28,28,53,0.5)',
                      background: isMe ? 'rgba(0,180,216,0.04)' : 'transparent',
                      borderLeft: isMe ? '2px solid var(--blue)' : '2px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                      <EveImage category="characters" id={m.character_id} variation="portrait" size={32} px={22} round
                        style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '0.72rem', fontWeight: isMe ? 600 : 400, color: isMe ? 'var(--blue)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.characterName}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 }}>
                      <EveImage category="types" id={m.ship_type_id} variation="icon" size={32} px={20} style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.shipName}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.65rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <SolarSystem name={m.systemName} systemId={m.solar_system_id} fontSize="0.65rem" />
                    </div>
                    <RoleBadge role={m.role} />
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textAlign: 'right' }}>
            Ververst elke 15 seconden
          </div>
        </div>
      )}
    </Layout>
  )
}
