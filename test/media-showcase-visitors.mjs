#!/usr/bin/env node
// Manual acceptance of the actual public page with two independent visitors.
// Candidate static files may be routed at the public origin. Nostr signalling,
// WebRTC, HLS loaders, decoding, visible counters and graph remain real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { chromium } from 'playwright';

const options = { url: 'https://forgesworn.dev/', quality: 'preview' };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = { '--url': 'url', '--quality': 'quality', '--site': 'site', '--output': 'output', '--screenshots': 'screenshots',
    '--observe-seconds': 'observeSeconds', '--min-peer-bytes': 'minPeerBytes', '--min-peer-share': 'minPeerShare', '--diagnostics': 'diagnostics' }[process.argv[index]];
  assert(name && process.argv[index + 1], 'Use --output PRIVATE-RECEIPT.json [--site site] [--screenshots DIRECTORY] [--quality preview|full] [--url PAGE]');
  options[name] = ['site', 'output', 'screenshots'].includes(name) ? resolve(process.argv[index + 1]) : process.argv[index + 1];
}
assert(options.output && ['preview', 'full'].includes(options.quality));
for (const [key, maximum] of [['observeSeconds', 90], ['minPeerBytes', 1024 ** 3], ['minPeerShare', 1]]) {
  options[key] = Number(options[key] ?? 0); assert(Number.isFinite(options[key]) && options[key] >= 0 && options[key] <= maximum);
}
const url = new URL(options.url);
assert.equal(url.origin, 'https://forgesworn.dev');
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.woff2': 'font/woff2', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const receipt = { schema: 1, measuredAt: new Date().toISOString(), passed: false, page: url.href, quality: options.quality,
  scenario: 'Actual homepage UI, two independent browser contexts, one visible player each',
  candidateStaticFileRouting: Boolean(options.site), publicSignallingSimulated: false, nativeWebRtc: true,
  mediaDecodingSimulated: false, hiddenHolders: 0, noAutoplayOverride: true,
  networkBoundary: 'Two browser contexts on one Mac using actual public Nostr WSS and native WebRTC. Separate physical networks and internet NAT traversal are not asserted.',
  trafficBoundary: 'Verified media counters come from the actual production UI. Native RTC wire counters can also contain protocol traffic.',
  privateDiagnosticExposure: options.diagnostics === 'true',
  pageErrors: [], localApiRequests: 0, sockets: [], sources: [], players: [], samples: [], cleanup: {} };
let browser, stage = 'setup';
const pages = [], mediaHttp = [], cdps = [];
const meetsContribution = (player, index) => player.graph.peerBytes >= Math.max(1, options.minPeerBytes) &&
  player.graph.peerBytes / Math.max(1, player.graph.peerBytes + player.originBytes) >= options.minPeerShare &&
  (options.minPeerShare === 0 || mediaHttp[index].bodyBytes < player.core.loadedMediaBytes);
const isMedia = value => {
  const url = new URL(value);
  return /\.(?:m3u8|mp4|m4s)$/.test(url.pathname) &&
    (url.origin === 'https://v4v.com' && url.pathname.startsWith('/forgesworn-media-demo/dejavu-4k-v1/') ||
      url.origin === 'https://forgesworn.dev' && /^\/media\/(?:dejavu-4k\/|dejavu-preview\/rtmp\/)/.test(url.pathname));
};

