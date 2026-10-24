// Manual DOM regression for the zero-video / moving-peer-arrows report.
// These are explicit input observations, not a simulated media benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';

const output = process.argv[2] && resolve(process.argv[2]);
assert(output, 'Use node test/media-swarm-visual-browser.mjs PRIVATE-RECEIPT.json');
const receipt = { measuredAt: new Date().toISOString(), scope: 'Graph rendering regression with explicit observation inputs; no media or peers simulated as real',
  passed: false, checks: {}, pageErrors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', error => receipt.pageErrors.push(String(error)));
  await page.route('https://forgesworn.dev/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/graph-regression') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}#map{width:100%;height:400px}</style><div id="map"></div>' });
    assert(['/media-swarm-visual.mjs', '/media-transfer-stats.mjs'].includes(path));
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../site' + path, import.meta.url)) });
  });
  await page.goto('https://forgesworn.dev/graph-regression');
  receipt.checks.controlOnly = await page.evaluate(async () => {
    const { createSwarmVisual } = await import('/media-swarm-visual.mjs');
    const map = document.getElementById('map');
    window.visual = createSwarmVisual(map);
    window.observations = { active: true, playing: true, enabled: true, serving: true, peerBytes: 0, uploadedBytes: 0, originBytes: 0,
      topology: { connections: [{ id: 'peer-1', state: 'connected', bytesSent: 1008, bytesReceived: 279479 }] } };
    visual.update(observations);
    return { peerNodes: map.querySelectorAll('[data-peer-id]').length, flights: map.querySelectorAll('[data-flight-source]').length,
      label: map.querySelector('[data-peer-id] .swarm-sub').textContent };
  });
  assert.deepEqual(receipt.checks.controlOnly, { peerNodes: 1, flights: 0, label: '0 B to them · 0 B to you' });
  receipt.checks.hostOnly = await page.evaluate(() => {
    observations.originBytes = 6206410; visual.update(observations);
    return { hostFlights: document.querySelectorAll('[data-flight-source="origin"]').length,
      peerFlights: document.querySelectorAll('[data-flight-source^="peer-"]').length };
  });
  assert.equal(receipt.checks.hostOnly.hostFlights, 1); assert.equal(receipt.checks.hostOnly.peerFlights, 0);
  receipt.checks.media = await page.evaluate(() => {
    Object.assign(observations.topology.connections[0], { mediaBytesSent: 918, verifiedMediaBytesReceived: 6206410 });
    Object.assign(observations, { uploadedBytes: 918, peerBytes: 6206410 }); visual.update(observations);
    return { up: document.querySelector('[data-flight-source="peer-upload"]').dataset.bytes,
      down: document.querySelector('[data-flight-source="peer-download"]').dataset.bytes,
      label: document.querySelector('[data-peer-id] .swarm-sub').textContent };
  });
  assert.deepEqual(receipt.checks.media, { up: '918', down: '6206410', label: '918 B to them · 6.2 MB to you' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('svg').getAttribute('viewBox') === '0 0 520 390');
  receipt.checks.resize = await page.evaluate(() => ({ flights: document.querySelectorAll('[data-flight-source]').length,
    label: document.querySelector('[data-peer-id] .swarm-sub').textContent }));
  assert.equal(receipt.checks.resize.flights, 0); assert.equal(receipt.checks.resize.label, receipt.checks.media.label);
  receipt.checks.paused = await page.evaluate(() => {
    observations.playing = false; observations.topology.connections = []; visual.update(observations);
    return { peerNodes: document.querySelectorAll('[data-peer-id]').length, flights: document.querySelectorAll('[data-flight-source]').length };
  });
  assert.deepEqual(receipt.checks.paused, { peerNodes: 0, flights: 0 });
  await page.evaluate(() => visual.destroy());
  assert.equal(receipt.pageErrors.length, 0);
  receipt.passed = true;
} catch (error) { receipt.failure = String(error); process.exitCode = 1; }
finally {
  await browser?.close(); receipt.browserClosed = true;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks, browserClosed: true }));
}
