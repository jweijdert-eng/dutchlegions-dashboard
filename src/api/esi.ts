const BASE = 'https://esi.evetech.net/latest'

import type { TokenData } from '../auth/sso'

const _cache = new Map<string, { data: unknown; expires: number }>()
export function clearEsiCache() { _cache.clear() }

const _sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Gelijktijdigheidslimiet: ESI error-limit (420) slaat toe bij een burst van
// honderden requests (bv. veel asset-locaties tegelijk). Door max N tegelijk te
// laten lopen blijven we onder de limiet i.p.v. een storm aan retries te triggeren.
const _MAX_CONCURRENT = 16
let _active = 0
const _waiters: Array<() => void> = []
async function _acquire(): Promise<void> {
  if (_active < _MAX_CONCURRENT) { _active++; return }
  await new Promise<void>(resolve => _waiters.push(resolve))
  // Slot is direct overgedragen door _release — _active is al verrekend.
}
function _release(): void {
  const next = _waiters.shift()
  if (next) next()      // geef het slot door zonder de teller te wijzigen
  else _active--        // niemand wacht → slot vrijgeven
}

// Fetch met retry/backoff op transiente ESI-fouten (420 error-limited, 5xx, netwerk).
// Andere 4xx (403/404/422) worden direct teruggegeven — dat zijn echte fouten, geen
// rate-limiting. Voorkomt dat bij veel locaties tegelijk namen/security wegvallen.
async function esiFetch(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  await _acquire()
  try {
    return await _esiFetchInner(url, init, attempts)
  } finally {
    _release()
  }
}

async function _esiFetchInner(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let last: Response | undefined
  for (let i = 0; i < attempts; i++) {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (e) {
      if (i === attempts - 1) throw e
      await _sleep(Math.min(2000, 250 * 2 ** i) + Math.random() * 150)
      continue
    }
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 420)) return res
    last = res
    if (i === attempts - 1) break
    const ra = parseInt(res.headers.get('retry-after') ?? '')
    await _sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : Math.min(2000, 250 * 2 ** i) + Math.random() * 150)
  }
  return last!
}

async function esiGet<T>(path: string, token?: string): Promise<T> {
  const key = `${token?.slice(-20) ?? ''}:${path}`
  const hit = _cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data as T

  const sep = path.includes('?') ? '&' : '?'
  const res = await esiFetch(`${BASE}${path}${sep}datasource=tranquility`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`ESI ${path}: ${res.status}`)

  const cc = res.headers.get('cache-control') ?? ''
  const maxAge = Math.min(Math.max(parseInt(cc.match(/max-age=(\d+)/)?.[1] ?? '60'), 30), 3600)
  const data = await res.json() as T
  _cache.set(key, { data, expires: Date.now() + maxAge * 1000 })
  return data
}

export interface WalletJournalEntry {
  id: number
  date: string
  ref_type: string
  description: string
  amount: number
  balance: number
}

export interface SkillQueueEntry {
  skill_id: number
  queue_position: number
  finish_date?: string
  start_date?: string
  finished_level: number
}

export interface MarketOrder {
  order_id: number
  type_id: number
  is_buy_order: boolean
  price: number
  volume_remain: number
  volume_total: number
  location_id: number
  issued: string
  duration: number
  state?: string
  escrow?: number
}

export interface WalletTransaction {
  transaction_id: number
  date: string
  type_id: number
  quantity: number
  unit_price: number
  is_buy: boolean
  client_id: number
  location_id: number
}

export interface Killmail {
  killmail_id: number
  killmail_time: string
  solar_system_id: number
  victim: {
    character_id?: number
    corporation_id?: number
    alliance_id?: number
    ship_type_id: number
  }
  attackers: Array<{
    character_id?: number
    corporation_id?: number
    alliance_id?: number
    final_blow: boolean
  }>
}

export interface CharacterInfo {
  name: string
  corporation_id: number
  alliance_id?: number
  birthday: string
  security_status: number
}

export interface SkillsInfo {
  total_sp: number
  unallocated_sp?: number
}

export interface CorporationInfo {
  name: string
  ticker: string
  member_count: number
}

export interface AllianceInfo {
  name: string
  ticker: string
}

export interface AssetItem {
  item_id: number
  type_id: number
  location_id: number
  location_flag: string
  location_type: 'station' | 'solar_system' | 'item' | 'other'
  quantity: number
  is_singleton: boolean
}

export interface AssetLocation {
  item_id: number
  location_id: number
  location_flag: string
  location_type: 'station' | 'solar_system' | 'structure' | 'item' | 'other'
}

export async function getAssets(id: number, token: string): Promise<AssetItem[]> {
  const results: AssetItem[] = []
  for (let page = 1; page <= 20; page++) {
    try {
      const entries = await esiGet<AssetItem[]>(`/characters/${id}/assets/?page=${page}`, token)
      results.push(...entries)
      if (entries.length < 1000) break
    } catch { break }
  }
  return results
}

