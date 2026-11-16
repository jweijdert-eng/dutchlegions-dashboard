// Waar is iedereen: toont de pagina de gedeelde posities per systeem + de bewegingen-feed,
// en meldt de rapporteur (useLocationReporter) de eigen positie aan locations.php?
import { chromium } from 'playwright-core'
import fs from 'fs'
const APP = process.env.APP || 'http://localhost:8081'
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); fs.mkdirSync(SHOT, { recursive: true })
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (id, naam, scp) => 'x.' + b64u({ scp, exp: Math.floor(Date.now() / 1000) + 7200, name: naam, sub: `CHARACTER:EVE:${id}` }) + '.y'
const LOC = ['esi-location.read_location.v1', 'esi-location.read_ship_type.v1']

const IK = 90000001, ALT = 90000002
const TOKENS = [
  { accessToken: jwt(IK, 'Brandweer', LOC), refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: IK, characterName: 'Brandweer' },
  { accessToken: jwt(ALT, 'Zonder Recht', []), refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: ALT, characterName: 'Zonder Recht' },
]
const Q02UL = 30004787, QW7 = 30004789, PS94K = 30004770, JITA = 30000142

const DATA = { ok: true, now: new Date().toISOString(), members: [
  { character_id: IK, name: 'Brandweer', solar_system_id: Q02UL, station_id: null, structure_id: 1030000000001, ship_type_id: 12005, ship_name: 'Ratsnack', age: 12, since_change: 600 },
  { character_id: 90000003, name: 'Piet Pilot', solar_system_id: Q02UL, station_id: null, structure_id: null, ship_type_id: 11987, ship_name: 'Snelle Jelle', age: 40, since_change: 40 },
  { character_id: 90000004, name: 'Klaas Koerier', solar_system_id: JITA, station_id: 60003760, structure_id: null, ship_type_id: null, ship_name: null, age: 7200, since_change: 9000 },
  { character_id: 90000005, name: 'Rita Ratter', solar_system_id: PS94K, station_id: null, structure_id: null, ship_type_id: 12005, ship_name: 'Tick', age: 90, since_change: 3000 },
], feed: [
  { character_id: 90000003, name: 'Piet Pilot', from_system: QW7, to_system: Q02UL, ship_type_id: 11987, at: new Date(Date.now() - 40000).toISOString(), age: 40 },
  { character_id: 90000004, name: 'Klaas Koerier', from_system: null, to_system: JITA, ship_type_id: null, at: new Date(Date.now() - 7200000).toISOString(), age: 7200 },
] }

const posts = []
const b = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addInitScript(({ toks }) => localStorage.setItem('eve_tokens', JSON.stringify(toks)), { toks: TOKENS })
await ctx.route('**/api/*.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' }))
await ctx.route('**/api/roles.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"me":"member"}' }))
await ctx.route('**/api/siteconfig.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"accent":"","links":[],"bridges":[],"intelChannels":[]}' }))
await ctx.route('**/api/locations.php*', r => {
  const req = r.request()
  if (req.method() === 'POST') {
    posts.push({ body: req.postDataJSON(), token: req.headers()['x-token'] })
    return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
  }
  return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(DATA) })
})
await ctx.route('**esi.evetech.net/**', r => {
  const u = r.request().url()
  const j = (o) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=5' }, body: JSON.stringify(o) })
  if (u.includes(`/characters/${IK}/location`)) return j({ solar_system_id: Q02UL, structure_id: 1030000000001 })
  if (u.includes(`/characters/${IK}/ship/`)) return j({ ship_type_id: 12005, ship_name: 'Ratsnack', ship_item_id: 1 })
  if (u.includes('/universe/structures/')) return j({ name: 'Q-02UL - Brandweerkazerne', solar_system_id: Q02UL, type_id: 35834 })
  if (u.includes('/characters/')) return r.fulfill({ status: 403, body: '{}' })
  return j([])
})

const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto(`${APP}/waar`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForSelector('text=Piet Pilot', { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(1500)

const tekst = await p.locator('body').innerText()
console.log('  OK  systeemnamen uit de bundel:', /Q-02UL/.test(tekst) && /Jita/.test(tekst) && /PS-94K/.test(tekst))
console.log('  OK  groep Q-02UL heeft 2 piloten:', (await p.locator('div:has(> div:has-text("Q-02UL")) :text("2 piloten")').count()) > 0)
console.log('  OK  schip opgelost (Ishtar):', /Ishtar/.test(tekst))
console.log('  OK  gedockt in station (Jita 4-4):', /gedockt · Jita 4 - Moon 4/.test(tekst))
console.log('  OK  structure-naam via ESI:', /Brandweerkazerne/.test(tekst))
console.log('  OK  feed toont sprong 5-6QW7 → Q-02UL:', /5-6QW7\s*→\s*[\d.-]*\s*Q-02UL/.test(tekst.replace(/\n/g, ' ')))
console.log('  OK  teller actief = 3:', /3\s*actief/.test(tekst.replace(/\n/g, ' ')))
console.log('  OK  waarschuwing login zonder locatie-recht:', /Zonder Recht: je login mist het locatie-recht/.test(tekst))

// Rapporteur: één POST voor het character mét recht, geen voor het character zonder.
await p.waitForTimeout(1000)
const mijn = posts.filter(x => x.body?.solar_system_id)
console.log('  OK  rapporteur meldt positie:', mijn.length >= 1 && mijn[0].body.solar_system_id === Q02UL && mijn[0].body.ship_type_id === 12005 && mijn[0].body.structure_id === 1030000000001)
console.log('  OK  token in X-Token van dat character:', mijn.length >= 1 && mijn[0].token === TOKENS[0].accessToken)
console.log('  OK  geen melding voor character zonder recht:', !posts.some(x => x.token === TOKENS[1].accessToken))

// Filter: alleen actief → Klaas (2 uur oud) verdwijnt.
await p.locator('label:has-text("alleen actief") input').check()
await p.waitForTimeout(300)
console.log('  OK  filter "alleen actief" verbergt oude melding:', (await p.locator('#waar-lijst >> text=Klaas Koerier').count()) === 0)
await p.locator('label:has-text("alleen actief") input').uncheck()
await p.fill('input[placeholder^="Zoek"]', 'jita')
await p.waitForTimeout(300)
console.log('  OK  zoeken op systeem:', (await p.locator('#waar-lijst >> text=Klaas Koerier').count()) === 1 && (await p.locator('#waar-lijst >> text=Piet Pilot').count()) === 0)
await p.fill('input[placeholder^="Zoek"]', '')
await p.screenshot({ path: SHOT + 'waar.png', fullPage: true })

// Delen uitzetten → afmelding (shared:false) met het token.
await p.goto(`${APP}/settings`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForSelector('text=Locatie delen', { timeout: 15000 }).catch(() => {})
const n0 = posts.length
await p.locator('div:has(> div > div:text-is("Locatie delen")) button[role=switch]').first().click()
await p.waitForTimeout(800)
const af = posts.slice(n0).filter(x => x.body?.shared === false)
console.log('  OK  uitzetten meldt af (shared:false):', af.length >= 1 && af[0].token === TOKENS[0].accessToken)
await p.goto(`${APP}/waar`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForSelector('text=Je deelt je eigen positie niet', { timeout: 15000 }).catch(() => {})
console.log('  OK  pagina meldt dat je niet deelt:', (await p.locator('text=Je deelt je eigen positie niet').count()) > 0)

console.log('JS-fouten:', errs.length ? errs : 'geen')
await b.close()
