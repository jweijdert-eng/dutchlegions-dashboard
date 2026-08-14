// Kleuren in Local Chat: eigen corp/alliance moeten vriendelijk zijn, niet rood.
// Voedt de pagina met een nagemaakte EVE-chatlog via de bestand-invoer en mockt
// ESI zodat elke afzender een bekende corp/alliance heeft.
import { chromium } from 'playwright-core'
import fs from 'fs'
const APP = process.env.APP || 'http://localhost:8081'
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'); fs.mkdirSync(SHOT, { recursive: true })
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const JWT = 'x.' + b64u({ scp: [], exp: Math.floor(Date.now() / 1000) + 7200, name: 'Ikzelf', sub: 'CHARACTER:EVE:90000001' }) + '.y'

const IK = 90000001, CORPMAAT = 2001, ALLYMAAT = 2002, BLAUW = 2003, VREEMDE = 2004
const MIJN_CORP = 98652891, MIJN_ALLY = 99013537
const namen = { 'Ikzelf': IK, 'Corp Maatje': CORPMAAT, 'Ally Maatje': ALLYMAAT, 'Blauwe Vriend': BLAUW, 'Vreemde Snuiter': VREEMDE }
const info = {
  [IK]:       { corporation_id: MIJN_CORP, alliance_id: MIJN_ALLY },
  [CORPMAAT]: { corporation_id: MIJN_CORP, alliance_id: MIJN_ALLY },
  [ALLYMAAT]: { corporation_id: 555001,    alliance_id: MIJN_ALLY },   // andere corp, zelfde alliance
  [BLAUW]:    { corporation_id: 555002,    alliance_id: 777001 },      // staat als +10 in de contacten
  [VREEMDE]:  { corporation_id: 555003,    alliance_id: 777002 },      // niets bekend
}

// EVE schrijft chatlogs als UTF-16LE met BOM.
const log = [
  '  Channel ID:      local',
  '  Channel Name:    Local',
  '',
  '[ 2026.08.14 20:01:00 ] Corp Maatje > o7',
  '[ 2026.08.14 20:01:10 ] Ally Maatje > hoi',
  '[ 2026.08.14 20:01:20 ] Blauwe Vriend > alles rustig',
  '[ 2026.08.14 20:01:30 ] Vreemde Snuiter > ...',
  '[ 2026.08.14 20:01:40 ] Ikzelf > test',
].join('\r\n')
const pad = SHOT + 'local-test.txt'
fs.writeFileSync(pad, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(log, 'utf16le')]))

const b = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } })
await ctx.addInitScript(({ jwt }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: jwt, refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 90000001, characterName: 'Ikzelf' }]))
  localStorage.setItem('eve_local_standings', '{}')
}, { jwt: JWT })
await ctx.route('**/api/*.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' }))
await ctx.route('**/api/roles.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"me":"member"}' }))
await ctx.route('**/api/siteconfig.php*', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"accent":"","links":[],"bridges":[],"intelChannels":[]}' }))
await ctx.route('**esi.evetech.net/**', async r => {
  const u = r.request().url()
  const j = (o, h = {}) => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(o) })
  if (u.includes('/universe/ids/')) {
    const gevraagd = JSON.parse(r.request().postData() || '[]')
    return j({ characters: gevraagd.filter(n => namen[n]).map(n => ({ id: namen[n], name: n })) })
  }
  // Alleen Blauwe Vriend staat in de persoonlijke contacten (+10).
  if (u.includes('/contacts/')) {
    if (u.includes(`/characters/${IK}/contacts/`)) return j([{ contact_id: BLAUW, contact_type: 'character', standing: 10 }], { 'x-pages': '1' })
    return j([], { 'x-pages': '1' })
  }
  const m = u.match(/\/characters\/(\d+)\/\?/)
  if (m && info[m[1]]) return j(info[m[1]])
  return j([])
})

const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto(`${APP}/local`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await p.waitForTimeout(1000)
await p.locator('input[type=file]').setInputFiles(pad)
await p.waitForSelector('text=Vreemde Snuiter', { timeout: 15000 }).catch(() => {})
await p.waitForTimeout(2500)   // namen → ids → corp-info is gebatcht (400ms per stap)

const kleur = async (naam) => p.locator(`span:text-is("${naam}")`).first().evaluate(el => getComputedStyle(el).color).catch(() => '?')
const rood = 'rgb(224, 85, 85)', groen = 'rgb(62, 207, 110)', lichtblauw = 'rgb(127, 224, 255)'
const k = {}
for (const n of ['Corp Maatje', 'Ally Maatje', 'Blauwe Vriend', 'Vreemde Snuiter']) k[n] = await kleur(n)
console.log('  kleuren:', JSON.stringify(k))
console.log('  OK  corpmaat is groen (was rood):', k['Corp Maatje'] === groen)
console.log('  OK  alliancemaat is lichtblauw (was rood):', k['Ally Maatje'] === lichtblauw)
console.log('  OK  blauw contact is groen:', k['Blauwe Vriend'] === groen)
console.log('  OK  vreemde blijft rood:', k['Vreemde Snuiter'] === rood)
await p.screenshot({ path: SHOT + 'localchat-standings.png' })

await p.click('button:has-text("Vrienden")')
await p.waitForTimeout(400)
const naVriendFilter = await p.locator('tbody tr').count()
console.log('  OK  vriendenfilter toont corp+ally+blauw+jezelf (4):', naVriendFilter === 4)
await p.click('button:has-text("Vrienden")')
await p.click('button:has-text("Vijanden")')
await p.waitForTimeout(400)
console.log('  OK  vijandenfilter toont alleen de vreemde (1):', (await p.locator('tbody tr').count()) === 1)

console.log('JS-fouten:', errs.length ? errs : 'geen')
await b.close()
