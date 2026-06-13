import { chromium } from 'playwright-core'
const APP = `http://localhost:${process.env.PORT ?? 8081}`
const N = Number(process.env.N ?? 25)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 1200 } })
await ctx.addInitScript(() => localStorage.setItem('eve_tokens', JSON.stringify([{ accessToken: 'f', refreshToken: 'f', expiresAt: Date.now()+7200000, characterId: 90000001, characterName: 'Desk Tester' }])))
const J = (o) => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(o) })
const F = { status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'busy' }
const hits = {}
const failTimes = (p, n) => { hits[p] = (hits[p]||0)+1; return hits[p] <= n }
await ctx.route('**esi.evetech.net/**', route => {
  const url = new URL(route.request().url()); const p = url.pathname
  if (p.includes('/assets/names/')) return route.fulfill(J([]))
  if (p.match(/\/characters\/\d+\/assets\/$/)) {
    const items = Array.from({length:N}, (_,i)=>({ item_id:1000+i, type_id:34, location_id:60003760+i, location_flag:'Hangar', location_type:'station', quantity:1+i, is_singleton:false }))
    return route.fulfill(J(items))
  }
  if (p.includes('/characters/90000001/location/')) return route.fulfill(J({ solar_system_id: 30000142 }))
  if (p.includes('/universe/names/')) {
    if (failTimes(p,2)) return route.fulfill(F)
    const ids = JSON.parse(route.request().postData()||'[]')
    return route.fulfill(J(ids.map(id => ({ id, name:`Name ${id}`, category:'station' }))))
  }
  const st = p.match(/\/universe\/stations\/(\d+)\//)
  if (st) { if (failTimes(p,2)) return route.fulfill(F); const id=+st[1]; return route.fulfill(J({ name:`Station ${id}`, system_id:30000142+(id-60003760) })) }
  const sy = p.match(/\/universe\/systems\/(\d+)\//)
  if (sy) { if (failTimes(p,2)) return route.fulfill(F); const id=+sy[1]; const sec=((id-30000142)%10)/10*0.9; return route.fulfill(J({ name:`Sys ${id}`, security_status: sec, constellation_id: 20000000 })) }
  if (p.includes('/universe/constellations/')) return route.fulfill(F) // optioneel
  if (p.includes('/universe/regions/')) return route.fulfill(F)
  return route.fulfill(J([]))
})
const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/assets`, { waitUntil: 'networkidle' }).catch(()=>{})
await page.waitForTimeout(Number(process.env.WAIT ?? 6000))
const body = await page.locator('body').innerText()
console.log(`alle ${N} locaties geladen:`, body.includes(`${N} locaties`))
console.log('GEEN "Onbekende" locaties (alles resolved):', !body.includes('Onbekende'))
console.log('voorbeeld-station "Station 60003760" zichtbaar:', body.includes('Station 60003760'))
const secMatches = (body.match(/\b0\.\d\b|-0\.\d\b/g)||[])
console.log('aantal security-getallen gevonden:', secMatches.length, '(verwacht ~', N, ')')
await browser.close()