async function snapshot(page) {
  return page.evaluate(async () => {
    const video = document.getElementById('lab-video'), map = document.getElementById('public-swarm-map'), qa = window.__visitorQa;
    const raw = qa.swarm?.metrics();
    const label = map.querySelector('svg')?.getAttribute('aria-label') ?? '';
    const peerBytes = Number(/(\d+) verified peer bytes received/.exec(label)?.[1] ?? 0);
    const uploadedBytes = Number(/(\d+) video bytes uploaded/.exec(label)?.[1] ?? 0);
    const connections = await Promise.all(qa.peers.map(async peer => {
      const state = peer.connectionState;
      if (state === 'closed') return { state };
      try {
        const reports = [...(await peer.getStats()).values()];
        const channels = reports.filter(report => report.type === 'data-channel');
        return { state, bytesSent: channels.reduce((sum, row) => sum + (row.bytesSent ?? 0), 0),
          bytesReceived: channels.reduce((sum, row) => sum + (row.bytesReceived ?? 0), 0) };
      } catch { return { state }; }
    }));
    const root = document.getElementById('main');
    let bufferSeconds = 0;
    for (let i = 0; i < video.buffered.length; i++) if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) bufferSeconds = video.buffered.end(i) - video.currentTime;
    return { currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, bufferSeconds,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, paused: video.paused, muted: video.muted, volume: video.volume,
      totalVideoElements: document.querySelectorAll('video').length, visibleVideoElements: [...document.querySelectorAll('video')].filter(v => !v.hidden).length,
      quality: document.getElementById('lab-quality').value,
      visibleDelivery: document.getElementById('public-delivery').textContent,
      visiblePeerBytes: document.getElementById('public-peer-bytes').textContent,
      visibleUploadedBytes: document.getElementById('public-upload-bytes').textContent,
      visibleOriginBytes: document.getElementById('public-origin-bytes')?.textContent,
      originBytes: Number(document.getElementById('public-origin-bytes')?.dataset.bytes),
      core: { state: root.dataset.peerEngine, multiHolderDelivered: Number(root.dataset.multiHolderDelivered),
        loadedMediaBytes: Number(root.dataset.loadedMediaBytes), originTransferredBytes: Number(root.dataset.originTransferredBytes),
        cacheHighWaterBytes: Number(root.dataset.cacheHighWaterBytes) },
      stalls: document.getElementById('browser-stalls')?.textContent, stalledTime: document.getElementById('browser-stall-time')?.textContent,
      transferSummary: document.getElementById('public-transfer-summary')?.textContent,
      diagnostics: raw ? { segments: raw.segments, bytes: raw.bytes, core: raw.core,
        peerCounts: Object.fromEntries(Object.entries(raw.peers).filter(([, value]) => typeof value === 'number')),
        eligibility: raw.peerEligibilityDiagnostics, requests: raw.peerRequestDiagnostics, refusals: raw.uploadRefusalDiagnostics,
        transport: raw.transportDiagnostics, errors: { total: raw.errors?.total, byStage: raw.errors?.byStage } } : undefined,
      visiblePeers: document.getElementById('public-peers').textContent,
      sharingStatus: document.getElementById('public-share-status').textContent,
      graph: { peerBytes, uploadedBytes, observedPeers: Number(map.dataset.observedPeers), connectedPeers: Number(map.dataset.connectedPeers),
        drawnPeerNodes: map.querySelectorAll('[data-peer-id]').length, nativeDescription: label,
        media: [...map.querySelectorAll('[data-peer-id]')].map(node => ({ id: node.dataset.peerId,
          uploadedBytes: Number(node.dataset.mediaBytesSent), verifiedPeerBytes: Number(node.dataset.verifiedMediaBytesReceived),
          label: node.querySelector('.swarm-sub').textContent, name: node.querySelector('.swarm-label').textContent })),
        viewBox: map.querySelector('svg').getAttribute('viewBox') },
      native: { connections, activeConnections: connections.filter(peer => ['new', 'connecting', 'connected'].includes(peer.state)).length,
        connectedConnections: connections.filter(peer => peer.state === 'connected').length,
        openSockets: qa.sockets.filter(socket => socket.readyState < 2).length },
    };
  });
}