// ESI's /characters/{id}/assets/locations/ is POST-only en geeft uitsluitend posities
// (x,y,z) terug — géén location_id, dus onbruikbaar voor onze locatie-boom. De vorige
// GET-implementatie leverde altijd 405 (vrat error-budget). Nesting (items in
// containers/schepen) wordt al volledig opgelost via de parent-chain in Assets, dus
// dit is bewust een no-op.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getAssetLocations(_characterId: number, _token: string): Promise<AssetLocation[]> {
  return []
}

export async function getAssetNames(characterId: number, itemIds: number[], token: string): Promise<Map<number, string>> {
  if (itemIds.length === 0) return new Map()
  try {
    const res = await fetch(`${BASE}/characters/${characterId}/assets/names/?datasource=tranquility`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(itemIds),
    })
    if (!res.ok) return new Map()
    const data = await res.json() as Array<{ item_id: number; name: string }>
    return new Map(data.map(d => [d.item_id, d.name]))
  } catch { return new Map() }
}

export interface StructureInfo {
  name: string
  solar_system_id: number
  type_id: number
}

const _structureCache = new Map<number, StructureInfo>()

export function findInStructureCache(systemId: number): Array<{ id: number; name: string }> {
  const results: Array<{ id: number; name: string }> = []
  for (const [id, info] of _structureCache) {
    if (info.solar_system_id === systemId) results.push({ id, name: info.name })
  }
  return results
}

function isStructureFallbackName(id: number, name: string) {
  return name === `Structure ${id}` || name === `#${id}`
}

function _persistUnresolved(id: number, charIds: number[]) {
  try {
    const key = 'unresolved_structures'
    const raw = localStorage.getItem(key)
    const map = raw ? JSON.parse(raw) as Record<string, { chars: number[]; lastSeen: number }> : {}
    const entry = map[id] ?? { chars: [], lastSeen: 0 }
    for (const c of charIds) if (!entry.chars.includes(c)) entry.chars.push(c)
    entry.lastSeen = Date.now()
    map[id] = entry
    localStorage.setItem(key, JSON.stringify(map))
  } catch { /* ignore */ }
}

// True als deze structuur recent al met (minstens) deze characters tevergeefs is
// geprobeerd → de mislukte netwerk-calls overslaan bij een volgende load.
const _UNRESOLVED_TTL = 12 * 3600 * 1000 // 12 uur
function _triedAllRecently(id: number, charIds: number[]): boolean {
  if (charIds.length === 0) return false
  try {
    const raw = localStorage.getItem('unresolved_structures')
    if (!raw) return false
    const map = JSON.parse(raw) as Record<string, { chars: number[]; lastSeen: number }>
    const entry = map[String(id)]
    if (!entry || Date.now() - entry.lastSeen > _UNRESOLVED_TTL) return false
    return charIds.every(c => entry.chars.includes(c))
  } catch { return false }
}

function _normalizeTokens(tokens?: string | string[] | TokenData[] | TokenData) {
  if (!tokens) return { tokens: [] as string[], charIds: [] as number[] }
  if (typeof tokens === 'string') return { tokens: [tokens], charIds: [] }
  if (Array.isArray(tokens)) {
    if (tokens.length === 0) return { tokens: [], charIds: [] }
    // array of strings?
    if (typeof tokens[0] === 'string') return { tokens: tokens as string[], charIds: [] }
    // array of TokenData
    const arr = tokens as TokenData[]
    return { tokens: arr.map(a => a.accessToken), charIds: arr.map(a => a.characterId) }
  }
  // single TokenData
  const t = tokens as TokenData
  return { tokens: [t.accessToken], charIds: [t.characterId] }
}

