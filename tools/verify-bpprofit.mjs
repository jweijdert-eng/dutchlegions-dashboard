import { chromium } from 'playwright-core'
import fs from 'fs'
const APP='http://localhost:8081'
const SHOT=new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/,'$1'); fs.mkdirSync(SHOT,{recursive:true})
const FEED={ok:true,me:10,aantal:3,bijgewerkt:new Date().toISOString(),rows:[
  {product_id:2048,product:'Damage Control I',output:1,matcost:12000,jobfee:800,sellval:38000,profit:25200,per_unit:25200,margin:196.9,sell:40000,volume:5400},
  {product_id:24483,product:'Capital Fusion Thruster',output:1,matcost:3200000,jobfee:120000,sellval:5600000,profit:2280000,per_unit:2280000,margin:68.7,sell:5900000,volume:13986},
  {product_id:31,product:'Test lage marge',output:1,matcost:1000000,jobfee:5000,sellval:1030000,profit:25000,per_unit:25000,margin:2.5,sell:1050000,volume:3},
]}
const b=await chromium.launch({channel:'msedge',headless:true})
const ctx=await b.newContext({viewport:{width:1400,height:900}})
await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'fake',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Verify Tester'}])))
await ctx.route('**/api/bpprofit.php*',r=>r.fulfill({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify(FEED)}))
await ctx.route('**/api/*.php',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'{}'}))
await ctx.route('**esi.evetech.net/**',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'[]'}))
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto(`${APP}/build-profit`,{waitUntil:'domcontentloaded'}).catch(()=>{})
await p.waitForSelector('text=Bouwwinst',{timeout:20000}).catch(()=>{})
await p.waitForTimeout(900)
const heeft=async t=>(await p.locator(`text=${t}`).count())>0
console.log('  OK titel:',await heeft('Bouwwinst'))
console.log('  OK Damage Control:',await heeft('Damage Control I'))
console.log('  OK Capital Fusion Thruster:',await heeft('Capital Fusion Thruster'))
console.log('  OK marge +196.9%:',await heeft('+196.9%'))
// filter: min volume 10 → de vol=3 rij (marge 2.5) valt weg; standaard minVol=10
console.log('  OK lage-volume rij weg (default minVol=10):', !(await heeft('Test lage marge')))
console.log('  rijen in tabel:', await p.$$eval('tbody tr',e=>e.length))
await p.screenshot({path:SHOT+'bpprofit.png',fullPage:true})
console.log('  JS-fouten:',errs.length?errs:'geen')
await b.close()
