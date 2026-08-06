/* Controleert de PI-opzetplanner op de gebouwde site.
 *
 *   npx vite preview --port 4174
 *   node tools/verify-pi-opzet.mjs
 *
 * De pagina zit achter de login, dus we zetten een neptoken neer — zelfde truc
 * als verify-fittings.mjs. Er is geen ESI nodig: alles komt uit de bundels in
 * /public, alleen de Jita-prijzen komen van fuzzwork.
 */
import { chromium } from 'playwright-core'

const APP = process.env.APP ?? 'http://localhost:4174'
const CHAR_ID = 90224240

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1500, height: 1400 } })
await context.addInitScript(({ charId }) => {
  localStorage.setItem('eve_tokens', JSON.stringify([{
    accessToken: 'fake-test-token', refreshToken: 'fake-refresh',
    expiresAt: Date.now() + 7200_000, characterId: charId, characterName: 'Verify Tester',
  }]))
  // Verse begintoestand, anders test je wat er van een vorige keer nog staat.
  for (const k of Object.keys(localStorage)) if (k.startsWith('piopzet.')) localStorage.removeItem(k)
}, { charId: CHAR_ID })

const page = await context.newPage()
const fouten = []
page.on('pageerror', e => fouten.push(e.message))
page.on('console', m => { if (m.type() === 'error') fouten.push('console: ' + m.text().slice(0, 160)) })

await page.goto(`${APP}/pi-opzet`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

const lees = () => page.evaluate(() => {
  const tekst = (s) => document.querySelector(s)?.textContent?.trim() ?? null
  const kaarten = [...document.querySelectorAll('h3')].map(h => h.textContent.trim())
  const body = document.body.innerText
  const perDag = body.match(/([\d.,]+)\s+Robotics\/dag/)?.[1] ?? null
  const slots = body.match(/(\d+) extractie \+ (\d+) fabriek = (\d+)\s+van je (\d+) slots/)
  return {
    titel: tekst('h1') ?? tekst('[class*=title]'),
    kaarten,
    perDag,
    slots: slots ? { extractie: +slots[1], fabriek: +slots[2], totaal: +slots[3], van: +slots[4] } : null,
    ketenregels: [...document.body.querySelectorAll('div')]
      .map(d => d.textContent).filter(t => /fabriek\(en\)/.test(t ?? '')).length,
    systemen: body.match(/^\s*([A-Z0-9-]{5,7})\s/gm)?.length ?? 0,
    heeftLava: /Lava/.test(body),
    ajiUitgesloten: /AJI-MA/.test(body),
    logistiek: body.match(/P1 naar \w[\w-]*: ([\d.,]+) m³\/dag/)?.[1] ?? null,
    accounts: [...document.body.innerText.matchAll(/ACCOUNT (\d) — (\d+) van (\d+) planeten/g)]
      .map(m => `acc${m[1]}: ${m[2]}/${m[3]}`),
    grens: body.match(/begrensd door: ([^\n]+)/)?.[1] ?? null,
    squallzin: body.match(/één rit per [\d,]+ dagen[^\n]*/)?.[0] ?? null,
  }
})

console.log('── PI-opzetplanner ──')
console.log(JSON.stringify(await lees(), null, 1))
await page.screenshot({ path: 'tools/pi-opzet.png', fullPage: true })

// Doel wisselen: de keten moet meebewegen
await page.selectOption('select', 'Broadcast Node').catch(() => {})
await page.waitForTimeout(900)
const na = await page.evaluate(() => document.body.innerText.match(/([\d.,]+)\s+(\S+)\/dag/)?.[0] ?? null)
console.log('\nna wisselen naar Broadcast Node:', na)

console.log('\nJS-fouten:', fouten.length ? fouten : 'geen')
await browser.close()
