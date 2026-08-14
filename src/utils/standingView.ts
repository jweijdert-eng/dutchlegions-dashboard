import type { EsiStanding } from '../hooks/useEsiStandings'
import type { Standing } from './localStandings'

// Hoe een naam in local gekleurd wordt. Stond eerst twee keer los in
// LocalChat.tsx én LocalChatWidget.tsx; die kopieën liepen uit elkaar te lopen,
// dus staat het hier één keer.

export type ChatStanding = EsiStanding | 'own'

/**
 * Handmatige override > eigen characters > eigen corp/alliance > contacten.
 *
 * Bewust streng: wie niet aantoonbaar vriendelijk is, kleurt rood. Een
 * onbekende in local is een risico, geen neutraal gegeven. Maar je eigen corp-
 * en alliance-leden vallen daar nadrukkelijk NIET onder — die staan niet in de
 * contactenlijst en kleurden daardoor eerst allemaal rood.
 */
export function effectiveStanding(
  name: string,
  ownNames: string[],
  esi: EsiStanding,
  manual: Record<string, Standing>,
): ChatStanding {
  if (ownNames.some(n => n.toLowerCase() === name.toLowerCase())) return 'own'
  const m = manual[name]
  if (m === 'friend') return 'friend'
  if (m === 'enemy') return 'enemy'
  if (esi === 'corp' || esi === 'alliance' || esi === 'friend') return esi
  return 'enemy'
}

export function isVriendelijk(s: ChatStanding): boolean {
  return s === 'own' || s === 'corp' || s === 'alliance' || s === 'friend'
}

export function standingColor(s: ChatStanding, fallback: string): string {
  if (s === 'own' || s === 'corp' || s === 'friend') return 'var(--green)'
  if (s === 'alliance') return '#7fe0ff'      // alliance lichtblauw, zoals in-game
  if (s === 'enemy') return 'var(--red)'
  return fallback
}

export function rowBg(s: ChatStanding, isMention: boolean, alt: boolean, altBg = 'rgba(15,15,34,0.35)'): string {
  if (s === 'enemy') return 'rgba(224,85,85,0.09)'
  if (s === 'alliance') return 'rgba(0,180,216,0.07)'
  if (isVriendelijk(s)) return 'rgba(62,207,110,0.07)'
  if (isMention) return 'rgba(240,192,64,0.06)'
  return alt ? altBg : 'transparent'
}

/** Het tekentje voor de naam: ▲ vriendelijk, ▼ vijandig. */
export function standingTeken(s: ChatStanding): string {
  if (s === 'enemy') return '▼'
  if (s === 'own') return ''
  return isVriendelijk(s) ? '▲' : ''
}

export function standingUitleg(s: ChatStanding): string {
  switch (s) {
    case 'own': return 'jouw eigen character'
    case 'corp': return 'jouw corp'
    case 'alliance': return 'jouw alliance'
    case 'friend': return 'blauw (contact)'
    default: return 'geen bekende standing — behandeld als vijandig'
  }
}
