// Actual homepage/controller with explicit room, HLS and media-state fixtures.
// This checks startup orchestration, not decoded playback or peer delivery.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const origin = 'https://forgesworn.dev';
const fixtures = {
  '/vendor/hls.light.min.mjs': `export default class Hls {
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static isSupported() { return true; }
    constructor() { this.handlers = new Map(); window.fixture.players.push(this); }
    on(event, handler) { this.handlers.set(event, handler); }
    loadSource() {}
    attachMedia(video) { this.video = video; queueMicrotask(() => this.handlers.get('manifest')?.()); }
    startLoad() {}
    destroy() { this.destroyed = true; }
  }`,
  '/media-listener-session.mjs': `export function createListenerSession({ onChange }) {
    let joined = false;
    const snapshot = () => ({ ready: true, observed: true, connectedRelays: 1, joined,
      listeners: joined ? 1 : 0, epochId: 'fixture', position: 50, startedAt: 1 });
    const notify = () => onChange(snapshot());
    window.fixture.roomUpdate = notify;
    return { snapshot, position: () => 50, observe: notify,
      join: async () => { joined = true; notify(); }, leave: () => { joined = false; notify(); }, stop() {} };
  }`,
  '/media-public-swarm.mjs': `export const PUBLIC_SWARM_SOURCE_SHA256 = 'a'.repeat(64);
    export const PUBLIC_SWARM_RELAYS = [];
    export function createPublicSwarm() { return { setEnabled: async () => {}, metrics: () => null, stop() {} }; }`,
};
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (fixtures[url.pathname]) return route.fulfill({ contentType: 'text/javascript', body: fixtures[url.pathname] });
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) return route.abort();
    try { return await route.fulfill({ contentType: types[extname(path)] ?? 'application/octet-stream', body: await readFile(path) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.addInitScript(() => {
    window.fixture = { players: [], readyState: 1, ranges: [], plays: 0, paused: true, block: true };
    const state = window.fixture;
    Object.defineProperties(HTMLMediaElement.prototype, {
      readyState: { get: () => state.readyState }, duration: { get: () => 268.6 }, paused: { get: () => state.paused },
      buffered: { get: () => ({ length: state.ranges.length, start: i => state.ranges[i][0], end: i => state.ranges[i][1] }) },
    });
    HTMLMediaElement.prototype.play = function () {
      state.plays++;
      if (state.block) return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
      state.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () { state.paused = true; };
    HTMLMediaElement.prototype.load = function () {};
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#public-play').click();
  await page.waitForFunction(() => document.querySelector('#main').dataset.playbackPrime === 'buffering');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.fixture.roomUpdate());
    assert.equal(await page.locator('#public-play').innerText(), 'Loading the mix…');
    assert.equal(await page.locator('#public-play').isDisabled(), true);
  }
  await page.evaluate(() => { window.fixture.readyState = 4; window.fixture.ranges = [[0, 100]]; });
  await page.waitForFunction(() => window.fixture.plays === 1);
  assert.equal(await page.locator('#public-play').isDisabled(), false);
  assert.match(await page.locator('#lab-status').innerText(), /Press play/);
  assert.equal(await page.evaluate(() => window.fixture.players.length), 1);
  await page.evaluate(() => { window.fixture.block = false; });
  await page.locator('#public-play').click();
  await page.waitForFunction(() => !window.fixture.paused);
  assert.equal(await page.evaluate(() => window.fixture.players.length), 1, 'retry keeps the prepared player');
  assert.equal(await page.evaluate(() => window.fixture.players[0].destroyed === true), false);
  assert.equal(await page.evaluate(() => document.querySelector('#lab-video').muted), false);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(() => window.fixture.players[0].destroyed), true);
  console.log(JSON.stringify({ suite: 'media-showcase-lifecycle', passed: true,
    checks: ['priming label survives room updates', 'gesture retry preserves prepared player and sound', 'pagehide cleanup'],
    scope: 'Real homepage/controller; explicit room/HLS/media fixtures, no decoded playback or peer-delivery claim.' }));
} finally { await browser?.close(); }
