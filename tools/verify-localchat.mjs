// Verifieert de in-browser Local Chat (File System Access API i.p.v. WebSocket-server):
// - pagina rendert zonder te crashen / zonder ws://localhost:8765
// - in 'idle' toont 'ie de "Kies Chatlogs-map"-knop
import { chromium } from 'playwright-core'

const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 1831618559, characterName: 'Desk Tester' }])))
await ctx.route('**/characters/1831618559/**', r => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '[]' }))

const page = await ctx.newPage()
const wsAttempts = []
page.on('websocket', ws => wsAttempts.push(ws.url()))
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))

await page.goto(`${APP}/local`, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForTimeout(1200)

const btn = page.locator('button:has-text("Kies Chatlogs-map")')
console.log('"Kies Chatlogs-map"-knop zichtbaar:', await btn.isVisible().catch(() => false))
console.log('status-label:', await page.locator('text=/Niet verbonden|Live|Geen logbestand|Toegang nodig/').first().textContent().catch(() => '—'))
console.log('hint Documents\\EVE\\logs\\Chatlogs aanwezig:', await page.locator('text=Documents').first().isVisible().catch(() => false))
console.log('WebSocket-pogingen (verwacht: leeg):', JSON.stringify(wsAttempts))
console.log('showDirectoryPicker beschikbaar:', await page.evaluate(() => 'showDirectoryPicker' in window))

await page.screenshot({ path: '.verify-shots/localchat-idle.png' })
await browser.close()
console.log('Screenshot: localchat-idle.png')
