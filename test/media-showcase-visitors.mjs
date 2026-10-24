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
  const name = { '--url': 'url', '--quality': 'quality', '--site': 'site', '--output': 'output', '--screenshots': 'screenshots' }[process.argv[index]];
  assert(name && process.argv[index + 1], 'Use --output PRIVATE-RECEIPT.json [--site site] [--screenshots DIRECTORY] [--quality preview|full] [--url PAGE]');
  options[name] = ['site', 'output', 'screenshots'].includes(name) ? resolve(process.argv[index + 1]) : process.argv[index + 1];
}
assert(options.output && ['preview', 'full'].includes(options.quality));
const url = new URL(options.url);
assert.equal(url.origin, 'https://forgesworn.dev');
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.woff2': 'font/woff2', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const receipt = { schema: 1, measuredAt: new Date().toISOString(), passed: false, page: url.href, quality: options.quality,
  scenario: 'Actual homepage UI, two independent browser contexts, one visible player each',
  candidateStaticFileRouting: Boolean(options.site), publicSignallingSimulated: false, nativeWebRtc: true,
  mediaDecodingSimulated: false, hiddenHolders: 0, noAutoplayOverride: true,
  networkBoundary: 'Two browser contexts on one Mac using actual public Nostr WSS and native WebRTC. Separate physical networks and internet NAT traversal are not asserted.',
  trafficBoundary: 'Verified media counters come from the actual production UI. Native RTC wire counters can also contain protocol traffic.',
  pageErrors: [], localApiRequests: 0, sockets: [], sources: [], players: [], cleanup: {} };
let browser, stage = 'setup';
const pages = [];

async function snapshot(page) {
  return page.evaluate(async () => {
    const video = document.getElementById('lab-video'), map = document.getElementById('public-swarm-map'), qa = window.__visitorQa;
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
    return { currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, paused: video.paused, muted: video.muted, volume: video.volume,
      totalVideoElements: document.querySelectorAll('video').length, visibleVideoElements: [...document.querySelectorAll('video')].filter(v => !v.hidden).length,
      quality: document.getElementById('lab-quality').value,
      visibleDelivery: document.getElementById('public-delivery').textContent,
      visiblePeerBytes: document.getElementById('public-peer-bytes').textContent,
      visibleUploadedBytes: document.getElementById('public-upload-bytes').textContent,
      visibleOriginBytes: document.getElementById('public-origin-bytes')?.textContent,
      originBytes: Number(document.getElementById('public-origin-bytes')?.dataset.bytes),
      transferSummary: document.getElementById('public-transfer-summary')?.textContent,
      visiblePeers: document.getElementById('public-peers').textContent,
      sharingStatus: document.getElementById('public-share-status').textContent,
      graph: { peerBytes, uploadedBytes, observedPeers: Number(map.dataset.observedPeers), connectedPeers: Number(map.dataset.connectedPeers),
        drawnPeerNodes: map.querySelectorAll('[data-peer-id]').length, nativeDescription: label,
        media: [...map.querySelectorAll('[data-peer-id]')].map(node => ({ id: node.dataset.peerId,
          uploadedBytes: Number(node.dataset.mediaBytesSent), verifiedPeerBytes: Number(node.dataset.verifiedMediaBytesReceived),
          label: node.querySelector('.swarm-sub').textContent })),
        viewBox: map.querySelector('svg').getAttribute('viewBox') },
      native: { connections, activeConnections: connections.filter(peer => ['new', 'connecting', 'connected'].includes(peer.state)).length,
        connectedConnections: connections.filter(peer => peer.state === 'connected').length,
        openSockets: qa.sockets.filter(socket => socket.readyState < 2).length },
    };
  });
}

