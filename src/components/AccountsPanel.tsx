import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useAlerts } from '../context/useAlerts'
import { getWallet, getCharacterInfo, getAlliance } from '../api/esi'
import EveImage from './EveImage'
import SolarSystem from './SolarSystem'

interface CharInfo { wallet: number | null; corpId: number | null; allianceId: number | null; allianceName: string | null }

function fmtISK(v: number) {
  const abs = Math.abs(v), neg = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${neg}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${neg}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${neg}${(abs / 1e3).toFixed(0)}K`
  return `${neg}${abs.toFixed(0)}`
}

// Accountbeheer + character-switcher (verplaatst vanuit de zijbalk naar Instellingen).
export default function AccountsPanel() {
  const { tokens, removeToken, selectedCharId, setSelectedCharId, mainCharId, setMainCharId } = useAuth()
  const alerts = useAlerts()
  const [info, setInfo] = useState<Map<number, CharInfo>>(new Map())

  useEffect(() => {
    tokens.forEach(async t => {
      const wallet = await getWallet(t.characterId, t.accessToken).catch(() => null)
      const ci = await getCharacterInfo(t.characterId).catch(() => null)
      const allianceId = ci?.alliance_id ?? null
      const ally = allianceId ? await getAlliance(allianceId).catch(() => null) : null
      setInfo(prev => new Map(prev).set(t.characterId, {
        wallet, corpId: ci?.corporation_id ?? null, allianceId, allianceName: ally?.name ?? null,
      }))
    })
  }, [tokens.map(t => t.characterId).join(',')])

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      {/* Alle accounts */}
      <div
        onClick={() => setSelectedCharId(null)}
        style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.85rem', cursor: 'pointer',
          background: selectedCharId === null ? 'rgba(0,180,216,0.08)' : 'transparent',
          borderLeft: `3px solid ${selectedCharId === null ? 'var(--blue)' : 'transparent'}`, borderBottom: '1px solid var(--border)' }}
      >
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(0,180,216,0.15)', border: '1px solid rgba(0,180,216,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', color: 'var(--blue)', flexShrink: 0 }}>⊞</div>
        <div>
          <div style={{ fontSize: '0.78rem', fontWeight: 600, color: selectedCharId === null ? 'var(--blue)' : 'var(--text)' }}>Alle accounts</div>
          <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{tokens.length} account{tokens.length !== 1 ? 's' : ''} · toont gecombineerde data</div>
        </div>
      </div>

      {/* Per account */}
      {tokens.map(t => {
        const d   = info.get(t.characterId)
        const l   = alerts.locations.get(t.characterId)
        const sel = selectedCharId === t.characterId
        const main = mainCharId === t.characterId
        return (
          <div key={t.characterId}
            onClick={() => setSelectedCharId(sel ? null : t.characterId)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.85rem', cursor: 'pointer',
              background: sel ? 'rgba(0,180,216,0.08)' : 'transparent',
              borderLeft: `3px solid ${sel ? 'var(--blue)' : 'transparent'}`, borderBottom: '1px solid rgba(28,28,53,0.5)' }}
            onMouseEnter={e => { if (!sel) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)' }}
            onMouseLeave={e => { if (!sel) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            <EveImage category="characters" id={t.characterId} variation="portrait" size={64} px={36} round
              style={{ border: `1px solid ${sel ? 'var(--blue)' : 'var(--border)'}`, display: 'block', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: sel ? 'var(--blue)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                {t.characterName}
                {main && <span style={{ color: 'var(--gold)', fontSize: '0.62rem' }}>★</span>}
              </div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>{d?.wallet != null ? `${fmtISK(d.wallet)} ISK` : '—'}</div>
              {(d?.corpId || d?.allianceId) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.12rem' }}>
                  {d?.corpId && <EveImage category="corporations" id={d.corpId} variation="logo" size={32} px={14} style={{ borderRadius: 2, flexShrink: 0 }} />}
                  {d?.allianceId && <EveImage category="alliances" id={d.allianceId} variation="logo" size={32} px={14} style={{ borderRadius: 2, flexShrink: 0 }} />}
                  {d?.allianceName && <span style={{ fontSize: '0.58rem', color: 'var(--gold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.allianceName}</span>}
                </div>
              )}
              {l?.system && l.system !== '—' && (
                <div style={{ fontSize: '0.6rem', color: 'var(--text)', marginTop: '0.1rem' }}>
                  ⬡ <SolarSystem name={l.system} systemId={l.systemId ?? undefined} fontSize="0.6rem" />
                  {l.shipName && l.shipName !== '—' && <span style={{ color: 'var(--gold)', marginLeft: '0.3rem' }}>· {l.shipName}</span>}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
              <button
                onClick={e => { e.stopPropagation(); setMainCharId(main ? null : t.characterId) }}
                title={main ? 'Verwijder als hoofdaccount' : 'Stel in als hoofdaccount'}
                style={{ background: main ? 'rgba(240,192,64,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${main ? 'rgba(240,192,64,0.5)' : 'rgba(255,255,255,0.1)'}`, color: main ? 'var(--gold)' : 'var(--text-dim)', borderRadius: 3, fontSize: '0.78rem', padding: '0.3rem 0.5rem', cursor: 'pointer' }}
              >★</button>
              <button
                onClick={e => { e.stopPropagation(); if (confirm(`${t.characterName} uitloggen?`)) { removeToken(t.characterId); window.location.href = '/' } }}
                title="Uitloggen"
                style={{ background: 'rgba(224,85,85,0.07)', border: '1px solid rgba(224,85,85,0.2)', color: 'var(--red)', borderRadius: 3, fontSize: '0.78rem', padding: '0.3rem 0.5rem', cursor: 'pointer' }}
              >⏏</button>
            </div>
          </div>
        )
      })}

      {/* + Account toevoegen */}
      <NavLink to="/login"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', padding: '0.6rem', textDecoration: 'none', background: 'rgba(0,180,216,0.05)', color: 'var(--blue)', fontSize: '0.72rem', fontWeight: 600 }}
      >+ Account toevoegen</NavLink>
    </div>
  )
}