export async function getStructureInfo(id: number, tokens?: string | string[] | TokenData[] | TokenData): Promise<StructureInfo | null> {
  if (_structureCache.has(id)) return _structureCache.get(id)!

  // Try full JSON cache (name + solar_system_id) first
  const cachedJson = localStorage.getItem(`structure_info_${id}`)
  if (cachedJson) {
    try {
      const parsed = JSON.parse(cachedJson) as StructureInfo
      if (parsed.name && parsed.solar_system_id > 0) {
        _structureCache.set(id, parsed)
        return parsed
      }
    } catch { /* corrupt cache, fall through */ }
    localStorage.removeItem(`structure_info_${id}`)
  }

  // Legacy cache: name only — don't return early, still fetch to get solar_system_id
  const cachedName = localStorage.getItem(`structure_name_${id}`)
  if (cachedName && isStructureFallbackName(id, cachedName)) {
    localStorage.removeItem(`structure_name_${id}`)
  }

  const norm = _normalizeTokens(tokens)

  // Recent al met al deze characters tevergeefs geprobeerd? Sla de mislukte calls over
  // (scheelt N+1 ESI-calls per ontoegankelijke citadel bij elke herlaad).
  if (_triedAllRecently(id, norm.charIds)) {
    if (cachedName && !isStructureFallbackName(id, cachedName)) {
      const partial: StructureInfo = { name: cachedName, solar_system_id: 0, type_id: 0 }
      _structureCache.set(id, partial)
      return partial
    }
    return null
  }

  for (const token of norm.tokens) {
    try {
      const res = await esiFetch(`${BASE}/universe/structures/${id}/?datasource=tranquility`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json() as StructureInfo
        _structureCache.set(id, data)
        localStorage.setItem(`structure_info_${id}`, JSON.stringify(data))
        localStorage.removeItem(`structure_name_${id}`)
        return data
      }
    } catch { continue }
  }

  try {
    const res = await esiFetch(`${BASE}/universe/structures/${id}/?datasource=tranquility`)
    if (res.ok) {
      const data = await res.json() as StructureInfo
      _structureCache.set(id, data)
      localStorage.setItem(`structure_info_${id}`, JSON.stringify(data))
      localStorage.removeItem(`structure_name_${id}`)
      return data
    }
  } catch {
    /* ignore */
  }

  // If we have a legacy name-only cache, return partial (name known, system unknown)
  if (cachedName && !isStructureFallbackName(id, cachedName)) {
    const partial: StructureInfo = { name: cachedName, solar_system_id: 0, type_id: 0 }
    _structureCache.set(id, partial)
    return partial
  }

  if (norm.charIds.length > 0) _persistUnresolved(id, norm.charIds)
  else _persistUnresolved(id, [])

  return null
}

export async function getStructureName(id: number, tokens?: string | string[] | TokenData[] | TokenData): Promise<string | null> {
  const cached = localStorage.getItem(`structure_name_${id}`)
  if (cached && !isStructureFallbackName(id, cached)) return cached
  if (cached && isStructureFallbackName(id, cached)) {
    localStorage.removeItem(`structure_name_${id}`)
  }
  const info = await getStructureInfo(id, tokens)
  return info?.name ?? null
}

export interface IndustryJob {
  job_id: number
  blueprint_type_id: number
  product_type_id?: number
  activity_id: number
  runs: number
  cost: number
  status: 'active' | 'cancelled' | 'delivered' | 'paused' | 'ready' | 'reverted'
  start_date: string
  end_date: string
  duration: number
  output_location_id: number
  successful_runs?: number
}

export const getIndustryJobs = (id: number, token: string) =>
  esiGet<IndustryJob[]>(`/characters/${id}/industry/jobs/?include_completed=false`, token)

export interface MiningEntry {
  date: string
  solar_system_id: number
  type_id: number
  quantity: number
}

export const getMining = (id: number, token: string) =>
  esiGet<MiningEntry[]>(`/characters/${id}/mining/`, token)

export interface Planet {
  planet_id: number
  solar_system_id: number
  planet_type: string
  num_pins: number
  last_update: string
  upgrade_level: number
}

export interface PlanetPin {
  pin_id: number
  type_id: number
  latitude: number
  longitude: number
  schematic_id?: number
  expiry_time?: string
  install_time?: string
  last_cycle_start?: string
  extractor_details?: {
    cycle_time?: number
    head_radius?: number
    product_type_id?: number
    qty_per_cycle?: number
    heads?: { head_id: number; latitude: number; longitude: number }[]
  }
  contents?: { amount: number; type_id: number }[]
}

export interface PlanetLink {
  source_pin_id: number
  destination_pin_id: number
  link_level: number
}

export interface PlanetRoute {
  route_id: number
  source_pin_id: number
  destination_pin_id: number
  content_type_id: number
  quantity: number
  waypoints?: number[]
}

export interface SchematicPin {
  type_id: number
  quantity: number
  is_input: boolean
}

export interface Schematic {
  schematic_name: string
  cycle_time: number
  pins?: SchematicPin[]
}

const _schematicCache = new Map<number, Schematic>()

export async function getSchematic(id: number): Promise<Schematic | null> {
  if (_schematicCache.has(id)) return _schematicCache.get(id)!
  try {
    const data = await esiGet<Schematic>(`/universe/schematics/${id}/`)
    _schematicCache.set(id, data)
    return data
  } catch { return null }
}

export interface PlanetDetail {
  pins: PlanetPin[]
  links: PlanetLink[]
  routes: PlanetRoute[]
}

export const getPlanets      = (id: number, token: string) => esiGet<Planet[]>(`/characters/${id}/planets/`, token)
export const getPlanetDetail = (charId: number, planetId: number, token: string) =>
  esiGet<PlanetDetail>(`/characters/${charId}/planets/${planetId}/`, token)

