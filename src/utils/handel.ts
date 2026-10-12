// Rekenkern van het Handelscentrum: hubs, bewaren van je handelsgeschiedenis en
// FIFO-winst over alle hubs heen.
//
// ESI geeft maar 30 dagen aan wallet-transacties en journal terug. Daarom bewaren
// we alles wat we ooit ophaalden in deze browser: elke keer dat je kijkt groeit je
// geschiedenis, en een verkoop van iets dat je twee maanden terug kocht krijgt
// gewoon zijn aankoopprijs.
import type { WalletTransaction, WalletJournalEntry } from '../api/esi'

export interface Hub { key: string; naam: string; station: number; regio: number }
export const HUBS: Hub[] = [
  { key: 'jita',    naam: 'Jita',    station: 60003760, regio: 10000002 },
  { key: 'amarr',   naam: 'Amarr',   station: 60008494, regio: 10000043 },
  { key: 'dodixie', naam: 'Dodixie', station: 60011866, regio: 10000032 },
  { key: 'rens',    naam: 'Rens',    station: 60004588, regio: 10000030 },
  { key: 'hek',     naam: 'Hek',     station: 60005686, regio: 10000042 },
]
export const JITA = HUBS[0]
const HUB_OP_STATION = new Map(HUBS.map(h => [h.station, h]))
/** De hub van een station, of null (ander station of een citadel). */
export const hubVan = (locationId: number): Hub | null => HUB_OP_STATION.get(locationId) ?? null
/** 'jita', 'amarr', … of 'overig' voor alles wat geen hub is. */
export const hubKey = (locationId: number) => hubVan(locationId)?.key ?? 'overig'
/** Citadels hebben id's boven de biljoen; NPC-stations niet. */
export const isCitadel = (locationId: number) => locationId > 1e12
/** Voor de voetregel en kopjes: waar de getallen over gaan. */
export function uitlegHub(hub: string): string {
  if (hub === 'alle') return 'alle hubs en citadels'
  if (hub === 'overig') return 'stations en citadels buiten de vijf hubs'
  return HUBS.find(h => h.key === hub)?.naam ?? hub
}

export interface Fees { broker: number; tax: number }
export const PRESETS: Array<Fees & { label: string }> = [
  { label: 'Geen skills',  broker: 0.05,  tax: 0.08 },
  { label: 'Basis skills', broker: 0.03,  tax: 0.072 },
  { label: 'Max skills',   broker: 0.02,  tax: 0.036 },
  { label: 'Corp/NPC hub', broker: 0.003, tax: 0.036 },
]

export const DAG = 86400e3
const BEWAAR_DAGEN = 400

