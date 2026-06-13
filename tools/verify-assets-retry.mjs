import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now()+7200000, characterId: 90000001, characterName: 'Desk Tester' }])))
const J = (o) => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(o) })
const FAIL503 = { status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'overloaded' }
const seen = {}  // faal elke unieke pathname één keer
function once(p, ok) { if (!seen[p]) { seen[p] = 1; return FAIL503 } return ok }
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  if (p.includes('/assets/locations/')) return route.fulfill(J([]))
  if (p.includes('/assets/names/'))     return route.fulfill(J([]))
  if (p.match(/\/characters\/\d+\/assets\/$/)) return route.fulfill(J([
    { item_id: 1001, type_id: 34, location_id: 60003760, location_flag: 'Hangar', location_type: 'station', quantity: 100, is_singleton: false },
  ]))
  if (p.includes('/characters/90000001/location/')) return route.fulfill(J({ solar_system_id: 30000142 }))
  if (p.includes('/universe/names/'))            return route.fulfill(once(p, J([{ id: 34, name: 'Tritanium', category: 'inventory_type' }, { id: 60003760, name: 'Jita IV - Moon 4 - CNAP', category: 'station' }])))
  if (p.includes('/universe/stations/60003760/')) return route.fulfill(once(p, J({ name: 'Jita IV - Moon 4 - CNAP', system_id: 30000142 })))
  if (p.includes('/universe/systems/30000142/'))  return route.fulfill(once(p, J({ name: 'Jita', security_status: 0.9459, constellation_id: 20000020 })))
  if (p.includes('/universe/constellations/'))    return route.fulfill(once(p, J({ name: 'Kimotoro', region_id: 10000002 })))
  if (p.includes('/universe/regions/'))           return route.fulfill(once(p, J({ name: 'The Forge' })))
  return route.fulfill(J([]))
})
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/assets`, { waitUntil: 'networkidle' }).catch(()=>{})
await page.waitForTimeout(4000)
const body = await page.locator('body').innerText()
console.log('naam "Jita IV - Moon 4 - CNAP" zichtbaar (geen rauw ID):', body.includes('Jita IV - Moon 4 - CNAP'))
console.log('GEEN rauw ID "60003760":', !body.includes('60003760'))
console.log('security "0.9" zichtbaar (ondanks 503 op 1e poging):', body.includes('0.9'))
await browser.close()
