import { chromium } from 'playwright-core'
const APP=`http://localhost:${process.env.PORT??8081}`
const b=await chromium.launch({channel:'msedge',headless:true})
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const ctx=await b.newContext({viewport:{width:1300,height:900},deviceScaleFactor:2})
await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'f',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Desk Tester'}])))
await ctx.route('**/characters/90000001/**', r=>r.fulfill(J([])))
// Assets in Jita 4-4 (60003760): 1M Tritanium (0.01 m³) + 50k Veldspar (0.1 m³) = 15.000 m³
// (na de catch-all geregistreerd → Playwright geeft deze voorrang)
await ctx.route('**/characters/90000001/assets/**', r=>r.fulfill(J([
  {item_id:1001,type_id:34,quantity:1000000,location_id:60003760,location_type:'station',location_flag:'Hangar',is_singleton:false},
  {item_id:1002,type_id:1230,quantity:50000,location_id:60003760,location_type:'station',location_flag:'Hangar',is_singleton:false},
])))
await ctx.route('**/universe/names/**', r=>{const ids=JSON.parse(r.request().postData()||'[]');const nm={34:'Tritanium',1230:'Veldspar',60003760:'Jita IV - Moon 4 - Caldari Navy Assembly Plant'};return r.fulfill(J(ids.map(id=>({id,name:nm[id]??`X ${id}`,category:'x'}))))})
await ctx.route('**images.evetech.net/**', r=>r.fulfill({status:200,headers:{'access-control-allow-origin':'*'},body:''}))
const page=await ctx.newPage()
await page.goto(`${APP}/assets`,{waitUntil:'networkidle'}).catch(()=>{})
await page.waitForTimeout(2000)
const t=await page.locator('body').innerText()
console.log('ASSETS: Jita-station via bundel?', /Jita/.test(t))
console.log('ASSETS: m³ totaal zichtbaar?', /m³/.test(t))
console.log('ASSETS: ~15.0k m³?', /15\.0k m³/.test(t))
await page.screenshot({path:'.verify-shots/assets-m3.png',fullPage:true})
await b.close()
