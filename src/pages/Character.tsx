import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  getCharacterInfo, getSkillsInfo, getCorporation, getWallet,
  getClones, getImplants, getCharacterAttributes, getStationInfo, getStructureName, resolveNames,
  type CharacterInfo, type CorporationInfo, type ClonesInfo, type CharacterAttributes,
} from '../api/esi'
import Layout, { PageHeader } from '../components/Layout'
import EveImage from '../components/EveImage'
import Location from '../components/Location'
import { secColor } from '../utils/secColor'
import { usePageLoading } from '../hooks/usePageLoading'
import type { TokenData } from '../auth/sso'

function fmtISK(v: number) {
  const abs = Math.abs(v)
  const neg = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(2)}B ISK`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M ISK`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K ISK`
  return `${neg}${abs.toFixed(0)} ISK`
}
function fmtSP(sp: number) {
  if (sp >= 1e6) return `${(sp / 1e6).toFixed(1)}M SP`
  if (sp >= 1e3) return `${(sp / 1e3).toFixed(0)}K SP`
  return `${sp} SP`
}

function fmtBirthday(date: string) {
  return new Date(date).toLocaleDateString('nl-NL', { year: 'numeric', month: 'long', day: 'numeric' })
}
function fmtDate(date?: string) {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })
}

type Tab = 'overview' | 'implants' | 'clones' | 'attributes'

interface CharData {
  info: CharacterInfo
  corp: CorporationInfo | null
  allianceName: string | null
  totalSP: number
  wallet: number
}

interface ImplantData {
  typeId: number
  name: string
}

interface CloneData {
  clones: ClonesInfo
  locationNames: Map<number, string>
  implantNames: Map<number, string>
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none', border: 'none', borderBottom: `2px solid ${active ? 'var(--blue)' : 'transparent'}`,
        color: active ? 'var(--blue)' : 'var(--text-dim)', cursor: 'pointer',
        fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em',
        padding: '0.5rem 0.75rem', transition: 'color 0.15s',
      }}
    >
      {label}
    </button>
  )
}

function CharCard({ token, allTokens }: { token: TokenData; allTokens: TokenData[] }) {
  const [tab, setTab]           = useState<Tab>('overview')
  const [data, setData]         = useState<CharData | null>(null)
  const [implants, setImplants] = useState<ImplantData[] | null>(null)
  const [cloneData, setCloneData] = useState<CloneData | null>(null)
  const [attrs, setAttrs]       = useState<CharacterAttributes | null>(null)
  const [loading, setLoading]   = useState(true)
  usePageLoading(loading)
  const [tabLoading, setTabLoading] = useState(false)

  useEffect(() => {
    async function load() {
      const [infoRes, skillsRes, walletRes] = await Promise.allSettled([
        getCharacterInfo(token.characterId),
        getSkillsInfo(token.characterId, token.accessToken),
        getWallet(token.characterId, token.accessToken),
      ])
      const info   = infoRes.status   === 'fulfilled' ? infoRes.value   : null
      const skills = skillsRes.status === 'fulfilled' ? skillsRes.value : null
      const wallet = walletRes.status === 'fulfilled' ? walletRes.value : 0
      if (!info) { setLoading(false); return }

      const [corpRes, allianceNames] = await Promise.all([
        getCorporation(info.corporation_id).catch(() => null),
        info.alliance_id ? resolveNames([info.alliance_id]) : Promise.resolve(new Map<number, string>()),
      ])
      setData({ info, corp: corpRes, allianceName: info.alliance_id ? (allianceNames.get(info.alliance_id) ?? null) : null, totalSP: skills?.total_sp ?? 0, wallet })
      setLoading(false)
    }
    load()
  }, [token.characterId, token.accessToken])

  async function loadImplants() {
    if (implants) return
    setTabLoading(true)
    const ids = await getImplants(token.characterId, token.accessToken).catch(() => [] as number[])
    const nameMap = await resolveNames(ids)
    setImplants(ids.map(id => ({ typeId: id, name: nameMap.get(id) ?? `Type ${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name)))
    setTabLoading(false)
  }

  async function loadClones() {
    if (cloneData) return
    setTabLoading(true)
    const clones = await getClones(token.characterId, token.accessToken).catch(() => null)
    if (!clones) { setTabLoading(false); return }

    const allImplantIds = [...new Set(clones.jump_clones.flatMap(c => c.implants))]
    const allLocationIds = [
      clones.home_location.location_id,
      ...clones.jump_clones.map(c => c.location_id),
    ]
    const stationIds   = allLocationIds.filter(id => id < 1_000_000_000)
    const structureIds = allLocationIds.filter(id => id >= 1_000_000_000)

    const [implantNames, locationMap] = await Promise.all([
      resolveNames(allImplantIds),
      Promise.all([
        ...stationIds.map(async id => {
          const s = await getStationInfo(id)
          return [id, s?.name ?? `Station ${id}`] as [number, string]
        }),
        ...structureIds.map(async id => {
          const name = await getStructureName(id, allTokens)
          return [id, name ?? `#${id}`] as [number, string]
        }),
      ]).then(entries => new Map(entries)),
    ])

    setCloneData({ clones, locationNames: locationMap, implantNames })
    setTabLoading(false)
  }

  async function loadAttributes() {
    if (attrs) return
    setTabLoading(true)
    const a = await getCharacterAttributes(token.characterId, token.accessToken).catch(() => null)
    setAttrs(a)
    setTabLoading(false)
  }

  function handleTab(t: Tab) {
    setTab(t)
    if (t === 'implants')   loadImplants()
    if (t === 'clones')     loadClones()
    if (t === 'attributes') loadAttributes()
  }

  if (loading) return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, padding: '1.5rem', color: 'var(--text-dim)', fontSize: '0.75rem' }}>Laden...</div>
  )
  if (!data) return null

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      {/* Banner + portrait */}
      <div style={{ height: 80, background: 'linear-gradient(135deg, #0b0b2a, #0f0f35)', borderBottom: '1px solid var(--border)', position: 'relative' }}>
        {/* Corp logo achtergrond — eigen overflow:hidden zodat portrait vrij blijft */}
        {data.info.corporation_id && (
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            <EveImage
              category="corporations" id={data.info.corporation_id} variation="logo" size={256} px={120}
              style={{ position: 'absolute', right: -10, top: '50%', transform: 'translateY(-50%)', opacity: 0.12, filter: 'blur(1px)', borderRadius: 0 }}
            />
            <EveImage
              category="corporations" id={data.info.corporation_id} variation="logo" size={64} px={40}
              style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', borderRadius: 3, border: '1px solid var(--border)' }}
            />
          </div>
        )}
        <EveImage
          category="characters" id={token.characterId} variation="portrait" size={128} px={80}
          style={{ position: 'absolute', bottom: -40, left: '1.5rem', borderRadius: 3, border: '2px solid var(--border)' }}
        />
      </div>

      <div style={{ padding: '2.75rem 1.5rem 0' }}>
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.2rem' }}>{token.characterName}</div>
          {data.corp && <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>[{data.corp.ticker}] {data.corp.name}</div>}
          {data.allianceName && <div style={{ fontSize: '0.68rem', color: 'var(--blue)', marginTop: '0.1rem' }}>{data.allianceName}</div>}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
          <TabButton label="OVERVIEW"    active={tab === 'overview'}    onClick={() => handleTab('overview')} />
          <TabButton label="IMPLANTS"    active={tab === 'implants'}    onClick={() => handleTab('implants')} />
          <TabButton label="KLONEN"      active={tab === 'clones'}      onClick={() => handleTab('clones')} />
          <TabButton label="ATTRIBUTEN"  active={tab === 'attributes'}  onClick={() => handleTab('attributes')} />
        </div>
      </div>

      <div style={{ padding: '0 1.5rem 1.5rem', minHeight: 160 }}>
        {tabLoading && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', padding: '1rem 0' }}>Laden...</div>
        )}

        {/* Overview */}
        {tab === 'overview' && !tabLoading && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            {[
              { label: 'Skill Points',    value: fmtSP(data.totalSP),                  color: 'var(--gold)' },
              { label: 'Wallet',          value: fmtISK(data.wallet),                  color: data.wallet < 0 ? 'var(--red)' : 'var(--text)' },
              { label: 'Sec Status',      value: data.info.security_status.toFixed(2), color: secColor(data.info.security_status) },
              { label: 'Corp Members',    value: data.corp ? `${data.corp.member_count}` : '—', color: 'var(--text)' },
              { label: 'Geboren',         value: fmtBirthday(data.info.birthday),      color: 'var(--text-dim)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: 'rgba(15,15,34,0.5)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>{label.toUpperCase()}</div>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Implants */}
        {tab === 'implants' && !tabLoading && implants && (
          implants.length === 0
            ? <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen implants</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {implants.map(imp => (
                  <div key={imp.typeId} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <EveImage category="types" id={imp.typeId} variation="icon" size={32} px={26} />
                    <span style={{ fontSize: '0.73rem' }}>{imp.name}</span>
                  </div>
                ))}
              </div>
        )}

        {/* Clones */}
        {tab === 'clones' && !tabLoading && cloneData && (() => {
          const { clones, locationNames, implantNames } = cloneData
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              {/* Home location */}
              <div>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.35rem' }}>THUISBASIS</div>
                <Location
                  locationId={clones.home_location.location_id}
                  name={locationNames.get(clones.home_location.location_id) ?? `Location ${clones.home_location.location_id}`}
                  fontSize="0.75rem"
                />
                {clones.last_clone_jump_date && (
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>
                    Laatste jump: {fmtDate(clones.last_clone_jump_date)}
                  </div>
                )}
              </div>

              {/* Jump clones */}
              {clones.jump_clones.length === 0 ? (
                <div style={{ fontSize: '0.73rem', color: 'var(--text-dim)' }}>Geen jump clones</div>
              ) : (
                <div>
                  <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.5rem' }}>
                    JUMP CLONES ({clones.jump_clones.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {clones.jump_clones.map(jc => (
                      <div key={jc.clone_id} style={{ background: 'rgba(15,15,34,0.5)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.6rem 0.75rem' }}>
                        <Location
                          locationId={jc.location_id}
                          name={locationNames.get(jc.location_id) ?? `Location ${jc.location_id}`}
                          fontSize="0.72rem"
                        />
                        {jc.implants.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.5rem' }}>
                            {jc.implants.map(id => (
                              <div key={id} title={implantNames.get(id)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'rgba(0,180,216,0.06)', border: '1px solid rgba(0,180,216,0.15)', borderRadius: 2, padding: '0.15rem 0.4rem' }}>
                                <EveImage category="types" id={id} variation="icon" size={32} px={16} />
                                <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {implantNames.get(id) ?? `Type ${id}`}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {jc.implants.length === 0 && (
                          <div style={{ fontSize: '0.62rem', color: 'var(--border)', marginTop: '0.3rem' }}>Geen implants</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })()}
        {/* Attributes */}
        {tab === 'attributes' && !tabLoading && attrs && (() => {
          const ATTRS = [
            { label: 'Intelligence', value: attrs.intelligence, color: '#00b4d8' },
            { label: 'Memory',       value: attrs.memory,       color: '#3ecf6e' },
            { label: 'Perception',   value: attrs.perception,   color: '#f97316' },
            { label: 'Willpower',    value: attrs.willpower,    color: '#e05555' },
            { label: 'Charisma',     value: attrs.charisma,     color: '#a78bfa' },
          ]
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {ATTRS.map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'rgba(15,15,34,0.5)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
                    <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.2rem' }}>{label.toUpperCase()}</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: 'rgba(15,15,34,0.5)', border: '1px solid var(--border)', borderRadius: 2, padding: '0.5rem 0.75rem' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', fontWeight: 700, letterSpacing: '0.12em', marginBottom: '0.35rem' }}>NEURAL REMAP</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                  <span style={{ color: attrs.bonus_remaps ? 'var(--green)' : 'var(--text-dim)' }}>
                    {attrs.bonus_remaps ?? 0} bonus remap{(attrs.bonus_remaps ?? 0) !== 1 ? 's' : ''}
                  </span>
                  {attrs.last_remap_date && (
                    <span style={{ color: 'var(--text-dim)' }}>Laatste: {fmtDate(attrs.last_remap_date)}</span>
                  )}
                </div>
                {attrs.accrued_remap_cooldown_date && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>
                    Cooldown tot: {fmtDate(attrs.accrued_remap_cooldown_date)}
                  </div>
                )}
              </div>
            </div>
          )
        })()}
        {tab === 'attributes' && !tabLoading && !attrs && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>Geen data</div>
        )}
      </div>
    </div>
  )
}

export default function Character() {
  const { activeTokens: tokens, tokens: allTokens } = useAuth()
  return (
    <Layout header={<PageHeader title="Character" sub={`${tokens.length} account${tokens.length !== 1 ? 's' : ''}`} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '0.875rem' }}>
        {tokens.map(t => <CharCard key={t.characterId} token={t} allTokens={allTokens} />)}
      </div>
    </Layout>
  )
}
