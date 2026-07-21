import { chromium } from 'playwright-core'
const APP='http://localhost:8090'
const json=body=>({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify(body)})
async function run(role){
  const b=await chromium.launch({channel:'msedge',headless:true})
  const ctx=await b.newContext({viewport:{width:1440,height:900}})
  await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'fake',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Tester'}])))
  await ctx.route('**/api/*.php',r=>r.fulfill(json({})))
  await ctx.route('**esi.evetech.net/**',r=>r.fulfill(json([])))
  await ctx.route('**/characters/*/contracts/**',r=>r.fulfill(json([])))
  await ctx.route('**/api/roles.php**',r=>r.fulfill(json({me:role})))
  const p=await ctx.newPage()
  await p.goto(`${APP}/hauling`,{waitUntil:'domcontentloaded'}).catch(()=>{})
  await p.waitForSelector('text=Hauling',{timeout:20000}).catch(()=>{})
  await p.waitForTimeout(1200)
  const btn=await p.locator('button:has-text("Voorbeeld")').count()
  console.log(`  rol=${role}: knop aanwezig=${btn>0}`)
  await b.close()
  return btn>0
}
const member=await run('member')
const admin=await run('admin')
console.log('  OK member ziet GEEN knop:', member===false)
console.log('  OK admin ziet WEL knop:', admin===true)
