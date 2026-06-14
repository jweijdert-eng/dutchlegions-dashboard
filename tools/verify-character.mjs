import { chromium } from 'playwright-core'
const APP=`http://localhost:${process.env.PORT??8081}`
const b=await chromium.launch({channel:'msedge',headless:true})
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const ctx=await b.newContext({viewport:{width:760,height:900},deviceScaleFactor:2})
await ctx.addInitScript(()=>localStorage.setItem('eve_tokens',JSON.stringify([{accessToken:'f',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:1831618559,characterName:'Desk Tester'}])))
await ctx.route('**/characters/1831618559/', r=>r.fulfill(J({name:'Desk Tester',corporation_id:98652891,alliance_id:99013537,birthday:'2012-05-10T00:00:00Z',security_status:3.4})))
await ctx.route('**/characters/1831618559/skills/**', r=>r.fulfill(J({total_sp:148000000,unallocated_sp:250000,skills:[
  {skill_id:3327,skillpoints_in_skill:5400000,active_skill_level:5,trained_skill_level:5},
  {skill_id:3330,skillpoints_in_skill:4200000,active_skill_level:5,trained_skill_level:5},
  {skill_id:3300,skillpoints_in_skill:2560000,active_skill_level:4,trained_skill_level:4},
  {skill_id:33699,skillpoints_in_skill:1800000,active_skill_level:5,trained_skill_level:5},
  {skill_id:3402,skillpoints_in_skill:900000,active_skill_level:3,trained_skill_level:3},
]})))
await ctx.route('**/characters/1831618559/wallet/**', r=>r.fulfill(J(1234567890)))
await ctx.route('**/characters/1831618559/corporationhistory/**', r=>r.fulfill(J([
  {record_id:3,corporation_id:98652891,start_date:'2022-08-01T00:00:00Z'},
  {record_id:2,corporation_id:98000111,start_date:'2019-03-15T00:00:00Z'},
  {record_id:1,corporation_id:1000166,start_date:'2012-05-12T00:00:00Z'},
])))
await ctx.route('**/corporations/98652891/', r=>r.fulfill(J({name:'Dutch Legions',ticker:'DLEG',member_count:80})))
await ctx.route('**/universe/names/**', r=>{const ids=JSON.parse(r.request().postData()||'[]');const nm={3327:'Spaceship Command',3330:'Gallente Cruiser',3300:'Gunnery',33699:'Drones',3402:'Shield Management',98652891:'Dutch Legions',98000111:'Old Corp Inc',1000166:'Center for Advanced Studies'};return r.fulfill(J(ids.map(id=>({id,name:nm[id]??`X ${id}`,category:'x'}))))})
await ctx.route('**images.evetech.net/**', r=>r.fulfill({status:200,headers:{'access-control-allow-origin':'*'},body:''}))
const page=await ctx.newPage()
await page.goto(`${APP}/character`,{waitUntil:'networkidle'}).catch(()=>{})
await page.waitForTimeout(1500)
await page.locator('button:has-text("STATS")').click(); await page.waitForTimeout(800)
console.log('STATS: 148.0M SP?', (await page.locator('body').innerText()).includes('148.0M'))
console.log('STATS: hoogste skill Spaceship Command?', (await page.locator('body').innerText()).includes('Spaceship Command'))
await page.screenshot({path:'.verify-shots/character-stats.png'})
await page.locator('button:has-text("HISTORIE")').click(); await page.waitForTimeout(800)
const body=await page.locator('body').innerText()
console.log('HISTORIE: Dutch Legions + HUIDIG?', body.includes('Dutch Legions')&&body.includes('HUIDIG'))
console.log('HISTORIE: oude corp?', body.includes('Old Corp Inc'))
await page.screenshot({path:'.verify-shots/character-history.png'})
await b.close()
