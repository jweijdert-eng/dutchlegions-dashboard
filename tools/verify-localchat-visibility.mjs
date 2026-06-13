import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })

async function check(label, charId, settingsBody) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(cid => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken:'f', refreshToken:'f', expiresAt:Date.now()+7200000, characterId:cid, characterName:'Tester' }])), charId)
  await ctx.route('**/characters/*/**', r => r.fulfill({ status:200, headers:{'access-control-allow-origin':'*'}, body:'[]' }))
  await ctx.route('**/api/settings.php', r => r.fulfill({ status:200, headers:{'content-type':'application/json'}, body: settingsBody }))
  const page = await ctx.newPage()
  await page.goto(`${APP}/`, { waitUntil:'networkidle' }).catch(()=>{})
  await page.waitForTimeout(1200)
  const local = await page.locator('nav a[href="/local"]').count()
  const admin = await page.locator('nav a[href="/admin"]').count()
  console.log(`${label}: Local Chat link=${local>0}, Admin link=${admin>0}`)
  await ctx.close()
}

await check('member, setting default (geen key)', 90000001, '{}')
await check('member, setting UIT', 90000001, '{"local_chat":false}')
await check('member, setting AAN', 90000001, '{"local_chat":true}')
await check('admin, setting UIT', 1831618559, '{"local_chat":false}')
await browser.close()
