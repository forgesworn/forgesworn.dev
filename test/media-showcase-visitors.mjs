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
  nativeMedia: [], mediaRequests: [], droppedMediaRequestRecords: 0, staticMediaResponses: [], cleanup: {} };
let browser, stage = 'setup';
const pages = [], mediaHttp = [], cdps = [];
const performanceSessions = new WeakMap();
const PERFORMANCE_FIELDS = new Set(['Timestamp', 'TaskDuration', 'TaskOtherDuration', 'ScriptDuration', 'LayoutDuration',
  'RecalcStyleDuration', 'ThreadTime', 'ProcessTime', 'JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'Frames',
  'LayoutCount', 'RecalcStyleCount']);
const REQUEST_PRIORITIES = new Set(['VeryLow', 'Low', 'Medium', 'High', 'VeryHigh']);
const BODY_CHUNK_LIMIT = 64, PRIORITY_CHANGE_LIMIT = 16, LONG_TASK_LIMIT = 128;
const priority = value => REQUEST_PRIORITIES.has(value) ? value : null;
const isMedia = value => {
  const resource = new URL(value);
  return /\.(?:m3u8|mp4|m4s)$/.test(resource.pathname) &&
    (resource.origin === 'https://v4v.com' && resource.pathname.startsWith('/forgesworn-media-demo/dejavu-4k-v1/') ||
      resource.origin === url.origin && /^\/media\/(?:dejavu-4k\/|dejavu-preview\/rtmp\/)/.test(resource.pathname));
};
const meetsContribution = (player, index) => Number.isFinite(player.core.loadedMediaBytes) && player.core.loadedMediaBytes > 0 &&
  player.peerBytes >= Math.max(1, options.minPeerBytes) &&
  player.peerBytes / Math.max(1, player.core.loadedMediaBytes) >= options.minPeerShare &&
  (options.minPeerShare === 0 || mediaHttp[index].bodyBytes < player.core.loadedMediaBytes);

// Same bounded single-range behaviour as the local demo server. HEAD ignores
// Range; GET supports closed, open-ended and suffix ranges without changing data.
function staticResource(body, range, method = 'GET') {
  const headers = { 'accept-ranges': 'bytes', 'content-length': String(body.length) };
  if (method === 'HEAD') return { status: 200, headers, body: Buffer.alloc(0) };
  if (!range) return { status: 200, headers, body };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const unsatisfied = () => ({ status: 416, headers: { ...headers, 'content-length': '0',
    'content-range': 'bytes */' + body.length }, body: Buffer.alloc(0) });
  if (!match || (!match[1] && !match[2]) || body.length === 0) return unsatisfied();
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) return unsatisfied();
  const start = first === null ? Math.max(0, body.length - last) : first;
  const end = first !== null && last !== null ? Math.min(body.length - 1, last) : body.length - 1;
  if (start > end || start >= body.length || start < 0) return unsatisfied();
  return { status: 206, headers: { ...headers, 'content-length': String(end - start + 1),
    'content-range': 'bytes ' + start + '-' + end + '/' + body.length }, body: body.subarray(start, end + 1) };
}

function assertStaticResource() {
  const body = Buffer.from('#EXTM3U\n');
  for (const [range, expected] of [['bytes=0-', body], ['bytes=1-', body.subarray(1)],
    ['bytes=-2', body.subarray(-2)], ['bytes=0-999', body], ['bytes=0-0', body.subarray(0, 1)]]) {
    const reply = staticResource(body, range);
    assert.equal(reply.status, 206); assert.deepEqual(reply.body, expected);
    assert.equal(Number(reply.headers['content-length']), expected.length);
  }
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=8-', 'bytes=2-1', 'bytes=0-9007199254740992', 'bytes=0-1,3-4'])
    assert.equal(staticResource(body, range).status, 416);
  const head = staticResource(body, 'bytes=0-', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), body.length);
  assert.equal(staticResource(Buffer.alloc(0), 'bytes=0-').status, 416);
  return { passed: true, closedOpenSuffixClampAndHead: true };
}

function observedModule(resource, diagnostics) {
  const target = new URL(resource);
  return target.origin === 'https://forgesworn.dev' && (target.pathname === '/media-public-swarm.mjs' ||
    diagnostics && target.pathname === '/media-lab.mjs');
}

