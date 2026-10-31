import type { TokenData } from './sso'

// Het EVE-token waarmee de eigen API (/api/*.php) bewijst wie je bent en dat je lid bent.
// Leest altijd de nieuwste stand uit localStorage (AuthContext ververst daar de tokens),
// zodat een callback of interval nooit met een verlopen token blijft zitten.
// Voorkeur: het hoofd-character, anders het eerste dat nog geldig is.
export function apiToken(characterId?: number): string {
  let tokens: TokenData[] = []
  try { tokens = JSON.parse(localStorage.getItem('eve_tokens') ?? '[]') as TokenData[] } catch { /* leeg */ }
  if (characterId != null) return tokens.find(t => t.characterId === characterId)?.accessToken ?? ''
  const main = Number(localStorage.getItem('eve_main_char') || 0)
  const nu = Date.now()
  const geldig = tokens.filter(t => t.expiresAt > nu)
  return (geldig.find(t => t.characterId === main) ?? geldig[0] ?? tokens[0])?.accessToken ?? ''
}

// Header voor een aanroep naar de eigen API. Het token gaat in een header en niet in de
// URL, zodat het niet in de serverlogs belandt.
export function apiHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
  return { ...(extra ?? {}), 'X-Token': token ?? apiToken() }
}
