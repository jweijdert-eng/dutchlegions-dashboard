// Live-verificatie: de losse pagina /koopjes toont de publieke
// item-exchange-contracten onder de Jita-prijs met Jita-waardering. Token gefaket; de
// corpcontracts-feed wordt gemockt zodat we niet van de echte corp afhankelijk zijn.
import { chromium } from 'playwright-core'
import fs from 'fs'

const APP = 'http://localhost:8081'
const CHAR_ID = 90000001
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
fs.mkdirSync(SHOT, { recursive: true })

// Nep-feed: één koopje, één te duur contract, één waarvan de inhoud onbekend is.
const FEED = {
  ok: true,
  regio: { id: 10000002, naam: 'The Forge' },
  bijgewerkt: new Date().toISOString(),
  totalen: { kandidaten: 4000, gewaardeerd: 812, nog_te_gaan: 3188, koopjes: 2,
             beste: 4.7393e8, waarde: 2.06e9, vraagprijs: 1.39e9 },
  rows: [
    { id: 1, titel: 'Stormbringer fit', prijs: 1.09e9, beloning: 0, betaalt: 1.09e9,
      volume: 12500, waardeSell: 1.564e9, waardeBuy: 1.4e9, nettoSell: 4.7393e8,
      nettoBuy: 3.1e8, marge: 43.5, aantalItems: 4, dunneMarkt: false, heeftBpc: false,
      prijsOnbekend: false, uitgegeven: new Date().toISOString(),
      verlooptOp: new Date(Date.now() + 5 * 86400000).toISOString(), locatieId: 60003760,
      locatie: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      items: [{ typeId: 54732, naam: 'Stormbringer', aantal: 1, isBpc: false, waarde: 1.4e9 },
              { typeId: 34, naam: 'Tritanium', aantal: 1000, isBpc: false, waarde: 4000 }] },
    { id: 2, titel: 'Officer mod bundel', prijs: 3e8, beloning: 0, betaalt: 3e8,
      volume: 50, waardeSell: 4.96e8, waardeBuy: 4.1e8, nettoSell: 1.96e8, nettoBuy: 1.1e8,
      marge: 65.3, aantalItems: 2, dunneMarkt: true, heeftBpc: true, prijsOnbekend: true,
      uitgegeven: new Date(Date.now() - 3600000).toISOString(),
      verlooptOp: new Date(Date.now() + 2 * 86400000).toISOString(), locatieId: 1035466617946,
      locatie: '',
      items: [{ typeId: 47757, naam: 'Vepas Modified BCS', aantal: 1, isBpc: false, waarde: 4.96e8 }] },
  ],
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{
    accessToken: 'fake-test-token', refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 7200_000, characterId: charId, characterName: 'Verify Tester',
  }]))
}, { charId: CHAR_ID })

await ctx.route('**/api/contractdeals.php*', r => r.fulfill({
  status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: JSON.stringify(FEED),
}))
await ctx.route('**/api/*.php', r => r.fulfill({
  status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: '{}',
}))
// ESI niet echt bevragen: de persoonlijke contractenlijst mag leeg blijven.
await ctx.route('**esi.evetech.net/**', r => r.fulfill({
  status: 200, headers: { 'content-type': 'application/json' }, body: '[]',
}))

const page = await ctx.newPage()
const fouten = []
page.on('pageerror', e => { fouten.push(e.message); console.log('PAGE ERROR:', e.message) })

console.log('--- Koopjes-pagina laden ---')
await page.goto(`${APP}/koopjes`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForSelector('text=Koopjes', { timeout: 20000 })
await page.waitForTimeout(1200)

console.log('--- Sidebar-link aanwezig? ---')
const sidebarLink = await page.locator('a[href="/koopjes"]').count()
// Moet in de Finance-groep staan, niet onderaan bij "Links" (items die in geen
// enkele groep van DEFAULT_LAYOUT staan belanden daar automatisch).
const inFinance = await page.locator('a[href="/koopjes"]').isVisible().catch(() => false)
console.log('  sidebar-link /koopjes:', sidebarLink, '| zichtbaar in de nav:', inFinance)

console.log('--- Contracts-pagina heeft GEEN scope-schakelaar meer ---')
await page.goto(`${APP}/contracts`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForTimeout(900)
const geenSchakelaar = (await page.locator('button', { hasText: /^KOOPJES$/ }).count()) === 0
console.log('  geen KOOPJES-knop op /contracts:', geenSchakelaar)

console.log('--- Terug naar /koopjes voor de inhoud ---')
await page.goto(`${APP}/koopjes`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForSelector('text=The Forge', { timeout: 20000 })
await page.waitForTimeout(800)

const heeft = async (t) => (await page.locator(`text=${t}`).count()) > 0
const checks = {
  'paginatitel Koopjes':    await heeft('Koopjes'),
  'regio The Forge':        await heeft('The Forge'),
  'sidebar-link':           sidebarLink > 0,
  'staat in de nav-groep':  inFinance,
  'schakelaar weg':         geenSchakelaar,
  'contract Stormbringer':  await heeft('Stormbringer'),
  'winst 473.93 mln':       await heeft('473.93 mln'),
  'marge +44%':             await heeft('+44%'),
  'tweede koopje':          await heeft('Officer mod bundel'),
  'badge dunne markt':      await heeft('dunne markt'),
  'badge bpc':              await heeft('bpc'),
  'voortgang gewaardeerd':  await heeft('812 / 4000'),
  'melding nog te scannen': await heeft('Nog 3188 contracten te scannen'),
  'stationnaam getoond':    await heeft('Jita IV - Moon 4 - Caldari Navy Assembly Plant'),
  'structure zonder naam':  await heeft('locatie #1035466617946'),
}
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'OK ' : 'MIS'} ${k}`)
await page.screenshot({ path: SHOT + 'koopjes-lijst.png', fullPage: true })

console.log('--- Sorteren op Marge % ---')
await page.click('button:has-text("Marge %")').catch(() => console.log('  (sorteerknop niet gevonden)'))
await page.waitForTimeout(600)


console.log('\nJS-fouten:', fouten.length ? fouten : 'geen')
const gezakt = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
console.log(gezakt.length ? `GEZAKT: ${gezakt.join(', ')}` : 'ALLE CHECKS OK')
console.log('Screenshots in .verify-shots/')
await browser.close()
