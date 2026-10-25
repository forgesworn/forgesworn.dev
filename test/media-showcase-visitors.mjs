#!/usr/bin/env node
// The actual page, two independent visitors, public signalling and native RTC.
// Candidate routing adds observation references only; media and deadlines stay real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { chromium } from 'playwright';

const options = { url: 'https://forgesworn.dev/', quality: 'preview' };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = { '--url': 'url', '--quality': 'quality', '--site': 'site', '--output': 'output', '--screenshots': 'screenshots',
    '--observe-seconds': 'observeSeconds', '--min-peer-bytes': 'minPeerBytes', '--min-peer-share': 'minPeerShare', '--diagnostics': 'diagnostics' }[process.argv[index]];
  assert(name && process.argv[index + 1], 'Use --output PRIVATE.json [--site site] [--quality preview|full] [--observe-seconds 0..360]');
  options[name] = ['site', 'output', 'screenshots'].includes(name) ? resolve(process.argv[index + 1]) : process.argv[index + 1];
}
assert(options.output && ['preview', 'full'].includes(options.quality));
for (const [key, maximum] of [['observeSeconds', 360], ['minPeerBytes', 1024 ** 3], ['minPeerShare', 1]]) {
  options[key] = Number(options[key] ?? 0);
  assert(Number.isFinite(options[key]) && options[key] >= 0 && options[key] <= maximum);
}
const url = new URL(options.url);
assert.equal(url.origin, 'https://forgesworn.dev');
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.woff2': 'font/woff2', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.wasm': 'application/wasm', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const receipt = { schema: 2, measuredAt: new Date().toISOString(), passed: false, page: url.href, quality: options.quality,
  scenario: 'Actual homepage, two independent contexts, one visible player each',
  candidateStaticFileRouting: Boolean(options.site), publicSignallingSimulated: false, nativeWebRtc: true,
  mediaDecodingSimulated: false, hiddenHolders: 0, noAutoplayOverride: true,
  networkBoundary: 'Two fresh contexts on one Mac; actual public Nostr WSS and native WebRTC. Physical devices and separate-network NAT are not asserted.',
  cacheBoundary: 'Playwright request routing disables the browser HTTP cache throughout this run, including remote media. This is persistent cache bypass, stronger than only a cold first visit.',
  trafficBoundary: 'Headline and graph bytes are verified media or submitted media, not RTC protocol bytes. CDP HTTP body bytes include partial aborted responses; completed encoded-transfer bytes exclude those partial responses and are not total wire traffic.',
  audioBoundary: 'The unmodified page audio route is used. Native CDP audio-decoder properties plus unmuted advancing playback are recorded; no AudioContext or analyser is inserted.',
  privateDiagnosticExposure: options.diagnostics === 'true',
  pageErrors: [], localApiRequests: 0, deadTurnEndpointRequests: 0, sockets: [], sources: [], players: [], samples: [],
  nativeMedia: [], cleanup: {} };
let browser, stage = 'setup';
const pages = [], mediaHttp = [], cdps = [];
const isMedia = value => {
  const resource = new URL(value);
  return /\.(?:m3u8|mp4|m4s)$/.test(resource.pathname) &&
    (resource.origin === 'https://v4v.com' && resource.pathname.startsWith('/forgesworn-media-demo/dejavu-4k-v1/') ||
      resource.origin === url.origin && /^\/media\/(?:dejavu-4k\/|dejavu-preview\/rtmp\/)/.test(resource.pathname));
};
const meetsContribution = (player, index) => player.peerBytes >= Math.max(1, options.minPeerBytes) &&
  player.peerBytes / Math.max(1, player.core.loadedMediaBytes) >= options.minPeerShare &&
  (options.minPeerShare === 0 || mediaHttp[index].bodyBytes < player.core.loadedMediaBytes);

