#!/usr/bin/env node
// Manual smoke of the actual page, with real media and independent visitors.
// Nostr is an explicitly local, bounded wire relay in this fixture. It does
// not qualify public relay availability, clock consensus or public-NAT paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, extname, dirname } from 'node:path';
import { chromium } from 'playwright';
import { verifyEvent, matchFilter } from '../site/vendor/media-peer-demo.js';

const options = { url: 'https://forgesworn.dev/', quality: 'preview' };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { '--url': 'url', '--quality': 'quality', '--site': 'site', '--output': 'output' }[process.argv[index]];
  assert(key && process.argv[index + 1], 'Use --output PRIVATE-RECEIPT.json [--site site] [--quality preview|full] [--url PAGE]');
  options[key] = ['site', 'output'].includes(key) ? resolve(process.argv[index + 1]) : process.argv[index + 1];
}
assert(options.output && ['preview', 'full'].includes(options.quality));
const url = new URL(options.url);
assert.equal(url.origin, 'https://forgesworn.dev');
const LEASE_MS = 24_000;
const ROOM_KIND = 30378;
const RELAYS = /^wss:\/\/(?:relay\.damus\.io|nos\.lol|relay\.primal\.net)\/?$/u;
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain' };
const clients = new Set(), addressable = new Map();
const wire = { published: 0, delivered: 0, rejected: 0, roomActive: 0, roomLeft: 0, reports: 0, connections: 0, closed: 0 };
const receipt = { schema: 1, at: new Date().toISOString(), passed: false, page: url.href, quality: options.quality,
  scenario: 'Actual page: delayed join, pause/rejoin, initiator departure, empty-room expiry and fresh visitor',
  candidateStaticRouting: Boolean(options.site), media: 'Unmodified remote film and real browser decoding',
  signalling: 'Bounded local Nostr wire relay using Playwright WebSocket routing; not public relays',
  moduleTimingOverrides: null, moduleDefaults: { discoveryMs: 1250, heartbeatMs: 6000, ttlMs: LEASE_MS,
    openTimeoutMs: 5000, publishTimeoutMs: 5000 },
  nativeWebRtc: true, hiddenHolders: 0, maximumConcurrentVisitors: 2, sources: [], phases: [], errors: [], cleanup: {} };
