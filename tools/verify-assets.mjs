import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now()+7200000, characterId: 90000001, characterName: 'Desk Tester' }])))
await ctx.route('**/characters/90000001/**', r => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '[]' }))
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(e.message))
await page.goto(`${APP}/assets`, { waitUntil: 'networkidle' }).catch(()=>{})
await page.waitForTimeout(1500)
console.log('titel "Assets" zichtbaar:', await page.locator('text=Assets').first().isVisible().catch(()=>false))
console.log('rendert (geen lege body):', (await page.locator('body').innerText()).includes('Assets'))
console.log('page errors:', JSON.stringify(errs))
await browser.close()