try {
  if (options.site) for (const file of [url.pathname === '/' ? 'index.html' : url.pathname.slice(1), 'media-lab.mjs', 'media-public-swarm.mjs', 'media-swarm-visual.mjs', 'media-showcase.css']) {
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
      try { return route.fulfill({ status: 200, contentType: mime[extname(file)] ?? 'application/octet-stream', body: await readFile(file) }); }
      catch { return route.fulfill({ status: 404, body: 'Not found' }); }
    });
    const page = await context.newPage(); pages.push(page);
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
  const deadline = Date.now() + 30000;
  stage = 'actual-peer-traffic-and-graph';
  let snapshots;
  while (Date.now() < deadline) {
    snapshots = await Promise.all(pages.map(snapshot));
    if (snapshots[1].graph.peerBytes > 0 && snapshots[0].graph.uploadedBytes > 0 && snapshots.every(player =>
      player.decodedFrames > 10 && player.graph.connectedPeers > 0 && player.graph.drawnPeerNodes === player.native.activeConnections &&
      player.graph.connectedPeers === player.native.connectedConnections && player.native.connections.some(peer => peer.bytesSent > 0 || peer.bytesReceived > 0))) break;
    await pages[0].waitForTimeout(250);
  }
  receipt.players = snapshots;
  assert(snapshots[1].graph.peerBytes > 0, 'Second visible visitor did not receive verified peer media.');
  assert(snapshots[0].graph.uploadedBytes > 0, 'First visible visitor did not supply actual video.');
  for (const player of snapshots) {
    assert(player.decodedFrames > 10 && !player.paused);
    assert.equal(player.totalVideoElements, 1); assert.equal(player.visibleVideoElements, 1);
    assert.equal(player.graph.drawnPeerNodes, player.graph.observedPeers);
    assert.equal(player.graph.drawnPeerNodes, player.native.activeConnections);
    assert.equal(player.graph.connectedPeers, player.native.connectedConnections);
    assert.equal(player.graph.media.reduce((sum, peer) => sum + peer.verifiedPeerBytes, 0), player.graph.peerBytes,
      'Graph received video must match completed verified media, not RTC control or pending payloads.');
    assert.equal(player.graph.media.reduce((sum, peer) => sum + peer.uploadedBytes, 0), player.graph.uploadedBytes,
      'Graph uploaded video must match actual binary submissions.');
    assert(player.originBytes > 0 && !player.visibleOriginBytes.startsWith('0 '));
    assert(!player.visiblePeerBytes.startsWith('0.0 '));
    assert(player.native.connections.some(peer => peer.bytesSent > 0 || peer.bytesReceived > 0));
    assert.equal(player.quality, options.quality);
    assert.equal(player.height, options.quality === 'preview' ? 1080 : 2160);
  }
  if (options.screenshots) {
    await mkdir(options.screenshots, { recursive: true, mode: 0o700 });
    for (const [index, page] of pages.entries()) {
      await page.locator('#public-swarm-map').scrollIntoViewIfNeeded();
      await page.locator('.swarm-stage').screenshot({ path: resolve(options.screenshots, `homepage-visitor-${index + 1}-actual-peers.png`) });
    }
    await pages[1].setViewportSize({ width: 390, height: 844 });
    await pages[1].locator('#public-swarm-map').scrollIntoViewIfNeeded();
    await pages[1].waitForFunction(() => document.querySelector('#public-swarm-map svg').getAttribute('viewBox') === '0 0 520 390');
    await pages[1].locator('.swarm-stage').screenshot({ path: resolve(options.screenshots, 'homepage-visitor-2-mobile-actual-peers.png') });
    receipt.mobile = await snapshot(pages[1]);
    assert(receipt.mobile.graph.peerBytes > 0 && receipt.mobile.graph.drawnPeerNodes > 0);
  }
  stage = 'pause-removes-actual-connections';
  await pages[0].locator('#lab-video').press('Space');
  await pages[0].waitForFunction(() => document.getElementById('lab-video').paused && window.__visitorQa.peers.every(peer => peer.connectionState === 'closed') && window.__visitorQa.sockets.every(socket => socket.readyState === 3), undefined, { timeout: 10000 });
  const stopped = await snapshot(pages[0]);
  assert.equal(stopped.graph.drawnPeerNodes, 0);
  receipt.paused = { nativePaused: stopped.paused, graphNodesRemoved: stopped.graph.drawnPeerNodes === 0,
    peerConnectionsClosed: stopped.native.activeConnections === 0, socketsClosed: stopped.native.openSockets === 0 };
  assert.equal(receipt.pageErrors.length, 0); assert.equal(receipt.localApiRequests, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error); receipt.failureStage = stage; process.exitCode = 1;
  receipt.players = await Promise.all(pages.map(page => snapshot(page).catch(() => null)));
} finally {
  for (const page of pages) await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
  await browser?.close();
  receipt.cleanup = { browserClosed: true, staticServerCreated: false, fixtureServiceCreated: false };
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, stage, receivedBySecond: receipt.players[1]?.graph.peerBytes,
    uploadedByFirst: receipt.players[0]?.graph.uploadedBytes, pageErrors: receipt.pageErrors.length, browserClosed: true }));
}
