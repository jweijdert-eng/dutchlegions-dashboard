import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const APP = process.env.TEST_APP || 'http://127.0.0.1:8081'
const walletScope = 'esi-wallet.read_corporation_wallets.v1'
const divisionScope = 'esi-corporations.read_divisions.v1'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
// 1×1 doorzichtige PNG voor images.evetech.net (portretten, logo's, iconen).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function setup({ scopes = [walletScope, divisionScope], denied = [], namesDenied = false, journalDenied = false, refresh = false, main = null, pad = '/corp-wallet' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const calls = []
  let failJournal = journalDenied
  const maakToken = (id, label) => `test.${btoa(JSON.stringify({ sub: `CHARACTER:EVE:${id}`, scp: scopes }))}.${label}-${id}`
  await ctx.addInitScript(({ tokens, main }) => {
    if (!sessionStorage.getItem('test_seeded')) {
      localStorage.setItem('eve_tokens', JSON.stringify(tokens))
      if (main) localStorage.setItem('eve_main_char', String(main))
      sessionStorage.setItem('test_seeded', '1')
    }
  }, { main, tokens: [90000001, 90000002].map(id => ({
    characterId: id, characterName: `Character ${id}`, expiresAt: Date.now() + (refresh ? 60000 : 7200000),
    accessToken: maakToken(id, 'test'), refreshToken: `refresh-${id}`,
  })) })
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) return route.continue()
    if (url.hostname === 'login.eveonline.com' && url.pathname === '/v2/oauth/token') {
      if (!refresh) return route.fulfill({ status: 400, json: { error: 'invalid_grant' } })
      // Token-verversing pas na het eerste laden, zoals elke ~20 minuten op de echte site.
      await new Promise(r => setTimeout(r, 1500))
      const id = Number(new URLSearchParams(route.request().postData() ?? '').get('refresh_token')?.split('-')[1])
      return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { access_token: maakToken(id, 'nieuw'), refresh_token: `refresh-${id}`, expires_in: 1200 } })
    }
    if (url.hostname === 'login.eveonline.com') return route.fulfill({ contentType: 'text/html', body: 'Mock EVE authorization' })
    if (url.hostname === 'images.evetech.net') return route.fulfill({ contentType: 'image/png', body: PNG })
    if (url.hostname !== 'esi.evetech.net') return route.fulfill({ json: {} })
    const path = url.pathname.replace('/latest', '')
    const auth = route.request().headers().authorization ?? ''
    const who = auth.endsWith('90000001') ? 90000001 : 90000002
    if (/^\/characters\/\d+\/$/.test(path)) return route.fulfill({ json: { name: 'Character', corporation_id: 98000001, security_status: 1 } })
    if (path === '/corporations/98000001/') return route.fulfill({ json: { name: 'Test Corporation', ticker: 'TEST', member_count: 2 } })
    if (path === '/corporations/98000001/wallets/') {
      calls.push({ path, who })
      if (denied.includes(who)) return route.fulfill({ status: 403, json: { error: 'Forbidden' } })
      return route.fulfill({ json: Array.from({ length: 7 }, (_, i) => ({ division: i + 1, balance: (i + 1) * 1000000 })) })
    }
    if (path === '/corporations/98000001/divisions/') return route.fulfill(namesDenied
      ? { status: 403, json: { error: 'Director role required' } }
      : { json: { wallet: [{ division: 1, name: 'Operations' }, { division: 2, name: 'Ship replacement' }] } })
    if (path.includes('/wallets/') && path.endsWith('/journal/')) {
      calls.push({ path, who, page: url.searchParams.get('page'), auth })
      if (failJournal) return route.fulfill({ status: 403, json: { error: 'Forbidden' } })
      const division = Number(path.split('/')[4])
      const second = url.searchParams.get('page') === '2'
      return route.fulfill({ headers: { 'x-pages': division === 1 ? '2' : '1', 'access-control-expose-headers': 'x-pages' }, json: division === 1 ? [{
        id: second ? 2 : 1, date: new Date(Date.now() - (second ? 86400000 : 1000)).toISOString(),
        ref_type: second ? 'market_transaction' : 'corporation_account_withdrawal',
        description: second ? 'Older income' : 'SRP payout', amount: second ? 300000 : -250000, balance: second ? undefined : 1000000,
      }] : [] })
    }
    if (/\/wallet\/$/.test(path)) return route.fulfill({ json: 100 })
    if (path === '/status/') return route.fulfill({ json: { players: 20000, server_version: '1', start_time: new Date().toISOString() } })
    return route.fulfill({ json: [] })
  })
  const page = await ctx.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', e => { errors.push(e.message); console.error('PAGE:', e.message) })
  await page.goto(`${APP}${pad}`, { waitUntil: 'domcontentloaded' })
  return { ctx, page, calls, errors, setJournalDenied: value => { failJournal = value } }
}