const _planetTypeCache = new Map<number, number>()
export async function getPlanetTypeId(planetId: number): Promise<number | null> {
  if (_planetTypeCache.has(planetId)) return _planetTypeCache.get(planetId)!
  try {
    const data = await esiGet<{ type_id: number }>(`/universe/planets/${planetId}/`)
    _planetTypeCache.set(planetId, data.type_id)
    return data.type_id
  } catch { return null }
}

export interface MailHeader {
  mail_id: number
  subject: string
  from: number
  timestamp: string
  is_read?: boolean
  labels?: number[]
}

export interface MailBody {
  body: string
  from: number
  recipients: Array<{ recipient_id: number; recipient_type: string }>
  subject: string
  timestamp: string
}

export interface Fitting {
  fitting_id: number
  name: string
  description: string
  ship_type_id: number
  items: Array<{ type_id: number; flag: string; quantity: number }>
}

export const getMail       = (id: number, token: string) => esiGet<MailHeader[]>(`/characters/${id}/mail/`, token)
export const getMailBody   = (id: number, mailId: number, token: string) => esiGet<MailBody>(`/characters/${id}/mail/${mailId}/`, token)
export const getFittings   = (id: number, token: string) => esiGet<Fitting[]>(`/characters/${id}/fittings/`, token)

export interface JumpClone {
  clone_id: number
  location_id: number
  location_type: 'station' | 'structure'
  implants: number[]
}

export interface ClonesInfo {
  home_location: { location_id: number; location_type: 'station' | 'structure' }
  jump_clones: JumpClone[]
  last_clone_jump_date?: string
}

export const getClones   = (id: number, token: string) => esiGet<ClonesInfo>(`/characters/${id}/clones/`, token)
export const getImplants = (id: number, token: string) => esiGet<number[]>(`/characters/${id}/implants/`, token)

export interface Blueprint {
  item_id: number
  type_id: number
  location_id: number
  location_flag: string
  quantity: number       // -1 = BPO, -2 = BPC
  runs: number           // -1 = unlimited (BPO)
  material_efficiency: number
  time_efficiency: number
}

export interface CharacterAttributes {
  intelligence: number
  memory: number
  perception: number
  willpower: number
  charisma: number
  bonus_remaps?: number
  last_remap_date?: string
  accrued_remap_cooldown_date?: string
}

export interface Contract {
  contract_id: number
  type: 'item_exchange' | 'auction' | 'courier' | 'loan' | 'unknown'
  status: 'outstanding' | 'in_progress' | 'finished_issuer' | 'finished_contractor' | 'finished' | 'cancelled' | 'rejected' | 'failed' | 'deleted' | 'reversed'
  availability: 'public' | 'personal' | 'corporation' | 'alliance'
  title?: string
  issuer_id: number
  issuer_corporation_id?: number
  assignee_id?: number
  acceptor_id?: number
  date_issued: string
  date_expired: string
  date_completed?: string
  for_corporation: boolean
  price: number
  reward: number
  collateral?: number
  buyout?: number
  volume?: number
  days_to_complete?: number
  start_location_id?: number
  end_location_id?: number
}

export interface ContractItem {
  record_id: number
  type_id: number
  quantity: number
  is_included: boolean
  is_singleton: boolean
  raw_quantity?: number
}

export interface ContractBid {
  bid_id: number
  bidder_id: number
  amount: number
  date_bid: string
}

export const getContractItems = (charId: number, contractId: number, token: string) =>
  esiGet<ContractItem[]>(`/characters/${charId}/contracts/${contractId}/items/`, token)

export const getContractBids = (charId: number, contractId: number, token: string) =>
  esiGet<ContractBid[]>(`/characters/${charId}/contracts/${contractId}/bids/`, token)

export async function getBlueprints(id: number, token: string): Promise<Blueprint[]> {
  const results: Blueprint[] = []
  for (let page = 1; page <= 20; page++) {
    try {
      const entries = await esiGet<Blueprint[]>(`/characters/${id}/blueprints/?page=${page}`, token)
      results.push(...entries)
      if (entries.length < 1000) break
    } catch { break }
  }
  return results
}

export const getCharacterAttributes = (id: number, token: string) =>
  esiGet<CharacterAttributes>(`/characters/${id}/attributes/`, token)

export async function getContracts(id: number, token: string): Promise<Contract[]> {
  const results: Contract[] = []
  for (let page = 1; page <= 10; page++) {
    try {
      const entries = await esiGet<Contract[]>(`/characters/${id}/contracts/?page=${page}`, token)
      results.push(...entries)
      if (entries.length < 1000) break
    } catch { break }
  }
  return results
}

