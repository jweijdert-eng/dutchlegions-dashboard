import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const J=(o)=>({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(o)})
const now = Date.now()
const iso = ms => new Date(ms).toISOString()
const planets = [
  { planet_id:5001, solar_system_id:30000142, planet_type:'temperate', owner_id:90000001, upgrade_level:5, num_pins:7, last_update:iso(now-6*3600000) },
  { planet_id:5002, solar_system_id:30002187, planet_type:'barren',    owner_id:90000001, upgrade_level:4, num_pins:4, last_update:iso(now-12*3600000) },
  { planet_id:5003, solar_system_id:30000144, planet_type:'lava',      owner_id:90000001, upgrade_level:3, num_pins:5, last_update:iso(now-2*86400000) },
  { planet_id:5004, solar_system_id:30002510, planet_type:'storm',     owner_id:90000001, upgrade_level:5, num_pins:8, last_update:iso(now-3*3600000) },
]
const ex = (pt, qpc=3000) => ({ product_type_id:pt, qty_per_cycle:qpc, cycle_time:3600, heads:[{head_id:0,latitude:0.5,longitude:0.3},{head_id:1,latitude:0.55,longitude:0.35}] })
const detail = {
  5001:{ pins:[
    {pin_id:1,type_id:2254,latitude:0.4,longitude:0.4},
    {pin_id:2,type_id:2848,latitude:0.5,longitude:0.3,expiry_time:iso(now+5*3600000),extractor_details:ex(2073)},
    {pin_id:3,type_id:2481,latitude:0.3,longitude:0.6,schematic_id:65,contents:[]},
    {pin_id:4,type_id:2480,latitude:0.6,longitude:0.6,schematic_id:100,contents:[]},
    {pin_id:5,type_id:2541,latitude:0.45,longitude:0.5,contents:[{type_id:2073,amount:12000},{type_id:3683,amount:340},{type_id:2867,amount:88}]},
    {pin_id:6,type_id:2542,latitude:0.4,longitude:0.45,contents:[{type_id:2867,amount:20}]},
    {pin_id:7,type_id:2848,latitude:0.52,longitude:0.32,expiry_time:iso(now+5.5*3600000),extractor_details:ex(2073)},
  ], links:[{source_pin_id:1,destination_pin_id:3,link_level:2},{source_pin_id:3,destination_pin_id:4,link_level:1}],
     routes:[{route_id:1,source_pin_id:2,destination_pin_id:3,content_type_id:2073},{route_id:2,source_pin_id:3,destination_pin_id:4,content_type_id:3683},{route_id:3,source_pin_id:4,destination_pin_id:5,content_type_id:2867}] },
  5002:{ pins:[
    {pin_id:1,type_id:2254,latitude:0.4,longitude:0.4},
    {pin_id:2,type_id:2848,latitude:0.5,longitude:0.3,expiry_time:iso(now+2*86400000),extractor_details:ex(2270,5000)},
    {pin_id:3,type_id:2543,latitude:0.45,longitude:0.5,contents:[{type_id:2270,amount:40000}]},
    {pin_id:4,type_id:2536,latitude:0.46,longitude:0.52,contents:[{type_id:2270,amount:9000}]},
  ], links:[], routes:[{route_id:1,source_pin_id:2,destination_pin_id:3,content_type_id:2270}] },
  5003:{ pins:[
    {pin_id:1,type_id:2254,latitude:0.4,longitude:0.4},
    {pin_id:2,type_id:2848,latitude:0.5,longitude:0.3,expiry_time:iso(now-3600000),extractor_details:ex(2306)},
    {pin_id:3,type_id:2541,latitude:0.45,longitude:0.5,contents:[]},
  ], links:[], routes:[] },
  5004:{ pins:[
    {pin_id:1,type_id:2254,latitude:0.4,longitude:0.4},
    {pin_id:2,type_id:2848,latitude:0.5,longitude:0.3,expiry_time:iso(now+9*3600000),extractor_details:ex(2310)},
    {pin_id:3,type_id:2481,latitude:0.3,longitude:0.6,schematic_id:65,contents:[]},
    {pin_id:4,type_id:2484,latitude:0.6,longitude:0.6,schematic_id:133,contents:[]},
    {pin_id:5,type_id:2541,latitude:0.45,longitude:0.5,contents:[{type_id:2310,amount:5000}]},
    {pin_id:6,type_id:2542,latitude:0.4,longitude:0.45,contents:[]},
  ], links:[], routes:[{route_id:1,source_pin_id:2,destination_pin_id:3,content_type_id:2310}] },
}
const schem = { 65:{schematic_name:'Water',cycle_time:1800,pins:[{type_id:2073,is_input:true,quantity:3000},{type_id:3683,is_input:false,quantity:20}]},
  100:{schematic_name:'Coolant',cycle_time:3600,pins:[{type_id:3683,is_input:true,quantity:40},{type_id:2867,is_input:false,quantity:5}]},
  133:{schematic_name:'Wetware',cycle_time:3600,pins:[{type_id:2310,is_input:true,quantity:40},{type_id:2867,is_input:false,quantity:3}]} }
const names = { 30000142:'Jita',30002187:'Amarr',30000144:'Perimeter',30002510:'Rens',2073:'Aqueous Liquids',2270:'Base Metals',2306:'Heavy Metals',2310:'Noble Metals',3683:'Water',2867:'Coolant' }
async function setup(ctx){
  await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{accessToken:'f',refreshToken:'f',expiresAt:Date.now()+7200000,characterId:90000001,characterName:'Desk Tester'}])))
  await ctx.route('**market.fuzzwork.co.uk/**', r => { const u=new URL(r.request().url()); const ids=(u.searchParams.get('types')||'').split(','); const o={}; ids.forEach(id=>o[id]={buy:{max:10},sell:{min:({'2073':12,'2270':9,'3683':480,'2867':1200,'2306':55,'2310':70})[id]??5}}); return r.fulfill(J(o)) })
  await ctx.route('**esi.evetech.net/**', route => {
    const p=new URL(route.request().url()).pathname
    if (p.match(/\/characters\/\d+\/planets\/$/)) return route.fulfill(J(planets))
    const pd=p.match(/\/characters\/\d+\/planets\/(\d+)\//); if (pd) return route.fulfill(J(detail[+pd[1]]??{pins:[],links:[],routes:[]}))
    const sc=p.match(/\/universe\/schematics\/(\d+)\//); if (sc) return route.fulfill(J(schem[+sc[1]]??{schematic_name:'?',cycle_time:1800,pins:[]}))
    if (p.includes('/universe/names/')){ const ids=JSON.parse(route.request().postData()||'[]'); return route.fulfill(J(ids.map(id=>({id,name:names[id]??`Type ${id}`,category:'x'})))) }
    return route.fulfill(J([]))
  })
}
for (const [w,h,tag] of [[1400,1000,'desktop'],[420,900,'mobiel']]) {
  const ctx = await browser.newContext({ viewport:{width:w,height:h} })
  await setup(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
  await page.goto(`${APP}/planets`, { waitUntil:'networkidle' }).catch(()=>{})
  await page.waitForTimeout(2500)
  await page.screenshot({ path:`.verify-shots/planets-${tag}.png`, fullPage:true })
  console.log(`${tag}: kolonies=${await page.locator('text=/Temperate|Barren|Lava|Storm/').count()}`)
  await ctx.close()
}
await browser.close()
