import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 700, height: 700 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken:'f', refreshToken:'f', expiresAt:Date.now()+7200000, characterId:90000001, characterName:'Tester' }])))
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const future = new Date(Date.now()+3*86400000).toISOString()
const pins = [
  { pin_id:1, type_id:2254, latitude:0.2, longitude:0.2 },                                   // cmd center
  { pin_id:2, type_id:2848, latitude:0.5, longitude:0.3, expiry_time:future, extractor_details:{ product_type_id:2268, qty_per_cycle:1200, cycle_time:3600, heads:[{head_id:0,latitude:0.55,longitude:0.32}] } }, // extractor
  { pin_id:3, type_id:2481, latitude:0.3, longitude:0.6, schematic_id:127 },                 // basic factory
  { pin_id:4, type_id:2480, latitude:0.6, longitude:0.6, schematic_id:128 },                 // advanced factory
  { pin_id:5, type_id:2542, latitude:0.4, longitude:0.45 },                                  // launchpad
  { pin_id:6, type_id:2541, latitude:0.5, longitude:0.5 },                                   // storage
]
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  if (p.match(/\/characters\/\d+\/planets\/$/)) return route.fulfill(J([
    { planet_id:5001, solar_system_id:30000142, planet_type:'temperate', owner_id:90000001, upgrade_level:4, num_pins:6, last_update:new Date(Date.now()-3600000).toISOString() }
  ]))
  if (p.match(/\/characters\/\d+\/planets\/5001\/$/)) return route.fulfill(J({ pins, links:[], routes:[] }))
  if (p.match(/\/universe\/schematics\/\d+\//)) return route.fulfill(J({ schematic_name:'Test', cycle_time:1800, pins:[{type_id:3683,is_input:false,quantity:5}] }))
  if (p.includes('/universe/names/')) { const ids=JSON.parse(route.request().postData()||'[]'); return route.fulfill(J(ids.map(id=>({id,name:`Name ${id}`,category:'inventory_type'})))) }
  return route.fulfill(J([]))
})
ctx.route('**images.evetech.net/**', r => r.fulfill({ status:404, headers:{'access-control-allow-origin':'*'}, body:'' }))
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/planets`, { waitUntil:'networkidle' }).catch(()=>{})
await page.waitForTimeout(2500)
const card = page.locator('text=Temperate').first()
console.log('kolonie zichtbaar:', await card.isVisible().catch(()=>false))
console.log('aantal pin-labels:', await page.locator('text=/Cmd Center|Extractor|Basic|Advanced|Launchpad|Storage/').count())
await page.screenshot({ path: '.verify-shots/planets-icons.png' })
await browser.close()
