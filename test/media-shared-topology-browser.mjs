#!/usr/bin/env node
// One bounded three-visitor recording-boundary smoke. Real remote preview,
// native decoding and native WebRTC; explicitly local signed Nostr relay.
// Private reference capture changes no options, clock or media responses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { chromium } from 'playwright';
import { verifyEvent, matchFilter } from '../site/vendor/media-peer-demo.js';

const options = { url: 'https://forgesworn.dev/', observeSeconds: 38 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = { '--url': 'url', '--site': 'site', '--output': 'output', '--screenshots': 'screenshots', '--observe-seconds': 'observeSeconds' }[process.argv[i]];
  assert(key && process.argv[i + 1], 'Use --output PRIVATE.json [--site site] [--screenshots PRIVATE-DIR] [--url PAGE] [--observe-seconds 38]');
  options[key] = ['site', 'output', 'screenshots'].includes(key) ? resolve(process.argv[i + 1]) : process.argv[i + 1];
}
assert(options.output); options.observeSeconds = Number(options.observeSeconds);
assert(options.observeSeconds >= 33 && options.observeSeconds <= 45);
const pageUrl = new URL(options.url); assert.equal(pageUrl.origin, 'https://forgesworn.dev');
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain' };
const clients = new Set(), stored = new Map(), contexts = [], pages = [];
const wire = { room: 0, reports: 0, signalling: 0, rejected: 0, opened: 0, closed: 0 };
const receipt = { schema: 1, at: new Date().toISOString(), passed: false, page: pageUrl.href, quality: 'preview',
  scenario: 'Three real visitors across a recording boundary; current membership, actual local PCs and independently checked reported remote edges',
  relay: 'Bounded local signed Nostr wire fixture; public relay availability is not measured',
  media: 'Unmodified public preview, real decoding', nativeWebRtc: true, hiddenHolders: 0, maximumConcurrentVisitors: 3,
  clockBoundary: 'Three contexts on one Mac share its OS clock. This measures media timelines, not physical speaker phase or clock skew between devices.',
  privateReferenceCapture: true, timingOverrides: null, sources: [], errors: [], samples: [], cleanup: {} };
