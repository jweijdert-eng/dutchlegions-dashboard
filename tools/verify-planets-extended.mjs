import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([
  { accessToken:'f', refreshToken:'f', expiresAt:Date.now()+7200000, characterId:90000001, characterName:'Pilot Alpha' },
  { accessToken:'g', refreshToken:'g', expiresAt:Date.now()+7200000, characterId:90000002, characterName:'Pilot Bravo' },
])))
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const soonExpiry = new Date(Date.now()+6*3600000).toISOString()   // binnen 12u → waarschuwing
const farExpiry  = new Date(Date.now()+3*86400000).toISOString()  // ruim → geen waarschuwing

// Aqueous Liquids (2268, P0) → wordt verbruikt door fabriek → niet "final".
// Fabriek-output 3683 (P1) → final product. Launchpad bevat 3683 als voorraad.
const pins = [
  { pin_id:1, type_id:2254, latitude:0.2, longitude:0.2 },                                   // cmd center
  { pin_id:2, type_id:2848, latitude:0.5, longitude:0.3, expiry_time:soonExpiry, extractor_details:{ product_type_id:2268, qty_per_cycle:1200, cycle_time:3600, heads:[{head_id:0,latitude:0.55,longitude:0.32}] } }, // extractor
  { pin_id:3, type_id:2481, latitude:0.3, longitude:0.6, schematic_id:127 },                 // basic factory → output 3683
  { pin_id:4, type_id:2542, latitude:0.4, longitude:0.45, contents:[{ type_id:3683, amount:5000 }] }, // launchpad met voorraad
]
const routes = [
  { route_id:1, source_pin_id:2, destination_pin_id:3, content_type_id:2268, quantity:1200 },
  { route_id:2, source_pin_id:3, destination_pin_id:4, content_type_id:3683, quantity:20 },
]
const links = [
  { source_pin_id:1, destination_pin_id:2, link_level:0 },
  { source_pin_id:1, destination_pin_id:3, link_level:0 },
  { source_pin_id:3, destination_pin_id:4, link_level:0 },
]

await ctx.route('**market.fuzzwork.co.uk/aggregates/**', route => {
  const ids = new URL(route.request().url()).searchParams.get('types')?.split(',') ?? []
  const out = {}
  for (const id of ids) out[id] = { buy:{ max: 500 }, sell:{ min: 600 } }
  return route.fulfill(J(out))
})
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  // char 1 = kolonie die binnenkort verloopt; char 2 = kolonie die ruim loopt
  if (p.match(/\/characters\/90000001\/planets\/$/)) return route.fulfill(J([
    { planet_id:5001, solar_system_id:30000142, planet_type:'temperate', owner_id:90000001, upgrade_level:5, num_pins:4, last_update:new Date(Date.now()-3600000).toISOString() }
  ]))
  if (p.match(/\/characters\/90000002\/planets\/$/)) return route.fulfill(J([
    { planet_id:5002, solar_system_id:30000142, planet_type:'barren', owner_id:90000002, upgrade_level:3, num_pins:4, last_update:new Date(Date.now()-3600000).toISOString() }
  ]))
  if (p.match(/\/characters\/90000001\/planets\/5001\/$/)) return route.fulfill(J({ pins, links, routes }))
  if (p.match(/\/characters\/90000002\/planets\/5002\/$/)) return route.fulfill(J({
    pins: pins.map(pn => pn.pin_id===2 ? { ...pn, expiry_time:farExpiry } : pn), links, routes,
  }))
  if (p.match(/\/universe\/schematics\/\d+\//)) return route.fulfill(J({ schematic_name:'Bacteria', cycle_time:1800, pins:[{type_id:2268,is_input:true,quantity:3000},{type_id:3683,is_input:false,quantity:5}] }))
  if (p.includes('/universe/names/')) { const ids=JSON.parse(route.request().postData()||'[]'); return route.fulfill(J(ids.map(id=>({id,name:`Item ${id}`,category:'inventory_type'})))) }
  return route.fulfill(J([]))
})

const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/planets`, { waitUntil:'networkidle' }).catch(()=>{})
await page.waitForTimeout(3000)

const txt = async (sel) => (await page.locator(sel).first().textContent().catch(()=>''))?.trim() ?? ''
const has = async (re) => await page.locator(`text=${re}`).count()

console.log('kolonies zichtbaar (Temperate/Barren):', await page.locator('text=/Temperate|Barren/').count())
console.log('— Summary —')
console.log('  StatCard OPGESLAGEN WAARDE:', await has('/OPGESLAGEN WAARDE/'))
console.log('  StatCard PRODUCTIE / UUR  :', await has('/PRODUCTIE/'))
console.log('  StatCard VERLOOPT BINNENKORT:', await has('/VERLOOPT BINNENKORT/'))
console.log('  ISK-waardes op pagina     :', await page.locator('text=/ISK/').count())
console.log('— Waarschuwing —')
console.log('  banner "loopt/lopen binnenkort leeg":', await has('/binnenkort leeg/'))
console.log('— Productie-output —')
console.log('  "/u" output-rijen          :', await page.locator('text=/\\/u/').count())
console.log('  Output-label                :', await has('/Output/'))
console.log('— Controls —')
console.log('  filter knoppen (Alle/Actief/Verlopen):', await page.locator('button:has-text("Alle"), button:has-text("Actief"), button:has-text("Verlopen")').count())
console.log('  sort knoppen (Verloop/Waarde/Output/Char/Systeem):', await page.locator('button:has-text("Verloop"), button:has-text("Waarde"), button:has-text("Output"), button:has-text("Char"), button:has-text("Systeem")').count())

// Test filter: klik "Verlopen" → 0 kolonies (beide actief)
await page.locator('button:has-text("Verlopen")').first().click().catch(()=>{})
await page.waitForTimeout(400)
console.log('  na klik Verlopen → "Geen kolonies in dit filter":', await has('/Geen kolonies in dit filter/'))
await page.locator('button:has-text("Alle")').first().click().catch(()=>{})
await page.waitForTimeout(400)

await page.screenshot({ path: '.verify-shots/planets-extended.png', fullPage:true })
console.log('screenshot: .verify-shots/planets-extended.png')
await browser.close()
