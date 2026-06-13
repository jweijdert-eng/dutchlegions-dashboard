// Verifieert de mobiele layout: drawer-sidebar + ingeklapte grids op de
// Hauling-tab (heeft 4-koloms cards + grafiek + tabel), iPhone-viewport.
import { chromium, devices } from 'playwright-core'

const APP = 'http://localhost:8081'
const CHAR_ID = 90000001
const JITA = 60003760, AMARR = 60008494
const day = (n, h = 12) => new Date(Date.now() - n * 86400_000 - h * 3600_000).toISOString()

const contracts = [
  { contract_id: 1, type: 'courier', status: 'finished', availability: 'public', for_corporation: false, issuer_id: 91000001, acceptor_id: CHAR_ID, price: 0, reward: 18_000_000, collateral: 3e8, volume: 12000, date_issued: day(5), date_expired: day(-5), date_completed: day(0, 4), start_location_id: JITA, end_location_id: AMARR },
  { contract_id: 2, type: 'courier', status: 'finished', availability: 'public', for_corporation: false, issuer_id: 91000001, acceptor_id: CHAR_ID, price: 0, reward: 40_000_000, collateral: 1.2e9, volume: 320000, date_issued: day(3), date_expired: day(-5), date_completed: day(1, 6), start_location_id: AMARR, end_location_id: JITA },
]

const iphone = devices['iPhone 13']
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ ...iphone })
await ctx.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 7200_000, characterId: charId, characterName: 'Mobile Tester' }]))
}, { charId: CHAR_ID })
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
await ctx.route(`**/characters/${CHAR_ID}/contracts/**`, route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors })
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(contracts) })
})

const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/hauling`, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForSelector('text=VOLTOOIDE HAULS', { timeout: 15000 })
await page.waitForTimeout(2000)

console.log('Viewport:', page.viewportSize())
// Geen horizontale page-overflow?
const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
console.log('scrollWidth', overflow.sw, 'clientWidth', overflow.cw, overflow.sw <= overflow.cw + 1 ? 'OK geen overflow' : 'OVERFLOW!')

// Sidebar mag niet zichtbaar zijn (drawer dicht): hamburger wel
const hamburger = await page.locator('button[aria-label="Menu openen"]').count()
console.log('Hamburger zichtbaar:', hamburger === 1)
const navVisible = await page.locator('nav a:has-text("Dashboard")').first().isVisible().catch(() => false)
console.log('Nav-links zichtbaar met drawer dicht:', navVisible, navVisible ? '(zou false moeten zijn)' : 'OK verborgen')

// Grid moet 2 koloms zijn (cols) — meet x-posities van de 4 cards
const cardCols = await page.evaluate(() => {
  const label = [...document.querySelectorAll('div')].find(d => d.textContent === 'TOTAAL VERDIEND')
  const grid = label?.closest('div[style*="grid"]')
  if (!grid) return null
  const xs = [...grid.children].map(c => Math.round(c.getBoundingClientRect().left))
  return [...new Set(xs)].length
})
console.log('Card-kolommen (unieke x):', cardCols, cardCols === 2 ? 'OK 2 koloms' : '')

await page.screenshot({ path: '.verify-shots/mobile-closed.png', fullPage: true })

// Open drawer
await page.click('button[aria-label="Menu openen"]')
await page.waitForTimeout(500)
const navAfter = await page.locator('nav a:has-text("Hauling")').first().isVisible().catch(() => false)
console.log('Drawer open → nav zichtbaar:', navAfter, navAfter ? 'OK' : 'FOUT')
await page.screenshot({ path: '.verify-shots/mobile-drawer.png' })

// Navigeer via drawer → moet sluiten
await page.click('nav a:has-text("Ratting")')
await page.waitForTimeout(700)
const drawerClosed = !(await page.locator('nav a:has-text("Hauling")').first().isVisible().catch(() => false))
console.log('Na navigatie drawer dicht:', drawerClosed, drawerClosed ? 'OK' : 'FOUT')
console.log('URL na nav:', new URL(page.url()).pathname)

await browser.close()
console.log('Screenshots: mobile-closed.png, mobile-drawer.png')