export const getWallet       = (id: number, token: string) => esiGet<number>(`/characters/${id}/wallet/`, token)
export const getSkillQueue   = (id: number, token: string) => esiGet<SkillQueueEntry[]>(`/characters/${id}/skillqueue/`, token)
export const getMarketOrders   = (id: number, token: string) => esiGet<MarketOrder[]>(`/characters/${id}/orders/`, token)
export async function getMarketHistory(id: number, token: string): Promise<MarketOrder[]> {
  const results: MarketOrder[] = []
  for (let page = 1; page <= 10; page++) {
    try {
      const entries = await esiGet<MarketOrder[]>(`/characters/${id}/orders/history/?page=${page}`, token)
      results.push(...entries)
      if (entries.length < 2000) break
    } catch { break }
  }
  return results
}
export const getTransactions   = (id: number, token: string) => esiGet<WalletTransaction[]>(`/characters/${id}/wallet/transactions/`, token)

export const getCharacterInfo = (id: number) => esiGet<CharacterInfo>(`/characters/${id}/`)
export const getSkillsInfo   = (id: number, token: string) => esiGet<SkillsInfo>(`/characters/${id}/skills/`, token)
export const getCorporation  = (id: number) => esiGet<CorporationInfo>(`/corporations/${id}/`)
export const getAlliance     = (id: number) => esiGet<AllianceInfo>(`/alliances/${id}/`)

export async function getWalletJournal(id: number, token: string, pages = 3): Promise<WalletJournalEntry[]> {
  const requests = Array.from({ length: pages }, (_, i) =>
    esiGet<WalletJournalEntry[]>(`/characters/${id}/wallet/journal/?page=${i + 1}`, token).catch(() => [] as WalletJournalEntry[])
  )
  const results = await Promise.all(requests)
  return results.flat()
}

export async function getKillmailDetail(id: number, hash: string): Promise<Killmail | null> {
  try {
    const res = await fetch(`${BASE}/killmails/${id}/${hash}/?datasource=tranquility`)
    if (!res.ok) return null
    return res.json() as Promise<Killmail>
  } catch { return null }
}

export async function getCharacterKillmails(
  charId: number, token: string, page = 1
): Promise<{ killmail_id: number; killmail_hash: string }[]> {
  try {
    const res = await fetch(
      `${BASE}/characters/${charId}/killmails/recent/?datasource=tranquility&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

export interface CharacterLocation {
  solar_system_id: number
  station_id?: number
  structure_id?: number
}

export interface CharacterShip {
  ship_type_id: number
  ship_item_id: number
  ship_name: string
}

export const getLocation = (id: number, token: string) => esiGet<CharacterLocation>(`/characters/${id}/location/`, token)
export const getShip     = (id: number, token: string) => esiGet<CharacterShip>(`/characters/${id}/ship/`, token)

export interface CalendarEvent {
  event_date: string
  event_id: number
  event_response: 'accepted' | 'declined' | 'tentative' | 'not_responded'
  importance: number
  title: string
}

export interface CalendarEventDetail {
  date: string
  duration: number
  event_id: number
  importance: number
  owner_id: number
  owner_name: string
  owner_type: 'eve_server' | 'corporation' | 'alliance' | 'character' | 'faction'
  response: string
  text: string
  title: string
}

export const getCalendar = (id: number, token: string) =>
  esiGet<CalendarEvent[]>(`/characters/${id}/calendar/`, token)

export const getCalendarEventDetail = (id: number, eventId: number, token: string) =>
  esiGet<CalendarEventDetail>(`/characters/${id}/calendar/${eventId}/`, token)

export interface OnlineStatus {
  online: boolean
  last_login?: string
  last_logout?: string
  logins?: number
}

export const getOnlineStatus = (id: number, token: string) =>
  esiGet<OnlineStatus>(`/characters/${id}/online/`, token)

export interface JumpFatigue {
  jump_fatigue_expire_date?: string
  last_jump_date?: string
  last_update_date?: string
}

export const getJumpFatigue = (id: number, token: string) =>
  esiGet<JumpFatigue>(`/characters/${id}/fatigue/`, token)

export interface LoyaltyPoint {
  corporation_id: number
  loyalty_points: number
}

export const getLoyaltyPoints = (id: number, token: string) =>
  esiGet<LoyaltyPoint[]>(`/characters/${id}/loyalty/points/`, token)

export interface StationInfo {
  name: string
  system_id: number
}

const _stationCache = new Map<number, StationInfo>()

export async function getStationInfo(id: number): Promise<StationInfo | null> {
  if (_stationCache.has(id)) return _stationCache.get(id)!
  try {
    const data = await esiGet<StationInfo>(`/universe/stations/${id}/`)
    _stationCache.set(id, data)
    return data
  } catch { return null }
}

export interface SystemInfo {
  name: string
  security_status: number
  constellation_id: number
  constellation_name: string | null
  region_id: number | null
  region_name: string | null
}

const _sysCache  = new Map<number, SystemInfo>()
const _consCache = new Map<number, { name: string; region_id: number }>()
const _regCache  = new Map<number, string>()

export async function getSystemInfo(id: number): Promise<SystemInfo | null> {
  if (_sysCache.has(id)) return _sysCache.get(id)!
  try {
    const sys = await esiGet<{ name: string; security_status: number; constellation_id: number }>(`/universe/systems/${id}/`)
    const info: SystemInfo = {
      name: sys.name,
      security_status: sys.security_status,
      constellation_id: sys.constellation_id,
      constellation_name: null,
      region_id: null,
      region_name: null,
    }
    _sysCache.set(id, info)

    // Constellation/region zijn aanvullend — als die calls falen (bv. rate-limit
    // bij veel systemen tegelijk) mag de al opgehaalde security_status niet verloren gaan.
    try {
      if (!_consCache.has(sys.constellation_id)) {
        const cons = await esiGet<{ name: string; region_id: number }>(`/universe/constellations/${sys.constellation_id}/`)
        _consCache.set(sys.constellation_id, cons)
      }
      const cons = _consCache.get(sys.constellation_id)
      if (cons) {
        info.constellation_name = cons.name
        info.region_id = cons.region_id

        if (!_regCache.has(cons.region_id)) {
          const reg = await esiGet<{ name: string }>(`/universe/regions/${cons.region_id}/`)
          _regCache.set(cons.region_id, reg.name)
        }
        info.region_name = _regCache.get(cons.region_id) ?? null
      }
    } catch { /* constellation/region optioneel — security blijft behouden */ }

    return info
  } catch { return null }
}

// Lichtgewicht: alléén de security_status (1 call), zonder de extra constellation/
// region-calls van getSystemInfo. Voor lijsten met veel systemen (bv. Assets) scheelt
// dat ~3× zoveel ESI-verkeer en voorkomt het dat de resolutie "blijft laden".
export async function getSystemSecurity(id: number): Promise<number | null> {
  const cached = _sysCache.get(id)
  if (cached) return cached.security_status
  try {
    const sys = await esiGet<{ security_status: number }>(`/universe/systems/${id}/`)
    return sys.security_status
  } catch { return null }
}

export const getRoute = (originSystemId: number, destinationSystemId: number, flag = 'shortest') =>
  esiGet<number[]>(`/route/${originSystemId}/${destinationSystemId}/?flag=${flag}`)

const INT32_MAX = 2_147_483_647

async function _namesBatch(ids: number[], out: Map<number, string>): Promise<void> {
  if (ids.length === 0) return
  try {
    const res = await esiFetch(`${BASE}/universe/names/?datasource=tranquility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids),
    })
    if (res.ok) {
      const data = await res.json() as Array<{ id: number; name: string }>
      data.forEach(d => out.set(d.id, d.name))
      return
    }
  } catch { /* fall through to split */ }
  // Batch failed (e.g. 422 from one invalid ID) — split and retry each half
  if (ids.length > 1) {
    const mid = Math.floor(ids.length / 2)
    await Promise.all([
      _namesBatch(ids.slice(0, mid), out),
      _namesBatch(ids.slice(mid), out),
    ])
  }
}

