// Live-verificatie: de Contracts-pagina heeft een MIJN/CORP-schakelaar, en onder
// CORP staat het item-exchange-blok met Jita-waardering. Token gefaket; de
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
  corp: { id: 98652891, naam: 'Dutch Legions' },
  bijgewerkt: new Date().toISOString(),
  totalen: { aantal: 3, onbekend: 1, koopjes: 1, waarde: 1.56e9, vraagprijs: 1.79e9,
             netto: 4.74e8, beste: 4.7393e8 },
  rows: [
    { id: 1, titel: 'Stormbringer', uitgever: 'Test Piloot', prijs: 1.09e9, beloning: 0,
      betaalt: 1.09e9, waardeSell: 1.564e9, waardeBuy: 1.4e9, nettoSell: 4.7393e8,
      nettoBuy: 3.1e8, marge: 43.5, aantalItems: 4, onbekend: false, leeg: false,
      dunneMarkt: false, heeftBpc: false, prijsOnbekend: false,
      verlooptOp: new Date(Date.now() + 5 * 86400000).toISOString(), locatieId: 60003760,
      items: [{ typeId: 54732, naam: 'Stormbringer', aantal: 1, isBpc: false, waarde: 1.4e9 },
              { typeId: 34, naam: 'Tritanium', aantal: 1000, isBpc: false, waarde: 4000 }] },
    { id: 2, titel: 'June Ratting Taxes', uitgever: 'Andere Piloot', prijs: 1.66e9, beloning: 0,
      betaalt: 1.66e9, waardeSell: 0, waardeBuy: 0, nettoSell: -1.66e9, nettoBuy: -1.66e9,
      marge: -100, aantalItems: 0, onbekend: false, leeg: true, dunneMarkt: false,
      heeftBpc: false, prijsOnbekend: false,
      verlooptOp: new Date(Date.now() + 2 * 86400000).toISOString(), locatieId: 60003760, items: [] },
    { id: 3, titel: 'Nog niet opgehaald', uitgever: 'Derde Piloot', prijs: 5e8, beloning: 0,
      betaalt: 5e8, waardeSell: null, waardeBuy: null, nettoSell: null, nettoBuy: null,
      marge: null, aantalItems: 0, onbekend: true, leeg: false, dunneMarkt: false,
      heeftBpc: false, prijsOnbekend: false,
      verlooptOp: new Date(Date.now() + 9 * 86400000).toISOString(), locatieId: 60003760, items: [] },
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

await ctx.route('**/api/corpcontracts.php*', r => r.fulfill({
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

console.log('--- Contracts-pagina laden ---')
await page.goto(`${APP}/contracts`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForSelector('text=Contracts', { timeout: 20000 })
await page.waitForTimeout(1200)

const knopMijn = await page.locator('button', { hasText: /^MIJN$/ }).count()
const knopCorp = await page.locator('button', { hasText: /^CORP$/ }).count()
console.log('MIJN-knop aanwezig:', knopMijn, '| CORP-knop aanwezig:', knopCorp)
await page.screenshot({ path: SHOT + 'contracts-mijn.png' })

console.log('--- Losse pagina /corp-contracts hoort weg te zijn ---')
await page.goto(`${APP}/corp-contracts`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForTimeout(900)
const corpPaginaWeg = !(await page.locator('text=open item exchange').count())
console.log('/corp-contracts toont GEEN eigen pagina meer:', corpPaginaWeg)

console.log('--- Terug naar Contracts en op CORP klikken ---')
await page.goto(`${APP}/contracts`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForSelector('button:has-text("CORP")', { timeout: 20000 })
await page.click('button:has-text("CORP")')
await page.waitForTimeout(1200)

const heeft = async (t) => (await page.locator(`text=${t}`).count()) > 0
const checks = {
  'corpnaam Dutch Legions':      await heeft('Dutch Legions'),
  'contract Stormbringer':       await heeft('Stormbringer'),
  'winst 473.93 mln':            await heeft('473.93 mln'),
  'marge +44%':                  await heeft('+44%'),
  'badge inhoud onbekend':       await heeft('inhoud onbekend'),
  'badge leeg':                  await heeft('leeg'),
  'melding over onbekende inhoud': await heeft('tellen niet mee in de totalen'),
  'uitleg dunne markt':          await heeft('dunne markt'),
}
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'OK ' : 'MIS'} ${k}`)
await page.screenshot({ path: SHOT + 'contracts-corp.png', fullPage: true })

console.log('--- Sorteren op Marge % ---')
await page.click('button:has-text("Marge %")').catch(() => console.log('  (sorteerknop niet gevonden)'))
await page.waitForTimeout(600)

console.log('--- Filter "alleen koopjes" ---')
await page.locator('input[type=checkbox]').first().check().catch(() => {})
await page.waitForTimeout(600)
const naFilter = await page.locator('text=June Ratting Taxes').count()
console.log('  verliescontract verborgen na filter:', naFilter === 0)
await page.screenshot({ path: SHOT + 'contracts-corp-koopjes.png' })

console.log('\nJS-fouten:', fouten.length ? fouten : 'geen')
const gezakt = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
console.log(gezakt.length ? `GEZAKT: ${gezakt.join(', ')}` : 'ALLE CHECKS OK')
console.log('Screenshots in .verify-shots/')
await browser.close()
