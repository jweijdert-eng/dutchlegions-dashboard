// Notities en bouwprojecten sturen het EVE-token mee (de server leest daaruit wie je bent),
// nooit meer alleen een character-ID. Ook: een verlopen token wordt eerst ververst.
//   PORT=8091 node tools/verify-notes-token.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const APP = `http://localhost:${process.env.PORT || 8081}`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const maakToken = label => `test.${Buffer.from(JSON.stringify({ sub: 'CHARACTER:EVE:90000001', scp: ['publicData'] })).toString('base64')}.${label}`

async function setup({ verlopen = false, pad }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const calls = []
  await ctx.addInitScript(({ token, verlopen }) => {
    if (!sessionStorage.getItem('test_seeded')) {
      localStorage.setItem('eve_tokens', JSON.stringify([{ characterId: 90000001, characterName: 'Tester', accessToken: token,
        refreshToken: 'refresh-1', expiresAt: verlopen ? Date.now() - 60000 : Date.now() + 7200000 }]))
      sessionStorage.setItem('test_seeded', '1')
    }
  }, { token: maakToken('oud'), verlopen })
  await ctx.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.hostname === 'localhost' && !url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/notes.php' || url.pathname === '/api/buildprojects.php') {
      const body = req.postData() ? JSON.parse(req.postData()) : null
      calls.push({ pad: url.pathname, methode: req.method(), token: url.searchParams.get('token') ?? body?.token, query: url.search, body })
      if (req.method() !== 'GET') return route.fulfill({ json: { ok: true } })
      if (url.pathname === '/api/notes.php') return route.fulfill({ json: [{ id: 'n1', title: 'Boodschappen', content: 'Tritanium', updatedAt: 1 }] })
      return route.fulfill({ json: [] })
    }
    if (url.hostname === 'login.eveonline.com' && url.pathname === '/v2/oauth/token')
      return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { access_token: maakToken('nieuw'), refresh_token: 'refresh-2', expires_in: 1200 } })
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} })
    if (url.hostname === 'esi.evetech.net') return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: [] })
    return route.fulfill({ status: 404, body: '' })
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(APP + pad, { waitUntil: 'domcontentloaded' })
  return { ctx, page, calls, errors }
}

try {
  // Notities: laden, bewerken, toevoegen en wissen gaan allemaal met het token.
  const a = await setup({ pad: '/notes' })
  await a.page.getByText('Boodschappen').first().waitFor()
  const laad = a.calls.find(c => c.methode === 'GET')
  assert.equal(laad.token, maakToken('oud'))
  assert.ok(!laad.query.includes('characterId'), 'geen character-ID meer in de URL')
  await a.page.locator('textarea').first().fill('Tritanium en Pyerite')
  await a.page.waitForTimeout(1200)
  const opslaan = a.calls.find(c => c.methode === 'POST')
  assert.ok(opslaan, 'bewerken slaat op')
  assert.equal(opslaan.token, maakToken('oud'))
  assert.equal(opslaan.body.characterId, undefined)
  assert.equal(opslaan.body.note.content, 'Tritanium en Pyerite')
  assert.deepEqual(a.errors, [])
  await a.ctx.close()

  // Verlopen token: eerst verversen, pas daarna laden (anders weigert de server).
  const b = await setup({ pad: '/notes', verlopen: true })
  await b.page.getByText('Boodschappen').first().waitFor()
  const gets = b.calls.filter(c => c.methode === 'GET')
  // StrictMode laat effecten in dev twee keer lopen; het gaat erom dat het oude token nooit gaat.
  assert.ok(gets.length >= 1)
  assert.ok(gets.every(g => g.token === maakToken('nieuw')), 'het verlopen token wordt niet gebruikt')
  await b.ctx.close()

  // Bouwprojecten: laden met het token.
  const c = await setup({ pad: '/build' })
  await c.page.waitForFunction(() => true)
  for (let i = 0; i < 40 && !c.calls.some(x => x.pad === '/api/buildprojects.php'); i++) await c.page.waitForTimeout(250)
  const bp = c.calls.find(x => x.pad === '/api/buildprojects.php')
  assert.ok(bp, 'bouwprojecten geladen')
  assert.equal(bp.token, maakToken('oud'))
  assert.ok(!bp.query.includes('characterId'))
  assert.deepEqual(c.errors, [])
  await c.ctx.close()
  console.log('Notities en bouwprojecten sturen het token mee; verlopen token eerst ververst. OK')
} finally {
  await browser.close()
}