function instrumentAdapter(source) {
  const substitutions = [
    ['sockets.add(this);', 'sockets.add(this); window.__visitorQa.ownedSockets.push(this);'],
    ['connections.add(this);', 'connections.add(this); window.__visitorQa.ownedPeers.push(this);'],
    ['return { setEnabled, metrics, stop };',
      'const qaAdapter = { setEnabled, metrics, stop }; window.__visitorQa.adapter = qaAdapter; return qaAdapter;'],
    ['swarm = createSwarm(', 'swarm = window.__visitorQa.swarm = createSwarm('],
  ];
  for (const [before, after] of substitutions) {
    assert.equal(source.split(before).length, 2, 'The observation anchor must match exactly once: ' + before);
    source = source.replace(before, after);
  }
  return source;
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const qa = window.__visitorQa;
    const connections = await Promise.all(qa.peers.map(async (peer, nativeId) => {
      const record = { nativeId, owned: qa.ownedPeers.includes(peer), state: peer.connectionState };
      if (record.state === 'closed') return record;
      try {
        const reports = [...(await peer.getStats()).values()].filter(row => row.type === 'data-channel');
        record.bytesSent = reports.reduce((sum, row) => sum + (row.bytesSent ?? 0), 0);
        record.bytesReceived = reports.reduce((sum, row) => sum + (row.bytesReceived ?? 0), 0);
      } catch {}
      return record;
    }));
    const video = document.getElementById('lab-video'), map = document.getElementById('public-swarm-map');
    const root = document.getElementById('main'), raw = qa.wantDiagnostics ? qa.swarm?.metrics() : null, adapter = qa.adapter?.metrics();
    const observedNumber = value => value === '' || value === undefined || value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const bytes = id => observedNumber(document.getElementById(id)?.dataset.bytes);
    const reading = id => observedNumber(/^[\d.]+/.exec(document.getElementById(id)?.textContent ?? '')?.[0]);
    const accepted = qa.swarm?.peerConnectionDetails?.() ?? [];
    const topology = (adapter?.topology.connections ?? []).map(peer => ({ ...peer,
      nativeId: qa.peers.indexOf(accepted.find(item => item.pubkey === peer.peerId)?.connection) }));
    const buffered = [];
    let bufferSeconds = 0;
    for (let index = 0; index < video.buffered.length; index++) {
      const start = video.buffered.start(index), end = video.buffered.end(index);
      buffered.push([start, end]);
      if (video.currentTime >= start && video.currentTime <= end) bufferSeconds = end - video.currentTime;
    }
    const peerNodes = [...map.querySelectorAll('[data-swarm-node="listener"][data-peer-id]')].map(node => ({
      id: node.dataset.peerId, peerId: node.dataset.viewerId, roomMemberId: node.dataset.roomMemberId ?? null,
      uploadedBytes: Number(node.dataset.mediaBytesSent), verifiedPeerBytes: Number(node.dataset.verifiedMediaBytesReceived),
      label: node.querySelector('.swarm-sub')?.textContent, name: node.querySelector('.swarm-label')?.textContent,
    }));
    return { measuredAt: Date.now(), currentTime: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight,
      codedFrame: qa.codedFrame, presentedFrames: qa.presentedFrames, bufferSeconds, buffered, readyState: video.readyState, seeking: video.seeking,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, droppedFrames: video.getVideoPlaybackQuality().droppedVideoFrames,
      paused: video.paused, muted: video.muted, volume: video.volume,
      totalVideoElements: document.querySelectorAll('video').length,
      visibleVideoElements: [...document.querySelectorAll('video')].filter(node => !node.hidden && node.getBoundingClientRect().width > 0).length,
      quality: document.getElementById('lab-quality').value, visibleDelivery: document.getElementById('public-delivery').textContent,
      visiblePeerBytes: document.getElementById('public-peer-bytes').textContent,
      visibleUploadedBytes: document.getElementById('public-upload-bytes').textContent,
      visibleOriginBytes: document.getElementById('public-origin-bytes')?.textContent,
      originBytes: bytes('public-origin-bytes'), peerBytes: bytes('public-peer-bytes'), uploadedBytes: bytes('public-upload-bytes'),
      core: { state: root.dataset.peerEngine, multiHolderDelivered: Number(root.dataset.multiHolderDelivered),
        loadedMediaBytes: Number(root.dataset.loadedMediaBytes), originTransferredBytes: Number(root.dataset.originTransferredBytes),
        cacheHighWaterBytes: Number(root.dataset.cacheHighWaterBytes), worker: adapter?.core?.transferWorker ?? null },
      stallCount: reading('browser-stalls'), stalledSeconds: reading('browser-stall-time'),
      sourceNetworkBodyBytes: observedNumber(root.dataset.sourceNetworkBytes), sourceCacheBodyBytes: observedNumber(root.dataset.sourceCacheBytes),
      visiblePeers: document.getElementById('public-peers').textContent,
      room: { listeners: Number(root.dataset.sharedListeners ?? 0), epoch: root.dataset.sharedEpoch ?? null,
        state: root.dataset.sharedSession ?? null, position: observedNumber(root.dataset.sharedPosition) },
      viewerId: adapter?.viewerId ?? null, topology, adapterResources: adapter?.resources ?? null,
      workerEvidence: qa.workers.map(record => ({ ...record, posts: { ...record.posts } })),
      diagnostics: raw ? { segments: raw.segments, bytes: raw.bytes, core: raw.core,
        peerCounts: Object.fromEntries(Object.entries(raw.peers).filter(([, value]) => typeof value === 'number')),
        eligibility: raw.peerEligibilityDiagnostics, requests: raw.peerRequestDiagnostics, refusals: raw.uploadRefusalDiagnostics,
        transport: raw.transportDiagnostics, errors: { total: raw.errors?.total, byStage: raw.errors?.byStage } } : undefined,
      graph: { peerBytes: Number(map.dataset.peerBytes), uploadedBytes: Number(map.dataset.uploadedBytes),
        observedPeers: Number(map.dataset.observedPeers), connectedPeers: Number(map.dataset.connectedPeers),
        roomMembers: Number(map.dataset.roomMembers), unmappedConnections: Number(map.dataset.unmappedConnections),
        drawnPeerNodes: peerNodes.length, media: peerNodes,
        roomNodes: [...map.querySelectorAll('[data-room-member-id]')].map(node => ({
          id: node.dataset.roomMemberId, kind: node.dataset.swarmNode, name: node.querySelector('.swarm-label')?.textContent,
          detail: node.querySelector('.swarm-sub')?.textContent })),
        nativeEdges: [...map.querySelectorAll('[data-edge-kind="native-peer"]')].map(edge => ({
          id: edge.dataset.connectionId, fromPeerId: edge.dataset.fromPeerId, toPeerId: edge.dataset.toPeerId,
          attribution: edge.dataset.attribution })),
        nativeDescription: map.querySelector('svg')?.getAttribute('aria-label'),
        viewBox: map.querySelector('svg')?.getAttribute('viewBox') },
      native: { connections, activeConnections: connections.filter(peer => peer.state !== 'closed').length,
        connectedConnections: connections.filter(peer => peer.owned && peer.state === 'connected').length,
        openSockets: qa.sockets.filter(socket => socket.readyState < 2).length,
        ownedOpenSockets: qa.ownedSockets.filter(socket => socket.readyState < 2).length,
        passiveOpenSockets: qa.sockets.filter(socket => !qa.ownedSockets.includes(socket) && socket.readyState < 2).length },
    };
  });
}

