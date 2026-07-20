import { chromium } from 'playwright-core'
import fs from 'fs'
const APP='http://localhost:8081'
const SHOT=new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/,'$1'); fs.mkdirSync(SHOT,{recursive:true})
const iso=(min)=>new Date(Date.now()+min*60000).toISOString()
// Nep-JWT met de waypoint-scope zodat canWaypoint=true.
const b64u=(o)=>Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
const JWT='x.'+b64u({scp:['esi-ui.write_waypoint.v1'],exp:Math.floor(Date.now()/1000)+7200,name:'Verify Tester',sub:'CHARACTER:EVE:90000001'})+'.y'
const FEED={ok:true,region:'Cobalt Edge',region_id:10000053,aantal:2,kwetsbaar_nu:1,onder_aanval:1,bijgewerkt:new Date().toISOString(),
  rows:[
    {structure_id:1,system_id:30001780,type:'IHUB',type_full:'Infrastructure Hub',system:'GQLB-V',sec:-0.4,alliance_id:99011990,alliance:'Insidious.',adm:1.4,status:'campaign',when:iso(140),campaign:true,defender:'Insidious.',defender_score:60,attackers_score:40},
    {structure_id:2,system_id:30000208,type:'IHUB',type_full:'Infrastructure Hub',system:'HXK-J6',sec:-0.6,alliance_id:99003581,alliance:'Beyond the Breach',adm:4.1,status:'vulnerable',when:iso(3),campaign:false,defender:'',defender_score:null,attackers_score:null},
  ]}
const b=await chromium.launch({channel:'msedge',headless:true})
const ctx=await b.newContext({viewport:{width:1400,height:900}})
await ctx.addInitScript(({jwt})=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:jwt,refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Verify Tester'}])),{jwt:JWT})
await ctx.route('**/api/*.php',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'{}'}))
await ctx.route('**/api/sovtimer.php*',r=>r.fulfill({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify(FEED)}))
let wpBody=null
await ctx.route('**/api/waypoint.php',r=>{ try{wpBody=JSON.parse(r.request().postData()||'{}')}catch{} r.fulfill({status:200,headers:{'content-type':'application/json'},body:JSON.stringify({ok:true,status:204})}) })
await ctx.route('**esi.evetech.net/**',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'[]'}))
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto(`${APP}/sov-timer`,{waitUntil:'domcontentloaded'}).catch(()=>{})
await p.waitForSelector('text=Cobalt Edge',{timeout:20000}).catch(()=>{})
await p.waitForTimeout(1200)
// live klok: lees de eerste countdown twee keer met 1.6s ertussen → moet veranderen en ':' bevatten
const cd=()=>p.locator('tbody tr').first().locator('td').nth(1).innerText()
const t1=await cd(); await p.waitForTimeout(1600); const t2=await cd()
console.log('  klok t1:',JSON.stringify(t1.split('\n')[0]),'→ t2:',JSON.stringify(t2.split('\n')[0]))
console.log('  OK  live tikt (verandert):', t1!==t2)
console.log('  OK  uu:mm:ss-formaat:', /\d{2}:\d{2}:\d{2}/.test(t1))
// klik systeem → in-game route
await p.locator('button:has-text("GQLB-V")').first().click()
await p.waitForTimeout(500)
console.log('  waypoint-call body:',JSON.stringify(wpBody))
console.log('  OK  route gezet naar juiste systeem-id (30001780):', wpBody && wpBody.dest===30001780 && wpBody.clear===true)
console.log('  OK  bevestiging zichtbaar:', (await p.locator('text=Route naar GQLB-V gezet').count())>0)
await p.screenshot({path:SHOT+'sov2.png',fullPage:true})
console.log('JS-fouten:',errs.length?errs:'geen')
await b.close()
