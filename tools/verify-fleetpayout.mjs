import { chromium } from 'playwright-core'
import fs from 'fs'
const APP = 'http://localhost:8081'
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); fs.mkdirSync(SHOT, { recursive: true })
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const JWT = 'x.' + b64u({ scp: ['esi-fleets.read_fleet.v1', 'esi-assets.read_assets.v1'], exp: Math.floor(Date.now() / 1000) + 7200, name: 'FC Tester', sub: 'CHARACTER:EVE:90000001' }) + '.y'
// Gestopte sessie met twee leden: A=60min, B=20min → 75%/25%
const SESS = { running: false, fleetId: 12345, opStart: Date.now() - 3600000, potRaw: '1b', taxPct: 10, mode: 'time', members: {
  '90000001': { name: 'Piloot A', joinTime: Date.now() - 3600000, shipTypeId: 670, totalMs: 3600000, presentSince: null },
  '90000002': { name: 'Piloot B', joinTime: Date.now() - 1200000, shipTypeId: 670, totalMs: 1200000, presentSince: null },
} }
const ASSETS = [
  { item_id: 1, type_id: 55932, location_id: 1, location_flag: 'Cargo', location_type: 'item', quantity: 5, is_singleton: false },   // 5×10M
  { item_id: 2, type_id: 55933, location_id: 1, location_flag: 'Cargo', location_type: 'item', quantity: 20, is_singleton: false },  // 20×1M  → 70M
  { item_id: 3, type_id: 81143, location_id: 1, location_flag: 'Cargo', location_type: 'item', quantity: 1000, is_singleton: false },
  { item_id: 4, type_id: 81144, location_id: 1, location_flag: 'Cargo', location_type: 'item', quantity: 500, is_singleton: false },
]
const FUZZ = { '81143': { sell: { min: 1500 } }, '81144': { sell: { min: 8000 } } }   // magma 1500, ice 8000
const IDS = { inventory_types: [{ id: 81143, name: 'Magmatic Gas' }, { id: 81144, name: 'Superionic Ice' }] }

const b = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } })
await ctx.addInitScript(({ jwt, sess }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: jwt, refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 90000001, characterName: 'FC Tester' }]))
  localStorage.setItem('fleet_payout_v1', JSON.stringify(sess))
}, { jwt: JWT, sess: SESS })
const json = body => ({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
// Generieke routes eerst; specifieke daarna (Playwright: laatst geregistreerd wint).
await ctx.route('**/api/*.php', r => r.fulfill(json({})))
await ctx.route('**esi.evetech.net/**', r => r.fulfill(json([])))
await ctx.route('**/characters/*/assets/**', r => r.fulfill(json(ASSETS)))
await ctx.route('**/universe/ids/**', r => r.fulfill(json(IDS)))
await ctx.route('**market.fuzzwork.co.uk/**', r => r.fulfill(json(FUZZ)))

const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto(`${APP}/fleet-payout`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForSelector('text=Fleet Payout', { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(900)
const cells = async () => p.$$eval('tbody tr', rows => rows.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim())))
const has = async t => (await p.locator(`text=${t}`).count()) > 0

let c = await cells()
console.log('  A:', c[0]); console.log('  B:', c[1])
console.log('  OK naar-tijd A 75% / 675M:', c[0].some(x => x.includes('75.0%')) && c[0].some(x => x.includes('675.00M')))
console.log('  OK naar-tijd B 25% / 225M:', c[1].some(x => x.includes('25.0%')) && c[1].some(x => x.includes('225.00M')))
await p.click('button:has-text("Gelijk")'); await p.waitForTimeout(300); c = await cells()
console.log('  OK gelijk beide 450M:', c[0].some(x => x.includes('450.00M')) && c[1].some(x => x.includes('450.00M')))

await p.click('button:has-text("ESS Bonds")'); await p.waitForTimeout(500)
console.log('  OK ESS Bonds 70M:', await has('70.00M ISK'))
await p.click('button:has-text("Skyhook")'); await p.waitForTimeout(500)
console.log('  OK Skyhook 5.50M:', await has('5.50M ISK'))

// Loot plakken (2000 magma × 1500 + 100 ice × 8000 = 3.0M + 0.8M = 3.8M)
await p.click('summary:has-text("Loot plakken")')
await p.fill('textarea', 'Magmatic Gas\t2000\nSuperionic Ice\t100')
await p.click('button:has-text("Waardeer")'); await p.waitForTimeout(600)
console.log('  OK plak-waardering 3.80M:', await has('3.80M ISK'))

await p.screenshot({ path: SHOT + 'fleetpayout.png', fullPage: true })
console.log('  JS-fouten:', errs.length ? errs : 'geen')
await b.close()