function assertGraph(player) {
  assert.equal(player.graph.peerBytes, player.peerBytes, 'Graph and verified headline must agree.');
  assert.equal(player.graph.uploadedBytes, player.uploadedBytes, 'Graph and media-sent headline must agree.');
  assert.equal(player.graph.connectedPeers, player.topology.length);
  assert.equal(player.graph.drawnPeerNodes, player.graph.nativeEdges.length);
  assert(player.graph.connectedPeers <= player.native.connectedConnections);
  for (const edge of player.graph.nativeEdges) {
    const actual = player.topology.find(peer => peer.id === edge.id);
    assert(actual && actual.nativeId >= 0, 'Every local graph edge must map to the actual accepted native PC.');
    assert.equal(edge.toPeerId, actual.peerId);
    assert.equal(edge.attribution, 'measured-here');
    const node = player.graph.media.find(peer => peer.id === edge.id);
    assert(node);
    assert.equal(node.peerId, actual.peerId);
    assert(node.uploadedBytes <= actual.mediaBytesSent, 'The graph cannot invent submitted media.');
    assert(node.verifiedPeerBytes <= actual.verifiedMediaBytesReceived, 'The graph cannot invent verified media.');
  }
  assert(player.graph.media.reduce((sum, peer) => sum + peer.verifiedPeerBytes, 0) <= player.peerBytes);
  assert(player.graph.media.reduce((sum, peer) => sum + peer.uploadedBytes, 0) <= player.uploadedBytes);
  // The room roster includes the local viewer and may include public outsiders.
  // Its numbering is separate from the bounded set of local native PC edges.
  const names = player.graph.roomNodes.map(node => node.kind === 'self' ? node.detail : node.name);
  const numbers = names.map(name => Number(/Listener (\d+)/.exec(name ?? '')?.[1]));
  assert(numbers.every(value => Number.isInteger(value) && value >= 1 && value <= player.graph.roomMembers));
  assert.equal(new Set(numbers).size, numbers.length);
  if (player.graph.roomMembers <= 11) assert.deepEqual(numbers.toSorted((a, b) => a - b),
    Array.from({ length: player.graph.roomMembers }, (_, index) => index + 1));
}

