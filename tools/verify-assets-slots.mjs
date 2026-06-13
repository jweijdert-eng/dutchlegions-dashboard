import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken:'f', refreshToken:'f', expiresAt:Date.now()+7200000, characterId:90000001, characterName:'Desk Tester' }])))
const J = (o) => ({ status:200, headers:{'access-control-allow-origin':'*','content-type':'application/json'}, body:JSON.stringify(o) })
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  if (p.includes('/assets/locations/')||p.includes('/assets/names/')) return route.fulfill(J([]))
  if (p.match(/\/characters\/\d+\/assets\/$/)) return route.fulfill(J([
    { item_id:1, type_id:587, location_id:60003760, location_flag:'Hangar',  location_type:'station', quantity:1, is_singleton:true },   // schip in hangar -> tonen
    { item_id:2, type_id:34,  location_id:60003760, location_flag:'Hangar',  location_type:'station', quantity:99, is_singleton:false },  // los item -> tonen
    { item_id:3, type_id:2456,location_id:1,         location_flag:'HiSlot0', location_type:'item',    quantity:1, is_singleton:false },   // gefit -> verbergen
    { item_id:4, type_id:2457,location_id:1,         location_flag:'MedSlot1',location_type:'item',    quantity:1, is_singleton:false },   // gefit -> verbergen
    { item_id:5, type_id:2458,location_id:1,         location_flag:'LoSlot2', location_type:'item',    quantity:1, is_singleton:false },   // gefit -> verbergen
    { item_id:6, type_id:31177,location_id:1,        location_flag:'RigSlot0',location_type:'item',    quantity:1, is_singleton:false },   // gefit -> verbergen
  ]))
  if (p.includes('/characters/90000001/location/')) return route.fulfill(J({ solar_system_id:30000142 }))
  if (p.includes('/universe/names/')) { const ids=JSON.parse(route.request().postData()||'[]'); return route.fulfill(J(ids.map(id=>({id,name:`Name ${id}`,category:'station'})))) }
  if (p.includes('/universe/stations/60003760/')) return route.fulfill(J({ name:'Jita IV - Moon 4 - CNAP', system_id:30000142 }))
  if (p.includes('/universe/systems/30000142/')) return route.fulfill(J({ name:'Jita', security_status:0.9459, constellation_id:20000020 }))
  return route.fulfill(J([]))
})
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/assets`, { waitUntil:'networkidle' }).catch(()=>{})
await page.waitForTimeout(2500)
// klap de locatie open zodat de items zichtbaar zijn
await page.locator('text=Jita IV - Moon 4 - CNAP').click().catch(()=>{})
await page.waitForTimeout(500)
const body = await page.locator('body').innerText()
console.log('GEEN "Hi Slot":', !body.includes('Hi Slot'))
console.log('GEEN "Med Slot":', !body.includes('Med Slot'))
console.log('GEEN "Lo Slot":', !body.includes('Lo Slot'))
console.log('GEEN "Rig Slot":', !body.includes('Rig Slot'))
console.log('header toont nog items (Jita aanwezig):', body.includes('Jita'))
console.log('item-count in header:', (body.match(/(\d+) items/)||[])[0])
await browser.close()
