// Live-verificatie: /mineralen toont mineraalcontracten uit Delve, herkent onze
// sov-systemen, lost een structure op met het (neppe) token en filtert.
// Feed en ESI gemockt, dus onafhankelijk van de echte contractmarkt.
import { chromium } from 'playwright-core'
import fs from 'fs'

const APP = `http://localhost:${process.env.PORT || 8081}`
const CHAR_ID = 90000001
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
fs.mkdirSync(SHOT, { recursive: true })

const nu = Date.now()
const FEED = {
  ok: true,
  regio: 'Delve',
  eigenSystemen: { '30004787': 'Q-02UL', '30004759': '1B-VKF' },
  bijgewerkt: new Date().toISOString(),
  totalen: { kandidaten: 326, gescand: 120, nog_te_gaan: 206, mineraal: 3 },
  rows: [
    // puur Tritanium in een structure in Q-02UL (eigen) — goedkoper dan Jita
    { id: 1, titel: 'trit', prijs: 3.5e6, beloning: 0, betaalt: 3.5e6, volume: 10000,
      waardeJita: 3.83e6, waardeMineralen: 3.83e6, korting: 8.6, puur: true, perStuk: 3.5,
      mineralen: [{ typeId: 34, naam: 'Tritanium', aantal: 1_000_000, jitaSell: 3.83, jitaBuy: 3.6, waarde: 3.83e6 }],
      overig: [], aantalOverig: 0, heeftInlever: false, prijsOnbekend: false,
      uitgegeven: new Date(nu - 3600e3).toISOString(), verlooptOp: new Date(nu + 5 * 86400e3).toISOString(),
      locatieId: 1054611409751, locatie: '', systeem: '', issuerId: 90000042, issuer: 'Miner Mike', forCorp: false },
    // gemengd contract op een NPC-station buiten onze sov — duurder dan Jita
    { id: 2, titel: '', prijs: 2.5e8, beloning: 0, betaalt: 2.5e8, volume: 30000,
      waardeJita: 2.1e8, waardeMineralen: 1.2e8, korting: -19.0, puur: false, perStuk: null,
      mineralen: [{ typeId: 36, naam: 'Mexallon', aantal: 500_000, jitaSell: 100, jitaBuy: 95, waarde: 5e7 },
                  { typeId: 35, naam: 'Pyerite', aantal: 2_000_000, jitaSell: 35, jitaBuy: 30, waarde: 7e7 }],
      overig: [{ typeId: 11399, naam: 'Some Module', aantal: 3, isBpc: false, waarde: 9e7 }], aantalOverig: 1,
      heeftInlever: false, prijsOnbekend: false,
      uitgegeven: new Date(nu - 7200e3).toISOString(), verlooptOp: new Date(nu + 2 * 86400e3).toISOString(),
      locatieId: 60014949, locatie: 'ZXB-VC VIII - Moon 4 - Blood Raiders Assembly Plant', systeem: 'ZXB-VC',
      issuerId: 90000043, issuer: 'Corp Seller', issuerCorpId: 98000001, issuerCorp: 'Dutch Legions', forCorp: true },
    // structure die niet op te lossen is (geen docking-rechten)
    { id: 3, titel: '', prijs: 1e7, beloning: 0, betaalt: 1e7, volume: 100,
      waardeJita: 1.5e7, waardeMineralen: 1.5e7, korting: 33.3, puur: true, perStuk: 15000,
      mineralen: [{ typeId: 40, naam: 'Megacyte', aantal: 1000, jitaSell: 15000, jitaBuy: 14000, waarde: 1.5e7 }],
      overig: [], aantalOverig: 0, heeftInlever: false, prijsOnbekend: false,
      uitgegeven: new Date(nu - 60e3).toISOString(), verlooptOp: new Date(nu + 86400e3).toISOString(),
      locatieId: 1052738603765, locatie: '', systeem: '', issuerId: 90000044, issuer: 'Onbekend', forCorp: false },
  ],
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{
    accessToken: 'fake-test-token', refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 7200_000, characterId: charId, characterName: 'Verify Tester',
  }]))
  localStorage.removeItem('mineralen.v1')
}, { charId: CHAR_ID })

await ctx.route('**/api/contractdeals.php*', r => r.fulfill({
  status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: JSON.stringify(FEED),
}))
await ctx.route('**/api/*.php', r => r.fulfill({
  status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: '{}',
}))
// Structure 1054611409751 lost op naar Q-02UL; de andere geeft 403 (geen rechten).
await ctx.route('**esi.evetech.net/**', r => {
  const url = r.request().url()
  if (url.includes('/universe/structures/1054611409751/')) {
    return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Q-02UL - Dutch Legions Fort', solar_system_id: 30004787, type_id: 35833 }) })
  }
  if (url.includes('/universe/structures/')) return r.fulfill({ status: 403, headers: { 'content-type': 'application/json' }, body: '{"error":"Forbidden"}' })
  return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' })
})

const page = await ctx.newPage()
const fouten = []
page.on('pageerror', e => { fouten.push(e.message); console.log('PAGE ERROR:', e.message) })

console.log('--- Mineralen-pagina laden ---')
await page.goto(`${APP}/mineralen`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForSelector('text=Mineraalcontracten', { timeout: 20000 })
await page.waitForTimeout(1500)

const link = await page.locator('a[href="/mineralen"]').count()
console.log('  sidebar-link /mineralen:', link)

// Standaard: alleen onze systemen → alleen rij 1 (Q-02UL, via structure-lookup)
const rijen = () => page.locator('tbody tr').filter({ hasText: /Tritanium|Mexallon|Megacyte/ })
console.log('  rijen standaard (verwacht 1, Q-02UL):', await rijen().count())
const q02 = await page.locator('td:has-text("Q-02UL")').first().textContent().catch(() => '')
console.log('  eerste rij systeem:', q02?.trim().slice(0, 40))
console.log('  korting groen −8.6%:', await page.locator('text=−8.6%').count())
console.log('  per stuk 3,50 / 3,83:', await page.locator('text=3,50').count())
await page.screenshot({ path: SHOT + 'mineralen-eigen.png', fullPage: true })

// Filter uit → alle drie
await page.locator('button:has-text("alleen onze systemen")').click()
await page.waitForTimeout(300)
console.log('  rijen zonder eigen-filter (verwacht 3):', await rijen().count())
console.log('  duurder dan Jita +19.0%:', await page.locator('text=+19.0%').count())
console.log('  "+1 ander item" badge:', await page.locator('text=+1 ander item').count())
console.log('  onbekende structure toont "?":', await page.locator('td:has-text("?")').count() > 0)

// Alleen goedkoper dan Jita → 2 (rij 2 valt af)
await page.locator('button:has-text("alleen goedkoper dan Jita")').click()
await page.waitForTimeout(300)
console.log('  rijen alleen goedkoper (verwacht 2):', await rijen().count())

// Uitklappen
await rijen().first().click()
await page.waitForTimeout(300)
console.log('  uitklaprij met INHOUD:', await page.locator('text=INHOUD').count())
await page.screenshot({ path: SHOT + 'mineralen-alles.png', fullPage: true })

console.log('--- fouten:', fouten.length, '---')
await browser.close()
process.exit(fouten.length ? 1 : 0)
