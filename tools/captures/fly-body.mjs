// Actual offline neural runs plus a synthetic signer. No public writes.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { safeShot } from '../shotguard.mjs';
const escape = JSON.parse(readFileSync('test/fixtures/fly-escape-event.json'));
const html = readFileSync('site/fly/index.html', 'utf8').replace(/const FLY = '[0-9a-f]{64}'/, `const FLY = '${escape.pubkey}'`);
mkdirSync('captures-out/fly-body', { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [name, width] of [['desktop', 1440], ['phone', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(), sockets = [], errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://127.0.0.1:8826/fly/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.routeWebSocket(/.*/, ws => { sockets.push(ws); ws.onMessage(m => { if (String(m).includes('"EVENT"')) writes.push(m); }); });
    await page.goto('http://127.0.0.1:8826/fly/');
    await page.locator('[data-artwork="ready"]').waitFor();
    await page.locator('#fly-box').scrollIntoViewIfNeeded();
    await safeShot(page, `captures-out/fly-body/${name}-rest.png`, { allow: [escape.pubkey] });
    sockets[0].send(JSON.stringify(['EVENT', 'fly', escape]));
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'flight');
    assert.ok(Number(await page.locator('#fly-box').getAttribute('data-altitude')) > .17);
    await safeShot(page, `captures-out/fly-body/${name}-flight.png`, { allow: [escape.pubkey] });
    await page.locator('#motion-pause').click();
    const still = await page.locator('canvas').evaluate(c => c.toDataURL());
    await page.waitForTimeout(250);
    assert.equal(await page.locator('canvas').evaluate(c => c.toDataURL()), still);
    await page.locator('#motion-pause').click();
    await page.locator('#fly-box').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'landing');
    await safeShot(page, `captures-out/fly-body/${name}-landing.png`, { allow: [escape.pubkey] });
    await page.waitForFunction(() => document.querySelector('#motion-status').textContent.includes('replay complete'));
    assert.equal(await page.locator('#fly-box').getAttribute('data-altitude'), '0.00000');
    await page.locator('[data-brain-recording="retreat"]').click();
    await page.locator('#fly-box').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'backward');
    assert.match(await page.locator('#motion-status').textContent(), /Recorded brain response/);
    await safeShot(page, `captures-out/fly-body/${name}-retreat.png`, { allow: [escape.pubkey] });
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    results.push({ device: name, signedEscapeTakeoffFlightLanding: true, pause: true, recordedRetreat: true, publications: writes.length, errors });
    console.log(`${name}: signed escape takes off, flies, pauses and lands; recorded retreat stays labelled`);
    await context.close();
  }
} finally { await browser.close(); }
writeFileSync('captures-out/fly-body/checks.json', JSON.stringify(results, null, 2) + '\n');