export async function searchStructure(
  charId: number, token: string, name: string
): Promise<{ ids: number[]; forbidden: boolean }> {
  try {
    const res = await fetch(
      `${BASE}/characters/${charId}/search/?categories=structure&search=${encodeURIComponent(name)}&datasource=tranquility`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (res.status === 403) return { ids: [], forbidden: true }
    if (!res.ok) return { ids: [], forbidden: false }
    const data = await res.json() as { structure?: number[] }
    return { ids: data.structure ?? [], forbidden: false }
  } catch { return { ids: [], forbidden: false } }
}

export async function resolveSystemId(name: string): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/universe/ids/?datasource=tranquility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([name]),
    })
    if (!res.ok) return null
    const data = await res.json() as { solar_systems?: Array<{ id: number }> }
    return data.solar_systems?.[0]?.id ?? null
  } catch { return null }
}

export async function findStructuresBySystem(
  charId: number,
  token: string,
  systemId: number
): Promise<Array<{ id: number; name: string }>> {
  const structureIds = new Set<number>()

  const addHigh = (id: number) => { if (id > 1_000_000_000) structureIds.add(id) }

  await Promise.allSettled([
    // Market orders (active + history)
    esiGet<Array<{ location_id: number }>>(`/characters/${charId}/orders/`, token)
      .then(r => r.forEach(o => addHigh(o.location_id))),
    esiGet<Array<{ location_id: number }>>(`/characters/${charId}/orders/history/?page=1`, token)
      .then(r => r.forEach(o => addHigh(o.location_id))),
    // Wallet transactions
    esiGet<Array<{ location_id: number }>>(`/characters/${charId}/wallet/transactions/`, token)
      .then(r => r.forEach(t => addHigh(t.location_id))),
    // Assets (all pages)
    (async () => {
      for (let page = 1; page <= 10; page++) {
        const entries = await esiGet<Array<{ location_id: number }>>(`/characters/${charId}/assets/?page=${page}`, token)
        entries.forEach(a => addHigh(a.location_id))
        if (entries.length < 1000) break
      }
    })(),
    // Contracts (start/end location)
    esiGet<Array<{ start_location_id?: number; end_location_id?: number }>>(`/characters/${charId}/contracts/`, token)
      .then(r => r.forEach(c => {
        if (c.start_location_id) addHigh(c.start_location_id)
        if (c.end_location_id) addHigh(c.end_location_id)
      })),
    // Current location (if docked right now)
    esiGet<{ solar_system_id: number; structure_id?: number }>(`/characters/${charId}/location/`, token)
      .then(r => { if (r.structure_id) structureIds.add(r.structure_id) }),
  ])

  if (structureIds.size === 0) return []

  const results: Array<{ id: number; name: string }> = []
  await Promise.all([...structureIds].map(async id => {
    const info = await getStructureInfo(id, token)
    if (info?.solar_system_id === systemId) results.push({ id, name: info.name })
  }))
  return results
}