function assertObservedModules() {
  for (const query of ['', '?v=fixture']) {
    assert(observedModule('https://forgesworn.dev/media-public-swarm.mjs' + query, false));
    assert(observedModule('https://forgesworn.dev/media-public-swarm.mjs' + query, true));
    assert(observedModule('https://forgesworn.dev/media-lab.mjs' + query, true));
    assert.equal(observedModule('https://forgesworn.dev/media-lab.mjs' + query, false), false);
  }
  for (const other of ['https://example.org/media-lab.mjs', 'https://forgesworn.dev/media-lab.mjs.map',
    'https://forgesworn.dev/vendor/media-peer-demo.js', 'https://forgesworn.dev/media/dejavu-4k/index.m3u8'])
    assert.equal(observedModule(other, true), false);
  return { passed: true, nonDiagnostic: ['media-public-swarm.mjs'], diagnostic: ['media-public-swarm.mjs', 'media-lab.mjs'] };
}

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

function instrumentController(source) {
  for (const [before, after] of [
    ["s.playbackEngine = 'hls.js';", "s.playbackEngine = 'hls.js'; window.__visitorQa.hls = player;"],
    ['s.hls.on(Hls.Events.ERROR, (_, data) => {',
      's.hls.on(Hls.Events.ERROR, (_, data) => { window.__visitorQa.captureHlsError(data);'],
  ]) {
    assert.equal(source.split(before).length, 2, 'The Hls observation anchor must match exactly once: ' + before);
    source = source.replace(before, after);
  }
  return source;
}

async function performanceSnapshot(page) {
  const session = performanceSessions.get(page);
  if (!session || session.state !== 'ready') return { state: session?.state ?? 'unavailable', metrics: null };
  // One bounded request per existing sample. A delayed CDP reply is retained
  // as pending, rather than queueing more diagnostic work behind it.
  if (session.pending) return { state: 'pending', requestedAt: session.pending.requestedAt, metrics: null };
  const requestedAt = Date.now(), pending = { requestedAt };
  session.pending = pending;
  const request = session.cdp.send('Performance.getMetrics').then(result => {
    if (!Array.isArray(result.metrics)) throw new Error('Missing diagnostic metrics');
    const metrics = Object.fromEntries(result.metrics.filter(row => PERFORMANCE_FIELDS.has(row.name) && Number.isFinite(row.value))
      .map(row => [row.name, row.value]));
    return { state: 'ready', requestedAt, receivedAt: Date.now(), metrics,
      missingMetrics: [...PERFORMANCE_FIELDS].filter(name => !Object.hasOwn(metrics, name)) };
  }).catch(() => ({ state: 'unavailable', requestedAt, receivedAt: Date.now(), metrics: null }))
    .finally(() => { if (session.pending === pending) session.pending = null; });
  let deadline;
  try {
    return await Promise.race([request, new Promise(resolve => { deadline = setTimeout(() =>
      resolve({ state: 'timeout', requestedAt, receivedAt: Date.now(), metrics: null }), 1000); })]);
  } finally { clearTimeout(deadline); }
}

