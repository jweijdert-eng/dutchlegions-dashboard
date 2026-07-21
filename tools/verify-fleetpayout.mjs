import { chromium } from 'playwright-core'
import fs from 'fs'
const APP='http://localhost:8081'
const SHOT=new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/,'$1'); fs.mkdirSync(SHOT,{recursive:true})
const b64u=o=>Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
const JWT='x.'+b64u({scp:['esi-fleets.read_fleet.v1'],exp:Math.floor(Date.now()/1000)+7200,name:'FC Tester',sub:'CHARACTER:EVE:90000001'})+'.y'
// Gestopte sessie met twee leden: A=60min, B=20min → 75%/25%
const SESS={running:false,fleetId:12345,opStart:Date.now()-3600000,potRaw:'1b',taxPct:10,mode:'time',members:{
  '90000001':{name:'Piloot A',joinTime:Date.now()-3600000,shipTypeId:670,totalMs:3600000,presentSince:null},
  '90000002':{name:'Piloot B',joinTime:Date.now()-1200000,shipTypeId:670,totalMs:1200000,presentSince:null},
}}
const b=await chromium.launch({channel:'msedge',headless:true})
const ctx=await b.newContext({viewport:{width:1400,height:900}})
await ctx.addInitScript(({jwt,sess})=>{localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:jwt,refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'FC Tester'}]));localStorage.setItem('fleet_payout_v1',JSON.stringify(sess))},{jwt:JWT,sess:SESS})
await ctx.route('**esi.evetech.net/**',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'[]'}))
await ctx.route('**/api/*.php',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'{}'}))
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto(`${APP}/fleet-payout`,{waitUntil:'domcontentloaded'}).catch(()=>{})
await p.waitForSelector('text=Fleet Payout',{timeout:20000}).catch(()=>{})
await p.waitForTimeout(900)
const cells=async()=>p.$$eval('tbody tr',rows=>rows.map(tr=>[...tr.querySelectorAll('td')].map(td=>td.innerText.replace(/\s+/g,' ').trim())))
let c=await cells()
console.log('  rijen:',c.length)
console.log('  A:', c[0])
console.log('  B:', c[1])
// naar tijd: A 75% ~675M, B 25% ~225M
console.log('  OK naar-tijd A 75%:', c[0].some(x=>x.includes('75.0%')) )
console.log('  OK naar-tijd A ~675M:', c[0].some(x=>x.includes('675.00M')) )
console.log('  OK naar-tijd B ~225M:', c[1].some(x=>x.includes('225.00M')) )
// gelijk verdelen → beide 450M
await p.click('button:has-text("Gelijk")'); await p.waitForTimeout(300); c=await cells()
console.log('  OK gelijk beide 450M:', c[0].some(x=>x.includes('450.00M')) && c[1].some(x=>x.includes('450.00M')) )
await p.screenshot({path:SHOT+'fleetpayout.png',fullPage:true})
console.log('  JS-fouten:',errs.length?errs:'geen')
await b.close()
