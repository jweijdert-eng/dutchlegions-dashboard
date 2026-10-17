import { getCharacterInfo, getCorporation, tokenScopes } from './esi'
import type { TokenData } from '../auth/sso'

export const CORP_WALLET_SCOPE = 'esi-wallet.read_corporation_wallets.v1'
export const CORP_DIVISIONS_SCOPE = 'esi-corporations.read_divisions.v1'

export interface CorpDivision { division: number; balance: number; name: string }
export interface CorpJournalEntry {
  id: number
  date: string
  ref_type: string
  description: string
  amount?: number
  balance?: number
  reason?: string
}
export interface CorpWalletData {
  id: number
  name: string
  ticker: string
  divisions: CorpDivision[]
  charIds: number[]   // characters die deze wallet mogen lezen; de werkende eerst
  via: string
}

class CorpEsiError extends Error {
  constructor(public status: number) {
    super(status === 403 ? 'Dit character heeft geen toegang tot de corp wallet in EVE.'
      : status === 401 ? 'De EVE-login is verlopen. Koppel je character opnieuw.'
      : `EVE kon de corp wallet niet ophalen (HTTP ${status}). Probeer later opnieuw.`)
  }
}

// Privégegevens blijven in het geheugen van deze pagina. ESI controleert de
// toestemming én corp-rol; tokenScopes is alleen een hulp voor de login-knop.
async function request<T>(path: string, token: TokenData, signal: AbortSignal): Promise<{ data: T; pages: number }> {
  const res = await fetch(`https://esi.evetech.net/latest${path}`, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!res.ok) throw new CorpEsiError(res.status)
  return { data: await res.json() as T, pages: Math.max(1, Number(res.headers.get('x-pages')) || 1) }
}

async function withAccess<T>(tokens: TokenData[], path: string, signal: AbortSignal) {
  let denied: unknown = new Error('Geen gekoppeld character met wallettoestemming.')
  for (const token of tokens) {
    try { return { ...await request<T>(path, token, signal), token } }
    catch (error) {
      if (!(error instanceof CorpEsiError) || ![401, 403].includes(error.status)) throw error
      denied = error
    }
  }
  throw denied
}

export async function loadCorpWallets(tokens: TokenData[], signal: AbortSignal) {
  const eligible = tokens.filter(t => tokenScopes(t.accessToken).includes(CORP_WALLET_SCOPE))
  const groups = new Map<number, TokenData[]>()
  const notices: string[] = []
  await Promise.all(eligible.map(async token => {
    try {
      const info = await getCharacterInfo(token.characterId)
      const group = groups.get(info.corporation_id) ?? []
      group.push(token)
      groups.set(info.corporation_id, group)
    } catch { notices.push(`${token.characterName}: corporation kon niet worden opgehaald. Probeer opnieuw.`) }
  }))
  const wallets = await Promise.all([...groups].map(async ([id, candidates]) => {
    const { name, ticker } = await getCorporation(id).catch(() => ({ name: `Corporation ${id}`, ticker: '' }))
    try {
      const { data, token } = await withAccess<Array<{ division: number; balance: number }>>(candidates, `/corporations/${id}/wallets/`, signal)
      const names: Record<number, string> = {}
      const namers = candidates.filter(t => tokenScopes(t.accessToken).includes(CORP_DIVISIONS_SCOPE))
      if (namers.length) {
        try {
          const result = await withAccess<{ wallet?: Array<{ division: number; name?: string }> }>(namers, `/corporations/${id}/divisions/`, signal)
          for (const division of result.data.wallet ?? []) if (division.name) names[division.division] = division.name
        } catch { /* Divisienamen vereisen Director; saldi werken ook zonder die rol. */ }
      }
      return {
        id, name, ticker, charIds: [token, ...candidates.filter(t => t !== token)].map(t => t.characterId), via: token.characterName,
        divisions: data.map(d => ({ ...d, name: names[d.division] ?? (d.division === 1 ? 'Master Wallet' : `Divisie ${d.division}`) }))
          .sort((a, b) => a.division - b.division),
      } satisfies CorpWalletData
    } catch (error) {
      if (!signal.aborted) notices.push(`${name}: ${error instanceof Error ? error.message : 'Ophalen mislukt.'}`)
      return null
    }
  }))
  return { wallets: wallets.filter((w): w is CorpWalletData => w !== null).sort((a, b) => a.name.localeCompare(b.name)), notices }
}

// Met de tokens van nu: ze worden elke ~20 minuten ververst, dus niet die van het laden van de wallet.
export async function loadCorpJournal(wallet: CorpWalletData, tokens: TokenData[], division: number, page: number, signal: AbortSignal) {
  const candidates = wallet.charIds.map(id => tokens.find(t => t.characterId === id)).filter((t): t is TokenData => !!t)
  const result = await withAccess<CorpJournalEntry[]>(candidates,
    `/corporations/${wallet.id}/wallets/${division}/journal/?page=${page}`, signal)
  return { entries: result.data, pages: result.pages }
}
