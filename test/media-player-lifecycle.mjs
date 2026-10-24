// Manual orchestration regression test: node test/media-player-lifecycle.mjs
// Uses the real landing page and player controller. The peer/media adapters
// below are explicit fixtures, not evidence of WebRTC or decoded playback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../site/', import.meta.url));
const catalogue = { clips: {
  rtmp: { playlist: 'rtmp/index.m3u8', manifest: 'rtmp/segments.json' },
  srt: { playlist: 'srt/index.m3u8', manifest: 'srt/segments.json' },
} };
const hlsFixture = `
export default class Hls {
  static Events = { FRAG_LOADED: 'fragment', ERROR: 'error' };
  static isSupported() { return true; }
  constructor() { this.handlers = new Map(); this.destroyed = false; }
  on(name, handler) { this.handlers.set(name, handler); }
  attachMedia(video) { this.video = video; }
  loadSource(url) {
    this.video.setAttribute('src', url);
    queueMicrotask(() => {
      if (!this.destroyed) this.handlers.get(Hls.Events.FRAG_LOADED)?.('fragment', { payload: new Uint8Array(1024) });
    });
  }
  destroy() { this.destroyed = true; this.handlers.clear(); }
}
`;
const peerFixture = `
export async function startPeerDemo({ video, signal, onStats }) {
  const state = window.__playerFixture;
  if (state.failNextStart) { state.failNextStart = false; throw new Error('Fixture peer unavailable'); }
  const record = { id: state.sessions.length + 1, closed: false, stopRequested: false };
  state.sessions.push(record);
  record.emit = (overrides = {}) => onStats({
    phase: 'peer', viewer: { peerBytes: record.id * 1024, verifiedPeerSegments: record.id, connectedPeers: 1 },
    transport: { selectedPairs: [] }, ...overrides,
  });
  const stop = () => {
    record.stopRequested = true;
    if (!record.completion) {
      record.completion = new Promise(resolve => { record.releaseStop = () => {
        record.closed = true; signal.removeEventListener('abort', stop); resolve();
      }; });
      if (!state.deferStops) record.releaseStop();
    }
    return record.completion;
  };
  signal.addEventListener('abort', stop, { once: true });
  video.setAttribute('src', '/fixture-video-' + record.id + '.mp4');
  record.emit();
  if (state.deferStartup) await new Promise(resolve => { record.releaseStartup = resolve; });
  if (signal.aborted) await stop();
  return { stop };
}
`;
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const send = (type, body) => { response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body); };
    if (pathname === '/vendor/hls.light.min.mjs') return send('application/javascript', hlsFixture);
    if (pathname === '/media-peer-demo.mjs') return send('application/javascript', peerFixture);
    if (/^\/media\/(?:demo|dejavu-preview)\/manifest\.json$/.test(pathname)) return send('application/json', JSON.stringify(catalogue));
    if (/^\/media\/(?:demo|dejavu-preview)\/(rtmp|srt)\/segments\.json$/.test(pathname)) return send('application/json', '{"schema":1,"segments":[]}');
    if (pathname.startsWith('/fixture-video-')) { response.writeHead(204); return response.end(); }
    const target = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!target.startsWith(resolve(root) + sep)) { response.writeHead(404); return response.end(); }
    return send(mime[extname(target)] || 'application/octet-stream', await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
const completed = [];

async function freshPage() {
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  await page.addInitScript(() => {
    window.__playerFixture = { sessions: [], deferStops: false, deferStartup: false, failNextStart: false };
    // Native media is deliberately stubbed; these tests exercise ownership,
    // cancellation and visible counters, not a synthetic playback success.
    HTMLMediaElement.prototype.play = function () {
      return window.__playerFixture.blockPlayback
        ? Promise.reject(new DOMException('Fixture requires a play gesture', 'NotAllowedError'))
        : Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/media-peer-fixture.html`, { waitUntil: 'networkidle', timeout: 10000 });
  return page;
}
async function playing(page, count) {
  await page.waitForFunction(count => window.__playerFixture.sessions.length === count && !document.getElementById('demo-start').disabled,
    count, { timeout: 4000 });
}
async function run(name, check) {
  const page = await freshPage();
  try { await check(page); completed.push(name); }
  finally {
    await page.evaluate(async () => {
      const state = window.__playerFixture;
      state.deferStops = false;
      for (const session of state.sessions) { session.releaseStartup?.(); session.releaseStop?.(); }
      document.getElementById('demo-stop').click();
    }).catch(() => {});
    await page.close();
  }
}

try {
  browser = await chromium.launch({ headless: true, timeout: 15000 });
  await run('double Replay creates one replacement session', async page => {
    await page.evaluate(() => { const button = document.getElementById('demo-start'); button.click(); button.click(); });
    await playing(page, 1);
    await page.evaluate(() => {
      window.__playerFixture.deferStops = true;
      const button = document.getElementById('demo-start'); button.click(); button.click();
    });
    await page.waitForFunction(() => window.__playerFixture.sessions[0].stopRequested);
    assert.equal(await page.evaluate(() => window.__playerFixture.sessions.length), 1);
    assert.equal(await page.locator('#demo-start').isDisabled(), true);
    await page.evaluate(() => window.__playerFixture.sessions[0].releaseStop());
    await playing(page, 2);
    assert.deepEqual(await page.evaluate(() => window.__playerFixture.sessions.map(session => session.closed)), [true, false]);
    await page.evaluate(() => window.__playerFixture.sessions[0].emit({ viewer: { peerBytes: 999999, verifiedPeerSegments: 999, connectedPeers: 99 } }));
    assert.equal(await page.locator('#demo-fragments').innerText(), '2');
    assert.equal(await page.locator('#demo-peers').innerText(), '1');
  });

  await run('Stop overtakes delayed Replay without clearing a later session', async page => {
    await page.locator('#demo-start').click(); await playing(page, 1);
    await page.evaluate(() => { window.__playerFixture.deferStops = true; document.getElementById('demo-start').click(); });
    await page.waitForFunction(() => window.__playerFixture.sessions[0].stopRequested);
    await page.locator('#demo-stop').click();
    await page.waitForFunction(() => !document.getElementById('demo-start').disabled);
    await page.locator('#demo-start').click(); await playing(page, 2);
    await page.evaluate(() => window.__playerFixture.sessions[0].releaseStop());
    await page.waitForFunction(() => window.__playerFixture.sessions[0].closed);
    assert.equal(await page.locator('#media-video').getAttribute('src'), '/fixture-video-2.mp4');
    assert.equal(await page.evaluate(() => window.__playerFixture.sessions.length), 2);
    assert.deepEqual(await page.evaluate(() => window.__playerFixture.sessions.map(session => session.closed)), [true, false]);
  });

  await run('Stop during setup and pagehide close owned sessions', async page => {
    await page.evaluate(() => { window.__playerFixture.deferStartup = true; document.getElementById('demo-start').click(); });
    await page.waitForFunction(() => window.__playerFixture.sessions.length === 1);
    await page.locator('#demo-stop').click();
    await page.waitForFunction(() => window.__playerFixture.sessions[0].closed);
    await page.evaluate(() => window.__playerFixture.sessions[0].releaseStartup());
    await page.waitForFunction(() => !document.getElementById('demo-start').disabled);
    assert.equal(await page.locator('#media-video').getAttribute('src'), null);
    assert.equal(await page.locator('#demo-peers').innerText(), '0');
    await page.evaluate(() => { window.__playerFixture.deferStartup = false; document.getElementById('demo-start').click(); });
    await playing(page, 2);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.waitForFunction(() => window.__playerFixture.sessions.every(session => session.closed));
    assert.equal(await page.locator('#media-video').getAttribute('src'), null);
    assert.equal(await page.locator('#demo-peers').innerText(), '0');
  });

  await run('origin fallback never reports origin fragments as verified peer media', async page => {
    await page.evaluate(() => { window.__playerFixture.failNextStart = true; document.getElementById('demo-start').click(); });
    await page.waitForFunction(() => document.getElementById('demo-transport').textContent === 'HLS origin');
    assert.equal(await page.locator('#demo-fragments').innerText(), '0');
    assert.match(await page.locator('#demo-bytes').innerText(), /^0 (KB|B)$/);
    assert.equal(await page.locator('#demo-peers').innerText(), '0');
    await page.locator('#demo-stop').click();
    await page.waitForFunction(() => document.getElementById('demo-transport').textContent === 'Stopped');
  });

  await run('cached relay candidates do not label origin fallback as Spry traffic', async page => {
    await page.locator('#demo-start').click(); await playing(page, 1);
    await page.evaluate(() => window.__playerFixture.sessions[0].emit({ phase: 'origin-fallback',
      transport: { selectedPairs: [{ localType: 'relay', remoteType: 'relay' }] } }));
    assert.equal(await page.locator('#demo-transport').innerText(), 'HLS origin');
    await page.locator('#demo-stop').click();
    await page.waitForFunction(() => document.getElementById('demo-transport').textContent === 'Stopped');
    assert.equal(await page.locator('#demo-peers').innerText(), '0');
  });

  await run('browser policy keeps audible controls and prepared media without silently muting', async page => {
    await page.evaluate(() => { window.__playerFixture.blockPlayback = true; });
    await page.locator('#demo-start').click(); await playing(page, 1);
    assert.equal(await page.locator('#media-video').getAttribute('src'), '/fixture-video-1.mp4');
    assert.equal(await page.evaluate(() => document.getElementById('media-video').muted), false);
    assert.equal(await page.evaluate(() => window.__playerFixture.sessions[0].closed), false);
    assert.match(await page.locator('#demo-status').innerText(), /Press play on the video.*sound/);
    await page.evaluate(() => window.__playerFixture.sessions[0].emit());
    assert.match(await page.locator('#demo-status').innerText(), /Press play on the video.*sound/);
    await page.evaluate(() => {
      window.__playerFixture.blockPlayback = false;
      document.getElementById('media-video').dispatchEvent(new Event('playing'));
    });
    assert.equal(await page.locator('#demo-status').innerText(), 'Playing the demo.');
    await page.locator('#demo-stop').click();
    await page.waitForFunction(() => window.__playerFixture.sessions[0].closed);
  });
  console.log(JSON.stringify({ suite: 'media-player-lifecycle', checks: completed, count: completed.length,
    scope: 'Production page/controller with explicitly mocked peer/media adapters; not decoded-media or WebRTC acceptance.' }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
