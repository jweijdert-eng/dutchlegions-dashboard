import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken:'f', refreshToken:'f', expiresAt:Date.now()+7200000, characterId:90000001, characterName:'Desk Tester' }])))
const J = (o) => ({ status:200, headers:{'access-control-allow-origin':'*','content-type':'application/json'}, body:JSON.stringify(o) })
// 4 stations, elk in een systeem met andere security
const SYS = { 60003760:[30000001,0.9], 60003761:[30000002,0.5], 60003762:[30000003,0.2], 60003763:[30000004,-0.4] }
await ctx.route('**esi.evetech.net/**', route => {
  const p = new URL(route.request().url()).pathname
  if (p.includes('/assets/locations/')||p.includes('/assets/names/')) return route.fulfill(J([]))
  if (p.match(/\/characters\/\d+\/assets\/$/)) return route.fulfill(J(
    Object.keys(SYS).map((st,i)=>({ item_id:1+i, type_id:34, location_id:+st, location_flag:'Hangar', location_type:'station', quantity:1, is_singleton:false }))
  ))
  if (p.includes('/characters/90000001/location/')) return route.fulfill(J({ solar_system_id:30000001 }))
  if (p.includes('/universe/names/')) { const ids=JSON.parse(route.request().postData()||'[]'); return route.fulfill(J(ids.map(id=>({id,name:`Loc ${id}`,category:'station'})))) }
  const st=p.match(/\/universe\/stations\/(\d+)\//); if (st) { const id=+st[1]; return route.fulfill(J({ name:`Station ${id}`, system_id:SYS[id][0] })) }
  const sy=p.match(/\/universe\/systems\/(\d+)\//); if (sy) { const id=+sy[1]; const e=Object.values(SYS).find(v=>v[0]===id); return route.fulfill(J({ name:`Sys ${id}`, security_status:e[1], constellation_id:1 })) }
  return route.fulfill(J([]))
})
const page = await ctx.newPage()
await page.goto(`${APP}/assets`, { waitUntil:'networkidle' }).catch(()=>{})
await page.waitForTimeout(2500)
const colors = await page.evaluate(() => {
  const out = {}
  document.querySelectorAll('span').forEach(s => { if (/^-?\d\.\d$/.test(s.textContent.trim())) out[s.textContent.trim()] = getComputedStyle(s).color })
  return out
})
const exp = { '0.9':'rgb(72, 240, 192)', '0.5':'rgb(239, 239, 0)', '0.2':'rgb(240, 72, 0)', '-0.4':'rgb(240, 0, 0)' }
for (const [k,v] of Object.entries(exp)) console.log(`security ${k}: ${colors[k]===v ? 'OK ('+v+')' : 'FOUT — kreeg '+colors[k]+', verwacht '+v}`)
await browser.close()
