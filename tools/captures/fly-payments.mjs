// Synthetic mint, intercepted relays and mocked wallet only. No public writes.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { safeShot } from '../shotguard.mjs';
const f = JSON.parse(readFileSync('test/fixtures/fly-confirmed-zap.json'));
const base = process.env.FLY_TEST_URL || 'http://127.0.0.1:8826/fly/';
const html = readFileSync('site/fly/index.html','utf8').replace(/const FLY = '[0-9a-f]{64}'/, `const FLY = '${f.recipient}'`).replace(/const LNURL = '[^']+'/, `const LNURL = '${f.lnurl}'`).replace('const openedAt = Math.floor(Date.now() / 1000);', 'const openedAt = 0;');
mkdirSync('captures-out/fly-payments', { recursive: true });
const browser = await chromium.launch(), results = [];
try {
  for (const [name, width, height, kind] of [['desktop',1440,1000,'receipt'],['phone',390,844,'brain']]) {
    const page = await browser.newPage({ viewport: { width, height } }), sockets = [], writes = [], errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    page.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
    await page.route(base, r => r.fulfill({contentType:'text/html',body:html}));
    await page.routeWebSocket(/.*/, ws => { sockets.push(ws); ws.onMessage(m => { if (String(m).includes('"EVENT"')) writes.push(m); }); });
    await page.route('https://moneyer.dev/.well-known/lnurlp/fly', r => r.fulfill({json:{tag:'payRequest',allowsNostr:true,nostrPubkey:f.provider,minSendable:3000,maxSendable:10000000,callback:'https://mint.invalid/invoice'}}));
    await page.goto(base); await page.waitForFunction(() => document.querySelector('#fly-box').dataset.artwork || document.querySelector('#motion-status').textContent === 'Loading the fly…', null, {timeout:10000});
    await page.waitForFunction(() => ['ready','failed'].includes(document.querySelector('#fly-box').dataset.artwork));
    assert.equal(await page.locator('#fly-box').getAttribute('data-artwork'), 'ready');
    assert.ok(await page.locator('#zap-button').evaluate(e => e.getBoundingClientRect().bottom < innerHeight));
    assert.ok(await page.locator('#fly-box').evaluate(e => e.getBoundingClientRect().top >= 0));
    await page.locator('[data-amount="21"]').click(); assert.equal(await page.locator('#zap-button').textContent(), 'Zap 21 sats');
    await page.locator('#zap-button').click(); assert.ok(await page.locator('#wallet-options').evaluate(e => e.open), 'No browser wallet reveals QR beside the fly');
    const send = e => sockets[0].send(JSON.stringify(['EVENT','fly',e]));
    send(f.invalid.wrongProvider); await page.waitForTimeout(300);
    assert.equal(await page.locator('#fly-box').getAttribute('data-activity-source'), 'ambient');
    assert.equal(await page.locator('#feed-list .zap').count(), 0, 'Untrusted mint cannot invent a zap');
    // Receipt must queue if a free feeding interaction is already active.
    if (kind === 'receipt') {
      await page.locator('#wallet-options').evaluate(e => { e.open = false; });
      await page.locator('#feed-drop').click(); send(f.receipt);
    } else send(f.plainPaymentReport);
    await page.waitForFunction(kind => document.querySelector('#motion-status').textContent.includes(kind === 'receipt' ? 'Mint confirmed 210 sats' : 'Fly confirmed 19 sats'), kind, {timeout:20000});
    assert.equal(await page.locator('#wallet-options').evaluate(e => e.open), false);
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.motion === 'feed');
    assert.ok(Number(await page.locator('#fly-box').getAttribute('data-food')) > 0);
    await page.locator('#motion-pause').click();
    await safeShot(page, `captures-out/fly-payments/${name}-paid-feeding.png`, {allow:[f.recipient,f.provider]});
    await page.locator('#motion-pause').click();
    await page.waitForFunction(() => Number(document.querySelector('#fly-box').dataset.drop) > .5);
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.activitySource === 'ambient');
    if (kind === 'receipt') {
      send(f.receipt); await page.waitForTimeout(300);
      assert.equal(await page.locator('#fly-box').getAttribute('data-activity-source'), 'ambient', 'Duplicate receipt cannot feed twice');
      await page.route('https://mint.invalid/invoice?*', r => r.fulfill({json:{pr:f.receipt.tags.find(t=>t[0]==='bolt11')[1]}}));
      await page.evaluate(() => { window.webln = {enable:async()=>{},sendPayment:async()=>({})}; });
      await page.locator('#zap-button').click(); await page.waitForFunction(() => document.querySelector('#zap-status').textContent.startsWith('Paid.'));
      assert.equal(await page.locator('#fly-box').getAttribute('data-activity-source'), 'ambient', 'Wallet completion for the same invoice cannot repeat receipt feeding');
    }
    assert.deepEqual(writes,[]); assert.deepEqual(errors,[]);
    results.push({name,source:kind,controlsAndFlyVisible:true,confirmedPaymentDrinksAndRegurgitates:true,duplicatesIgnored:kind==='receipt',noPublicWrites:true});
    await page.close(); console.log(`${name}: ${kind} confirmation feeds, regurgitates and keeps payment controls beside the fly`);
  }
  const history = await browser.newPage({reducedMotion:'reduce'}), relays = [];
  await history.route(base, r => r.fulfill({contentType:'text/html',body:html.replace('const openedAt = 0;', 'const openedAt = Math.floor(Date.now() / 1000);')}));
  await history.routeWebSocket(/.*/, ws => relays.push(ws));
  await history.goto(base); await history.waitForFunction(() => document.querySelector('#fly-box').dataset.artwork === 'ready');
  relays[0].send(JSON.stringify(['EVENT','fly',f.plainPaymentReport]));
  await history.locator('#replay-feeding').waitFor();
  assert.equal(await history.locator('#fly-box').getAttribute('data-activity-source'), 'ambient', 'Historical payments do not interrupt arrival');
  await history.locator('#replay-feeding').click();
  assert.match(await history.locator('#motion-status').textContent(), /Replay.*Fly confirmed 19 sats/);
  assert.ok(Number(await history.locator('#fly-box').getAttribute('data-food')) > 0, 'Replay lets the visitor see feeding without paying again');
  results.push({historicalPaymentReplay:true,noNewPaymentRequired:true});
  await history.close();
} finally { await browser.close(); }
writeFileSync('captures-out/fly-payments/checks.json', JSON.stringify(results,null,2)+'\n');
