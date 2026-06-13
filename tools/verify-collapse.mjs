// Verifieert de inklapbare desktop-sidebar: breedte krimpt, labels verdwijnen,
// icoontjes blijven, voorkeur blijft bewaard (localStorage), uitklappen herstelt.
import { chromium } from 'playwright-core'

const APP = 'http://localhost:8081'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 90000001, characterName: 'Desk Tester' }])))
await ctx.route('**/characters/90000001/**', r => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '[]' }))
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/hauling`, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForSelector('nav a:has-text("Dashboard")', { timeout: 15000 })
await page.waitForTimeout(800)

const navW = () => page.evaluate(() => Math.round(document.querySelector('nav').getBoundingClientRect().width))
const labelVisible = () => page.locator('nav a:has-text("Hauling") span', { hasText: 'Hauling' }).first().isVisible().catch(() => false)

console.log('start breedte:', await navW(), '(verwacht 200)')
console.log('label "Hauling" zichtbaar:', await labelVisible())
await page.screenshot({ path: '.verify-shots/desktop-expanded.png' })

await page.click('button[aria-label="Menu inklappen"]')
await page.waitForTimeout(500)
console.log('na inklappen breedte:', await navW(), '(verwacht 58)')
console.log('label "Hauling" zichtbaar:', await labelVisible(), '(verwacht false)')
console.log('iconen nog aanwezig:', await page.locator('nav a').count(), 'nav-links')
await page.screenshot({ path: '.verify-shots/desktop-collapsed.png' })

// Reload → voorkeur bewaard?
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(800)
console.log('na reload breedte:', await navW(), '(verwacht 58 = onthouden)')

await page.click('button[aria-label="Menu uitklappen"]')
await page.waitForTimeout(500)
console.log('na uitklappen breedte:', await navW(), '(verwacht 200)')
console.log('label "Hauling" weer zichtbaar:', await labelVisible())

await browser.close()
console.log('Screenshots: desktop-expanded.png, desktop-collapsed.png')