export function fmtISK(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '-' : ''
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`
  return `${sign}${a.toLocaleString('nl-NL', { maximumFractionDigits: 2 })}`
}
export const plus = (v: number) => (v > 0 ? '+' : '') + fmtISK(v)
export const kleur = (v: number) => (v > 0 ? '#4ade80' : v < 0 ? '#ff5c6c' : 'var(--text-dim)')

// ── bewaren ─────────────────────────────────────────────────────────────
export interface Tx extends WalletTransaction { charId: number }
export interface Kost { id: number; tijd: number; soort: 'broker' | 'tax'; bedrag: number; charId: number }

function lees<T>(sleutel: string): T[] {
  try { return JSON.parse(localStorage.getItem(sleutel) || '[]') as T[] } catch { return [] }
}
/**
 * Opslaan; is de browser-opslag vol, dan eerst het oudste kwart laten vallen
 * (lijsten staan van oud naar nieuw) in plaats van helemaal niets meer te bewaren.
 */
function schrijf(sleutel: string, lijst: unknown[]) {
  let rest = lijst
  for (let poging = 0; poging < 4; poging++) {
    try { localStorage.setItem(sleutel, JSON.stringify(rest)); return } catch {
      if (rest.length < 20) return
      rest = rest.slice(Math.floor(rest.length / 4))
    }
  }
}
// Transacties compact bewaard (≈ 3× kleiner dan het ESI-object), zodat er een
// jaar handel in de browser past: [id, unix-tijd, type, aantal, prijs, koop?, plek].
type TxRij = [number, number, number, number, number, 0 | 1, number]
const naarRij = (t: WalletTransaction): TxRij =>
  [t.transaction_id, Math.round(+new Date(t.date) / 1000), t.type_id, t.quantity, t.unit_price, t.is_buy ? 1 : 0, t.location_id]
const vanRij = (r: TxRij, charId: number): Tx => ({
  transaction_id: r[0], date: new Date(r[1] * 1000).toISOString(), type_id: r[2], quantity: r[3],
  unit_price: r[4], is_buy: r[5] === 1, client_id: 0, location_id: r[6], charId,
})
const TX_KEY = (c: number) => `handel:tx2:${c}`
const KOST_KEY = (c: number) => `handel:kosten:${c}`
const CHARS_KEY = 'handel:chars'

function onthoudChar(charId: number) {
  const c = lees<number>(CHARS_KEY)
  if (!c.includes(charId)) schrijf(CHARS_KEY, [...c, charId])
}

/** Nieuwe transacties van één character bij de bewaarde voegen. */
export function bewaarTx(charId: number, nieuw: WalletTransaction[]) {
  onthoudChar(charId)
  const grens = (Date.now() - BEWAAR_DAGEN * DAG) / 1000
  const map = new Map<number, TxRij>()
  for (const r of lees<TxRij>(TX_KEY(charId))) map.set(r[0], r)
  for (const t of nieuw) map.set(t.transaction_id, naarRij(t))
  schrijf(TX_KEY(charId), [...map.values()].filter(r => r[1] >= grens).sort((a, b) => a[1] - b[1]))
}

/** Broker fees en sales tax uit de journal: wat je écht betaalde. */
export function bewaarKosten(charId: number, journal: WalletJournalEntry[]) {
  onthoudChar(charId)
  const grens = Date.now() - BEWAAR_DAGEN * DAG
  const map = new Map<number, Kost>()
  for (const k of lees<Kost>(KOST_KEY(charId))) map.set(k.id, k)
  for (const j of journal) {
    const soort = j.ref_type === 'brokers_fee' ? 'broker' : j.ref_type === 'transaction_tax' ? 'tax' : null
    if (!soort) continue
    map.set(j.id, { id: j.id, tijd: +new Date(j.date), soort, bedrag: Math.abs(j.amount), charId })
  }
  schrijf(KOST_KEY(charId), [...map.values()].filter(k => k.tijd >= grens).sort((a, b) => a.tijd - b.tijd))
}

export function leesAlles(): { txs: Tx[]; kosten: Kost[] } {
  const chars = lees<number>(CHARS_KEY)
  return {
    txs: chars.flatMap(c => lees<TxRij>(TX_KEY(c)).map(r => vanRij(r, c))),
    kosten: chars.flatMap(c => lees<Kost>(KOST_KEY(c))),
  }
}

/** Sinds wanneer we handel bewaren (oudste transactie), of null. */
export function bewaardSinds(txs: Tx[]): number | null {
  return txs.length ? Math.min(...txs.map(t => +new Date(t.date))) : null
}

// ── FIFO ────────────────────────────────────────────────────────────────
export interface Verkoop {
  transactionId: number; charId: number; typeId: number; tijd: number; locationId: number
  qty: number; prijs: number; opbrengst: number; kosten: number   // opbrengst = qty × prijs, zonder fees
}
export interface OpenLot { typeId: number; locationId: number; qty: number; buyPrice: number; sinds: number }
export interface ZonderKoop { typeId: number; tijd: number; qty: number; waarde: number }

/**
 * Elke verkoop wordt tegen de oudste aankopen van hetzelfde item weggestreept,
 * waar je ze ook kocht: kopen in Amarr en verkopen in Jita is ook handel. Wat
 * overblijft zijn open posities (per plek waar ze liggen).
 */
export function fifo(txs: Tx[]) {
  const perType = new Map<number, Tx[]>()
  const gezien = new Set<string>()
  for (const t of txs) {
    const k = t.charId + ':' + t.transaction_id
    if (gezien.has(k)) continue
    gezien.add(k)
    const r = perType.get(t.type_id) ?? []
    r.push(t)
    perType.set(t.type_id, r)
  }
  const open: OpenLot[] = []
  const verkocht: Verkoop[] = []
  const zonderKoop: ZonderKoop[] = []
  for (const [typeId, rij] of perType) {
    rij.sort((a, b) => +new Date(a.date) - +new Date(b.date) || Number(b.is_buy) - Number(a.is_buy))
    const lots: Array<{ qty: number; price: number; locationId: number; tijd: number }> = []
    for (const t of rij) {
      const tijd = +new Date(t.date)
      if (t.is_buy) { lots.push({ qty: t.quantity, price: t.unit_price, locationId: t.location_id, tijd }); continue }
      let rest = t.quantity, qty = 0, kosten = 0
      while (rest > 0 && lots.length) {
        const l = lots[0], neem = Math.min(rest, l.qty)
        kosten += neem * l.price; qty += neem; l.qty -= neem; rest -= neem
        if (l.qty <= 0) lots.shift()
      }
      if (qty > 0) verkocht.push({ transactionId: t.transaction_id, charId: t.charId, typeId, tijd, locationId: t.location_id,
                                   qty, prijs: t.unit_price, opbrengst: qty * t.unit_price, kosten })
      if (rest > 0) zonderKoop.push({ typeId, tijd, qty: rest, waarde: rest * t.unit_price })
    }
    // Open lots per plek samenvoegen tot één positie met een gemiddelde prijs.
    const perPlek = new Map<number, { qty: number; waarde: number; sinds: number }>()
    for (const l of lots) {
      const p = perPlek.get(l.locationId) ?? { qty: 0, waarde: 0, sinds: l.tijd }
      p.qty += l.qty; p.waarde += l.qty * l.price; p.sinds = Math.min(p.sinds, l.tijd)
      perPlek.set(l.locationId, p)
    }
    for (const [locationId, p] of perPlek) {
      if (p.qty > 0) open.push({ typeId, locationId, qty: p.qty, buyPrice: p.waarde / p.qty, sinds: p.sinds })
    }
  }
  return { open, verkocht, zonderKoop }
}

/** Winst van een verkoop met geschatte fees (per item weten we de echte niet). */
export const nettoWinst = (v: Verkoop, f: Fees) => v.opbrengst * (1 - f.broker - f.tax) - v.kosten

/** Middernacht (lokale tijd) van een tijdstip, voor groeperen per dag. */
export const dagVan = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }

// ── volglijst ───────────────────────────────────────────────────────────
const VOLG_KEY = 'handel:volg'
export const leesVolg = (): number[] => lees<number>(VOLG_KEY)
export function zetVolg(typeId: number, aan: boolean) {
  const v = leesVolg().filter(x => x !== typeId)
  schrijf(VOLG_KEY, aan ? [...v, typeId] : v)
}
