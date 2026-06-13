import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now() + 7200000, characterId: 1831618559, characterName: 'Desk Tester' }])))
await ctx.route('**/characters/1831618559/**', r => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '[]' }))
const page = await ctx.newPage()
const ws = []
page.on('websocket', w => ws.push(w.url()))
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/`, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForTimeout(1500)
console.log('widget "LOCAL CHAT" zichtbaar:', await page.locator('text=LOCAL CHAT').first().isVisible().catch(() => false))
console.log('idle-tekst aanwezig:', await page.locator('text=Klik om Local in te stellen').isVisible().catch(() => false))
console.log('WebSocket-pogingen naar :8765 (verwacht: geen):', JSON.stringify(ws.filter(u => u.includes('8765'))))
await browser.close()
