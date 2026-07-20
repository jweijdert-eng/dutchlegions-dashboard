import { chromium } from 'playwright-core'
import fs from 'fs'
const APP='http://localhost:8081'
const SHOT=new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/,'$1'); fs.mkdirSync(SHOT,{recursive:true})
const iso=(min)=>new Date(Date.now()+min*60000).toISOString()
const FEED={ok:true,region:'Cobalt Edge',region_id:10000053,aantal:3,kwetsbaar_nu:2,onder_aanval:1,bijgewerkt:new Date().toISOString(),
  rows:[
    {structure_id:1,type:'IHUB',type_full:'Infrastructure Hub',system:'GQLB-V',sec:-0.4,alliance_id:99011990,alliance:'Insidious.',adm:1.4,status:'campaign',when:iso(140),campaign:true,defender:'Insidious.',defender_score:60,attackers_score:40},
    {structure_id:2,type:'IHUB',type_full:'Infrastructure Hub',system:'HXK-J6',sec:-0.6,alliance_id:99003581,alliance:'Beyond the Breach',adm:4.1,status:'vulnerable',when:iso(90),campaign:false,defender:'',defender_score:null,attackers_score:null},
    {structure_id:3,type:'TCU',type_full:'Territorial Claim Unit',system:'4GSZ-1',sec:-0.4,alliance_id:99003581,alliance:'Beyond the Breach',adm:null,status:'upcoming',when:iso(600),campaign:false,defender:'',defender_score:null,attackers_score:null},
  ]}
const b=await chromium.launch({channel:'msedge',headless:true})
const ctx=await b.newContext({viewport:{width:1400,height:900}})
await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'fake',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Verify Tester'}])))
await ctx.route('**/api/sovtimer.php*',r=>r.fulfill({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify(FEED)}))
await ctx.route('**/api/*.php',r=>r.fulfill({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:'{}'}))
await ctx.route('**esi.evetech.net/**',r=>r.fulfill({status:200,headers:{'content-type':'application/json'},body:'[]'}))
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto(`${APP}/sov-timer`,{waitUntil:'domcontentloaded'}).catch(()=>{})
await p.waitForSelector('text=Cobalt Edge',{timeout:20000}).catch(()=>{})
await p.waitForTimeout(1000)
const heeft=async t=>(await p.locator(`text=${t}`).count())>0
const checks={
  'titel regio':await heeft('Cobalt Edge'),
  'ONDER AANVAL':await heeft('ONDER AANVAL'),
  'KWETSBAAR':await heeft('KWETSBAAR'),
  'systeem GQLB-V':await heeft('GQLB-V'),
  'Insidious.':await heeft('Insidious.'),
  'ADM 4.1':await heeft('4.1'),
  'score 60% def':await heeft('60% def'),
  'route-veld':(await p.locator('input[placeholder*="thuissysteem"]').count())>0,
}
for(const[k,v]of Object.entries(checks))console.log(`  ${v?'OK ':'MIS'} ${k}`)
// route-link check: vul 'Vanaf' in en kijk of de systeemlink een dotlan-route wordt
await p.fill('input[placeholder*="thuissysteem"]','JITA').catch(()=>{})
await p.waitForTimeout(300)
const href=await p.locator('a:has-text("GQLB-V")').first().getAttribute('href').catch(()=>null)
console.log('  route-link:',href)
await p.screenshot({path:SHOT+'sov.png',fullPage:true})
console.log('JS-fouten:',errs.length?errs:'geen')
const fail=Object.entries(checks).filter(([,v])=>!v).map(([k])=>k)
console.log(fail.length?`GEZAKT: ${fail.join(', ')}`:'ALLE CHECKS OK')
await b.close()
