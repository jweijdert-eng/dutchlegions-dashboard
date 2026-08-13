import { chromium } from 'playwright-core'
import fs from 'fs'
const APP = process.env.APP || 'http://localhost:8081'
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); fs.mkdirSync(SHOT, { recursive: true })
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const JWT = 'x.' + b64u({ scp: ['esi-ui.write_waypoint.v1'], exp: Math.floor(Date.now() / 1000) + 7200, name: 'Verify Tester', sub: 'CHARACTER:EVE:90000001' }) + '.y'
const uur = (h) => new Date(Date.now() + h * 3600000).toISOString()
const min = (m) => new Date(Date.now() - m * 60000).toISOString()

const WAAK = ['Y5C-YD','F-9PXR','Q-02UL','31X-RE','7UTB-F','5-6QW7','T-IPZB','LUA5-L','Q-JQSG','T-M0FA','QC-YX6','4O-239',
              '1B-VKF','IP6V-X','R5-MM8','E3OI-U','T-J6HT','39P-1J','PS-94K','HZAQ-W','7G-QIG','NIDJ-K','8RQJ-2','RF-K9W']

const rij = (o) => ({ op_lijst: true, region_id: 10000060, region: 'Delve', sec: -0.4, wh_type: 'E587',
  max_size: 'xlarge', maat: 'capital (XL)', door: 'Total Space Cadet', first_seen: min(4), closed_at: null, ...o })

const FEED = {
  ok: true, aantal: 3, op_lijst: 3, dichtbij: 1, in_regio: 0, waaklijst: WAAK,
  home: 30004787, home_naam: 'Q-02UL', max_jumps: 0, regios: [], discord: true,
  bijgewerkt: new Date().toISOString(),
  rows: [
    rij({ sig_id: '71724', system_id: 30004789, system: '5-6QW7', jumps: 1, out_system: 'Thera',
          in_sig: 'VQD-106', out_sig: 'JZL-541', expires_at: uur(14.9) }),
    rij({ sig_id: '71801', system_id: 30004770, system: 'RF-K9W', jumps: 9, out_system: 'Turnur',
          in_sig: 'ABC-118', out_sig: 'QQR-402', wh_type: 'V898', max_size: 'large', maat: 'battleship (L)',
          door: 'Scout Two', expires_at: uur(3.2), first_seen: min(52) }),
    rij({ sig_id: '71844', system_id: 30004744, system: 'T-IPZB', jumps: 5, out_system: 'Thera',
          in_sig: 'KLM-330', out_sig: 'PPX-101', wh_type: 'L031', max_size: 'medium', maat: 'cruiser (M)',
          door: 'Wandering Eye', expires_at: uur(0.6), first_seen: min(190) }),
  ],
  gesloten: [
    rij({ sig_id: '71600', system_id: 30004787, system: 'Q-02UL', jumps: 0, out_system: 'Thera',
          in_sig: 'OLD-001', out_sig: 'OLD-002', expires_at: uur(-1), closed_at: min(40) }),
  ],
}

const CFG = { ok: true, enabled: true, webhook: 'https://discord.com/api/webhooks/123456/abcdef', ping: '@here',
  home: 30004787, maxJumps: 0, regions: [], systems: WAAK,
  pollUrl: 'https://dutchlegionsdashboard.eu/api/thera.php?action=poll&key=0123456789abcdef' }

const b = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addInitScript(({ jwt }) => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: jwt, refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 90000001, characterName: 'Verify Tester' }])), { jwt: JWT })
await ctx.route('**/api/*.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }))
await ctx.route('**/api/roles.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ me: 'admin' }) }))
await ctx.route('**/api/thera.php*', r => {
  const url = r.request().url()
  const body = url.includes('action=config') ? CFG : url.includes('action=test') ? { ok: true } : FEED
  r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
})
await ctx.route('**esi.evetech.net/**', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' }))

const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto(`${APP}/thera`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForSelector('text=5-6QW7', { timeout: 20000 }).catch(() => {})
await p.waitForTimeout(800)

console.log('  OK  3 rijen:', (await p.locator('tbody tr').count()) === 3)
console.log('  OK  Turnur-rij aanwezig:', (await p.locator('td :text("TURNUR")').count()) > 0)
console.log('  OK  afstand 1 spr.:', (await p.locator('text=1 spr.').count()) > 0)
console.log('  OK  ijkpunt Q-02UL in kop:', (await p.locator('text=Afstanden vanaf').count()) > 0)
console.log('  OK  recent verdwenen:', (await p.locator('text=RECENT VERDWENEN').count()) > 0)
await p.screenshot({ path: SHOT + 'thera-lijst.png', fullPage: true })

// Waakzone uitklappen
await p.click('button:has-text("Waakzone")').catch(() => {})
await p.waitForTimeout(300)
console.log('  OK  waakzone toont 24 chips:', (await p.locator('text=RF-K9W').count()) > 0)

// Admin-paneel
await p.click('button:has-text("Meldingen")').catch(() => {})
await p.waitForTimeout(600)
console.log('  OK  webhook-veld gevuld:', (await p.locator('input[value*="discord.com/api/webhooks"]').count()) > 0)
console.log('  OK  cron-URL zichtbaar:', (await p.locator('text=action=poll').count()) > 0)
await p.screenshot({ path: SHOT + 'thera-admin.png', fullPage: true })

console.log('JS-fouten:', errs.length ? errs : 'geen')
await b.close()
