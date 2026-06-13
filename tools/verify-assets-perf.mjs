import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken:'f', refreshToken:'f', expiresAt:Date.now()+7200000, characterId:90000001, characterName:'Desk Tester' }])))
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const STRUCT = 1035000000001
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  if (p.includes('/assets/locations/')||p.includes('/assets/names/')) return route.fulfill(J([]))
  if (p.match(/\/characters\/\d+\/assets\/$/)) return route.fulfill(J(
    Array.from({length:30},(_,i)=>({ item_id:100+i, type_id:34, location_id:STRUCT, location_flag:'Hangar', location_type:'other', quantity:1, is_singleton:false }))
  ))
  if (p.includes('/characters/90000001/location/')) return route.fulfill(J({ solar_system_id:30000142 }))
  if (p.includes('/universe/names/')) { const ids=JSON.parse(route.request().postData()||'[]'); return route.fulfill(J(ids.map(id=>({id,name:`Loc ${id}`,category:'station'})))) }
  if (p.includes(`/universe/structures/${STRUCT}/`)) return route.fulfill({ status:403, headers:{'access-control-allow-origin':'*'}, body:'forbidden' })
  return route.fulfill(J([]))
})
const page = await ctx.newPage()
let n1=0; const h1 = r => { if (new URL(r.url()).pathname.includes(`/universe/structures/${STRUCT}/`)) n1++ }
page.on('request', h1)
await page.goto(`${APP}/assets`, { waitUntil:'networkidle' }).catch(()=>{})
await page.waitForTimeout(2500)
console.log('1e load — structure-calls voor 30 items in 1 citadel:', n1, '(verwacht klein, niet ~30)')
page.off('request', h1)
let n2=0; page.on('request', r => { if (new URL(r.url()).pathname.includes(`/universe/structures/${STRUCT}/`)) n2++ })
await page.reload({ waitUntil:'networkidle' }).catch(()=>{})
await page.waitForTimeout(2500)
console.log('2e load (na herlaad) — structure-calls:', n2, '(verwacht 0 = overgeslagen via cache)')
await browser.close()
