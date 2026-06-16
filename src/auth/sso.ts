const CLIENT_ID = import.meta.env.VITE_EVE_CLIENT_ID as string
const REDIRECT_URI = (import.meta.env.VITE_EVE_REDIRECT_URI as string | undefined) ?? 'http://localhost:8080/callback'

const SCOPES = [
  'esi-wallet.read_character_wallet.v1',
  'esi-killmails.read_killmails.v1',
  'esi-markets.read_character_orders.v1',
  'esi-skills.read_skillqueue.v1',
  'esi-skills.read_skills.v1',
  'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1',
  'esi-assets.read_assets.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-industry.read_character_mining.v1',
  'esi-planets.manage_planets.v1',
  'esi-mail.read_mail.v1',
  'esi-mail.organize_mail.v1',
  'esi-fittings.read_fittings.v1',
  'esi-fittings.write_fittings.v1',
  'esi-clones.read_clones.v1',
  'esi-clones.read_implants.v1',
  'esi-universe.read_structures.v1',
  'esi-characters.read_blueprints.v1',
  'esi-contracts.read_character_contracts.v1',
  'esi-search.search_structures.v1',
  'esi-markets.structure_markets.v1',
  'esi-fleets.read_fleet.v1',
  'esi-fleets.write_fleet.v1',
  'esi-ui.write_waypoint.v1',
  'esi-mail.send_mail.v1',
  'esi-characters.read_medals.v1',
  'esi-characters.read_contacts.v1',
  'esi-corporations.read_contacts.v1',
  'esi-alliances.read_contacts.v1',
].join(' ')

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function generatePKCE() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64url(new Uint8Array(hash))
  return { verifier, challenge }
}

export async function startLogin() {
  if (!CLIENT_ID) throw new Error('VITE_EVE_CLIENT_ID is niet ingesteld in .env')

  const { verifier, challenge } = await generatePKCE()
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))

  sessionStorage.setItem('pkce_verifier', verifier)
  sessionStorage.setItem('oauth_state', state)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  window.location.href = `https://login.eveonline.com/v2/oauth/authorize?${params}`
}

export interface TokenData {
  accessToken: string
  refreshToken: string
  expiresAt: number
  characterId: number
  characterName: string
}

export async function exchangeCode(code: string, state: string): Promise<TokenData> {
  const savedState = sessionStorage.getItem('oauth_state')
  const verifier = sessionStorage.getItem('pkce_verifier')

  if (state !== savedState) throw new Error('OAuth state mismatch — probeer opnieuw in te loggen')
  if (!verifier) throw new Error('Geen PKCE verifier gevonden — probeer opnieuw')

  sessionStorage.removeItem('oauth_state')
  sessionStorage.removeItem('pkce_verifier')

  const res = await fetch('https://login.eveonline.com/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  })

  if (!res.ok) throw new Error(`Token exchange mislukt: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number }

  const [, payloadB64] = data.access_token.split('.')
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string; name: string }

  const sub = payload.sub
  const characterId = parseInt(sub.includes(':') ? sub.split(':').pop()! : sub)

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    characterId,
    characterName: payload.name,
  }
}

export async function refreshAccessToken(token: TokenData): Promise<TokenData> {
  const res = await fetch('https://login.eveonline.com/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: CLIENT_ID,
    }),
  })

  if (!res.ok) throw new Error(`Token refresh mislukt: ${res.status}`)

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number }

  return {
    ...token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}