function tailSummary() {
  if (receipt.samples.length < 2) return null;
  const end = receipt.samples.at(-1), target = Math.max(0, end.elapsedMs - 60_000);
  const begin = receipt.samples.find(sample => sample.elapsedMs >= target) ?? receipt.samples[0];
  return { fromElapsedMs: begin.elapsedMs, toElapsedMs: end.elapsedMs, seconds: (end.elapsedMs - begin.elapsedMs) / 1000,
    visitors: end.players.map((player, index) => {
      const first = begin.players[index], peerBytes = player.peerBytes - first.peerBytes;
      const acceptedBytes = player.core.loadedMediaBytes - first.core.loadedMediaBytes;
      const httpBodyBytes = end.mediaHttp[index].bodyBytes - begin.mediaHttp[index].bodyBytes;
      const window = receipt.samples.filter(sample => sample.elapsedMs >= begin.elapsedMs).map(sample => sample.players[index]);
      return { visitor: index, peerBytes, acceptedBytes, logicalSourceBytes: player.originBytes - first.originBytes,
        usefulPeerShare: acceptedBytes > 0 ? peerBytes / acceptedBytes : null,
        submittedUploadBytes: player.uploadedBytes - first.uploadedBytes, httpBodyBytes,
        httpBodyBelowAccepted: httpBodyBytes < acceptedBytes,
        completedEncodedTransferBytes: end.mediaHttp[index].encodedTransferBytes - begin.mediaHttp[index].encodedTransferBytes,
        newStalls: player.stallCount === null || first.stallCount === null ? null : player.stallCount - first.stallCount,
        addedStalledSeconds: player.stalledSeconds === null || first.stalledSeconds === null ? null : player.stalledSeconds - first.stalledSeconds,
        droppedFrames: player.droppedFrames - first.droppedFrames,
        minimumBufferSeconds: Math.min(...window.map(sample => sample.bufferSeconds)),
        frozenOrSeekingSamples: window.filter(sample => sample.seeking || sample.readyState < 3).length,
        startTime: first.currentTime, endTime: player.currentTime };
    }) };
}