let _mktStructIds: number[] | null = null

export async function searchMarketStructures(
  query: string,
  token: string,
  onProgress: (pct: number) => void,
  signal: AbortSignal
): Promise<Array<{ id: number; name: string }>> {
  // Try to resolve as system name — if it matches, filter by solar_system_id
  const systemId = await resolveSystemId(query)

  if (!_mktStructIds) {
    try {
      const res = await fetch(`${BASE}/universe/structures/?filter=market&datasource=tranquility`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      _mktStructIds = res.ok ? (await res.json() as number[]) : []
    } catch { _mktStructIds = [] }
  }

  const ids = _mktStructIds
  if (ids.length === 0) return []

  const q = query.toLowerCase()
  const results: Array<{ id: number; name: string }> = []
  const BATCH = 25

  for (let i = 0; i < ids.length && !signal.aborted && results.length < 8; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    await Promise.all(batch.map(async id => {
      if (signal.aborted) return
      const info = await getStructureInfo(id, token)
      if (!info) return
      const matches = systemId
        ? info.solar_system_id === systemId
        : info.name.toLowerCase().includes(q)
      if (matches) results.push({ id, name: info.name })
    }))
    onProgress(Math.min(Math.round((i + BATCH) / ids.length * 100), 99))
  }

  onProgress(100)
  return results
}

export async function getStructureOrders(structureId: number, token: string): Promise<PublicMarketOrder[]> {
  const results: PublicMarketOrder[] = []
  for (let page = 1; page <= 50; page++) {
    try {
      const entries = await esiGet<PublicMarketOrder[]>(
        `/markets/structures/${structureId}/?page=${page}`, token
      )
      results.push(...entries)
      if (entries.length < 1000) break
    } catch { break }
  }
  return results
}

export async function resolveTypeIds(names: string[]): Promise<Map<string, number>> {
  if (names.length === 0) return new Map()
  try {
    const res = await fetch(`${BASE}/universe/ids/?datasource=tranquility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(names),
    })
    if (!res.ok) return new Map()
    const data = await res.json() as { inventory_types?: Array<{ id: number; name: string }> }
    const map = new Map<string, number>()
    for (const t of data.inventory_types ?? []) map.set(t.name.toLowerCase(), t.id)
    return map
  } catch { return new Map() }
}

export interface PublicMarketOrder {
  order_id: number
  type_id: number
  is_buy_order: boolean
  price: number
  volume_remain: number
  location_id: number
}

export async function getRegionOrders(regionId: number, typeId: number): Promise<PublicMarketOrder[]> {
  const results: PublicMarketOrder[] = []
  for (let page = 1; page <= 5; page++) {
    try {
      const entries = await esiGet<PublicMarketOrder[]>(
        `/markets/${regionId}/orders/?order_type=all&type_id=${typeId}&page=${page}`
      )
      results.push(...entries)
      if (entries.length < 1000) break
    } catch { break }
  }
  return results
}

export interface CharacterFleet {
  fleet_id: number
  role: 'fleet_commander' | 'wing_commander' | 'squad_commander' | 'squad_member'
  squad_id: number
  wing_id: number
}

export interface FleetInfo {
  motd: string
  is_free_move: boolean
  is_registered: boolean
  is_voice_enabled: boolean
}

export interface FleetMember {
  character_id: number
  join_time: string
  role: 'fleet_commander' | 'wing_commander' | 'squad_commander' | 'squad_member'
  role_name: string
  ship_type_id: number
  solar_system_id: number
  squad_id: number
  wing_id: number
  station_id?: number
  takes_fleet_warp: boolean
}

export interface FleetSquad { id: number; name: string }
export interface FleetWing  { id: number; name: string; squads: FleetSquad[] }

export const getCharacterFleet = (charId: number, token: string) =>
  esiGet<CharacterFleet>(`/characters/${charId}/fleet/`, token)

export const getFleetInfo    = (fleetId: number, token: string) =>
  esiGet<FleetInfo>(`/fleets/${fleetId}/`, token)

export const getFleetMembers = (fleetId: number, token: string) =>
  esiGet<FleetMember[]>(`/fleets/${fleetId}/members/`, token)

export const getFleetWings   = (fleetId: number, token: string) =>
  esiGet<FleetWing[]>(`/fleets/${fleetId}/wings/`, token)

export async function resolveNames(ids: number[]): Promise<Map<number, string>> {
  // /universe/names/ only accepts int32 — filter out player structure IDs (> 2^31)
  const safe = [...new Set(ids.filter(id => id > 0 && id <= INT32_MAX))]
  if (safe.length === 0) return new Map()
  const result = new Map<number, string>()
  // Process in chunks of 1000 (ESI limit per request)
  for (let i = 0; i < safe.length; i += 1000) {
    await _namesBatch(safe.slice(i, i + 1000), result)
  }
  return result
}

// ─── Write operations ────────────────────────────────────────────────────────

export async function setWaypoint(systemId: number, token: string, clearOthers = false): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE}/ui/autopilot/waypoint/?add_to_beginning=false&clear_other_waypoints=${clearOthers}&destination_id=${systemId}&datasource=tranquility`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    )
    return res.ok
  } catch { return false }
}

export async function sendMail(
  characterId: number, token: string,
  subject: string, body: string,
  recipients: Array<{ recipient_id: number; recipient_type: string }>
): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/characters/${characterId}/mail/?datasource=tranquility`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, body, recipients }),
    })
    return res.ok
  } catch { return false }
}

export async function deleteMail(characterId: number, mailId: number, token: string): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(
      `${BASE}/characters/${characterId}/mail/${mailId}/?datasource=tranquility`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    )
    if (res.ok) return { ok: true, status: res.status }
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: body }
  } catch { return { ok: false, status: 0 } }
}

export async function saveFitting(
  characterId: number, token: string,
  fitting: { name: string; description: string; ship_type_id: number; items: Array<{ flag: string; quantity: number; type_id: number }> }
): Promise<{ ok: boolean; fittingId?: number; status: number; error?: string }> {
  try {
    const res = await fetch(
      `${BASE}/characters/${characterId}/fittings/?datasource=tranquility`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fitting),
      }
    )
    if (res.ok) {
      const data = await res.json() as { fitting_id: number }
      return { ok: true, fittingId: data.fitting_id, status: res.status }
    }
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: body }
  } catch { return { ok: false, status: 0 } }
}

export async function deleteFitting(
  characterId: number, fittingId: number, token: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(
      `${BASE}/characters/${characterId}/fittings/${fittingId}/?datasource=tranquility`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    )
    if (res.ok) return { ok: true, status: res.status }
    const body = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: body }
  } catch { return { ok: false, status: 0 } }
}

export async function cancelMarketOrder(characterId: number, orderId: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE}/characters/${characterId}/orders/${orderId}/?datasource=tranquility`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    )
    return res.ok
  } catch { return false }
}

