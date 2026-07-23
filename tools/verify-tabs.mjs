// Live-verificatie: het verbergen van een tab via Settings → ☰ Tabbladen werkt
// door in de zijbalk (gegroepeerde nav). Token wordt gefaket; /api-calls gemockt
// zodat de standaard-menu-indeling laadt.
import { chromium } from 'playwright-core'
import fs from 'fs'

const APP = 'http://localhost:8081'
const CHAR_ID = 90000001
const SHOT = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
fs.mkdirSync(SHOT, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
await ctx.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{
    accessToken: 'fake-test-token', refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 7200_000, characterId: charId, characterName: 'Verify Tester',
  }]))
}, { charId: CHAR_ID })
// Alleen de PHP-endpoints mocken (niet de /src/api/*-modules!) → standaard-menu laadt
await ctx.route('**/api/*.php', r => r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '{}' }))

const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))

console.log('--- Settings laden (sidebar + tab-toggles) ---')
await page.goto(`${APP}/settings`, { waitUntil: 'domcontentloaded' }).catch(() => {})
await page.waitForSelector('text=☰ Tabbladen', { timeout: 20000 })
await page.waitForTimeout(800)

const sideMining = () => page.locator('a[href="/mining"]').count()
console.log('Sidebar-link /mining vóór :', await sideMining())
await page.screenshot({ path: SHOT + 'tabs-before.png' })

console.log('--- Mining-toggle uitzetten in Settings ---')
const toggle = page.locator('xpath=//span[contains(., "Mining")]/following-sibling::button[@role="switch"]').first()
console.log('Toggle gevonden:', await toggle.count())
await toggle.click()
await page.waitForTimeout(700)
console.log('Sidebar-link /mining ná verbergen:', await sideMining())
await page.screenshot({ path: SHOT + 'tabs-after.png' })

console.log('--- Mining-toggle weer aanzetten ---')
await toggle.click()
await page.waitForTimeout(700)
console.log('Sidebar-link /mining na weer-aan:', await sideMining())

// Controle: hidden-tab in localStorage
const hidden = await page.evaluate(() => JSON.parse(localStorage.getItem('eve_member_settings') || '{}').hiddenTabs)
console.log('hiddenTabs in localStorage (eindstand):', JSON.stringify(hidden))

await browser.close()
console.log('Screenshots in', SHOT)