try {
  if (options.site) for (const file of [url.pathname === '/' ? 'index.html' : url.pathname.slice(1), 'media-lab.mjs', 'media-public-swarm.mjs',
    'media-swarm-visual.mjs', 'media-transfer-stats.mjs', 'media-showcase.css', 'vendor/media-peer-demo.js', 'vendor/media-peer-demo.build.json',
    'vendor/relayswarm-core.wasm', 'media/dejavu-swarm/catalogue-v2.json', 'media/dejavu-4k/index.m3u8']) {
    receipt.sources.push({ file: `site/${file}`, sha256: createHash('sha256').update(await readFile(resolve(options.site, file))).digest('hex') });
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  receipt.browserVersion = browser.version();
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (options.site) await context.route(`${url.origin}/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/lab/')) { receipt.localApiRequests++; return route.abort(); }
      const file = resolve(options.site, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (relative(options.site, file).startsWith('..')) return route.abort();
      try {
        let body = await readFile(file);
        if (options.diagnostics === 'true' && path === '/media-public-swarm.mjs') {
          const source = body.toString();
          assert.equal(source.split('swarm = createHlsSwarm(').length, 2);
          body = Buffer.from(source.replace('swarm = createHlsSwarm(', 'swarm = window.__visitorQa.swarm = createHlsSwarm('));
        }
        const range = route.request().headers().range;
        if (range) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(range);
          const start = Number(match?.[1]), end = Number(match?.[2]);
          if (!match || start > end || end >= body.length) return route.fulfill({ status: 416, headers: { 'content-range': `bytes */${body.length}` }, body: '' });
          return route.fulfill({ status: 206, contentType: mime[extname(file)] ?? 'application/octet-stream',
            headers: { 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes' }, body: body.subarray(start, end + 1) });
        }
        return route.fulfill({ status: 200, contentType: mime[extname(file)] ?? 'application/octet-stream', body });
      }
      catch { return route.fulfill({ status: 404, body: 'Not found' }); }
    });
    const page = await context.newPage(); pages.push(page);
    const http = { requests: 0, completed: 0, failed: 0, bodyBytes: 0, encodedTransferBytes: 0 }, requestIds = new Set();
    mediaHttp.push(http);
    const cdp = await context.newCDPSession(page); cdps.push(cdp); await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', event => { if (isMedia(event.request.url)) { requestIds.add(event.requestId); http.requests++; } });
    cdp.on('Network.dataReceived', event => { if (requestIds.has(event.requestId)) http.bodyBytes += event.dataLength; });
    cdp.on('Network.loadingFinished', event => { if (requestIds.has(event.requestId)) { http.completed++; http.encodedTransferBytes += event.encodedDataLength; requestIds.delete(event.requestId); } });
    cdp.on('Network.loadingFailed', event => { if (requestIds.has(event.requestId)) { http.failed++; requestIds.delete(event.requestId); } });
    await page.addInitScript(() => {
      const qa = window.__visitorQa = { peers: [], sockets: [] };
      const NativePeer = RTCPeerConnection, NativeSocket = WebSocket;
      window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); qa.peers.push(this); } };
      window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); qa.sockets.push(this); } };
    });
    page.on('pageerror', error => receipt.pageErrors.push({ visitor: index, message: String(error) }));
    page.on('websocket', socket => {
      const record = { visitor: index, relay: new URL(socket.url()).hostname, sent: 0, received: 0, errors: 0 };
      receipt.sockets.push(record);
      socket.on('framesent', () => record.sent++); socket.on('framereceived', () => record.received++); socket.on('socketerror', () => record.errors++);
    });
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const button = document.getElementById('public-play'); return button && !button.disabled; });
    await page.selectOption('#lab-quality', options.quality);
    const initial = await snapshot(page);
    assert.equal(initial.totalVideoElements, 1); assert.equal(initial.native.connections.length, 0); assert.equal(initial.native.openSockets, 0);
    assert.equal(initial.graph.drawnPeerNodes, 0);
  }
  receipt.beforePlayNoPeerNetworking = receipt.sockets.length === 0;
  assert(receipt.beforePlayNoPeerNetworking);
  stage = 'first-visitor-play-and-cache';
  await pages[0].click('#public-play');
  await pages[0].waitForFunction(() => document.getElementById('lab-video').currentTime > 3 && document.getElementById('lab-video').videoWidth > 0, undefined, { timeout: 20000 });
  stage = 'second-visitor-play';
  await pages[1].click('#public-play');
  const observationStart = Date.now(), deadline = observationStart + Math.max(30000, (options.observeSeconds + 10) * 1000);
  stage = 'actual-peer-traffic-and-graph';
  let snapshots;
  while (Date.now() < deadline) {
    snapshots = await Promise.all(pages.map(snapshot));
    const elapsedMs = Date.now() - observationStart;
    if (!receipt.samples.length || elapsedMs - receipt.samples.at(-1).elapsedMs >= 1000) receipt.samples.push({ elapsedMs, players: snapshots, mediaHttp: structuredClone(mediaHttp) });
    const usefulReceiver = snapshots.some(meetsContribution);
    if (elapsedMs >= options.observeSeconds * 1000 && usefulReceiver && snapshots.some(player => player.graph.uploadedBytes > 0) && snapshots.every(player =>
      player.decodedFrames > 10 && player.graph.connectedPeers > 0 && player.graph.drawnPeerNodes === player.graph.connectedPeers &&
      player.graph.connectedPeers <= player.native.connectedConnections && player.native.connections.some(peer => peer.bytesSent > 0 || peer.bytesReceived > 0))) break;
    await pages[0].waitForTimeout(250);
  }
  receipt.players = snapshots;
  const eligible = snapshots.map((_player, index) => index).filter(index => meetsContribution(snapshots[index], index));
  receipt.receivingVisitorIndex = (eligible.length ? eligible : snapshots.map((_player, index) => index))
    .reduce((best, index) => snapshots[index].graph.peerBytes > snapshots[best].graph.peerBytes ? index : best);
  const receiver = snapshots[receipt.receivingVisitorIndex];
  receipt.mediaHttp = structuredClone(mediaHttp);
  receipt.observationSeconds = (Date.now() - observationStart) / 1000;
  receipt.requiredPeerContribution = { bytes: options.minPeerBytes, share: options.minPeerShare };
  assert(receiver.graph.peerBytes > 0, 'Neither visible visitor received verified peer media.');
  assert(snapshots.some(player => player.graph.uploadedBytes > 0), 'Neither visible visitor supplied actual video.');
  for (const player of snapshots) {
    assert(player.decodedFrames > 10 && !player.paused);
    assert.equal(player.totalVideoElements, 1); assert.equal(player.visibleVideoElements, 1);
    assert.equal(player.graph.drawnPeerNodes, player.graph.observedPeers);
    assert(player.graph.connectedPeers <= player.native.connectedConnections);
    assert.equal(player.graph.drawnPeerNodes, player.graph.connectedPeers);
    assert(player.graph.media.reduce((sum, peer) => sum + peer.verifiedPeerBytes, 0) <= player.graph.peerBytes,
      'Active graph cannot credit more verified media than the session total.');
    assert(player.graph.media.reduce((sum, peer) => sum + peer.uploadedBytes, 0) <= player.graph.uploadedBytes,
      'Active graph cannot credit more binary submissions than the session total.');
    assert.deepEqual(player.graph.media.map(peer => peer.name), player.graph.media.map((_peer, index) => `Listener ${index + 1}`));
    assert.equal(player.core.state, 'ready');
    assert(player.core.cacheHighWaterBytes <= 64 * 1024 * 1024);
    assert(player.originBytes > 0 && !player.visibleOriginBytes.startsWith('0 '));
    assert(!player.visiblePeerBytes.startsWith('0.0 '));
    assert(player.native.connections.some(peer => peer.bytesSent > 0 || peer.bytesReceived > 0));
    assert.equal(player.quality, options.quality);
    assert.equal(player.height, options.quality === 'preview' ? 1080 : 2160);
  }
  assert(snapshots.some(player => player.core.multiHolderDelivered > 0), 'The Rust/WASM piece delivery path did not deliver a segment.');
  assert(receiver.graph.peerBytes >= options.minPeerBytes);
  assert(receiver.graph.media.some(peer => peer.verifiedPeerBytes > 0), 'No current listener node received verified-video credit.');
  assert(snapshots.some(player => player.graph.media.some(peer => peer.uploadedBytes > 0)), 'No current listener node recorded actual media sent.');
  assert(receiver.graph.peerBytes / (receiver.graph.peerBytes + receiver.originBytes) >= options.minPeerShare,
    'Peers did not supply the required useful share of video accepted for playback.');
  if (options.minPeerShare > 0) assert(receipt.mediaHttp[receipt.receivingVisitorIndex].bodyBytes < receiver.core.loadedMediaBytes,
    'The useful peer share did not reduce actual HTTP media body bytes below the bytes accepted for playback.');
  if (options.screenshots) {
    await mkdir(options.screenshots, { recursive: true, mode: 0o700 });
    for (const [index, page] of pages.entries()) {
      await page.locator('#public-swarm-map').scrollIntoViewIfNeeded();
      await page.locator('.swarm-stage').screenshot({ path: resolve(options.screenshots, `homepage-visitor-${index + 1}-actual-peers.png`) });
    }
    const mobilePage = pages[receipt.receivingVisitorIndex];
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    await mobilePage.locator('#public-swarm-map').scrollIntoViewIfNeeded();
    await mobilePage.waitForFunction(() => document.querySelector('#public-swarm-map svg').getAttribute('viewBox') === '0 0 520 390');
    await mobilePage.locator('.swarm-stage').screenshot({ path: resolve(options.screenshots, 'homepage-receiving-visitor-mobile-actual-peers.png') });
    receipt.mobile = await snapshot(mobilePage);
    assert(receipt.mobile.graph.peerBytes > 0 && receipt.mobile.graph.drawnPeerNodes > 0);
  }
  stage = 'pause-removes-actual-connections';
  await pages[0].locator('#lab-video').press('Space');
  await pages[0].waitForFunction(() => document.getElementById('lab-video').paused && window.__visitorQa.peers.every(peer => peer.connectionState === 'closed') && window.__visitorQa.sockets.every(socket => socket.readyState === 3), undefined, { timeout: 10000 });
  const stopped = await snapshot(pages[0]);
  assert.equal(stopped.graph.drawnPeerNodes, 0);
  receipt.paused = { nativePaused: stopped.paused, graphNodesRemoved: stopped.graph.drawnPeerNodes === 0,
    peerConnectionsClosed: stopped.native.activeConnections === 0, socketsClosed: stopped.native.openSockets === 0 };
  await pages[1].waitForFunction(() => document.querySelectorAll('#public-swarm-map [data-peer-id]').length === 0, undefined, { timeout: 10000 });
  receipt.paused.remoteNodeRemoved = true;
  stage = 'resume-renumbers-current-listeners';
  await pages[0].locator('#lab-video').press('Space');
  await Promise.all(pages.map(page => page.waitForFunction(() => Number(document.getElementById('public-peers').textContent) > 0, undefined, { timeout: 25000 })));
  receipt.resumed = await Promise.all(pages.map(snapshot));
  for (const player of receipt.resumed) {
    assert.deepEqual(player.graph.media.map(peer => peer.name), player.graph.media.map((_peer, index) => `Listener ${index + 1}`));
    assert.equal(player.graph.drawnPeerNodes, player.graph.connectedPeers);
    assert(player.graph.connectedPeers <= player.native.connectedConnections);
  }
  assert.equal(receipt.pageErrors.length, 0); assert.equal(receipt.localApiRequests, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error); receipt.failureStage = stage; process.exitCode = 1;
  receipt.players = await Promise.all(pages.map(page => snapshot(page).catch(() => null)));
} finally {
  for (const page of pages) await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
  await Promise.all(cdps.map(cdp => cdp.detach().catch(() => {})));
  await browser?.close();
  receipt.cleanup = { browserClosed: true, staticServerCreated: false, fixtureServiceCreated: false };
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, stage, receivedBySecond: receipt.players[1]?.graph.peerBytes,
    uploadedByFirst: receipt.players[0]?.graph.uploadedBytes, pageErrors: receipt.pageErrors.length, browserClosed: true }));
}
