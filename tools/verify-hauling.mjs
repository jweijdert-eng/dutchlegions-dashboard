import { chromium } from 'playwright-core'
const APP='http://localhost:8090'
const CTR=[
 {contract_id:1,type:'courier',status:'finished',availability:'personal',issuer_id:1,acceptor_id:90000001,date_issued:'2026-07-20T08:00:00Z',date_expired:'2026-07-27T08:00:00Z',date_accepted:'2026-07-20T10:00:00Z',date_completed:'2026-07-20T13:30:00Z',for_corporation:false,price:0,reward:50000000,collateral:1000000000,volume:12000,start_location_id:60003760,end_location_id:60008494},
 {contract_id:2,type:'courier',status:'in_progress',availability:'personal',issuer_id:1,acceptor_id:90000001,date_issued:'2026-07-21T07:00:00Z',date_expired:'2026-07-28T07:00:00Z',date_accepted:'2026-07-21T09:00:00Z',for_corporation:false,price:0,reward:30000000,collateral:500000000,volume:8000,start_location_id:60003760,end_location_id:60008494},
]
const b=await chromium.launch({channel:'msedge',headless:true})
const ctx=await b.newContext({viewport:{width:1440,height:900}})
await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'fake',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Tester'}])))
const json=body=>({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify(body)})
await ctx.route('**/api/*.php',r=>r.fulfill(json({})))
await ctx.route('**esi.evetech.net/**',r=>r.fulfill(json([])))
await ctx.route('**/characters/*/contracts/**',r=>r.fulfill(json(CTR)))
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto(`${APP}/hauling`,{waitUntil:'domcontentloaded'}).catch(()=>{})
await p.waitForSelector('text=Hauling',{timeout:20000}).catch(()=>{})
await p.waitForTimeout(1500)
const has=async t=>(await p.locator(`text=${t}`).count())>0
console.log('  OK kop "Geaccepteerd":', await has('Geaccepteerd'))
console.log('  OK kop "Duur":', await has('Duur'))
console.log('  OK duur 3u 30m (accept→lever):', await has('3u 30m'))
console.log('  OK onderweg geaccepteerd-tijd (✔):', (await p.locator('text=✔').count())>0)
await p.screenshot({path:'C:/Users/weijd/AppData/Local/Temp/claude/c--Users-weijd-Desktop-tracker/9d936401-17e3-4ea0-a5ce-faf37bedbfed/scratchpad/hauling.png',fullPage:true})
console.log('  JS-fouten:',errs.length?errs:'geen')
await b.close()