let browser, guard, stage = 'setup';
const send = (client, frame) => { try { client.route.send(JSON.stringify(frame)); } catch {} };
const matches = (event, filter) => { try { return matchFilter(filter, event); } catch { return false; } };
function localRelay(route) {
  const client = { route, subscriptions: new Map() }; clients.add(client); wire.opened++;
  route.onClose(() => { if (clients.delete(client)) wire.closed++; });
  route.onMessage(raw => {
    let frame;
    try { assert(typeof raw === 'string' && raw.length <= 128 * 1024); frame = JSON.parse(raw); assert(Array.isArray(frame)); } catch { wire.rejected++; return; }
    const [op, id, filter] = frame;
    if (op === 'CLOSE') { client.subscriptions.delete(id); return; }
    if (op === 'REQ') {
      if (typeof id !== 'string' || !filter || typeof filter !== 'object' || Array.isArray(filter) || client.subscriptions.size >= 16) { wire.rejected++; return; }
      client.subscriptions.set(id, filter);
      for (const event of stored.values()) if (matches(event, filter)) send(client, ['EVENT', id, event]);
      send(client, ['EOSE', id]); return;
    }
    const event = id;
    try { assert(op === 'EVENT' && [24170, 24171, 30378, 20378].includes(event?.kind) && verifyEvent(event)); } catch { wire.rejected++; return; }
    if (event.kind === 30378) {
      wire.room++;
      const key = `${event.pubkey}:${event.tags.find(tag => tag[0] === 'd')?.[1]}`, old = stored.get(key);
      if (!old || event.created_at > old.created_at || event.created_at === old.created_at && event.id < old.id) stored.set(key, event);
      if (stored.size > 32) stored.delete(stored.keys().next().value);
    } else if (event.kind === 20378) wire.reports++;
    else wire.signalling++;
    send(client, ['OK', event.id, true, '']);
    for (const other of clients) for (const [subscription, requested] of other.subscriptions) if (matches(event, requested)) send(other, ['EVENT', subscription, event]);
  });
}
const replacement = (source, from, to) => { assert.equal(source.split(from).length, 2, `Private capture anchor missing: ${from}`); return source.replace(from, to); };
async function visitor(index) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
  await context.addInitScript(() => {
    const qa = window.__sharedTopologyQa = { pcs: [], sockets: [], frames: 0, wraps: 0, lastFrameTime: null, events: [] };
    const PC = RTCPeerConnection, WS = WebSocket;
    window.RTCPeerConnection = class extends PC { constructor(...args) { super(...args); qa.pcs.push(this); } };
    window.WebSocket = class extends WS { constructor(...args) { super(...args); qa.sockets.push(this); } };
    document.addEventListener('DOMContentLoaded', () => {
      const video = document.getElementById('lab-video'); if (!video) return;
      for (const name of ['ended', 'pause', 'playing']) video.addEventListener(name, () => {
        qa.events.push({ name, at: Date.now(), time: video.currentTime, ended: video.ended });
        if (qa.events.length > 80) qa.events.shift();
      });
      const frame = (_at, meta) => {
        if (qa.lastFrameTime !== null && Number.isFinite(video.duration) && qa.lastFrameTime > video.duration * 0.7 && meta.mediaTime < video.duration * 0.3) qa.wraps++;
        qa.frames++; qa.lastFrameTime = meta.mediaTime; video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
    });
  });
  await context.routeWebSocket(/^wss:\/\/(?:relay\.damus\.io|nos\.lol|relay\.primal\.net)\/?$/u, localRelay);
  await context.route(`${pageUrl.origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (/\.(?:m3u8|mp4|m4s)$/u.test(path)) return route.continue();
    if (path.startsWith('/lab/')) return route.abort();
    let body, headers;
    if (options.site) {
      const file = resolve(options.site, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (relative(options.site, file).startsWith('..')) return route.abort();
      try { body = await readFile(file); headers = { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }; }
      catch { return route.fulfill({ status: 404, body: 'Not found' }); }
    } else {
      const response = await route.fetch(); body = await response.body(); headers = response.headers();
    }
    if (path === '/media-public-swarm.mjs') {
      let source = body.toString();
      source = replacement(source, 'swarm = createHlsSwarm(', 'swarm = globalThis.__sharedTopologyQa.swarm = createHlsSwarm(');
      source = replacement(source, 'export function createPublicSwarm(', 'function __fixtureCreatePublicSwarm(');
      body = Buffer.from(source + '\nexport function createPublicSwarm(options) { const instance = __fixtureCreatePublicSwarm(options); globalThis.__sharedTopologyQa.adapter = instance; return instance; }\n');
    }
    if (path === '/media-listener-session.mjs') {
      const source = replacement(body.toString(), 'export function createListenerSession(', 'function __fixtureCreateListenerSession(');
      body = Buffer.from(source + '\nexport function createListenerSession(...args) { const instance = __fixtureCreateListenerSession(...args); globalThis.__sharedTopologyQa.listener = instance; return instance; }\n');
    }
    const cleanHeaders = { ...headers }; delete cleanHeaders['content-length']; delete cleanHeaders['content-encoding'];
    return route.fulfill({ status: 200, headers: cleanHeaders, body });
  });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => receipt.errors.push({ visitor: index, message: String(error) }));
  await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const button = document.getElementById('public-play'); return button && !button.disabled; });
  await page.selectOption('#lab-quality', 'preview');
  return page;
}
async function snapshot(page) {
  return page.evaluate(() => {
    const qa = window.__sharedTopologyQa, root = document.getElementById('main'), video = document.getElementById('lab-video'), map = document.getElementById('public-swarm-map');
    const adapter = qa.adapter?.metrics(), room = qa.listener?.snapshot();
    const details = qa.swarm?.peerConnectionDetails?.().map(({ connection, pubkey }) => ({ peerId: pubkey, pcIndex: qa.pcs.indexOf(connection),
      state: connection.connectionState, iceState: connection.iceConnectionState }));
    const edges = [...map.querySelectorAll('g[data-edge-kind]')].map(node => ({ ...node.dataset,
      paths: [...node.querySelectorAll('path[data-direction]')].map(path => ({ ...path.dataset,
        strokeWidth: Number(path.getAttribute('stroke-width') ?? getComputedStyle(path).strokeWidth), strokeDasharray: path.getAttribute('stroke-dasharray') })) }));
    return { measuredAt: Date.now(), time: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended,
      rate: video.playbackRate, frames: video.getVideoPlaybackQuality().totalVideoFrames, wraps: qa.wraps, events: [...qa.events],
      videos: document.querySelectorAll('video').length, epoch: root.dataset.sharedEpoch, sharedState: root.dataset.sharedSession,
      activity: root.dataset.roomActivity, mediaSource: video.currentSrc, openNativeConnections: qa.pcs.filter(connection => connection.connectionState !== 'closed').length,
      roomListeners: Number(root.dataset.sharedListeners), visibleListeners: document.getElementById('public-peers')?.textContent,
      watcherCount: Number(root.dataset.watcherCount), watcherText: document.getElementById('public-watchers')?.textContent,
      visibleLocalPeers: document.getElementById('public-local-peers')?.textContent,
      localDetails: details ?? [], adapter, room, graph: { dataset: { ...map.dataset }, edges,
        members: [...map.querySelectorAll('g[data-room-member-id]')].map(node => node.dataset.roomMemberId),
        pulses: [...map.querySelectorAll('[data-flight-source]')].map(node => ({ ...node.dataset, radius: Number(node.getAttribute('r')) })),
        strength: map.querySelector('[data-swarm-strength-value]')?.textContent,
        strengthNote: map.querySelector('[data-swarm-strength-note]')?.textContent } };
  });
}
function clockSpread(players) {
  const at = Math.max(...players.map(player => player.measuredAt));
  const points = players.map(player => (player.time + (at - player.measuredAt) * player.rate / 1000) % player.duration);
  return Math.max(...points.flatMap((a, i) => points.map((b, j) => { const d = Math.abs(a - b); return Math.min(d, players[i].duration - d); })));
}
function pulseTruth(players) {
  let comparisons = 0;
  for (const player of players) for (const a of player.graph.pulses) for (const b of player.graph.pulses) if (Number(a.bytes) > Number(b.bytes) * 1.5 && Number(b.bytes) > 0) {
    assert.ok(a.radius >= b.radius, 'a larger concurrent measured byte batch is not drawn smaller');
    if (a.radius > 1.1001) assert.ok(a.radius > b.radius, 'unequal byte batches above the minimum size have visibly unequal pulse area');
    comparisons++;
  }
  return comparisons;
}
function graphTruth(players) {
  const byPeer = new Map(players.map(player => [player.adapter?.viewerId, player]));
  let reportedEdges = 0, magnitudeComparisons = 0;
  for (const player of players) {
    assert.equal(player.videos, 1); assert.equal(player.roomListeners, 3); assert.equal(Number(player.visibleListeners), 3);
    assert.equal(player.watcherCount, 3); assert.equal(Number(player.watcherText), 3);
    assert.equal(player.localDetails.length, 2); assert.ok(player.localDetails.every(detail => detail.pcIndex >= 0 && detail.state === 'connected'));
    assert.match(player.visibleLocalPeers, /^2\b/); assert.equal(player.graph.members.length, 3);
    assert.equal(new Set(player.graph.members).size, 3);
    const native = player.graph.edges.filter(edge => edge.edgeKind === 'native-peer'); assert.equal(native.length, 2);
    for (const edge of native) {
      assert.equal(edge.attribution, 'measured-here');
      const remote = edge.fromPeerId === player.adapter.viewerId ? edge.toPeerId : edge.fromPeerId;
      assert.ok(edge.fromPeerId === player.adapter.viewerId || edge.toPeerId === player.adapter.viewerId);
      assert.ok(player.localDetails.some(detail => detail.peerId === remote));
    }
    for (const edge of player.graph.edges.filter(edge => edge.edgeKind === 'reported-peer')) {
      assert.equal(edge.attribution, 'listener-reported');
      assert.ok(edge.paths.every(path => path.strokeDasharray && path.strokeDasharray !== 'none'), 'reported paths are visibly distinguished');
      const a = byPeer.get(edge.fromPeerId), b = byPeer.get(edge.toPeerId);
      assert.ok(a && b && a !== player && b !== player, 'remote edge joins the two actual other visitors');
      assert.equal(edge.fromMemberId, a.room.id); assert.equal(edge.toMemberId, b.room.id);
      for (const id of [edge.fromMemberId, edge.toMemberId]) {
        const member = player.room.members.find(row => row.id === id);
        assert.ok(member?.telemetry && member.telemetryExpiresAt > player.measuredAt, 'reported edges use fresh signed active-member observations');
      }
      assert.ok(a.localDetails.some(detail => detail.peerId === edge.toPeerId) && b.localDetails.some(detail => detail.peerId === edge.fromPeerId), 'both actual remote browsers confirm the reported connection');
      reportedEdges++;
    }
    assert.equal(player.graph.edges.filter(edge => edge.edgeKind === 'origin').length, 1);
    assert.equal(player.graph.edges.filter(edge => edge.edgeKind === 'reported-origin').length, 2);
    assert.ok(player.graph.strength && player.graph.strengthNote, 'strength shows its scope or measurement basis');
    const paths = player.graph.edges.flatMap(edge => edge.paths).filter(path => Number.isFinite(Number(path.bytesPerSecond)) && Number.isFinite(path.strokeWidth));
    for (const a of paths) for (const b of paths) if (Number(a.bytesPerSecond) > Number(b.bytesPerSecond) * 1.5 && Number(a.bytesPerSecond) > 0) {
      assert.ok(a.strokeWidth >= b.strokeWidth, 'larger measured traffic is not drawn thinner'); magnitudeComparisons++;
    }
  }
  assert.equal(reportedEdges, 3, 'each browser sees the other two visitors’ independently confirmed reported edge');
  return { reportedEdges, magnitudeComparisons, pulseComparisons: pulseTruth(players) };
}

try {
  if (options.site) for (const path of [pageUrl.pathname === '/' ? 'index.html' : pageUrl.pathname.slice(1), 'media-lab.mjs', 'media-public-swarm.mjs',
    'media-listener-session.mjs', 'media-swarm-visual.mjs', 'vendor/media-peer-demo.js']) receipt.sources.push({ path, sha256: createHash('sha256').update(await readFile(resolve(options.site, path))).digest('hex') });
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] }); receipt.browserVersion = browser.version();
  const run = async () => {
    stage = 'three-read-only-observers-before-play';
    for (let i = 0; i < 3; i++) await visitor(i);
    await Promise.all(pages.map(page => page.waitForFunction(() => document.getElementById('main').dataset.roomActivity === 'empty', undefined, { timeout: 10_000 })));
    receipt.observersBeforePlay = await Promise.all(pages.map(snapshot));
    assert.equal(wire.room, 0, 'observers publish no presence'); assert.equal(wire.reports, 0, 'observers publish no telemetry');
    assert.equal(wire.signalling, 0, 'observers start no peer signalling');
    for (const observer of receipt.observersBeforePlay) {
      assert.equal(observer.roomListeners, 0); assert.equal(Number(observer.visibleListeners), 0);
      assert.equal(observer.watcherCount, 0); assert.equal(Number(observer.watcherText), 0);
      assert.equal(observer.openNativeConnections, 0); assert.equal(observer.mediaSource, '');
      assert.equal(observer.room.observed, true); assert.equal(observer.room.id, null);
    }
    stage = 'play-count-fanout-one-two-three'; receipt.membership = [];
    for (let i = 0; i < 3; i++) {
      await pages[i].click('#public-play');
      await pages[i].waitForFunction(() => window.__sharedTopologyQa.listener.snapshot().ready, undefined, { timeout: 12_000 });
      const readyAt = Date.now();
      await Promise.all(pages.map(page => page.waitForFunction(count => Number(document.getElementById('main').dataset.sharedListeners) === count &&
        Number(document.getElementById('main').dataset.watcherCount) === count && Number(document.getElementById('public-peers').textContent) === count &&
        Number(document.getElementById('public-watchers').textContent) === count, i + 1, { timeout: 1_500 })));
      receipt.membership.push({ listeners: i + 1, fanoutAfterPublisherReadyMs: Date.now() - readyAt, players: await Promise.all(pages.map(snapshot)) });
      await pages[i].waitForFunction(() => {
        const video = document.getElementById('lab-video');
        return !video.paused && video.getVideoPlaybackQuality().totalVideoFrames > 0;
      }, undefined, { timeout: 25_000 });
      if (i < 2) await pages[0].waitForTimeout(1_200);
    }
    stage = 'native-mesh-and-fresh-reported-topology';
    const deadline = Date.now() + 20_000; let baseline;
    while (Date.now() < deadline) {
      baseline = await Promise.all(pages.map(snapshot));
      if (baseline.every(player => player.roomListeners === 3 && player.localDetails.length === 2 && player.graph.edges.filter(edge => edge.edgeKind === 'reported-peer').length === 1) && clockSpread(baseline) < 1) break;
      await pages[0].waitForTimeout(500);
    }
    receipt.baseline = baseline; receipt.baselineTruth = graphTruth(baseline);
    assert.equal(new Set(baseline.map(player => player.epoch)).size, 1);
    stage = 'one-real-recording-boundary';
    const began = Date.now(), until = began + options.observeSeconds * 1000;
    while (Date.now() < until) {
      const players = await Promise.all(pages.map(snapshot));
      const sample = { elapsedMs: Date.now() - began, spreadSeconds: clockSpread(players), players }; receipt.samples.push(sample);
      for (const [index, player] of players.entries()) {
        assert.equal(player.epoch, baseline[index].epoch, 'recording replay keeps the shared epoch');
        assert.equal(player.roomListeners, 3, 'recording replay does not remove a listener');
        assert.equal(Number(player.watcherText), 3, 'the visible ticker retains all three listeners across replay');
        assert.deepEqual(player.localDetails.map(detail => [detail.peerId, detail.pcIndex]).sort(), baseline[index].localDetails.map(detail => [detail.peerId, detail.pcIndex]).sort(), 'recording replay preserves the actual accepted PCs');
        assert.equal(player.adapter.enabled, true, 'recording replay keeps peer contribution enabled');
      }
      await pages[0].waitForTimeout(750);
    }
    const final = receipt.samples.at(-1).players; receipt.finalTruth = graphTruth(final);
    assert.ok(final.every((player, index) => player.wraps > baseline[index].wraps), 'all three decoded across a real recording boundary');
    const spreads = receipt.samples.map(sample => sample.spreadSeconds).sort((a, b) => a - b);
    receipt.clock = { maxSpreadSeconds: spreads.at(-1), p95SpreadSeconds: spreads[Math.floor((spreads.length - 1) * .95)] };
    assert.ok(receipt.clock.p95SpreadSeconds < 1, 'steady listening remains within a subsecond media-clock spread');
    assert.ok(receipt.samples.some(sample => sample.players.some(player => player.adapter.peerBytes > 0)), 'real verified peer media moved');
    assert.ok(receipt.baselineTruth.magnitudeComparisons + receipt.finalTruth.magnitudeComparisons > 0, 'actual unequal traffic magnitudes were compared');
    receipt.pulseComparisons = receipt.samples.reduce((sum, sample) => sum + pulseTruth(sample.players), 0);
    assert.ok(receipt.pulseComparisons > 0, 'actual concurrent pulse magnitudes were compared across the saved window');
    if (options.screenshots) { await mkdir(options.screenshots, { recursive: true, mode: 0o700 }); await pages[0].locator('#public-swarm-map').screenshot({ path: resolve(options.screenshots, 'three-listeners-real-graph.png') }); }
    stage = 'pause-immediately-removes-self-from-observed-count';
    await pages[2].evaluate(() => document.getElementById('lab-video').pause());
    const pausedAt = Date.now();
    await Promise.all(pages.map(page => page.waitForFunction(() => Number(document.getElementById('main').dataset.sharedListeners) === 2 &&
      Number(document.getElementById('main').dataset.watcherCount) === 2 && Number(document.getElementById('public-peers').textContent) === 2 &&
      Number(document.getElementById('public-watchers').textContent) === 2, undefined, { timeout: 1_500 })));
    receipt.pausedObserver = { fanoutMs: Date.now() - pausedAt, players: await Promise.all(pages.map(snapshot)) };
    assert.equal(receipt.pausedObserver.players[2].room.observed, true);
    assert.equal(receipt.pausedObserver.players[2].room.joined, false);
    assert.equal(receipt.pausedObserver.players[2].openNativeConnections, 0);
    assert.deepEqual(receipt.errors, []); assert.equal(wire.rejected, 0); receipt.passed = true;
  };
  await Promise.race([run(), new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(`Three-listener smoke exceeded 115s at ${stage}`)), 115_000); })]);
} catch (error) { receipt.failure = { stage, message: String(error), stack: error.stack }; process.exitCode = 1; }
finally {
  clearTimeout(guard); await Promise.allSettled(contexts.map(context => context.close())); await browser?.close();
  receipt.wire = wire; receipt.cleanup = { browserClosed: true, openContexts: 0, relayClients: clients.size };
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 }); await writeFile(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, stage, samples: receipt.samples.length, clock: receipt.clock, wire,
    errors: receipt.errors, cleanup: receipt.cleanup, ...(receipt.failure ? { failure: receipt.failure.message } : {}) }, null, 2));
}
