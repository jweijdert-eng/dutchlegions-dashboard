import { chromium } from 'playwright-core'
const APP=`http://localhost:${process.env.PORT??8081}`
const b=await chromium.launch({channel:'msedge',headless:true})
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const ctx=await b.newContext({viewport:{width:1100,height:900},deviceScaleFactor:2})
await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'f',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:1831618559,characterName:'Desk Tester'}])))
// Mining ledger: Veldspar (1230), Scordite (1228) in Jita (30000142)
await ctx.route('**/characters/1831618559/mining/**', r=>r.fulfill(J([
  {date:'2026-06-13',type_id:1230,solar_system_id:30000142,quantity:500000},
  {date:'2026-06-13',type_id:1228,solar_system_id:30000142,quantity:300000},
  {date:'2026-06-12',type_id:1230,solar_system_id:30000142,quantity:200000},
])))
await ctx.route('**/universe/names/**', r=>{const ids=JSON.parse(r.request().postData()||'[]');const nm={1230:'Veldspar',1228:'Scordite',30000142:'Jita'};return r.fulfill(J(ids.map(id=>({id,name:nm[id]??`X ${id}`,category:'x'}))))})
// Fuzzwork market aggregates (erts + mineralen)
await ctx.route('**market.fuzzwork.co.uk/aggregates/**', r=>{
  const url=new URL(r.request().url()); const types=(url.searchParams.get('types')||'').split(',').filter(Boolean)
  const price={1230:15,1228:25,34:6,35:12,1228000:0}; // Tritanium 34, Pyerite 35
  const out={}; for(const t of types) out[t]={buy:{max:price[t]??4},sell:{min:(price[t]??4)*1.2}}
  return r.fulfill(J(out))
})
await ctx.route('**images.evetech.net/**', r=>r.fulfill({status:200,headers:{'access-control-allow-origin':'*'},body:''}))
const page=await ctx.newPage()
await page.goto(`${APP}/mining`,{waitUntil:'networkidle'}).catch(()=>{})
await page.waitForTimeout(2000)
const t=await page.locator('body').innerText()
console.log('MINING: Veldspar?', t.includes('Veldspar'))
console.log('MINING: erts ISK in header?', /erts ~/.test(t))
console.log('MINING: gerefined ISK in header?', /gerefined ~/.test(t))
await page.screenshot({path:'.verify-shots/mining-refined.png',fullPage:true})
await b.close()
