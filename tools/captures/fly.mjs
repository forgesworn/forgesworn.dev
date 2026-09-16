// Run with Playwright installed locally. Fresh, offline browser context; no signer.
import { chromium } from 'playwright';
import { safeShot } from '../shotguard.mjs';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const out = process.env.SHOT_OUT || 'captures-out/fly';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [['desktop', 1440, 1080], ['mobile', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.routeWebSocket(/.*/, socket => socket.close());
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(process.env.FLY_PREVIEW_URL || 'http://127.0.0.1:8826/fly/');
    await page.locator('[data-artwork="ready"]').waitFor();
    await page.locator('#stage').scrollIntoViewIfNeeded();
    const still = await page.locator('canvas').evaluate(c => c.toDataURL());
    await page.waitForTimeout(250);
    assert.equal(await page.locator('canvas').evaluate(c => c.toDataURL()), still, 'Reduced motion must remain still');
    for (const mode of ['rest', 'feed', 'share']) {
      if (mode !== 'rest') await page.locator(`[data-fly-preview="${mode}"]`).click();
      await safeShot(page, `${out}/${name}-${mode}.png`);
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: horizontal overflow`);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`${name}: artwork loaded, preview controls work, no overflow or page errors`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1000, height: 940 }, recordVideo: { dir: `${out}/video`, size: { width: 1000, height: 940 } } });
  const page = await context.newPage();
  const errors = [], publications = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    if (String(message).includes('"EVENT"')) publications.push(message);
  }));
  await page.goto(process.env.FLY_PREVIEW_URL || 'http://127.0.0.1:8826/fly/');
  await page.locator('[data-artwork="ready"]').waitFor();
  await page.locator('#stage').evaluate(el => el.scrollIntoView());
  await page.locator('[data-fly-preview="flight"]').click();
  await page.waitForTimeout(1500);
  await safeShot(page, `${out}/desktop-flight.png`);
  await page.locator('[data-motion="landing"]').waitFor();
  await safeShot(page, `${out}/desktop-landing.png`);
  await page.locator('[data-motion="groom"]').waitFor();
  await page.locator('[data-fly-preview="feed"]').click();
  await page.waitForTimeout(2600);
  await page.locator('[data-fly-preview="share"]').click();
  await page.waitForTimeout(2200);
  await safeShot(page, `${out}/desktop-regurgitating.png`);
  await page.locator('#motion-pause').click();
  const frozen = await page.locator('canvas').evaluate(c => c.toDataURL());
  await page.waitForTimeout(300);
  assert.equal(await page.locator('canvas').evaluate(c => c.toDataURL()), frozen, 'Pause must stop animation');
  assert.equal(publications.length, 0, 'Previews must never publish Nostr events');
  assert.deepEqual(errors, []);
  const video = page.video();
  await context.close();
  await video.saveAs(`${out}/fly-motion.webm`);
  console.log('motion: flight → landing → grooming; feeding, sharing, pause and no-publication checks passed');
} finally { await browser.close(); }