try {
  receipt.harnessSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  if (options.site) for (const file of [url.pathname === '/' ? 'index.html' : url.pathname.slice(1), 'media-lab.mjs',
    'media-public-swarm.mjs', 'media-swarm-visual.mjs', 'media-transfer-stats.mjs', 'media-showcase.css',
    'vendor/media-peer-demo.js', 'vendor/media-peer-demo.build.json', 'vendor/relayswarm-core.wasm',
    'vendor/relayswarm-transfer-worker.js', 'media/dejavu-swarm/catalogue-v2.json', 'media/dejavu-4k/index.m3u8']) {
    receipt.sources.push({ file: 'site/' + file, sha256: createHash('sha256').update(await readFile(resolve(options.site, file))).digest('hex') });
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  receipt.browserVersion = browser.version();
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const routeAsset = async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/lab/')) { receipt.localApiRequests++; return route.abort(); }
      let body, contentType, headers = {}, status = 200;
      if (options.site) {
        const file = resolve(options.site, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
        if (relative(options.site, file).startsWith('..')) return route.abort();
        try { body = await readFile(file); contentType = mime[extname(file)] ?? 'application/octet-stream'; }
        catch { return route.fulfill({ status: 404, body: 'Not found' }); }
      } else {
        const response = await route.fetch();
        body = await response.body(); status = response.status(); headers = response.headers();
        contentType = headers['content-type'];
        delete headers['content-length']; delete headers['content-encoding']; delete headers['transfer-encoding'];
      }
      if (path === '/media-public-swarm.mjs') body = Buffer.from(instrumentAdapter(body.toString()));
      const range = route.request().headers().range;
      if (options.site && range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range), start = Number(match?.[1]), end = Number(match?.[2]);
        if (!match || start > end || end >= body.length) return route.fulfill({ status: 416, headers: { 'content-range': 'bytes */' + body.length }, body: '' });
        return route.fulfill({ status: 206, contentType, headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + body.length,
          'accept-ranges': 'bytes' }, body: body.subarray(start, end + 1) });
      }
      return route.fulfill({ status, headers, contentType, body });
    };
    await context.route(options.site ? url.origin + '/**' : url.origin + '/media-public-swarm.mjs*', routeAsset);
    const page = await context.newPage(); pages.push(page);
    const http = { requests: 0, completed: 0, failed: 0, bodyBytes: 0, encodedTransferBytes: 0 };
    const requestIds = new Set(); mediaHttp.push(http);
    const nativeMedia = { properties: {}, errors: [] }; receipt.nativeMedia.push(nativeMedia);
    const cdp = await context.newCDPSession(page); cdps.push(cdp);
    await cdp.send('Network.enable'); await cdp.send('Media.enable');
    cdp.on('Media.playerPropertiesChanged', event => {
      for (const property of event.properties) if (/^(?:kAudioTracks|kAudioDecoderName|audio_decoder|kVideoDecoderName|kResolution)$/.test(property.name))
        nativeMedia.properties[property.name] = property.value;
    });
    cdp.on('Media.playerErrorsRaised', event => { if (nativeMedia.errors.length < 30) nativeMedia.errors.push(...event.errors); });
    cdp.on('Network.requestWillBeSent', event => { if (isMedia(event.request.url)) { requestIds.add(event.requestId); http.requests++; } });
    cdp.on('Network.dataReceived', event => { if (requestIds.has(event.requestId)) http.bodyBytes += event.dataLength; });
    cdp.on('Network.loadingFinished', event => { if (requestIds.has(event.requestId)) { http.completed++; http.encodedTransferBytes += event.encodedDataLength; requestIds.delete(event.requestId); } });
    cdp.on('Network.loadingFailed', event => { if (requestIds.has(event.requestId)) { http.failed++; requestIds.delete(event.requestId); } });
    await page.addInitScript(wantDiagnostics => {
      const qa = window.__visitorQa = { peers: [], ownedPeers: [], sockets: [], ownedSockets: [], workers: [], events: [], presentedFrames: 0, codedFrame: null, wantDiagnostics };
      const NativePeer = RTCPeerConnection, NativeSocket = WebSocket, NativeWorker = Worker;
      window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); qa.peers.push(this); } };
      window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); qa.sockets.push(this); } };
      window.Worker = class extends NativeWorker {
        constructor(workerUrl, workerOptions) {
          super(workerUrl, workerOptions);
          if (workerOptions?.name !== 'relayswarm-transfer') return;
          const record = this.qaWorkerRecord = { id: qa.workers.length, posts: {}, successfulFrames: 0,
            deliveredFrames: 0, deliveredBytes: 0, failedFrames: 0, terminated: false };
          qa.workers.push(record);
          this.addEventListener('message', ({ data }) => {
            if (data?.v !== 1) return;
            if (data.ok !== true) { record.failedFrames++; return; }
            record.successfulFrames++;
            if (Array.isArray(data.result?.commands) && data.result.commands.some(command => command?.t === 'deliver') &&
              ArrayBuffer.isView(data.result.bytes) && data.result.bytes.byteLength > 0) {
              record.deliveredFrames++;
              record.deliveredBytes += data.result.bytes.byteLength;
            }
          });
        }
        postMessage(...args) {
          const operation = args[0]?.op, result = super.postMessage(...args);
          if (this.qaWorkerRecord && ['init', 'new', 'start', 'delivered', 'failed', 'progress', 'tick', 'free'].includes(operation))
            this.qaWorkerRecord.posts[operation] = (this.qaWorkerRecord.posts[operation] ?? 0) + 1;
          return result;
        }
        terminate() {
          if (this.qaWorkerRecord) this.qaWorkerRecord.terminated = true;
          return super.terminate();
        }
      };
      document.addEventListener('DOMContentLoaded', () => {
        const video = document.getElementById('lab-video');
        if (!video) return;
        for (const type of ['loadedmetadata', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'pause', 'ended', 'error'])
          video.addEventListener(type, () => {
            const buffered = [];
            for (let i = 0; i < video.buffered.length; i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]);
            qa.events.push({ type, at: Date.now(), time: video.currentTime, paused: video.paused, seeking: video.seeking,
              readyState: video.readyState, buffered, errorCode: video.error?.code ?? null });
            if (qa.events.length > 600) qa.events.shift();
          });
        const frame = (_now, metadata) => {
          qa.presentedFrames++;
          qa.codedFrame = { width: metadata.width, height: metadata.height, mediaTime: metadata.mediaTime };
          video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
      }, { once: true });
    }, options.diagnostics === 'true');
    page.on('request', request => { if (new URL(request.url()).port === '7443') receipt.deadTurnEndpointRequests++; });
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
    assert.equal(initial.totalVideoElements, 1); assert.equal(initial.native.connections.length, 0);
    assert.equal(initial.native.ownedOpenSockets, 0); assert(initial.native.passiveOpenSockets <= 3);
    assert.equal(initial.graph.nativeEdges.length, 0);
    assert.equal(mediaHttp[index].requests, 0);
    (receipt.beforePlay ??= []).push(initial);
  }
  receipt.beforePlayNoPeerNetworking = receipt.beforePlay.every(player => player.native.connections.length === 0 && player.native.ownedOpenSockets === 0);
  assert(receipt.beforePlayNoPeerNetworking);
  stage = 'first-visitor-play-and-cache';
  await pages[0].click('#public-play');
  await pages[0].waitForFunction(() => {
    const video = document.getElementById('lab-video'), qa = window.__visitorQa;
    return !video.paused && qa.presentedFrames > 10 && qa.adapter?.metrics().resources.heldBytes > 0;
  }, undefined, { timeout: 20000 });
  stage = 'second-visitor-play';
  await pages[1].click('#public-play');
  const observationStart = Date.now(), deadline = observationStart + Math.max(30000, (options.observeSeconds + 10) * 1000);
  stage = 'actual-peer-traffic-and-graph';
  let snapshots;
  while (Date.now() < deadline) {
    snapshots = await Promise.all(pages.map(snapshot));
    const elapsedMs = Date.now() - observationStart;
    if (!receipt.samples.length || elapsedMs - receipt.samples.at(-1).elapsedMs >= 1000)
      receipt.samples.push({ elapsedMs, players: snapshots, mediaHttp: structuredClone(mediaHttp) });
    if (elapsedMs >= options.observeSeconds * 1000 && snapshots.some(meetsContribution) &&
      snapshots.some(player => player.uploadedBytes > 0) && snapshots.every(player => player.decodedFrames > 10 &&
        player.graph.connectedPeers > 0 && player.graph.drawnPeerNodes === player.graph.connectedPeers &&
        player.graph.nativeEdges.length === player.topology.length && player.core.worker?.state === 'ready')) break;
    await pages[0].waitForTimeout(250);
  }
  receipt.players = snapshots;
  const eligible = snapshots.map((_player, index) => index).filter(index => meetsContribution(snapshots[index], index));
  receipt.receivingVisitorIndex = (eligible.length ? eligible : snapshots.map((_player, index) => index))
    .reduce((best, index) => snapshots[index].peerBytes > snapshots[best].peerBytes ? index : best);
  const receiver = snapshots[receipt.receivingVisitorIndex];
  receipt.mediaHttp = structuredClone(mediaHttp); receipt.observationSeconds = (Date.now() - observationStart) / 1000;
  receipt.requiredPeerContribution = { bytes: options.minPeerBytes, share: options.minPeerShare };
  receipt.tail60Seconds = tailSummary();
  receipt.mediaEvents = await Promise.all(pages.map(page => page.evaluate(() => window.__visitorQa.events)));
  assert(receiver.peerBytes > 0, 'Neither visible visitor received verified peer media.');
  assert(snapshots.some(player => player.uploadedBytes > 0), 'Neither visible visitor supplied actual video.');
  for (const [index, player] of snapshots.entries()) {
    assert(player.decodedFrames > 10 && player.presentedFrames > 10 && !player.paused);
    assert.equal(player.totalVideoElements, 1); assert.equal(player.visibleVideoElements, 1);
    assert.equal(player.muted, false); assert(player.volume > 0);
    assert.equal(player.stallCount, 0, 'Playback stalled after its first presented frame.');
    assert.equal(player.stalledSeconds, 0, 'Playback accumulated time stalled after its first presented frame.');
    if (Number.isFinite(player.droppedFrames)) assert.equal(player.droppedFrames, 0, 'Native video frames were dropped.');
    const audio = receipt.nativeMedia[index].properties;
    assert(Object.entries(audio).some(([name, value]) => /AudioDecoder|audio_decoder/.test(name) && value && value !== 'unknown'),
      'Native audio decoder evidence was not observed; the page audio route is unchanged.');
    assertGraph(player);
    assert.equal(player.graph.drawnPeerNodes, player.graph.connectedPeers, 'Every accepted local peer must map to its actual graph edge.');
    assert.equal(player.core.state, 'ready'); assert.equal(player.core.worker?.state, 'ready');
    assert(player.core.cacheHighWaterBytes <= 64 * 1024 * 1024);
    assert(player.originBytes > 0 && !player.visibleOriginBytes.startsWith('0 '));
    assert(player.native.connections.some(peer => peer.bytesSent > 0 || peer.bytesReceived > 0));
    assert.equal(player.quality, options.quality);
    assert.equal(player.height, options.quality === 'preview' ? 1080 : 2160);
    if (options.quality === 'full') assert.deepEqual([player.codedFrame.width, player.codedFrame.height], [3840, 2160]);
  }
  assert(snapshots.some(player => player.core.multiHolderDelivered > 0), 'The Rust/WASM piece path did not deliver a segment.');
  const workerProof = snapshots.flatMap(player => player.workerEvidence);
  assert(workerProof.some(record => record.deliveredFrames > 0 && record.deliveredBytes > 0),
    'The real packaged Worker did not return a verified deliver frame and its bytes.');
  assert(receiver.peerBytes >= options.minPeerBytes);
  assert(receiver.graph.media.some(peer => peer.verifiedPeerBytes > 0), 'No current native edge received verified video credit.');
  assert(snapshots.some(player => player.graph.media.some(peer => peer.uploadedBytes > 0)), 'No current native edge submitted media.');
  assert(receiver.peerBytes / receiver.core.loadedMediaBytes >= options.minPeerShare, 'Useful loaded-video peer share is below the required gate.');
  if (options.minPeerShare > 0) assert(receipt.mediaHttp[receipt.receivingVisitorIndex].bodyBytes < receiver.core.loadedMediaBytes,
    'Actual HTTP media bodies, including partial aborted races, are not below video accepted for playback.');
  assert.equal(receipt.deadTurnEndpointRequests, 0, 'The disabled/dead public TURN endpoint must not be called.');
  if (options.screenshots) {
    await mkdir(options.screenshots, { recursive: true, mode: 0o700 });
    for (const [index, page] of pages.entries()) {
      await page.locator('#public-swarm-map').scrollIntoViewIfNeeded();
      await page.locator('.swarm-stage').screenshot({ path: resolve(options.screenshots, 'homepage-visitor-' + (index + 1) + '-actual-peers.png') });
    }
    const mobilePage = pages[receipt.receivingVisitorIndex];
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    await mobilePage.locator('#public-swarm-map').scrollIntoViewIfNeeded();
    await mobilePage.waitForFunction(() => Number(document.querySelector('#public-swarm-map svg').viewBox.baseVal.width) <= 390);
    await mobilePage.locator('.swarm-stage').screenshot({ path: resolve(options.screenshots, 'homepage-receiving-visitor-mobile-actual-peers.png') });
    receipt.mobile = await snapshot(mobilePage); assertGraph(receipt.mobile);
  }
  stage = 'pause-closes-owned-peer-resources';
  await pages[0].locator('#lab-video').press('Space');
  await pages[0].waitForFunction(() => {
    const qa = window.__visitorQa;
    return document.getElementById('lab-video').paused && qa.ownedPeers.every(peer => peer.connectionState === 'closed') &&
      qa.ownedSockets.every(socket => socket.readyState === 3);
  }, undefined, { timeout: 10000 });
  const stopped = await snapshot(pages[0]);
  assert.equal(stopped.graph.nativeEdges.length, 0);
  assert.equal(stopped.native.activeConnections, 0); assert.equal(stopped.native.ownedOpenSockets, 0);
  assert(stopped.native.passiveOpenSockets <= 3, 'Only bounded read-only room observer sockets may remain.');
  receipt.paused = stopped;
  const departingViewer = snapshots[0].viewerId;
  assert(departingViewer, 'The actual departing SDK identity must be observed.');
  const departingNativeIds = snapshots[1].topology.filter(peer => peer.peerId === departingViewer).map(peer => peer.nativeId);
  assert(departingNativeIds.length > 0, 'The other visitor must have a native link to the departing visitor.');
  await pages[1].waitForFunction(({ peerId, nativeIds }) =>
    !window.__visitorQa.adapter?.metrics().topology.connections.some(peer => peer.peerId === peerId) &&
    nativeIds.every(id => window.__visitorQa.peers[id]?.connectionState === 'closed'),
  { peerId: departingViewer, nativeIds: departingNativeIds }, { timeout: 10000 });
  receipt.remoteAfterPause = await snapshot(pages[1]);
  // Other public listeners may remain; only the actual departing visitor's link must disappear.
  receipt.pauseBoundary = { departingViewer, remoteConnections: receipt.remoteAfterPause.topology, publicCohortMayRemain: true };
  stage = 'resume-reconnects-actual-native-edges';
  await pages[0].locator('#lab-video').press('Space');
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const metrics = window.__visitorQa.adapter?.metrics(), map = document.getElementById('public-swarm-map');
    return !document.getElementById('lab-video').paused && metrics?.connectedPeers > 0 &&
      Number(map.dataset.connectedPeers) === metrics.connectedPeers &&
      map.querySelectorAll('[data-edge-kind="native-peer"]').length === metrics.connectedPeers;
  }, undefined, { timeout: 25000 })));
  receipt.resumed = await Promise.all(pages.map(snapshot));
  for (const player of receipt.resumed) assertGraph(player);
  assert.equal(receipt.pageErrors.length, 0); assert.equal(receipt.localApiRequests, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error); receipt.failureStage = stage; process.exitCode = 1;
  receipt.players = await Promise.all(pages.map(page => snapshot(page).catch(() => null)));
  receipt.tail60Seconds ??= tailSummary();
  receipt.mediaEvents ??= await Promise.all(pages.map(page => page.evaluate(() => window.__visitorQa.events).catch(() => null)));
} finally {
  for (const page of pages) await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => {});
  for (const page of pages) await page.waitForFunction(() => window.__visitorQa.ownedPeers.every(peer => peer.connectionState === 'closed') &&
    window.__visitorQa.ownedSockets.every(socket => socket.readyState === 3), undefined, { timeout: 5000 }).catch(() => {});
  receipt.beforeBrowserClose = await Promise.all(pages.map(page => snapshot(page).catch(() => null)));
  await Promise.all(cdps.map(cdp => cdp.detach().catch(() => {})));
  await browser?.close();
  receipt.cleanup = { browserClosed: true, staticServerCreated: false, fixtureServiceCreated: false,
    ownedPeerResourcesClosedBeforeBrowser: receipt.beforeBrowserClose.every(player => player &&
      player.native.activeConnections === 0 && player.native.ownedOpenSockets === 0) };
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, stage, receivingVisitor: receipt.receivingVisitorIndex,
    peerBytes: receipt.players.map(player => player?.peerBytes), uploads: receipt.players.map(player => player?.uploadedBytes),
    tail60Seconds: receipt.tail60Seconds, pageErrors: receipt.pageErrors.length, cleanup: receipt.cleanup }));
}
