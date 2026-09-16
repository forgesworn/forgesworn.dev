// Isolated browser; intercepted relays and wallet. Never sends public input or money.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { safeShot } from '../shotguard.mjs';
const base = process.env.FLY_TEST_URL || 'http://127.0.0.1:8826/fly/';
const escape = JSON.parse(readFileSync('test/fixtures/fly-escape-event.json'));
const quiet = JSON.parse(readFileSync('test/fixtures/fly-quiet-event.json'));
mkdirSync('captures-out/fly-living', { recursive: true });
const browser = await chromium.launch({ headless: true }), results = [];
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(), sockets = [], errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    // Only the local test replaces the identity with a synthetic fixture signer.
    if (!process.env.FLY_TEST_URL) await page.route(base, route => route.fulfill({ contentType: 'text/html', body: readFileSync('site/fly/index.html', 'utf8').replace(/const FLY = '[0-9a-f]{64}'/, `const FLY = '${escape.pubkey}'`).replace('const openedAt = Math.floor(Date.now() / 1000);', 'const openedAt = 0;') }));
    await page.routeWebSocket(/.*/, ws => { sockets.push(ws); ws.onMessage(m => { if (String(m).includes('"EVENT"')) writes.push(m); }); });
    await page.goto(base); await page.locator('[data-artwork="ready"]').waitFor();
    const box = page.locator('#fly-box'), pixels = () => page.locator('canvas').evaluate(c => c.toDataURL());
    assert.ok(await page.locator('#feed-drop').evaluate(e => e.getBoundingClientRect().bottom < innerHeight), 'Fly and feeding control visible on arrival');
    const initial = await pixels(); await page.waitForTimeout(500); assert.notEqual(await pixels(), initial, 'Moves without a report');
    await page.locator('#motion-pause').click(); await safeShot(page, `captures-out/fly-living/${name}-arrival.png`, { allow: [escape.pubkey] });
    const paused = await pixels(); await page.waitForTimeout(200); assert.equal(await pixels(), paused);
    await page.locator('#motion-pause').click();
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'flight');
    assert.equal(await box.getAttribute('data-framed'), 'true');
    await page.locator('#motion-pause').click(); await safeShot(page, `captures-out/fly-living/${name}-flight.png`, { allow: [escape.pubkey] });
    await page.locator('#motion-pause').click(); await page.locator('#feed-drop').click();
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'landing');
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'feed');
    assert.equal(await box.getAttribute('data-altitude'), '0.00000');
    await page.waitForFunction(() => Number(document.querySelector('#fly-box').dataset.drop) > .8);
    await page.locator('#motion-pause').click();
    await safeShot(page, `captures-out/fly-living/${name}-regurgitate.png`, { allow: [escape.pubkey] });
    assert.match(await page.locator('#motion-status').textContent(), /visual interaction/);
    await page.locator('#motion-pause').click();
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.activitySource === 'ambient');
    if (!process.env.FLY_TEST_URL) {
      sockets[0].send(JSON.stringify(['EVENT', 'fly', { ...escape, content: escape.content + 'tampered' }]));
      await page.waitForTimeout(200); assert.equal(await box.getAttribute('data-activity-source'), 'ambient');
      sockets[0].send(JSON.stringify(['EVENT', 'fly', escape]));
      await page.waitForFunction(() => document.querySelector('#motion-status').textContent.includes('Brain replay'));
      await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'flight');
      await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'landing');
      await page.waitForFunction(() => document.querySelector('#fly-box').dataset.activitySource === 'ambient');
      sockets[0].send(JSON.stringify(['EVENT', 'fly', quiet]));
      await page.waitForTimeout(200); assert.equal(await box.getAttribute('data-activity-source'), 'ambient', 'Quiet reports do not stop exploring');
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    results.push({ device: name, visibleOnArrival: true, autonomousFlight: true, pause: true, landingDrinkingRegurgitation: true, signedBrainInterrupt: !process.env.FLY_TEST_URL, errors, publications: writes.length });
    console.log(`${name}: visible arrival, flight, landing, drinking, regurgitation, pause and source labels pass`);
    await context.close();
  }
  if (!process.env.FLY_TEST_URL) {
    const history = await browser.newPage(), relays = [];
    await history.route(base, route => route.fulfill({ contentType: 'text/html', body: readFileSync('site/fly/index.html', 'utf8').replace(/const FLY = '[0-9a-f]{64}'/, `const FLY = '${escape.pubkey}'`) }));
    await history.routeWebSocket(/.*/, ws => relays.push(ws));
    await history.goto(base); await history.locator('[data-artwork="ready"]').waitFor();
    relays[0].send(JSON.stringify(['EVENT', 'fly', escape]));
    await history.waitForFunction(() => !document.querySelector('#last-note').classList.contains('empty'));
    assert.equal(await history.locator('#fly-box').getAttribute('data-activity-source'), 'ambient', 'Historical report cannot interrupt arrival');
    await history.locator('.motion-demos > summary').first().click(); await history.locator('#motion-live').click();
    await history.waitForFunction(() => document.querySelector('#motion-status').textContent.includes('Brain replay'));
    results.push({ historicalReportsDoNotInterruptArrival: true, explicitHistoricalReplay: true });
    await history.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await page.routeWebSocket(/.*/, () => {}); await page.goto(base); await page.locator('[data-artwork="ready"]').waitFor();
  const pixels = () => page.locator('canvas').evaluate(c => c.toDataURL());
  const still = await pixels(); await page.waitForTimeout(300); assert.equal(await pixels(), still);
  await page.locator('#feed-drop').click(); const fed = await pixels(); assert.notEqual(fed, still);
  await page.waitForTimeout(300); assert.equal(await pixels(), fed, 'Reduced motion keeps feeding as a still pose');
  await page.locator('#motion-pause').click(); await page.waitForFunction(() => document.querySelector('#fly-box').dataset.activitySource === 'ambient');
  // A failed payment cannot feed; a mocked successful payment is explicitly an illustration.
  await page.route('https://moneyer.dev/.well-known/lnurlp/fly', r => r.fulfill({ json: { tag: 'payRequest', minSendable: 1000, maxSendable: 10000000, callback: 'https://mint.invalid/invoice' } }));
  await page.route('https://mint.invalid/invoice?*', r => r.fulfill({ json: { pr: 'synthetic-test-invoice' } }));
  await page.evaluate(() => { window.webln = { enable: async () => {}, sendPayment: async () => { throw Error('Cancelled test payment'); } }; });
  await page.locator('#zap-button').click(); await page.waitForFunction(() => document.querySelector('#zap-status').textContent.includes('Cancelled test payment'));
  assert.equal(await page.locator('#fly-box').getAttribute('data-activity-source'), 'ambient');
  await page.evaluate(() => { window.webln.sendPayment = async invoice => { if (invoice !== 'synthetic-test-invoice') throw Error('Unexpected invoice'); }; });
  await page.locator('#zap-button').click(); await page.waitForFunction(() => document.querySelector('#motion-status').textContent.includes('Payment confirmed'));
  assert.equal(await page.locator('#crop').textContent(), '0 sats', 'Visual feeding does not invent a ledger balance');
  results.push({ reducedMotion: true, rejectedPaymentDoesNotFeed: true, mockedPaymentFeeds: true });
} finally { await browser.close(); }
writeFileSync('captures-out/fly-living/checks.json', JSON.stringify(results, null, 2) + '\n');