try {
  const a = await setup({ denied: [90000001] })
  await a.page.getByText('SRP payout', { exact: true }).waitFor()
  assert.equal(await a.page.getByTestId('corp-total').innerText(), '28.000.000,00 ISK')
  assert.equal(await a.page.getByRole('combobox', { name: 'Corporation', exact: true }).locator('option').count(), 1)
  assert.ok(a.calls.some(c => c.path.endsWith('/wallets/') && c.who === 90000002))
  assert.ok(await a.page.locator('a[href="/corp-wallet"]').count())
  await a.page.getByRole('button', { name: 'Meer laden', exact: true }).click()
  await a.page.getByText('Older income', { exact: true }).waitFor()
  await a.page.getByRole('button', { name: 'Inkomsten', exact: true }).click()
  assert.equal(await a.page.getByText('SRP payout', { exact: true }).count(), 0)
  await a.page.getByRole('button', { name: 'Alles', exact: true }).click()
  await a.page.getByRole('button', { name: /Ship replacement/ }).click()
  await a.page.getByText('Geen journaalregels in deze divisie.', { exact: true }).waitFor()
  assert.equal(await a.page.getByText('SRP payout', { exact: true }).count(), 0)
  assert.equal(a.errors.length, 0, a.errors.join('\n'))
  await a.page.screenshot({ path: '.verify-shots/corp-wallet.png', fullPage: true })
  await a.ctx.close()
  console.log('OK: zeven divisies, geen dubbel saldo, ander character bij 403, paginering, filters en divisiewissel')

  const b = await setup({ namesDenied: true, journalDenied: true })
  await b.page.getByTestId('corp-total').waitFor()
  await b.page.getByRole('button', { name: /Master Wallet/ }).waitFor()
  await b.page.getByRole('alert').filter({ hasText: 'geen toegang' }).waitFor()
  assert.equal(await b.page.getByText('Geen journaalregels in deze divisie.', { exact: true }).count(), 0)
  b.setJournalDenied(false)
  await b.page.getByRole('button', { name: /Verversen/ }).click()
  await b.page.getByText('SRP payout', { exact: true }).waitFor()
  await b.ctx.close()
  console.log('OK: saldi zonder Director-namen; geweigerd journaal wordt geen leeg journaal; herstel via verversen')

  const c = await setup({ scopes: [] })
  await c.page.getByRole('button', { name: 'Toestemming geven via EVE' }).waitFor()
  assert.equal(c.calls.length, 0)
  await c.page.getByRole('button', { name: 'Toestemming geven via EVE' }).click()
  await c.page.waitForURL('https://login.eveonline.com/**')
  const scopes = new URL(c.page.url()).searchParams.get('scope').split(' ')
  assert.ok(scopes.includes(walletScope) && scopes.includes(divisionScope))
  await c.ctx.close()
  console.log('OK: ontbrekende scope vraagt opnieuw toestemming, geen ongeautoriseerde walletverzoeken')

  const d = await setup({ denied: [90000001, 90000002] })
  await d.page.getByRole('alert').filter({ hasText: 'geen toegang' }).waitFor()
  assert.equal(await d.page.getByTestId('corp-total').count(), 0)
  await d.ctx.close()
  console.log('OK: geweigerde corp wallet toont geen vals nulsaldo')

  const e = await setup({ refresh: true })
  await e.page.getByText('SRP payout', { exact: true }).waitFor()
  await e.page.waitForFunction(() => localStorage.getItem('eve_tokens')?.includes('nieuw'))
  await e.page.waitForTimeout(1500)
  assert.equal(e.calls.filter(c => c.path.endsWith('/wallets/')).length, 1, 'token verversen mag de wallet niet opnieuw laden')
  await e.page.getByRole('button', { name: 'Meer laden', exact: true }).click()
  await e.page.getByText('Older income', { exact: true }).waitFor()
  assert.ok(e.calls.find(c => c.page === '2')?.auth.includes('nieuw'), 'journaal moet het verse token gebruiken')
  assert.equal(await e.page.getByRole('button', { name: 'Toestemming geven via EVE' }).count(), 0)
  assert.equal(e.errors.length, 0, e.errors.join('\n'))
  await e.ctx.close()
  console.log('OK: token verversen laadt niet alles opnieuw; journaal gebruikt het verse token; geen koppel-blok bij een werkende wallet')

  // Main zonder rol bovenaan geselecteerd; de alt (CEO) mag de wallet wel zien.
  const f = await setup({ denied: [90000001], main: 90000001 })
  await f.page.getByTestId('corp-total').waitFor()
  assert.equal(await f.page.getByTestId('corp-total').innerText(), '28.000.000,00 ISK')
  assert.ok(f.calls.some(c => c.path.endsWith('/wallets/') && c.who === 90000002), 'de alt moet gebruikt worden, ook als de main geselecteerd is')
  assert.equal(f.errors.length, 0, f.errors.join('\n'))
  await f.ctx.close()
  console.log('OK: wallet van een alt is zichtbaar terwijl de main bovenaan geselecteerd staat')

  // Dashboard: band met logo en totaal, ook met de main geselecteerd; zonder toestemming geen band en geen walletverzoeken.
  const g = await setup({ denied: [90000001], main: 90000001, pad: '/' })
  const band = g.page.getByTestId('corp-wallet-band')
  await band.waitFor()
  assert.ok((await band.innerText()).includes('28.0M ISK'), await band.innerText())
  assert.ok((await band.innerText()).includes('Test Corporation [TEST]'))
  assert.equal(await band.locator('img[src*="/corporations/98000001/logo"]').count(), 1)
  await band.screenshot({ path: '.verify-shots/corp-wallet-band.png' })
  await band.getByRole('button', { name: 'Meer →' }).click()
  await g.page.waitForURL('**/corp-wallet')
  assert.equal(g.errors.length, 0, g.errors.join('\n'))
  await g.ctx.close()
  const h = await setup({ scopes: [], pad: '/' })
  await h.page.getByText('TOTAAL WALLET').waitFor()
  await h.page.waitForTimeout(1500)
  assert.equal(await h.page.getByTestId('corp-wallet-band').count(), 0)
  assert.equal(h.calls.filter(c => c.path.endsWith('/wallets/')).length, 0)
  await h.ctx.close()
  console.log('OK: dashboard toont de corp-wallet-band (logo, naam, totaal, Meer → naar de pagina); zonder toestemming niets')
} finally {
  await browser.close()
}