let browser, guard, stage = 'setup';
const contexts = new Set();
const deliver = (client, frame) => {
  try { client.route.send(JSON.stringify(frame)); wire.delivered++; } catch {}
};
const matches = (event, filter) => { try { return matchFilter(filter, event); } catch { return false; } };
function localRelay(route) {
  const client = { route, subscriptions: new Map() };
  clients.add(client); wire.connections++;
  route.onClose(() => { if (clients.delete(client)) wire.closed++; });
  route.onMessage(raw => {
    let frame;
    try { assert(typeof raw === 'string' && raw.length <= 128 * 1024); frame = JSON.parse(raw); assert(Array.isArray(frame)); }
    catch { wire.rejected++; return; }
    const [operation, id, filter] = frame;
    if (operation === 'CLOSE') { client.subscriptions.delete(id); return; }
    if (operation === 'REQ') {
      if (typeof id !== 'string' || client.subscriptions.size >= 16 || !filter || typeof filter !== 'object' || Array.isArray(filter)) { wire.rejected++; return; }
      client.subscriptions.set(id, filter);
      for (const event of addressable.values()) if (matches(event, filter)) deliver(client, ['EVENT', id, event]);
      deliver(client, ['EOSE', id]); return;
    }
    const event = id;
    try { assert(operation === 'EVENT' && [24170, 24171, ROOM_KIND, 20378].includes(event?.kind) && verifyEvent(event)); }
    catch { wire.rejected++; return; }
    wire.published++;
    if (event.kind === ROOM_KIND) {
      const address = event.tags.find(tag => tag[0] === 'd')?.[1];
      if (typeof address !== 'string') { wire.rejected++; return; }
      const key = `${event.pubkey}:${address}`, old = addressable.get(key);
      if (!old || event.created_at > old.created_at || event.created_at === old.created_at && event.id < old.id) addressable.set(key, event);
      if (addressable.size > 32) addressable.delete(addressable.keys().next().value);
      try { if (JSON.parse(event.content).status === 'left') wire.roomLeft++; else wire.roomActive++; } catch {}
    }
    if (event.kind === 20378) wire.reports++;
    // Signalling and telemetry are ephemeral and never replayed on a later REQ.
    deliver(client, ['OK', event.id, true, '']);
    for (const target of clients) for (const [subscription, requested] of target.subscriptions) {
      if (matches(event, requested)) deliver(target, ['EVENT', subscription, event]);
    }
  });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const root = document.getElementById('main'), video = document.getElementById('lab-video');
    return { state: root?.dataset.sharedSession, epoch: root?.dataset.sharedEpoch,
      startedAt: Number(root?.dataset.sharedStartedAt), position: Number(root?.dataset.sharedPosition),
      listeners: Number(root?.dataset.sharedListeners), status: document.getElementById('public-session-status')?.textContent,
      currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended,
      decodedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      videos: document.querySelectorAll('video').length, width: video.videoWidth,
      mediaSource: video.currentSrc,
      nativeConnections: window.__listenerSmokePcs.filter(connection => connection.connectionState !== 'closed').length,
      sockets: window.__listenerSmokeSockets.map(socket => ({ open: socket.readyState < 2 })),
    };
  });
}
async function visitor() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.add(context);
  if (options.site) await context.route(`${url.origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    // Film media remains on its real public host, including preview segments.
    if (/\.(?:m3u8|mp4|m4s)$/u.test(path)) return route.continue();
    if (path.startsWith('/lab/')) return route.abort();
    const file = resolve(options.site, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
    if (relative(options.site, file).startsWith('..')) return route.abort();
    try { return route.fulfill({ status: 200, contentType: mime[extname(file)] ?? 'application/octet-stream', body: await readFile(file) }); }
    catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  await context.routeWebSocket(RELAYS, localRelay);
  await context.addInitScript(() => {
    window.__listenerSmokeSockets = [];
    window.__listenerSmokePcs = [];
    const NativeSocket = WebSocket, NativePC = RTCPeerConnection;
    window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.__listenerSmokeSockets.push(this); } };
    window.RTCPeerConnection = class extends NativePC { constructor(...args) { super(...args); window.__listenerSmokePcs.push(this); } };
  });
  const page = await context.newPage();
  page.on('pageerror', error => receipt.errors.push(String(error)));
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const button = document.getElementById('public-play'); return button && !button.disabled; });
  await page.selectOption('#lab-quality', options.quality);
  const before = await snapshot(page);
  assert.equal(before.videos, 1); assert.equal(before.nativeConnections, 0, 'a room observer opens no WebRTC connection');
  assert.equal(before.mediaSource, '', 'a room observer does not load the film');
  assert.ok(before.sockets.filter(socket => socket.open).length <= 3, 'only bounded read-only room sockets may open before Play');
  return { context, page };
}
async function start(page) {
  const clickedAt = Date.now();
  await page.click('#public-play');
  await page.waitForFunction(() => {
    const root = document.getElementById('main'), video = document.getElementById('lab-video');
    return root?.dataset.sharedSession === 'live' && root.dataset.sharedEpoch && video.videoWidth > 0 &&
      video.currentTime > 0.1 && !video.paused && video.getVideoPlaybackQuality().totalVideoFrames > 0;
  }, undefined, { timeout: 25_000 });
  return { ...await snapshot(page), clickedAt };
}
const aligned = (a, b, message) => {
  assert(a.epoch && a.epoch === b.epoch, `${message}: different shared epoch`);
  assert.equal(a.startedAt, b.startedAt, `${message}: different epoch clock`);
  const difference = Math.abs(a.currentTime - b.currentTime);
  const distance = Number.isFinite(a.duration) && a.duration > 0 ? Math.min(difference, Math.abs(a.duration - difference)) : difference;
  assert.ok(distance < 3, `${message}: circular playback positions differ by ${distance.toFixed(2)}s`);
};
async function closeVisitor(value) { await value.context.close(); contexts.delete(value.context); }

try {
  if (options.site) for (const path of [url.pathname === '/' ? 'index.html' : url.pathname.slice(1), 'media-lab.mjs', 'media-listener-session.mjs', 'media-public-swarm.mjs']) {
    receipt.sources.push({ path, sha256: createHash('sha256').update(await readFile(resolve(options.site, path))).digest('hex') });
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  receipt.browserVersion = browser.version();
  const run = async () => {
    stage = 'first-play-creates-room';
    const a = await visitor(), first = await start(a.page); receipt.phases.push({ stage, first });
    assert.ok(first.epoch); assert.ok(first.startedAt >= first.clickedAt - 1000, 'an empty room creates a new clock after Play');
    assert.ok(Math.abs(first.currentTime - first.position) < 3, 'the first visitor follows the new clock');
    await a.page.waitForFunction(() => document.getElementById('lab-video').currentTime >= 6);
    stage = 'delayed-second-joins-current-position';
    const b = await visitor(), secondStart = await start(b.page);
    const joined = await Promise.all([snapshot(a.page), snapshot(b.page)]);
    receipt.phases.push({ stage, secondStart, players: joined });
    aligned(...joined, 'late join'); assert.ok(joined[1].currentTime > 3, 'late visitor must not restart at zero');
    stage = 'native-pause-and-resume-rejoins-edge';
    await b.page.evaluate(() => document.getElementById('lab-video').pause());
    await b.page.waitForFunction(() => document.getElementById('main').dataset.sharedSession === 'paused');
    const paused = await snapshot(b.page); await a.page.waitForTimeout(2_400);
    await b.page.evaluate(() => document.getElementById('lab-video').play());
    await b.page.waitForFunction(time => {
      const video = document.getElementById('lab-video'), delta = (video.currentTime - time + video.duration) % video.duration;
      return document.getElementById('main').dataset.sharedSession === 'live' && delta > 1.5 && delta < video.duration / 2;
    }, paused.currentTime, { timeout: 12_000 });
    const resumed = await Promise.all([snapshot(a.page), snapshot(b.page)]);
    receipt.phases.push({ stage, paused, players: resumed });
    aligned(...resumed, 'resume');
    stage = 'initiator-closes-follower-continues';
    const beforeClose = await snapshot(b.page); await closeVisitor(a);
    await b.page.waitForFunction(time => {
      const video = document.getElementById('lab-video'), delta = (video.currentTime - time + video.duration) % video.duration;
      return !video.paused && delta > 1 && delta < video.duration / 2;
    }, beforeClose.currentTime);
    const continued = await snapshot(b.page);
    receipt.phases.push({ stage, player: continued });
    assert.equal(continued.epoch, first.epoch);
    stage = 'all-leave-and-default-grace-expires';
    await closeVisitor(b);
    const emptySince = Date.now();
    await new Promise(resolve => setTimeout(resolve, LEASE_MS + 2_500));
    assert.equal(clients.size, 0, 'all local relay clients close when every visitor leaves');
    receipt.phases.push({ stage, waitedMs: Date.now() - emptySince, relayClients: clients.size });
    stage = 'third-visitor-starts-fresh';
    const c = await visitor(), fresh = await start(c.page);
    receipt.phases.push({ stage, player: fresh });
    assert.notEqual(fresh.epoch, first.epoch); assert.ok(fresh.startedAt >= fresh.clickedAt - 1000, 'expired room creates a fresh clock');
    assert.ok(Math.abs(fresh.currentTime - fresh.position) < 3, 'fresh playback follows its newly started clock');
    assert.ok(fresh.startedAt > first.startedAt); assert.equal(fresh.videos, 1);
    await closeVisitor(c);
    assert.deepEqual(receipt.errors, []); assert.ok(wire.roomActive > 0); assert.equal(wire.rejected, 0);
    receipt.passed = true;
  };
  await Promise.race([run(), new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(`Listener smoke exceeded 100s at ${stage}.`)), 100_000); })]);
} catch (error) { receipt.failure = { stage, message: String(error), stack: error.stack }; process.exitCode = 1; }
finally {
  clearTimeout(guard);
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  receipt.wire = wire;
  receipt.cleanup = { openContexts: 0, browserClosed: true, localRelayClients: clients.size };
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, stage, phases: receipt.phases.length, errors: receipt.errors,
    wire, cleanup: receipt.cleanup, ...(receipt.failure ? { failure: receipt.failure.message } : {}) }, null, 2));
}
