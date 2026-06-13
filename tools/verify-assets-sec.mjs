import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now()+7200000, characterId: 90000001, characterName: 'Desk Tester' }])))
const J = (o) => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(o) })
const FAIL = { status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'boom' }
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  if (p.includes('/assets/locations/')) return route.fulfill(J([]))
  if (p.includes('/assets/names/'))     return route.fulfill(J([]))
  if (p.match(/\/characters\/\d+\/assets\/$/)) return route.fulfill(J([
    { item_id: 1001, type_id: 34, location_id: 60003760, location_flag: 'Hangar', location_type: 'station', quantity: 100, is_singleton: false },
    { item_id: 1002, type_id: 34, location_id: 1035000000001, location_flag: 'Hangar', location_type: 'other', quantity: 50, is_singleton: false },
  ]))
  if (p.includes('/characters/90000001/location/')) return route.fulfill(J({ solar_system_id: 30000142 }))
  if (p.includes('/universe/names/')) return route.fulfill(J([{ id: 34, name: 'Tritanium', category: 'inventory_type' }]))
  if (p.includes('/universe/structures/1035000000001/')) return route.fulfill(J({ name: 'NP-7PZ - 13', solar_system_id: 30004759, type_id: 35834 }))
  if (p.includes('/universe/stations/60003760/')) return route.fulfill(J({ name: 'Jita IV - Moon 4 - CNAP', system_id: 30000142 }))
  if (p.includes('/universe/systems/30000142/')) return route.fulfill(J({ name: 'Jita', security_status: 0.9459, constellation_id: 20000020 }))
  if (p.includes('/universe/systems/30004759/')) return route.fulfill(J({ name: '319-3D', security_status: -0.41, constellation_id: 20000999 }))
  if (p.includes('/universe/constellations/')) return route.fulfill(FAIL)   // <-- faalt bewust
  if (p.includes('/universe/regions/'))        return route.fulfill(FAIL)
  return route.fulfill(J([]))
})
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/assets`, { waitUntil: 'networkidle' }).catch(()=>{})
await page.waitForTimeout(2500)
const body = await page.locator('body').innerText()
console.log('Jita highsec "0.9" zichtbaar:', body.includes('0.9'))
console.log('nullsec citadel "NP-7PZ - 13" zichtbaar:', body.includes('NP-7PZ - 13'))
console.log('nullsec security "-0.4" zichtbaar (ondanks falende constellation):', body.includes('-0.4'))
console.log('GEEN misleidende "0.1":', !body.includes('0.1'))
await page.screenshot({ path: '.verify-shots/assets-sec.png' })
await browser.close()
