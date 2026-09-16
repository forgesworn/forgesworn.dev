// Isolated browser, mocked signer and intercepted relays. No public posts.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { safeShot } from '../shotguard.mjs';
const base = process.env.FLY_TEST_URL || 'http://127.0.0.1:8826/fly/';
const out = 'captures-out/fly-onboarding';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (const [name,width,height] of [['desktop',1440,1000],['phone',390,844],['small-phone',320,740]]) {
    const page = await browser.newPage({ viewport:{width,height}, reducedMotion:'reduce' });
    const posts = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket(/.*/, ws => ws.onMessage(m => {
      const frame = JSON.parse(String(m));
      if (frame[0] === 'EVENT') posts.push(frame[1]);
    }));
    await page.route('https://moneyer.dev/**', r => r.abort());
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#fly-box').dataset.artwork === 'ready');
    assert.ok(await page.locator('#zap-button').evaluate(e => e.getBoundingClientRect().bottom < innerHeight), 'Feeding remains beside the visible fly');
    assert.ok(await page.locator('.participation-teaser a').isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    await safeShot(page, `${out}/${name}-arrival.png`);
    await page.locator('.participation-teaser a').click();
    assert.equal(posts.length,0, 'Reading about participation sends nothing');
    await page.locator('#mention-fly').click();
    assert.ok(await page.locator('#signer-help').isVisible());
    assert.equal(posts.length,0, 'Missing signer sends nothing');
    await page.locator('#signer-help a').click();
    assert.equal(new URL(page.url()).hash, '#install');
    assert.equal(await page.locator('.install-grid article').count(),3);
    assert.equal(await page.locator('.install-grid a[href*="chromewebstore.google.com"]').count(),1);
    assert.equal(await page.locator('.install-grid a[href*="addons.mozilla.org"]').count(),1);
    await safeShot(page, `${out}/${name}-install.png`);
    // Signing rejection is visible and permits a retry; signing requires a click.
    await page.evaluate(() => { window.nostr = {signEvent:async () => {throw new Error('User declined');}}; });
    await page.locator('#mention-fly').click();
    assert.match(await page.locator('#mention-status').textContent(), /wasn’t signed/);
    assert.equal(posts.length,0);
    await page.evaluate(() => { window.nostr = {signEvent:async event => event}; });
    assert.equal(posts.length,0, 'Installing a signer never automatically posts');
    await page.locator('#mention-fly').click();
    await page.waitForFunction(() => document.querySelector('#mention-status').textContent.startsWith('Mention signed.'));
    await page.waitForTimeout(200);
    assert.equal(posts.length,4, 'Explicit click sends to the four intercepted relays');
    for (const event of posts) {
      assert.equal(event.kind,1); assert.equal(event.content,'sugar');
      assert.deepEqual(event.tags,[['p','4e03e8814728eaba5f172ec94b3901d9d8ed012bd4f0ea043cc356e66893047e']]);
    }
    assert.equal(await page.locator('#signer-help').isVisible(),false);
    assert.deepEqual(errors,[]);
    results.push({name,feedingVisible:true,installLinks:true,noOverflow:true,missingSignerHelp:true,approvalRetry:true,taggedMention:true,publicPosts:0});
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync(`${out}/checks.json`,JSON.stringify({base,results},null,2)+'\n');
console.log(JSON.stringify(results,null,2));