export async function modifyMarketOrder(characterId: number, orderId: number, token: string, price: number): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE}/characters/${characterId}/orders/${orderId}/?datasource=tranquility`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ price }),
      }
    )
    return res.ok
  } catch { return false }
}

// Slot-layout van een schip via dogma attributes
// (12=lowSlots, 13=medSlots, 14=hiSlots, 1137=rigSlots, 1367=maxSubSystems, 2056=serviceSlots)
export interface ShipSlots { hi: number; med: number; low: number; rig: number; sub: number; service: number }
export async function getShipSlots(typeId: number): Promise<ShipSlots | null> {
  try {
    const data = await esiGet<{ dogma_attributes?: Array<{ attribute_id: number; value: number }> }>(`/universe/types/${typeId}/`)
    const attr = (id: number) => data.dogma_attributes?.find(a => a.attribute_id === id)?.value ?? 0
    return { hi: attr(14), med: attr(13), low: attr(12), rig: attr(1137), sub: attr(1367), service: attr(2056) }
  } catch { return null }
}

const _typeMetaCache = new Map<number, number>()

export async function getTypesMeta(typeIds: number[]): Promise<Map<number, number>> {
  const missing = typeIds.filter(id => id > 0 && !_typeMetaCache.has(id))
  await Promise.all(missing.map(async id => {
    try {
      const data = await esiGet<{ meta_group_id?: number }>(`/universe/types/${id}/`)
      if (data.meta_group_id !== undefined) _typeMetaCache.set(id, data.meta_group_id)
    } catch { /* skip */ }
  }))
  const map = new Map<number, number>()
  for (const id of typeIds) {
    const mg = _typeMetaCache.get(id)
    if (mg !== undefined) map.set(id, mg)
  }
  return map
}
