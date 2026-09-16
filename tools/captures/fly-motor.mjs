// Synthetic signer and intercepted relays; no keys, payments or posts on the network.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { safeShot } from '../shotguard.mjs';
const fixture = name => JSON.parse(readFileSync(`test/fixtures/fly-${name}-event.json`));
const brain = fixture('motor'), zap = fixture('zap'), quiet = fixture('quiet'), walk = fixture('walk');
const html = readFileSync('site/fly/index.html', 'utf8').replace(/const FLY = '[0-9a-f]{64}'/, `const FLY = '${brain.pubkey}'`);
mkdirSync('captures-out/fly-motor', { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, reducedMotion] of [['desktop', 1440, 'no-preference'], ['phone', 390, 'reduce']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion });
    const page = await context.newPage(), sockets = [], errors = [], publications = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://127.0.0.1:8826/fly/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.routeWebSocket(/.*/, ws => {
      sockets.push(ws);
      ws.onMessage(m => { if (String(m).includes('"EVENT"')) publications.push(m); });
    });
    await page.goto('http://127.0.0.1:8826/fly/');
    await page.locator('[data-artwork="ready"]').waitFor();
    await page.locator('#stage').evaluate(el => el.scrollIntoView());
    const pixels = () => page.locator('canvas').evaluate(c => c.toDataURL());
    const initial = await pixels();
    await page.waitForTimeout(3800);
    assert.equal(await pixels(), initial, 'No autonomous flight without telemetry');
    await page.locator('#poke-fly').click();
    await page.locator('#stage').evaluate(el => el.scrollIntoView());
    assert.equal(await pixels(), initial, 'A local poke must wait for the brain');
    // A successful wallet result is still sensory input, never motor output.
    await page.route('https://moneyer.dev/.well-known/lnurlp/fly', route => route.fulfill({ json: { tag: 'payRequest', minSendable: 1000, maxSendable: 10000000, callback: 'https://mint.invalid/invoice' } }));
    await page.route('https://mint.invalid/invoice?*', route => route.fulfill({ json: { pr: 'synthetic-test-invoice' } }));
    await page.evaluate(() => { window.webln = { enable: async () => {}, sendPayment: async invoice => { if (invoice !== 'synthetic-test-invoice') throw Error('Unexpected invoice'); window.testPaymentCalls = (window.testPaymentCalls || 0) + 1; } }; });
    await page.locator('#zap-button').click();
    await page.waitForFunction(() => document.querySelector('#zap-status').textContent.startsWith('Paid.'));
    assert.equal(await page.evaluate(() => window.testPaymentCalls), 1);
    await page.locator('#stage').evaluate(el => el.scrollIntoView());
    assert.equal(await pixels(), initial, 'Successful wallet payment waits for the brain');
    const send = e => sockets[0].send(JSON.stringify(['EVENT', 'fly', e]));
    send(zap); await page.waitForTimeout(150);
    assert.equal(await pixels(), initial, 'Payment receipt is not a motor report');
    send({ ...brain, content: brain.content + 'tampered' }); await page.waitForTimeout(150);
    assert.equal(await pixels(), initial, 'Forged motor report must not move the fly');
    send(brain);
    await page.waitForFunction(() => document.querySelector('#motion-status').textContent.includes('Brain replay'));
    await page.waitForTimeout(120);
    assert.notEqual(await pixels(), initial, 'Authenticated motor report drives its pose');
    await safeShot(page, `captures-out/fly-motor/${name}.png`, { allow: [brain.pubkey] });
    if (reducedMotion === 'reduce') {
      const still = await pixels(); await page.waitForTimeout(250); assert.equal(await pixels(), still);
      await page.locator('#motion-pause').click();
    }
    await page.waitForFunction(() => document.querySelector('#motion-status').textContent.includes('replay complete'));
    const completed = await pixels(); await page.waitForTimeout(300); assert.equal(await pixels(), completed, 'Replay stops');
    const startX = Number(await page.locator('#fly-box').getAttribute('data-position'));
    send(walk);
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.turnBalance === '-100');
    // Heading now turns continuously; allow the articulated body to finish the
    // turn before checking travel, rather than expecting a one-frame mirror flip.
    await page.waitForFunction(start => Number(document.querySelector('#fly-box').dataset.position) < start - .001, startX);
    send(quiet); await page.waitForTimeout(150);
    const quietX = await page.locator('#fly-box').getAttribute('data-position');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#fly-box').getAttribute('data-position'), quietX, 'Quiet report preserves position');
    assert.equal(await page.locator('#fly-box').getAttribute('data-motor'), '0,0,0,0,0,0');
    assert.deepEqual(publications, []); assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log(`${name}: idle/poke/payment/forgery stay still; signed motor report replays; quiet report stays still`);
    await context.close();
  }
} finally { await browser.close(); }
