import { useEffect, useState } from 'react'
import Layout, { PageHeader } from '../components/Layout'
import { useAuth } from '../auth/AuthContext'
import type { TokenData } from '../auth/sso'
import EveImage from '../components/EveImage'
import SolarSystem from '../components/SolarSystem'
import {
  getWallet, getWalletJournal, getSkillQueue, getIndustryJobs,
  getMail, getMarketOrders, getLocation, getShip, getCharacterInfo,
  getCorporation, getAlliance, getSystemInfo, resolveNames,
  getOnlineStatus, getJumpFatigue,
} from '../api/esi'
import { secColor } from '../utils/secColor'

function fmtISK(v: number) {
  const abs = Math.abs(v)
  const neg = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff <= 0) return 'Klaar'
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (d > 0) return `${d}d ${h}u`
  if (h > 0) return `${h}u ${m}m`
  return `${m}m`
}

function timeSince(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 0) return 'zojuist'
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (d > 0) return `${d}d ${h}u geleden`
  if (h > 0) return `${h}u ${m}m geleden`
  if (m > 0) return `${m}m geleden`
  return 'zojuist'
}

interface CharState {
  wallet: number | null
  dailyEarnings: number
  activeSkill: { name: string; level: number; progress: number; eta: string } | null
  queueCount: number
  activeJobs: number
  nextJobEta: string | null
  readyJobs: number
  unreadMail: number
  activeOrders: number
  systemName: string | null
  systemId: number | null
  shipTypeName: string | null
  shipName: string | null
  corpId: number | null
  corpName: string | null
  corpTicker: string | null
  allianceId: number | null
  allianceName: string | null
  allianceTicker: string | null
  isOnline: boolean | null
  lastLogout: string | null
  jumpFatigueExpiry: string | null
  secStatus: number | null
  birthday: string | null
  loaded: boolean
}

