// Live-verificatie van de Fittings-tab: EFT-import (slot-volgorde, charges,
// /offline) en DNA-export, via de echte UI in headless Edge.
// Geauthenticeerde fittings-endpoints worden gemockt; naam/ID-resolutie en
// type-meta gaan naar het echte (publieke) ESI.
import { chromium } from 'playwright-core'
import fs from 'fs'

const APP = 'http://localhost:8081'
const CHAR_ID = 90000001
const SHOT_DIR = new URL('../.verify-shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const NAMES = [
  'Rifter', '200mm AutoCannon II', 'Republic Fleet EMP S',
  '5MN Y-T8 Compact Microwarpdrive', 'Damage Control II',
  'Warrior II', 'Nanite Repair Paste',
]

async function resolveIds() {
  const res = await fetch('https://esi.evetech.net/latest/universe/ids/?datasource=tranquility', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(NAMES),
  })
  const data = await res.json()
  const map = new Map()
  for (const t of data.inventory_types ?? []) map.set(t.name, t.id)
  for (const n of NAMES) if (!map.has(n)) throw new Error(`ID niet gevonden voor: ${n}`)
  return map
}

const ids = await resolveIds()
const ID = (n) => ids.get(n)
console.log('Type IDs:', Object.fromEntries(ids))

// Mock-fitting voor de DNA-test: geen rigs (test lege-sectie-skip),
// charge in hetzelfde HiSlot, drones + cargo met quantities.
const mockFitting = {
  fitting_id: 4242,
  name: 'DNA Test Fit',
  description: '',
  ship_type_id: ID('Rifter'),
  items: [
    { type_id: ID('200mm AutoCannon II'), flag: 'HiSlot0', quantity: 1 },
    { type_id: ID('Republic Fleet EMP S'), flag: 'HiSlot0', quantity: 1 },
    { type_id: ID('5MN Y-T8 Compact Microwarpdrive'), flag: 'MedSlot0', quantity: 1 },
    { type_id: ID('Damage Control II'), flag: 'LoSlot0', quantity: 1 },
    { type_id: ID('Warrior II'), flag: 'DroneBay', quantity: 2 },
    { type_id: ID('Nanite Repair Paste'), flag: 'Cargo', quantity: 50 },
  ],
}

const EFT_IMPORT = `[Rifter, Live Test Fit]

Damage Control II
Multispectrum Coating II /offline

5MN Y-T8 Compact Microwarpdrive

200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S

Small Projectile Burst Aerator I

Warrior II x2

Nanite Repair Paste x50
`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP })

// Fake token, ver in de toekomst zodat de refresh-flow niet triggert
await context.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{
    accessToken: 'fake-test-token', refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 7200_000, characterId: charId, characterName: 'Verify Tester',
  }]))
}, { charId: CHAR_ID })

let capturedPost = null
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
}
await context.route(`**/characters/${CHAR_ID}/fittings/**`, async route => {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors })
  if (req.method() === 'GET') {
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify([mockFitting]) })
  }
  if (req.method() === 'POST') {
    capturedPost = JSON.parse(req.postData())
    return route.fulfill({ status: 201, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ fitting_id: 9999 }) })
  }
  return route.continue()
})

const page = await context.newPage()
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))

console.log('\n--- Stap 1: Fittings-pagina laden ---')
await page.goto(`${APP}/fittings`, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForSelector('text=DNA Test Fit', { timeout: 15000 })
console.log('Fitting card zichtbaar:', await page.locator('text=DNA Test Fit').count() > 0)

console.log('\n--- Stap 2: kaart openen (wheel + slotlijst) ---')
await page.click('text=DNA Test Fit')
await page.waitForTimeout(1500)
await page.screenshot({ path: SHOT_DIR + 'wheel.png' })

console.log('\n--- Stap 3: DNA kopieren ---')
await page.click('button[title="Kopieer Ship DNA"]')
await page.waitForTimeout(300)
const dna = await page.evaluate(() => navigator.clipboard.readText())
console.log('DNA:', dna)

console.log('\n--- Stap 4: EFT kopieren ---')
await page.click('button[title="Kopieer EFT"]')
await page.waitForTimeout(300)
console.log(await page.evaluate(() => navigator.clipboard.readText()))

console.log('\n--- Stap 5: EFT-import ---')
await page.click('text=+ Importeer EFT')
await page.fill('textarea', EFT_IMPORT)
await page.waitForTimeout(800)
const preview = await page.locator('div:has-text("modules")').filter({ hasText: '✓' }).last().textContent().catch(() => null)
console.log('Preview:', preview)
await page.screenshot({ path: SHOT_DIR + 'import-modal.png' })

await page.click('button:has-text("Opslaan")')
await page.waitForSelector('text=Fitting opgeslagen!', { timeout: 20000 })
console.log('Succes-melding zichtbaar')
await page.screenshot({ path: SHOT_DIR + 'import-saved.png' })

console.log('\n--- Captured POST body ---')
console.log(JSON.stringify(capturedPost, null, 2))

// Vertaal type_ids terug naar namen voor leesbare flags
const idToName = new Map([...ids].map(([n, i]) => [i, n]))
console.log('\n--- Flags (leesbaar) ---')
for (const it of capturedPost?.items ?? []) {
  console.log(`  ${(idToName.get(it.type_id) ?? 'type ' + it.type_id).padEnd(36)} ${it.flag.padEnd(10)} x${it.quantity}`)
}

await browser.close()
console.log('\nScreenshots in', SHOT_DIR)
