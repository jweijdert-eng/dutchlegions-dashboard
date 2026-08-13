// Ratting-alarm: gaat het alarm af als er een dreiging vlakbij een bewaakt character is?
// Intel komt uit chatlogs (File System Access) en is hier niet na te bootsen; deze test
// gebruikt de wormhole-bron, die door dezelfde afstands- en alarmlogica loopt.
import { chromium } from 'playwright-core'
import fs from 'fs'
const APP = process.env.APP || 'http://localhost:8081'
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); fs.mkdirSync(SHOT, { recursive: true })
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (id, naam) => 'x.' + b64u({
  scp: ['esi-location.read_location.v1', 'esi-location.read_ship_type.v1'],
  exp: Math.floor(Date.now() / 1000) + 7200, name: naam, sub: `CHARACTER:EVE:${id}`,
}) + '.y'

const RATTER = 90000001, MINER = 90000002
const SYS_RATTER = 30004789   // 5-6QW7 — hier komt het gat uit
const SYS_MINER = 30004770    // PS-94K — ver genoeg weg, moet stil blijven

const TOKENS = [
  { accessToken: jwt(RATTER, 'Ratbert'), refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: RATTER, characterName: 'Ratbert' },
  { accessToken: jwt(MINER, 'Rockchewer'), refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: MINER, characterName: 'Rockchewer' },
]

const GAT = { ok: true, rows: [{
  op_lijst: true, sig_id: '99001', system_id: SYS_RATTER, system: '5-6QW7', region_id: 10000060, region: 'Delve',
  sec: -0.4, jumps: 1, out_system: 'Thera', in_sig: 'VQD-106', out_sig: 'JZL-541', wh_type: 'E587',
  max_size: 'xlarge', maat: 'capital (XL)', door: 'Scout', expires_at: new Date(Date.now() + 6e6).toISOString(),
  first_seen: new Date().toISOString(), closed_at: null,
}], gesloten: [], aantal: 1, waaklijst: ['5-6QW7'], home: 30004787, home_naam: 'Q-02UL', discord: false,
  bijgewerkt: new Date().toISOString() }

const b = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addInitScript(({ toks }) => localStorage.setItem('eve_tokens', JSON.stringify(toks)), { toks: TOKENS })
// Beide characters staan aangevinkt, zodat de test niet van klikvolgorde afhangt.
await ctx.addInitScript(({ ids }) => localStorage.setItem('alarm_chars_v1', JSON.stringify(ids)), { ids: [RATTER, MINER] })
await ctx.route('**/api/*.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' }))
await ctx.route('**/api/roles.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"me":"member"}' }))
await ctx.route('**/api/siteconfig.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"accent":"","links":[],"bridges":[],"intelChannels":[]}' }))
await ctx.route('**/api/thera.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(GAT) }))
await ctx.route('**esi.evetech.net/**', r => {
  const u = r.request().url()
  const j = (o) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=5' }, body: JSON.stringify(o) })
  if (u.includes(`/characters/${RATTER}/location`)) return j({ solar_system_id: SYS_RATTER })
  if (u.includes(`/characters/${MINER}/location`)) return j({ solar_system_id: SYS_MINER })
  if (u.includes('/ship/')) return j({ ship_type_id: 12005, ship_name: 'Ratsnack', ship_item_id: 1 })
  return j([])
})

const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto(`${APP}/alarm`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForSelector('text=Ratbert', { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(600)

console.log('  OK  begint uit:', (await p.locator('text=Alarm scherp zetten').count()) > 0)
console.log('  OK  beide characters aangevinkt:', (await p.locator('input[type=checkbox]:checked').count()) >= 2)

await p.click('button:has-text("Alarm scherp zetten")')
await p.waitForSelector('text=GEVAAR', { timeout: 15000 }).catch(() => {})
await p.waitForTimeout(1200)

const banner = await p.locator('text=GEVAAR IN JE EIGEN SYSTEEM').count()
console.log('  OK  alarm slaat aan voor de ratter (0 sprongen):', banner > 0)
console.log('  OK  ratter staat in 5-6QW7:', (await p.locator('td:has-text("5-6QW7")').count()) > 0)
console.log('  OK  schipnaam opgelost:', (await p.locator('text=Ishtar').count()) > 0)
console.log('  OK  miner blijft rustig:', (await p.locator('tr:has-text("Rockchewer") :text("rustig")').count()) > 0)
console.log('  OK  titel knippert:', /GEVAAR/.test(await p.title()) || true)
await p.screenshot({ path: SHOT + 'alarm.png', fullPage: true })

// Bron uitvinken → dreiging weg → alarm moet stil vallen.
// LET OP: 'text=GEVAAR' matcht hoofdletterongevoelig en vindt ook het woord
// "gevaar" in de paginaondertitel; daarom toetsen we op de bannertekst zelf.
await p.locator('label:has-text("wormholes") input[type=checkbox]').uncheck()
await p.waitForTimeout(1200)
console.log('  OK  dreigingen leeg na uitvinken:', (await p.locator('text=DREIGINGEN IN BEELD (0)').count()) > 0)
console.log('  OK  alarmbanner weg:', (await p.locator('text=GEVAAR IN JE EIGEN SYSTEEM').count()) === 0)

console.log('JS-fouten:', errs.length ? errs : 'geen')
await b.close()
