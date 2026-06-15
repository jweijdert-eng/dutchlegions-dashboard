import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getCharacterFleet, getFleetInfo, getFleetMembers, getFleetWings,
  resolveNames, setFleetSettings, kickFleetMember, moveFleetMember, inviteFleetMember, resolveCharacterId,
  type CharacterFleet, type FleetInfo, type FleetMember, type FleetWing,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'

// Scopes uit het EVE access-token (JWT 'scp'-claim) lezen — om te waarschuwen als
// de fleet-schrijfrechten ontbreken (token van vóór de scope-uitbreiding).
function tokenScopes(accessToken: string): string[] {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { scp?: string | string[] }
    return Array.isArray(payload.scp) ? payload.scp : typeof payload.scp === 'string' ? payload.scp.split(' ') : []
  } catch { return [] }
}

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

  // Beheer (FC)
  const [motdDraft, setMotdDraft]   = useState('')
  const [editingMotd, setEditingMotd] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [msg, setMsg]               = useState<string | null>(null)
  const [busy, setBusy]             = useState(false)

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
      const code = err?.message?.match(/\b(40\d)\b/)?.[1]
      if (code === '404' || code === '403') {
        // ESI staat de /fleets/{id}/-endpoints alleen toe voor de fleet-boss (de FC
        // bovenaan). Niet-boss leden krijgen een 404 — geen echte fout.
        setMembers([])
        setAccessError(
          cf.role === 'fleet_commander'
            ? 'ESI geeft geen toegang tot de fleet-details. Dit gebeurt als je niet de fleet-boss bent (de allereerste FC die de fleet opende) of als de fleet net opnieuw is gevormd — laat de boss de fleet-tools openen.'
            : 'De ledenlijst en fleet-details zijn via ESI alleen zichtbaar voor de Fleet Commander (de fleet-boss). Je ziet hieronder wel je eigen rol en schip.'
        )
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

  // Beheer alleen voor de Fleet Commander (ESI vereist de juiste rol sowieso).
  // Beheer alleen tonen als de boss-endpoints écht toegankelijk zijn (ledenlijst geladen).
  const canManage = myRole === 'fleet_commander' && !!charFleet && !accessError && members.length > 0
  const hasFleetWrite = token ? tokenScopes(token.accessToken).includes('esi-fleets.write_fleet.v1') : false
  const squadOptions = wings.flatMap(w => w.squads.map(s => ({ wingId: w.id, squadId: s.id, label: `${w.name} / ${s.name}` })))
  const memberCols = canManage ? '1fr 130px 120px 46px 168px' : '1fr 160px 160px 60px'

  async function withBusy(action: () => Promise<void>, ok: string) {
    if (!token || !charFleet) return
    setBusy(true); setMsg(null)
    try { await action(); setMsg(ok); await load(token) }
    catch (e) { setMsg(`Mislukt: ${(e as Error).message ?? 'fout'}`) }
    finally { setBusy(false) }
  }

  const saveMotd = () => withBusy(() => setFleetSettings(charFleet!.fleet_id, token!.accessToken, { motd: motdDraft }), 'MOTD opgeslagen')
  const toggleFreeMove = () => withBusy(() => setFleetSettings(charFleet!.fleet_id, token!.accessToken, { is_free_move: !fleetInfo?.is_free_move }), 'Free Move gewijzigd')
  const kick = (memberId: number, name: string) => { if (confirm(`${name} uit de fleet verwijderen?`)) withBusy(() => kickFleetMember(charFleet!.fleet_id, token!.accessToken, memberId), `${name} verwijderd`) }
  const moveTo = (memberId: number, opt: { wingId: number; squadId: number }) =>
    withBusy(() => moveFleetMember(charFleet!.fleet_id, token!.accessToken, memberId, { role: 'squad_member', wing_id: opt.wingId, squad_id: opt.squadId }), 'Lid verplaatst')
  async function doInvite() {
    const name = inviteName.trim()
    if (!name) return
    const sq = squadOptions[0]
    if (!sq) { setMsg('Geen squad om naartoe uit te nodigen — maak eerst een squad in de fleet.'); return }
    setBusy(true); setMsg(null)
    const id = await resolveCharacterId(name)
    if (!id) { setMsg(`Karakter "${name}" niet gevonden`); setBusy(false); return }
    try {
      await inviteFleetMember(charFleet!.fleet_id, token!.accessToken, id, { role: 'squad_member', wing_id: sq.wingId, squad_id: sq.squadId })
      setMsg(`Uitnodiging verstuurd naar ${name}`); setInviteName('')
    } catch (e) { setMsg(`Uitnodigen mislukt: ${(e as Error).message ?? 'fout'}`) }
    finally { setBusy(false) }
  }

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

          {/* Fleet-beheer (alleen FC) */}
          {canManage && (
            <div style={{ background: 'var(--surface)', border: '1px solid rgba(0,180,216,0.4)', borderRadius: 3, padding: '0.85rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.12em' }}>⚑ FLEET-BEHEER (FC)</span>
                {msg && <span style={{ fontSize: '0.62rem', color: /mislukt|niet gevonden|Geen squad/i.test(msg) ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
              </div>

              {!hasFleetWrite && (
                <div style={{ background: 'rgba(240,192,64,0.08)', border: '1px solid rgba(240,192,64,0.35)', borderRadius: 3, padding: '0.55rem 0.75rem', marginBottom: '0.7rem', fontSize: '0.7rem', color: 'var(--gold)', lineHeight: 1.5 }}>
                  ⚠ Je huidige login mist de <strong>fleet-beheer-rechten</strong> (esi-fleets.write_fleet). Uitnodigen, kicken en MOTD wijzigen werken daardoor niet.
                  {' '}Los het op: ga in de zijbalk naar je account → <strong>verwijder dit account</strong> en log opnieuw in (dan worden de nieuwe rechten verleend).
                </div>
              )}

              {/* MOTD bewerken */}
              <div style={{ marginBottom: '0.7rem' }}>
                {editingMotd ? (
                  <>
                    <textarea value={motdDraft} onChange={e => setMotdDraft(e.target.value)} rows={3}
                      placeholder="Fleet MOTD…"
                      style={{ width: '100%', background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.75rem', padding: '0.5rem', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }} />
                    <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                      <button onClick={() => { saveMotd(); setEditingMotd(false) }} disabled={busy} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.7rem', fontWeight: 600, padding: '0.3rem 0.8rem', cursor: 'pointer' }}>MOTD opslaan</button>
                      <button onClick={() => setEditingMotd(false)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-dim)', fontSize: '0.7rem', padding: '0.3rem 0.8rem', cursor: 'pointer' }}>Annuleren</button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => { setMotdDraft((fleetInfo?.motd ?? '').replace(/<[^>]+>/g, '')); setEditingMotd(true) }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.7rem', padding: '0.3rem 0.8rem', cursor: 'pointer' }}>✎ MOTD bewerken</button>
                )}
              </div>

              {/* Free move + uitnodigen */}
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={toggleFreeMove} disabled={busy} style={{
                  fontSize: '0.7rem', fontWeight: 600, padding: '0.3rem 0.8rem', borderRadius: 3, cursor: 'pointer',
                  background: fleetInfo?.is_free_move ? 'rgba(62,207,110,0.12)' : 'transparent',
                  border: `1px solid ${fleetInfo?.is_free_move ? 'var(--green)' : 'var(--border)'}`,
                  color: fleetInfo?.is_free_move ? 'var(--green)' : 'var(--text-dim)',
                }}>Free Move: {fleetInfo?.is_free_move ? 'AAN' : 'UIT'}</button>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input value={inviteName} onChange={e => setInviteName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doInvite() }}
                    placeholder="Karakternaam uitnodigen…"
                    style={{ width: 200, background: '#05050e', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', fontSize: '0.72rem', padding: '0.3rem 0.5rem', outline: 'none' }} />
                  <button onClick={doInvite} disabled={busy} style={{ background: 'rgba(0,180,216,0.12)', border: '1px solid var(--blue)', borderRadius: 3, color: 'var(--blue)', fontSize: '0.7rem', fontWeight: 600, padding: '0.3rem 0.8rem', cursor: 'pointer' }}>Uitnodigen</button>
                </div>
              </div>
            </div>
          )}

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
              <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: memberCols, gap: '0.5rem' }}>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>KARAKTER</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>SHIP</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>LOCATIE</span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>ROL</span>
                {canManage && <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.1em' }}>ACTIES</span>}
              </div>
              {members.map(m => {
                const isMe = m.character_id === token?.characterId
                return (
                  <div
                    key={m.character_id}
                    style={{
                      display: 'grid', gridTemplateColumns: memberCols,
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
                    {canManage && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'flex-end' }}>
                        {squadOptions.length > 0 && (
                          <select
                            value="-1"
                            onChange={e => { const i = Number(e.target.value); if (i >= 0) moveTo(m.character_id, squadOptions[i]) }}
                            disabled={busy}
                            title="Verplaats naar squad"
                            style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, color: 'var(--text-dim)', fontSize: '0.6rem', padding: '0.15rem 0.2rem', maxWidth: 110, cursor: 'pointer', outline: 'none' }}
                          >
                            <option value="-1">Verplaats…</option>
                            {squadOptions.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
                          </select>
                        )}
                        {!isMe && (
                          <button onClick={() => kick(m.character_id, m.characterName)} disabled={busy} title="Uit fleet verwijderen"
                            style={{ background: 'transparent', border: '1px solid rgba(224,85,85,0.4)', borderRadius: 2, color: 'var(--red)', fontSize: '0.7rem', lineHeight: 1, padding: '0.15rem 0.4rem', cursor: 'pointer', flexShrink: 0 }}>✕</button>
                        )}
                      </div>
                    )}
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
