// Live-verificatie van de Hauling-tab met gemockte courier-contracten.
// Locaties zijn echte NPC-stations zodat naam-resolutie via publiek ESI loopt.
import { chromium } from 'playwright-core'

const APP = 'http://localhost:8081'
const CHAR_ID = 90000001
const JITA = 60003760, AMARR = 60008494, DODIXIE = 60011866, RENS = 60004588

const day = (n, h = 12) => new Date(Date.now() - n * 86400_000 - h * 3600_000).toISOString()

let cid = 1000
const courier = (over) => ({
  contract_id: cid++, type: 'courier', availability: 'public', for_corporation: false,
  issuer_id: 91000001, acceptor_id: CHAR_ID, price: 0, buyout: 0,
  date_issued: day(9), date_expired: day(-5), days_to_complete: 3,
  ...over,
})

const contracts = [
  courier({ status: 'finished', date_completed: day(0, 4),  reward: 18_000_000, collateral: 300e6, volume: 12000, start_location_id: JITA, end_location_id: AMARR }),
  courier({ status: 'finished', date_completed: day(0, 9),  reward: 25_000_000, collateral: 500e6, volume: 60000, start_location_id: JITA, end_location_id: DODIXIE }),
  courier({ status: 'finished', date_completed: day(1, 6),  reward: 40_000_000, collateral: 1.2e9, volume: 320000, start_location_id: AMARR, end_location_id: RENS }),
  courier({ status: 'finished', date_completed: day(3, 2),  reward: 12_500_000, collateral: 200e6, volume: 8000,  start_location_id: RENS, end_location_id: JITA }),
  courier({ status: 'finished', date_completed: day(3, 14), reward: 30_000_000, collateral: 900e6, volume: 145000, start_location_id: DODIXIE, end_location_id: JITA }),
  courier({ status: 'finished_contractor', date_completed: day(6, 1), reward: 55_000_000, collateral: 2e9, volume: 340000, start_location_id: JITA, end_location_id: RENS }),
  courier({ status: 'in_progress', reward: 35_000_000, collateral: 1e9, volume: 250000, start_location_id: JITA, end_location_id: AMARR }),
  courier({ status: 'failed', date_completed: day(8), reward: 20_000_000, collateral: 450e6, volume: 90000, start_location_id: AMARR, end_location_id: JITA }),
  // Ruis die eruit gefilterd moet worden:
  courier({ status: 'finished', date_completed: day(2), reward: 99_000_000, acceptor_id: 92000002, start_location_id: JITA, end_location_id: AMARR }), // andermans haul
  { contract_id: cid++, type: 'item_exchange', status: 'finished', availability: 'public', for_corporation: false, issuer_id: 91000001, acceptor_id: CHAR_ID, price: 5e6, reward: 0, date_issued: day(4), date_expired: day(-5), date_completed: day(4) },
]

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
await ctx.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{
    accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 7200_000,
    characterId: charId, characterName: 'Verify Hauler',
  }]))
}, { charId: CHAR_ID })

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}
await ctx.route(`**/characters/${CHAR_ID}/contracts/**`, route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors })
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(contracts) })
})

const page = await ctx.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto(`${APP}/hauling`, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForSelector('text=VOLTOOIDE HAULS', { timeout: 15000 })
await page.waitForTimeout(2500)

const header = await page.locator('text=ISK verdiend').first().textContent().catch(() => null)
console.log('Header:', header)
for (const label of ['TOTAAL VERDIEND', 'GEM. PER DAG', 'VOLUME GEHAULD', 'ONDERWEG']) {
  const card = page.locator(`div:has(> div:text("${label}"))`).last()
  console.log(label, '→', (await card.textContent()).replace(label, '').trim())
}
console.log('Onderweg-sectie:', await page.locator('text=ONDERWEG —').count() > 0)
console.log('Grafiek:', await page.locator('.recharts-bar-rectangle').count(), 'bars')
const rows = await page.locator('table >> nth=1 >> tbody tr').allTextContents()
console.log('Voltooide hauls rijen:')
for (const r of rows) console.log('  ', r)

await page.screenshot({ path: '.verify-shots/hauling.png', fullPage: true })
await browser.close()
console.log('Screenshot: .verify-shots/hauling.png')
