// Schermafdrukken van bestaande pagina's, om de huisstijl te vergelijken.
import { chromium } from 'playwright-core'
import fs from 'fs'
const APP = 'http://localhost:8081'
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); fs.mkdirSync(SHOT, { recursive: true })
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const JWT = 'x.' + b64u({ scp: ['esi-ui.write_waypoint.v1'], exp: Math.floor(Date.now() / 1000) + 7200, name: 'Verify Tester', sub: 'CHARACTER:EVE:90000001' }) + '.y'

const SOV = { ok: true, region: 'Delve', region_id: 10000060, aantal: 2, kwetsbaar_nu: 1, onder_aanval: 1, ours_count: 1, ours_attack: 1,
  bijgewerkt: new Date().toISOString(),
  rows: [
    { structure_id: 1, system_id: 30004787, type: 'IHUB', type_full: 'Infrastructure Hub', system: 'Q-02UL', sec: -0.5, alliance_id: 99011990, alliance: 'Insidious.', ours: true, adm: 1.4, status: 'campaign', when: new Date(Date.now() + 9e6).toISOString(), campaign: true, defender: 'Insidious.', defender_score: 60, attackers_score: 40, moved: true, d_def: -8, d_att: 8, trend: 'att' },
    { structure_id: 2, system_id: 30004789, type: 'TCU', type_full: 'Territorial Claim Unit', system: '5-6QW7', sec: -0.4, alliance_id: 99003581, alliance: 'Beyond the Breach', ours: false, adm: 4.1, status: 'vulnerable', when: new Date(Date.now() + 2e5).toISOString(), campaign: false, defender: '', defender_score: null, attackers_score: null, moved: false, d_def: 0, d_att: 0, trend: '' },
  ] }

const b = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } })
await ctx.addInitScript(({ jwt }) => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: jwt, refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 90000001, characterName: 'Verify Tester' }])), { jwt: JWT })
await ctx.route('**/api/*.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }))
await ctx.route('**/api/roles.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ me: 'admin' }) }))
await ctx.route('**/api/sovtimer.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(SOV) }))
await ctx.route('**esi.evetech.net/**', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' }))

for (const [route, naam, wacht] of [['/sov-timer', 'ref-sov', 'text=Q-02UL'], ['/gap-scanner', 'ref-gap', 'text=MARKT'], ['/koopjes', 'ref-koopjes', null]]) {
  const p = await ctx.newPage()
  await p.goto(APP + route, { waitUntil: 'domcontentloaded' }).catch(() => {})
  if (wacht) await p.waitForSelector(wacht, { timeout: 12000 }).catch(() => {})
  await p.waitForTimeout(1500)
  await p.screenshot({ path: `${SHOT}${naam}.png` })
  await p.close()
  console.log('geschoten:', naam)
}
await b.close()