async function snapshot(page) {
  const pending = page.evaluate(async () => {
    const qa = window.__visitorQa;
    qa.flushLongTasks?.();
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
      playbackEngine: root.dataset.playbackEngine ?? null, playbackFallback: root.dataset.playbackFallback ?? null,
      core: { state: root.dataset.peerEngine, multiHolderDelivered: observedNumber(root.dataset.multiHolderDelivered),
        loadedMediaBytes: observedNumber(root.dataset.loadedMediaBytes), originTransferredBytes: observedNumber(root.dataset.originTransferredBytes),
        cacheHighWaterBytes: Number(root.dataset.cacheHighWaterBytes), worker: adapter?.core?.transferWorker ?? null },
      stallCount: reading('browser-stalls'), stalledSeconds: reading('browser-stall-time'),
      sourceNetworkBodyBytes: observedNumber(root.dataset.sourceNetworkBytes), sourceCacheBodyBytes: observedNumber(root.dataset.sourceCacheBytes),
      visiblePeers: document.getElementById('public-peers').textContent,
      room: { listeners: Number(root.dataset.sharedListeners ?? 0), epoch: root.dataset.sharedEpoch ?? null,
        state: root.dataset.sharedSession ?? null, position: observedNumber(root.dataset.sharedPosition) },
      library: adapter?.library ?? null, viewerId: adapter?.viewerId ?? null, topology, adapterResources: adapter?.resources ?? null,
      workerEvidence: qa.workers.map(record => ({ ...record, posts: { ...record.posts } })),
      hlsErrors: qa.hlsErrors.slice(), hls: qa.hls ? { loadingEnabled: qa.hls.loadingEnabled,
        mediaAttached: qa.hls.media === video, currentLevel: qa.hls.currentLevel, bandwidthEstimate: qa.hls.bandwidthEstimate } : null,
      diagnostics: raw ? { segments: raw.segments, bytes: raw.bytes, core: raw.core,
        peerCounts: Object.fromEntries(Object.entries(raw.peers).filter(([, value]) => typeof value === 'number')),
        eligibility: raw.peerEligibilityDiagnostics, requests: raw.peerRequestDiagnostics, refusals: raw.uploadRefusalDiagnostics,
        transport: raw.transportDiagnostics, errors: { total: raw.errors?.total, byStage: raw.errors?.byStage } } : undefined,
      passiveDiagnostics: qa.wantDiagnostics ? { longTasks: { ...qa.longTasks, recent: qa.longTasks.recent.slice() } } : undefined,
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
  if (options.diagnostics !== 'true') return pending;
  const [result, performance] = await Promise.all([pending, performanceSnapshot(page)]);
  result.passiveDiagnostics.performance = performance;
  return result;
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

function deliveryTail(samples, windowMs = 60_000) {
  if (samples.length < 2) return null;
  const end = samples.at(-1), target = Math.max(0, end.elapsedMs - windowMs);
  const begin = samples.find(sample => sample.elapsedMs >= target) ?? samples[0];
  const selected = samples.filter(sample => sample.elapsedMs >= begin.elapsedMs);
  const delta = (after, before) => Number.isFinite(after) && Number.isFinite(before) && after >= before ? after - before : null;
  return { fromElapsedMs: begin.elapsedMs, toElapsedMs: end.elapsedMs, seconds: (end.elapsedMs - begin.elapsedMs) / 1000,
    visitors: end.players.map((player, index) => {
      const first = begin.players[index], epochs = [];
      for (const sample of selected) {
        const current = sample.players[index], previous = epochs.at(-1)?.last.players[index];
        const engine = current.playbackEngine || (current.core.state === 'ready' ? 'hls' : 'unavailable');
        const reason = !previous ? 'window-start' : engine !== epochs.at(-1).engine ? 'engine-change' :
          Number.isFinite(current.core.loadedMediaBytes) !== Number.isFinite(previous.core.loadedMediaBytes) ? 'counter-availability-change' :
            Number.isFinite(current.core.loadedMediaBytes) && current.core.loadedMediaBytes < previous.core.loadedMediaBytes ? 'accepted-counter-reset' :
              current.peerBytes < previous.peerBytes || current.uploadedBytes < previous.uploadedBytes ||
                current.droppedFrames < previous.droppedFrames ? 'media-counter-reset' : null;
        if (reason) epochs.push({ engine, reason, first: sample, last: sample }); else epochs.at(-1).last = sample;
      }
      const segments = epochs.map(epoch => {
        const a = epoch.first.players[index], b = epoch.last.players[index];
        const acceptedBytes = delta(b.core.loadedMediaBytes, a.core.loadedMediaBytes), peerBytes = delta(b.peerBytes, a.peerBytes);
        const httpBodyBytes = epoch.last.mediaHttp[index].bodyBytes - epoch.first.mediaHttp[index].bodyBytes;
        return { engine: epoch.engine, reason: epoch.reason, fromElapsedMs: epoch.first.elapsedMs, toElapsedMs: epoch.last.elapsedMs,
          seconds: (epoch.last.elapsedMs - epoch.first.elapsedMs) / 1000, acceptedBytes, peerBytes,
          logicalSourceBytes: delta(b.originBytes, a.originBytes), httpBodyBytes,
          usefulPeerShare: acceptedBytes > 0 && peerBytes !== null ? peerBytes / acceptedBytes : null,
          httpBodyBelowAccepted: acceptedBytes > 0 ? httpBodyBytes < acceptedBytes : null };
      });
      const discontinuity = epochs.length > 1 || !Number.isFinite(first.core.loadedMediaBytes) || !Number.isFinite(player.core.loadedMediaBytes);
      const peerBytes = delta(player.peerBytes, first.peerBytes);
      const acceptedBytes = discontinuity ? null : delta(player.core.loadedMediaBytes, first.core.loadedMediaBytes);
      const httpBodyBytes = end.mediaHttp[index].bodyBytes - begin.mediaHttp[index].bodyBytes;
      const window = selected.map(sample => sample.players[index]);
      return { visitor: index, discontinuity, epochs: segments, peerBytes, acceptedBytes,
        logicalSourceBytes: discontinuity ? null : delta(player.originBytes, first.originBytes),
        usefulPeerShare: acceptedBytes > 0 ? peerBytes / acceptedBytes : null,
        submittedUploadBytes: delta(player.uploadedBytes, first.uploadedBytes), httpBodyBytes,
        httpBodyBelowAccepted: acceptedBytes > 0 ? httpBodyBytes < acceptedBytes : null,
        completedEncodedTransferBytes: end.mediaHttp[index].encodedTransferBytes - begin.mediaHttp[index].encodedTransferBytes,
        newStalls: delta(player.stallCount, first.stallCount),
        addedStalledSeconds: delta(player.stalledSeconds, first.stalledSeconds),
        droppedFrames: delta(player.droppedFrames, first.droppedFrames),
        minimumBufferSeconds: Math.min(...window.map(sample => sample.bufferSeconds)),
        frozenOrSeekingSamples: window.filter(sample => sample.seeking || sample.readyState < 3).length,
        startTime: first.currentTime, endTime: player.currentTime };
    }) };
}

function tailSummary() { return deliveryTail(receipt.samples); }

try {
  if (options.diagnostics === 'true') receipt.passiveDiagnosticBoundary = {
    performanceMetrics: [...PERFORMANCE_FIELDS], metricUnits: 'CDP duration/time counters are cumulative seconds; heap sizes are bytes; counts retain CDP units.',
    cadence: 'One Performance.getMetrics query alongside each existing snapshot; 1s operation deadline; at most one outstanding query per page. No new polling timer.',
    longTasks: { limit: LONG_TASK_LIMIT, fields: ['startTime', 'durationMs'], timeBase: 'Page performance.timeOrigin + startTime (ms); support and drop state are explicit.' },
    bodyChunks: { limitPerRequest: BODY_CHUNK_LIMIT, fields: ['at', 'bytes', 'encodedBytes'], timeBase: 'Request wall time + CDP monotonic timestamp delta (ms).' },
    priorityChanges: { limitPerRequest: PRIORITY_CHANGE_LIMIT, values: [...REQUEST_PRIORITIES] },
    inferenceLimit: 'Correlation only: missing metrics do not establish idle CPU; long tasks do not identify the cause of a network slowdown.',
  };
  receipt.staticRangeSelfChecks = assertStaticResource();
  receipt.observerModuleSelfChecks = assertObservedModules();
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
      if (path === '/media-lab.mjs' && options.diagnostics === 'true') body = Buffer.from(instrumentController(body.toString()));
      if (options.site) {
        const reply = staticResource(body, route.request().headers().range, route.request().method());
        if (isMedia(route.request().url()) && receipt.staticMediaResponses.length < 512)
          receipt.staticMediaResponses.push({ visitor: index, at: Date.now(), path, method: route.request().method(),
            range: route.request().headers().range ?? null, status: reply.status, bodyBytes: reply.body.length, headers: reply.headers });
        return route.fulfill({ ...reply, contentType });
      }
      return route.fulfill({ status, headers, contentType, body });
    };
    await context.route(options.site ? url.origin + '/**' : resource => observedModule(resource, options.diagnostics === 'true'), routeAsset);
    const page = await context.newPage(); pages.push(page);
    const http = { requests: 0, completed: 0, failed: 0, bodyBytes: 0, encodedTransferBytes: 0 };
    const requestIds = new Set(), requestRecords = new Map(); mediaHttp.push(http);
    const requests = []; receipt.mediaRequests.push(requests);
    const nativeMedia = { properties: {}, errors: [] }; receipt.nativeMedia.push(nativeMedia);
    const cdp = await context.newCDPSession(page); cdps.push(cdp);
    await cdp.send('Network.enable'); await cdp.send('Media.enable');
    if (options.diagnostics === 'true') {
      const performance = { cdp, state: 'unavailable', pending: null };
      performanceSessions.set(page, performance);
      try { await cdp.send('Performance.enable'); performance.state = 'ready'; } catch {}
    }
    cdp.on('Media.playerPropertiesChanged', event => {
      for (const property of event.properties) if (/^(?:kAudioTracks|kAudioDecoderName|audio_decoder|kVideoDecoderName|kResolution)$/.test(property.name))
        nativeMedia.properties[property.name] = property.value;
    });
    cdp.on('Media.playerErrorsRaised', event => { if (nativeMedia.errors.length < 30) nativeMedia.errors.push(...event.errors); });
    const at = (event, record) => record.startedAt + (event.timestamp - record.timestamp) * 1000;
    cdp.on('Network.requestWillBeSent', event => { if (isMedia(event.request.url)) {
      requestIds.add(event.requestId); http.requests++;
      if (requests.length >= 512) { receipt.droppedMediaRequestRecords++; return; }
      const range = Object.entries(event.request.headers).find(([key]) => key.toLowerCase() === 'range')?.[1] ?? null;
      const record = { id: event.requestId, url: event.request.url, method: event.request.method, range,
        startedAt: event.wallTime * 1000, timestamp: event.timestamp, status: null, protocol: null,
        responseAt: null, firstBodyAt: null, lastBodyAt: null, endedAt: null, bodyBytes: 0, encodedDataBytes: 0,
        completedEncodedTransferBytes: null, completed: false, error: null,
        ...(options.diagnostics === 'true' ? { initialPriority: priority(event.request.initialPriority),
          priority: priority(event.request.initialPriority), priorityChanges: [], droppedPriorityChanges: 0,
          bodyChunks: [], bodyChunkCount: 0, droppedBodyChunks: 0 } : {}) };
      requests.push(record); requestRecords.set(event.requestId, record);
    } });
    if (options.diagnostics === 'true') cdp.on('Network.resourceChangedPriority', event => {
      const record = requestRecords.get(event.requestId); if (!record) return;
      record.priority = priority(event.newPriority);
      if (record.priorityChanges.length === PRIORITY_CHANGE_LIMIT) { record.priorityChanges.shift(); record.droppedPriorityChanges++; }
      record.priorityChanges.push({ at: at(event, record), priority: record.priority });
    });
    cdp.on('Network.responseReceived', event => {
      const record = requestRecords.get(event.requestId); if (!record) return;
      record.status = event.response.status; record.protocol = event.response.protocol;
      record.responseAt = at(event, record); record.ttfbMs = record.responseAt - record.startedAt;
      record.fromDiskCache = event.response.fromDiskCache ?? false; record.fromServiceWorker = event.response.fromServiceWorker ?? false;
      record.headers = Object.fromEntries(Object.entries(event.response.headers).filter(([key]) =>
        /^(?:content-length|content-type|content-encoding|content-range|accept-ranges|cache-control|age|cf-cache-status|retry-after|timing-allow-origin)$/i.test(key)));
    });
    cdp.on('Network.dataReceived', event => {
      if (requestIds.has(event.requestId)) http.bodyBytes += event.dataLength;
      const record = requestRecords.get(event.requestId); if (!record) return;
      record.firstBodyAt ??= at(event, record); record.lastBodyAt = at(event, record);
      record.bodyBytes += event.dataLength; record.encodedDataBytes += event.encodedDataLength;
      if (options.diagnostics === 'true') {
        record.bodyChunkCount++;
        if (record.bodyChunks.length === BODY_CHUNK_LIMIT) { record.bodyChunks.shift(); record.droppedBodyChunks++; }
        record.bodyChunks.push({ at: at(event, record), bytes: event.dataLength, encodedBytes: event.encodedDataLength });
      }
    });
    cdp.on('Network.loadingFinished', event => {
      if (requestIds.has(event.requestId)) { http.completed++; http.encodedTransferBytes += event.encodedDataLength; requestIds.delete(event.requestId); }
      const record = requestRecords.get(event.requestId); if (!record) return;
      record.completed = true; record.endedAt = at(event, record); record.durationMs = record.endedAt - record.startedAt;
      record.completedEncodedTransferBytes = event.encodedDataLength; requestRecords.delete(event.requestId);
    });
    cdp.on('Network.loadingFailed', event => {
      if (requestIds.has(event.requestId)) { http.failed++; requestIds.delete(event.requestId); }
      const record = requestRecords.get(event.requestId); if (!record) return;
      record.endedAt = at(event, record); record.durationMs = record.endedAt - record.startedAt;
      record.error = event.errorText; record.cancelled = event.canceled ?? false; requestRecords.delete(event.requestId);
    });
    await page.addInitScript(({ wantDiagnostics, longTaskLimit }) => {
      const qa = window.__visitorQa = { peers: [], ownedPeers: [], sockets: [], ownedSockets: [], workers: [], events: [], hlsErrors: [], presentedFrames: 0, codedFrame: null, wantDiagnostics };
      if (wantDiagnostics) {
        const supported = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
        const tasks = qa.longTasks = { state: supported ? 'unavailable' : 'unsupported', timeOrigin: performance.timeOrigin,
          count: supported ? 0 : null, totalDurationMs: supported ? 0 : null, maxDurationMs: supported ? 0 : null,
          recent: [], droppedRecent: 0, observerDroppedMaxReport: null };
        if (supported) {
          let observer;
          const accept = (entries, dropped) => {
            if (Number.isSafeInteger(dropped) && dropped >= 0) tasks.observerDroppedMaxReport = Math.max(tasks.observerDroppedMaxReport ?? 0, dropped);
            for (const entry of entries) {
              if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
              tasks.count++; tasks.totalDurationMs += entry.duration; tasks.maxDurationMs = Math.max(tasks.maxDurationMs, entry.duration);
              if (tasks.recent.length === longTaskLimit) { tasks.recent.shift(); tasks.droppedRecent++; }
              tasks.recent.push({ startTime: entry.startTime, durationMs: entry.duration });
            }
          };
          try {
            observer = new PerformanceObserver((list, _observer, options) => accept(list.getEntries(), options?.droppedEntriesCount));
            observer.observe({ type: 'longtask', buffered: true }); tasks.state = 'observing';
            qa.flushLongTasks = () => accept(observer.takeRecords());
            window.addEventListener('pagehide', () => { qa.flushLongTasks(); observer.disconnect(); tasks.state = 'stopped'; }, { once: true });
          } catch { observer?.disconnect(); tasks.state = 'unavailable'; tasks.count = tasks.totalDurationMs = tasks.maxDurationMs = null; }
        }
      }
      qa.captureHlsError = data => {
        const video = document.getElementById('lab-video'), buffered = [];
        for (let i = 0; i < Math.min(4, video.buffered.length); i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]);
        qa.hlsErrors.push({ at: Date.now(), type: data.type, details: data.details, fatal: data.fatal,
          message: String(data.error?.message ?? data.reason ?? '').slice(0, 1000), time: video.currentTime, readyState: video.readyState, buffered,
          response: data.response ? { url: data.response.url ?? null, code: data.response.code ?? null } : null,
          fragment: data.frag ? { url: data.frag.url, sn: data.frag.sn, start: data.frag.start, duration: data.frag.duration, level: data.frag.level } : null,
          retryCount: data.errorAction?.retryCount ?? data.retryCount ?? null,
          retryAction: data.errorAction ? { action: data.errorAction.action, flags: data.errorAction.flags } : null });
        if (qa.hlsErrors.length > 128) qa.hlsErrors.shift();
      };
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
    }, { wantDiagnostics: options.diagnostics === 'true', longTaskLimit: LONG_TASK_LIMIT });
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