function SkillBar({ progress, eta, name, level }: { progress: number; eta: string; name: string; level: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.3rem' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '68%' }}>
          {name}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
          <span style={{ fontSize: '0.62rem', color: 'var(--blue)', fontWeight: 700 }}>Lvl {level}</span>
          <span style={{ fontSize: '0.62rem', color: 'var(--gold)' }}>{eta}</span>
        </div>
      </div>
      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(progress * 100).toFixed(1)}%`, background: 'var(--blue)', borderRadius: 2, transition: 'width 1s linear', boxShadow: '0 0 6px rgba(0,180,216,0.5)' }} />
      </div>
    </div>
  )
}

function Section({ icon, color, children }: { icon: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{
      borderLeft: `2px solid ${color}`,
      paddingLeft: '0.6rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.25rem',
    }}>
      <span style={{ fontSize: '0.55rem', color, letterSpacing: '0.12em', fontWeight: 700, marginBottom: '0.1rem' }}>{icon}</span>
      {children}
    </div>
  )
}

function CharCard({ token }: { token: TokenData }) {
  const [s, setS] = useState<CharState>({
    wallet: null, dailyEarnings: 0, activeSkill: null, queueCount: 0,
    activeJobs: 0, nextJobEta: null, readyJobs: 0, unreadMail: 0,
    activeOrders: 0, systemName: null, systemId: null,
    shipTypeName: null, shipName: null,
    corpId: null, corpName: null, corpTicker: null,
    allianceId: null, allianceName: null, allianceTicker: null,
    isOnline: null, lastLogout: null, jumpFatigueExpiry: null,
    secStatus: null, birthday: null,
    loaded: false,
  })

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10)

    Promise.allSettled([
      getWallet(token.characterId, token.accessToken),
      getWalletJournal(token.characterId, token.accessToken, 1),
      getSkillQueue(token.characterId, token.accessToken),
      getIndustryJobs(token.characterId, token.accessToken),
      getMail(token.characterId, token.accessToken),
      getMarketOrders(token.characterId, token.accessToken),
      getLocation(token.characterId, token.accessToken),
      getShip(token.characterId, token.accessToken),
      getCharacterInfo(token.characterId),
      getOnlineStatus(token.characterId, token.accessToken),
      getJumpFatigue(token.characterId, token.accessToken),
    ]).then(async ([walletR, journalR, queueR, jobsR, mailR, ordersR, locR, shipR, charR, onlineR, fatigueR]) => {
      const wallet   = walletR.status  === 'fulfilled' ? walletR.value  : null
      const journal  = journalR.status === 'fulfilled' ? journalR.value : []
      const queue    = queueR.status   === 'fulfilled' ? queueR.value   : []
      const jobs     = jobsR.status    === 'fulfilled' ? jobsR.value    : []
      const mail     = mailR.status    === 'fulfilled' ? mailR.value    : []
      const orders   = ordersR.status  === 'fulfilled' ? ordersR.value  : []
      const loc      = locR.status     === 'fulfilled' ? locR.value     : null
      const ship     = shipR.status    === 'fulfilled' ? shipR.value    : null
      const charInfo = charR.status    === 'fulfilled' ? charR.value    : null
      const online   = onlineR.status  === 'fulfilled' ? onlineR.value  : null
      const fatigue  = fatigueR.status === 'fulfilled' ? fatigueR.value : null

      const dailyEarnings = journal
        .filter(e => e.date.startsWith(today) && e.amount > 0)
        .reduce((s, e) => s + e.amount, 0)

      const activeEntry = queue.find(e => e.queue_position === 0 && e.finish_date)
      let activeSkill: CharState['activeSkill'] = null
      if (activeEntry?.finish_date) {
        const names = await resolveNames([activeEntry.skill_id]).catch(() => new Map<number, string>())
        const name  = names.get(activeEntry.skill_id) ?? `Skill ${activeEntry.skill_id}`
        const start  = activeEntry.start_date ? new Date(activeEntry.start_date).getTime() : Date.now()
        const finish = new Date(activeEntry.finish_date).getTime()
        const progress = Math.min(1, Math.max(0, (Date.now() - start) / (finish - start)))
        activeSkill = { name, level: activeEntry.finished_level, progress, eta: timeUntil(activeEntry.finish_date) }
      }

      const activeJobList = jobs.filter(j => j.status === 'active')
      const readyJobs     = jobs.filter(j => j.status === 'ready').length
      const nextJob       = activeJobList.sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime())[0]

      let systemName: string | null = null
      const systemId: number | null = loc?.solar_system_id ?? null
      if (loc?.solar_system_id) {
        const info = await getSystemInfo(loc.solar_system_id).catch(() => null)
        systemName = info?.name ?? null
      }

      let shipTypeName: string | null = null
      if (ship?.ship_type_id) {
        const names = await resolveNames([ship.ship_type_id]).catch(() => new Map<number, string>())
        shipTypeName = names.get(ship.ship_type_id) ?? null
      }

      const corpId    = charInfo?.corporation_id ?? null
      const allianceId = charInfo?.alliance_id ?? null

      const [corpR2, aliR] = await Promise.allSettled([
        corpId    ? getCorporation(corpId)     : Promise.resolve(null),
        allianceId ? getAlliance(allianceId)   : Promise.resolve(null),
      ])

      const corp  = corpR2.status  === 'fulfilled' ? corpR2.value  : null
      const ali   = aliR.status    === 'fulfilled' ? aliR.value    : null

      setS({
        wallet,
        dailyEarnings,
        activeSkill,
        queueCount: queue.length,
        activeJobs: activeJobList.length,
        nextJobEta: nextJob?.end_date ? timeUntil(nextJob.end_date) : null,
        readyJobs,
        unreadMail: mail.filter(m => !m.is_read).length,
        activeOrders: orders.length,
        systemName,
        systemId,
        shipTypeName,
        shipName: ship?.ship_name ?? null,
        corpId,
        corpName: corp?.name ?? null,
        corpTicker: corp?.ticker ?? null,
        allianceId,
        allianceName: ali?.name ?? null,
        allianceTicker: ali?.ticker ?? null,
        isOnline: online?.online ?? null,
        lastLogout: online?.last_logout ?? null,
        jumpFatigueExpiry: fatigue?.jump_fatigue_expire_date ?? null,
        secStatus: charInfo?.security_status ?? null,
        birthday: charInfo?.birthday ?? null,
        loaded: true,
      })
    })
  }, [token.characterId])

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      width: 300,
      flexShrink: 0,
    }}>
      {/* ── Header ── */}
      <div style={{
        position: 'relative',
        background: 'linear-gradient(135deg, #0b0b2a 0%, #0d0d35 60%, #080818 100%)',
        borderBottom: '1px solid var(--border)',
        padding: '0.875rem 0.875rem 0.75rem',
        overflow: 'hidden',
      }}>
        {/* Faded corp logo bg */}
        {s.corpId && (
          <EveImage category="corporations" id={s.corpId} variation="logo" size={128} px={90}
            style={{ position: 'absolute', right: -10, top: '50%', transform: 'translateY(-50%)', opacity: 0.06, filter: 'blur(1px)', borderRadius: 0, pointerEvents: 'none' }} />
        )}

        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          {/* Portrait + corp overlay */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <EveImage category="characters" id={token.characterId} variation="portrait" size={64} px={56} round
              style={{ border: `2px solid ${s.isOnline === true ? 'rgba(62,207,110,0.6)' : 'rgba(0,180,216,0.35)'}`, display: 'block' }} />
            {/* Online status dot */}
            {s.isOnline !== null && (
              <div style={{
                position: 'absolute', bottom: s.corpId ? 16 : -3, left: -3,
                width: 10, height: 10, borderRadius: '50%',
                background: s.isOnline ? '#3ecf6e' : '#555',
                border: '2px solid var(--surface)',
                boxShadow: s.isOnline ? '0 0 6px rgba(62,207,110,0.8)' : 'none',
              }} />
            )}
            {s.corpId && (
              <EveImage category="corporations" id={s.corpId} variation="logo" size={32} px={20}
                style={{ position: 'absolute', bottom: -2, right: -4, borderRadius: 3, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
            )}
            {s.allianceId && (
              <EveImage category="alliances" id={s.allianceId} variation="logo" size={32} px={20}
                style={{ position: 'absolute', top: -2, right: -4, borderRadius: 3, border: '1px solid var(--surface)', background: 'var(--surface)' }} />
            )}
          </div>

          {/* Name + corp + wallet */}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.1rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {token.characterName}
              </div>
              {s.secStatus !== null && (
                <span style={{ fontSize: '0.6rem', fontWeight: 700, color: secColor(s.secStatus), flexShrink: 0, letterSpacing: '0.02em' }}>
                  {s.secStatus > 0 ? '+' : ''}{s.secStatus.toFixed(1)}
                </span>
              )}
              {s.birthday && (
                <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)', flexShrink: 0 }}>
                  {Math.floor((Date.now() - new Date(s.birthday).getTime()) / (365.25 * 24 * 3600 * 1000))}j
                </span>
              )}
            </div>
            {s.corpTicker && s.corpName && (
              <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '0.05rem' }}>
                <span style={{ color: 'var(--gold)', fontWeight: 700 }}>[{s.corpTicker}]</span>
                {' '}<span style={{ color: '#f97316' }}>{s.corpName}</span>
              </div>
            )}
            {s.allianceTicker && s.allianceName && (
              <div style={{ fontSize: '0.63rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '0.3rem' }}>
                <span style={{ color: 'var(--gold)', fontWeight: 700 }}>[{s.allianceTicker}]</span>
                {' '}<span style={{ color: 'var(--blue)' }}>{s.allianceName}</span>
              </div>
            )}
            <div style={{ marginTop: s.allianceName ? 0 : '0.3rem' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color: s.wallet != null ? 'var(--gold)' : 'var(--border)', fontVariantNumeric: 'tabular-nums' }}>
                {s.wallet != null ? `${fmtISK(s.wallet)} ISK` : '—'}
              </span>
              {s.dailyEarnings > 0 && (
                <span style={{ fontSize: '0.62rem', color: 'var(--green)', marginLeft: '0.4rem', fontWeight: 600 }}>
                  +{fmtISK(s.dailyEarnings)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', flex: 1 }}>
        {!s.loaded ? (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', textAlign: 'center', padding: '1.5rem 0' }}>Laden...</div>
        ) : (
          <>
            {/* Location */}
            {(s.systemName || s.shipTypeName) && (
              <Section icon="LOCATIE" color="var(--green)">
                {s.systemName && (
                  <div style={{ fontSize: '0.72rem', fontWeight: 600 }}>
                    <SolarSystem name={s.systemName} systemId={s.systemId ?? undefined} fontSize="0.72rem" />
                  </div>
                )}
                {s.shipTypeName && (
                  <div style={{ fontSize: '0.63rem', color: 'var(--text-dim)' }}>
                    {s.shipTypeName}
                    {s.shipName && s.shipName !== s.shipTypeName && (
                      <span style={{ color: 'var(--gold)', marginLeft: '0.3rem' }}>· {s.shipName}</span>
                    )}
                  </div>
                )}
              </Section>
            )}

            {/* Skill queue */}
            <Section icon="SKILL QUEUE" color="var(--blue)">
              {s.activeSkill ? (
                <SkillBar {...s.activeSkill} />
              ) : (
                <div style={{ fontSize: '0.68rem', color: 'var(--red)' }}>Queue leeg</div>
              )}
              {s.queueCount > 1 && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                  +{s.queueCount - 1} skill{s.queueCount - 1 !== 1 ? 's' : ''} in wachtrij
                </div>
              )}
            </Section>

            {/* Industry */}
            {(s.activeJobs > 0 || s.readyJobs > 0) && (
              <Section icon="INDUSTRIE" color="#a78bfa">
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  {s.readyJobs > 0 && (
                    <span style={{ fontSize: '0.67rem', fontWeight: 700, color: 'var(--green)', background: 'rgba(62,207,110,0.1)', border: '1px solid rgba(62,207,110,0.3)', borderRadius: 3, padding: '0.1rem 0.4rem' }}>
                      ✓ {s.readyJobs} klaar
                    </span>
                  )}
                  {s.activeJobs > 0 && (
                    <span style={{ fontSize: '0.67rem', color: '#a78bfa' }}>
                      {s.activeJobs} actief
                    </span>
                  )}
                  {s.nextJobEta && (
                    <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                      volgende: {s.nextJobEta}
                    </span>
                  )}
                </div>
              </Section>
            )}

            {/* Jump fatigue */}
            {s.jumpFatigueExpiry && new Date(s.jumpFatigueExpiry).getTime() > Date.now() && (
              <Section icon="JUMP FATIGUE" color="#f97316">
                <div style={{ fontSize: '0.68rem', color: '#f97316', fontVariantNumeric: 'tabular-nums' }}>
                  {timeUntil(s.jumpFatigueExpiry)}
                </div>
              </Section>
            )}

            {/* Last seen (offline) */}
            {s.isOnline === false && s.lastLogout && (
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#555', flexShrink: 0 }} />
                Offline · {timeSince(s.lastLogout)}
              </div>
            )}

            {/* Alerts row */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: 'auto', paddingTop: '0.1rem' }}>
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                padding: '0.35rem 0.5rem',
                background: s.unreadMail > 0 ? 'rgba(224,85,85,0.08)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${s.unreadMail > 0 ? 'rgba(224,85,85,0.3)' : 'var(--border)'}`,
                borderRadius: 3,
              }}>
                <span style={{ fontSize: '0.7rem' }}>✉</span>
                <span style={{ fontSize: '0.68rem', fontWeight: s.unreadMail > 0 ? 700 : 400, color: s.unreadMail > 0 ? 'var(--red)' : 'var(--text-dim)' }}>
                  {s.unreadMail > 0 ? s.unreadMail : '—'}
                </span>
              </div>
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                padding: '0.35rem 0.5rem',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border)',
                borderRadius: 3,
              }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>◊</span>
                <span style={{ fontSize: '0.68rem', color: s.activeOrders > 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                  {s.activeOrders > 0 ? s.activeOrders : '—'}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Inhoud zonder Layout — herbruikbaar (o.a. als 'Overzicht'-view in Character).
export function MultiCharBody() {
  const { tokens } = useAuth()
  return (
    <div style={{ padding: '1.25rem 0', overflowY: 'auto' }}>
      {tokens.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60%', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Geen accounts ingelogd
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
          {tokens.map(t => <CharCard key={t.characterId} token={t} />)}
        </div>
      )}
    </div>
  )
}

export default function MultiChar() {
  return (
    <Layout header={<PageHeader title="OVERZICHT" sub="Alle karakters in één oogopslag" />}>
      <MultiCharBody />
    </Layout>
  )
}
