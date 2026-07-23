import { chromium } from 'playwright-core'
const APP='http://localhost:8090'
const now=new Date().toISOString()
const POS=[
 {id:'p1',typeId:44992,name:'Core X-Type 500MN Microwarpdrive',qty:1,buyPrice:269800000,date:now},
 {id:'p2',typeId:2048,name:'Caldari Navy Medium Shield Booster',qty:4,buyPrice:149500000,date:now},
 {id:'p3',typeId:34,name:'Capital Clone Vat Bay',qty:5,buyPrice:22300000,date:now},
]
const b=await chromium.launch({channel:'msedge',headless:true})
const ctx=await b.newContext({viewport:{width:1440,height:900}})
await ctx.addInitScript(({pos})=>{localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'fake',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Tester'}]));localStorage.setItem('jita:positions',JSON.stringify(pos))},{pos:POS})
await ctx.route('**esi.evetech.net/**',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'[]'}))
await ctx.route('**/api/*.php',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'{}'}))
const p=await ctx.newPage()
await p.goto(`${APP}/jita-positions`,{waitUntil:'domcontentloaded'}).catch(()=>{})
await p.waitForSelector('text=Mijn posities',{timeout:20000}).catch(()=>{})
await p.waitForTimeout(1200)
// tabelbreedte vs wrapper-breedte
const dims=await p.evaluate(()=>{const t=document.querySelector('table');const w=t?.parentElement;return {tableW:t?.scrollWidth,wrapW:w?.clientWidth,advies:!!document.querySelector('button[title=\"Bewerken\"]')}})
console.log('table scrollWidth:',dims.tableW,'| wrapper clientWidth:',dims.wrapW,'| edit-knop in DOM:',dims.advies)
await p.screenshot({path:'C:/Users/weijd/AppData/Local/Temp/claude/c--Users-weijd-Desktop-tracker/9d936401-17e3-4ea0-a5ce-faf37bedbfed/scratchpad/pos.png',fullPage:true})
await b.close()
