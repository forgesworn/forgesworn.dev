import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicSwarm, validatePublicSwarmCatalogue, catalogueSegment, PUBLIC_SWARM_CATALOGUE_SHA256,
  PUBLIC_SWARM_LIMITS, PUBLIC_SWARM_RELAYS, PUBLIC_SWARM_ICE, prepareRecordedSource, createRecordedLive } from '../site/media-public-swarm.mjs';
import { verifyEvent } from '../site/vendor/media-peer-demo.js';
import { createPublicTurnCredentials } from '../site/media-turn-credentials.mjs';

const bytes = await readFile(new URL('../site/media/dejavu-swarm/catalogue-v3.json', import.meta.url));
const catalogue = JSON.parse(bytes);
const previousBytes = await readFile(new URL('../site/media/dejavu-swarm/catalogue-v2.json', import.meta.url));
const previousCatalogue = JSON.parse(previousBytes);
const libraryBuild = JSON.parse(await readFile(new URL('../site/vendor/media-peer-demo.build.json', import.meta.url)));
const preview = { quality: 'preview', playlistUrl: '/media/dejavu-preview/rtmp/index.m3u8', origin: 'https://forgesworn.dev/' };
const full = { quality: 'full', playlistUrl: '/media/dejavu-4k/index.m3u8', origin: 'https://forgesworn.dev/' };
const recordedManifests = {
  full: await readFile(new URL('../site/media/dejavu-4k/index.m3u8', import.meta.url)),
  preview: await readFile(new URL('../site/media/dejavu-preview/rtmp/stream.m3u8', import.meta.url)),
};

test('public startup shares one recording brand and one SDK module across its helpers', async () => {
  const [controller, listener, swarm] = await Promise.all(['media-lab.mjs', 'media-listener-session.mjs', 'media-public-swarm.mjs']
    .map(name => readFile(new URL(`../site/${name}`, import.meta.url), 'utf8')));
  // Separate module URLs create separate WeakSets for prepared recordings.
  // The controller fixtures alias their real helper, so check the shipped
  // graph too: preparing and consuming a recording must use one module.
  const helpers = [...controller.matchAll(/import\('(\.\/media-public-swarm\.mjs[^']*)'\)/g)].map(match => match[1]);
  assert.equal(helpers.length, 2);
  assert.equal(new Set(helpers).size, 1, 'preparation and playback must share the recording brand');
  const sdk = [listener, swarm].map(source => source.match(/from '(\.\/vendor\/media-peer-demo\.js[^']*)'/)?.[1]);
  assert(sdk.every(Boolean));
  assert.equal(new Set(sdk).size, 1, 'room and media helpers must not load duplicate SDK instances');
});

test('public VOD digest catalogue is pinned to reviewed source and matches every shipped preview segment', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PUBLIC_SWARM_CATALOGUE_SHA256);
  const plan = validatePublicSwarmCatalogue(catalogue, preview);
  for (const entry of plan.segments.values()) {
    const content = await readFile(new URL(`../site${new URL(entry.url).pathname}`, import.meta.url));
    assert.equal(content.length, entry.size);
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
    for (const [index, hash] of entry.pieces.entries()) {
      assert.equal(createHash('sha256').update(content.subarray(index * entry.pieceSize, Math.min(content.length, (index + 1) * entry.pieceSize))).digest('hex'), hash);
    }
  }
  const original = JSON.parse(await readFile(new URL('../site/media/dejavu-preview/playback.json', import.meta.url)));
  assert.equal(catalogue.sourceSha256, original.source.sha256);
  assert.equal(validatePublicSwarmCatalogue(catalogue, full).segments.size, 134);
});

test('the new catalogue changes only the approved full tail while retaining the previous immutable catalogue', () => {
  assert.equal(createHash('sha256').update(previousBytes).digest('hex'), 'fe69bf7b88279f796956a021db96b3fc99f12705c1d5f18a2f6fbe9f488b3073');
  assert.equal(catalogue.schema, 3);
  assert.equal(catalogue.derivedFromCatalogueSha256, createHash('sha256').update(previousBytes).digest('hex'));
  assert.deepEqual(catalogue.qualities.preview, previousCatalogue.qualities.preview);
  assert.deepEqual(catalogue.qualities.full.segments.slice(0, 133), previousCatalogue.qualities.full.segments.slice(0, 133));
  assert.equal(catalogue.qualities.full.swarmId, 'forgesworn-dejavu-4k-pieces-v3-76d90719a756c77d');
  const tail = catalogue.qualities.full.segments[133];
  assert.equal(tail.path, 'segment-0133-audioend-v2.m4s'); assert.equal(tail.sn, 133); assert.equal(tail.cc, 0);
  assert.equal(tail.size, 2238344); assert.equal(tail.sha256, '335270e1369142eaba9faf9964588db74f0219a8b703ac7b2ce643b5c994422d');
  assert.equal(tail.pieceSize, 65536); assert.equal(tail.pieces.length, Math.ceil(tail.size / tail.pieceSize));
  assert.throws(() => validatePublicSwarmCatalogue(previousCatalogue, full));
  const plan = validatePublicSwarmCatalogue(catalogue, full), url = new URL('segment-0133.m4s', plan.segments.values().next().value.url).href;
  assert.equal(catalogueSegment(plan, { url, frag: { sn: 133, cc: 0, level: 0, type: 'main', baseurl: plan.mediaPlaylist } }), null);
  for (const index of [0, 132, 133]) {
    const changed = structuredClone(catalogue);
    changed.qualities.full.segments[index].path = index === 133 ? 'segment-0133.m4s' : 'segment-0133-audioend-v2.m4s';
    assert.throws(() => validatePublicSwarmCatalogue(changed, full));
  }
});

test('catalogue refuses altered media identity, traversal, duplicate sequence, oversized media and unlicensed source', () => {
  for (const change of [
    value => { value.sourceSha256 = 'a'.repeat(64); },
    value => { value.licensed = false; },
    value => { value.qualities.preview.swarmId += '-evil'; },
    value => { value.qualities.preview.playlist = 'https://evil.test/index.m3u8'; },
    value => { value.qualities.preview.segments[0].path = '../secret'; },
    value => { value.qualities.preview.segments[1].sn = 0; },
    value => { value.qualities.preview.segments[0].cc = 1; },
    value => { value.qualities.preview.segments[0].size = PUBLIC_SWARM_LIMITS.maxSegmentBytes + 1; },
    value => { value.qualities.preview.segments[0].sha256 = 'not-a-hash'; },
    value => { value.qualities.preview.mediaBase = 'https://evil.test/'; },
    value => { value.qualities.preview.mediaPlaylist = '/media/other.m3u8'; },
    value => { value.qualities.preview.segments[0].pieceSize = 1; },
    value => { value.qualities.preview.segments[0].pieces.pop(); },
    value => { value.qualities.preview.segments[0].pieces[0] = 'not-a-hash'; },
  ]) {
    const altered = structuredClone(catalogue); change(altered);
    assert.throws(() => validatePublicSwarmCatalogue(altered, preview));
  }
  for (const playlistUrl of ['https://evil.test/media/dejavu-preview/rtmp/index.m3u8', `${preview.playlistUrl}?secret=x`, `${preview.playlistUrl}#x`]) {
    assert.throws(() => validatePublicSwarmCatalogue(catalogue, { ...preview, playlistUrl }));
  }
});

test('only the exact unencrypted muxed fragment receives a local commitment', () => {
  const plan = validatePublicSwarmCatalogue(catalogue, full);
  const context = { url: 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/segment-0000.m4s',
    frag: { sn: 0, cc: 0, level: 0, type: 'main', baseurl: 'https://forgesworn.dev/media/dejavu-4k/index.m3u8' } };
  assert.equal(catalogueSegment(plan, context)?.sha256, catalogue.qualities.full.segments[0].sha256);
  for (const patch of [
    value => { value.url += '?different=1'; },
    value => { value.url = 'https://evil.test/segment-0000.m4s'; },
    value => { value.frag.sn = 1; },
    value => { value.frag.cc = 1; },
    value => { value.frag.type = 'audio'; },
    value => { value.frag.baseurl = 'https://evil.test/media/dejavu-4k/index.m3u8'; },
    value => { value.frag.level = -1; },
    value => { value.frag.decryptdata = { method: 'AES-128' }; },
    value => { value.part = { index: 0 }; },
    value => { value.rangeEnd = 100; },
    value => { value.rangeStart = 1; },
  ]) {
    const changed = structuredClone(context); patch(changed);
    assert.equal(catalogueSegment(plan, changed), null);
  }
});

test('public configuration bounds upload rate, peers and cache without a cumulative byte cutoff', () => {
  assert.ok(PUBLIC_SWARM_RELAYS.every(value => new URL(value).protocol === 'wss:'));
  assert.deepEqual(PUBLIC_SWARM_ICE, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  assert.equal(PUBLIC_SWARM_LIMITS.maxPeers, 3);
  assert.equal(PUBLIC_SWARM_LIMITS.maxHeldBytes, 64 * 1024 * 1024);
  assert.equal(PUBLIC_SWARM_LIMITS.maxUploadBytesPerSecond, 4 * 1024 * 1024);
  assert.equal(PUBLIC_SWARM_LIMITS.maxUploadPeers, 2);
  assert.equal(Object.hasOwn(PUBLIC_SWARM_LIMITS, 'maxUploadBytesPerSession'), false);
});

// Exercise the real adapter lifecycle with an injected SDK factory. Native
// resource ownership and SDK accounting snapshots are simulated; no video/network
// benchmark or real GiB transfer is claimed by these unit tests.
function lifecycleFixture(t, { turnCredentials, turnConfiguration, turnFactory, origin = 'https://forgesworn.dev/live-media.html', fetchResponse, startupBufferTarget, startupBufferNeeded, startupBufferCommit } = {}) {
  let at = 0, nextTimer = 0, adapter;
  const timers = new Map(), globals = new Map(), sockets = [], connections = [], cycles = [];
  const page = new EventTarget(), abort = new AbortController(), fetches = [];
  const install = (name, value) => {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  const schedule = (fn, ms, interval = false) => {
    const id = ++nextTimer; timers.set(id, { fn, at: at + ms, period: interval ? ms : 0 }); return id;
  };
  class Socket extends EventTarget {
    constructor() { super(); this.readyState = 1; sockets.push(this); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  class Connection extends EventTarget {
    constructor(config) { super(); this.configuration = structuredClone(config); this.connectionState = 'connected'; this.iceConnectionState = 'connected'; this.stats = new Map(); connections.push(this); }
    getStats() { return Promise.resolve(this.stats); }
    createDataChannel() { return { closeCalls: 0, send() {}, close() { this.closeCalls++; } }; }
    close() { if (this.connectionState === 'closed') return; this.connectionState = 'closed'; this.dispatchEvent(new Event('connectionstatechange')); }
  }
  class Loader { load(context, config, callbacks) { callbacks.onSuccess({ data: new ArrayBuffer(16) }, {}, context, null); } }
  const Hls = { Events: { FRAG_LOADED: 'frag-loaded' } }, listeners = new Map();
  const hls = { config: { loader: Loader },
    on(event, handler) { listeners.set(event, handler); }, off(event) { listeners.delete(event); },
    loaded(size) { listeners.get(Hls.Events.FRAG_LOADED)?.(Hls.Events.FRAG_LOADED, { frag: { stats: { loaded: size } } }); } };
  const video = { currentTime: 123.25, volume: 0.4, muted: false, paused: false };
  t.after(() => {
    adapter?.stop();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  install('location', { href: origin });
  install('performance', { now: () => at });
  install('fetch', async (url, options) => {
    fetches.push({ url: String(url), options });
    if (fetchResponse) return fetchResponse(url, options);
    const path = new URL(url).pathname;
    const body = path.endsWith('/media/dejavu-swarm/catalogue-v3.json') ? bytes :
      path === full.playlistUrl ? recordedManifests.full :
      path === '/media/dejavu-preview/rtmp/stream.m3u8' ? recordedManifests.preview : null;
    assert(body, 'Only verified catalogue and canonical playlist metadata may be fetched');
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  });
  install('WebSocket', Socket); install('RTCPeerConnection', Connection);
  install('addEventListener', page.addEventListener.bind(page)); install('removeEventListener', page.removeEventListener.bind(page));
  install('setTimeout', (fn, ms) => schedule(fn, ms)); install('clearTimeout', id => timers.delete(id));
  install('setInterval', (fn, ms) => schedule(fn, ms, true)); install('clearInterval', id => timers.delete(id));
  const createSwarm = options => {
    assert.equal(options.sustainablePeerWait, true, 'peer waits must allow the playback buffer to replenish');
    assert.equal(options.zeroBudgetPeerRace, true);
    assert.equal(options.lateHaveRace, true, 'an existing peer may finish the requested segment while HTTP is running');
    assert.equal(options.maxPeerWaitMs, 2500, 'late availability must use the original bounded race window');
    assert.equal(options.lateWindowMs, 4000, 'a new peer must fit the existing late window');
    const workerUrl = new URL(options.transferWorkerUrl);
    assert.equal(workerUrl.origin, new URL(import.meta.url).origin);
    assert.equal(workerUrl.pathname, new URL('../site/vendor/relayswarm-transfer-worker.js', import.meta.url).pathname);
    const live = { mode: 'peer-first', pubkey: String(cycles.length + 1).repeat(64), core: { state: 'ready' },
      bytes: { peerFirst: 0, uploaded: 0, uploadRemaining: null, held: 1024 },
      segments: {}, peers: {}, relays: {} };
    const ownedSockets = options.relays.map(url => new options.WebSocketImpl(new URL(url).href));
    const pc = new options.RTCPeerConnectionImpl({});
    const cycle = { options, live, stopped: false,
      upload(amount) { live.bytes.uploaded += amount; } };
    let originalLoader, installedLoader;
    cycles.push(cycle);
    return {
      metrics() { return { ...live, serving: live.bytes.uploadRemaining !== 0 }; },
      peerConnectionDetails() { return cycle.stopped ? [] : [{ connection: pc, pubkey: 'f'.repeat(64) }]; },
      attach(player) { originalLoader = player.config.fLoader; installedLoader = class extends originalLoader {}; player.config.fLoader = installedLoader; },
      stop() {
        cycle.stopped = true;
        if (hls.config.fLoader === installedLoader) hls.config.fLoader = originalLoader;
        live.bytes.held = 0; ownedSockets.forEach(socket => socket.close()); pc.close();
      },
    };
  };
  const turnConfigurations = [];
  const createTurnCredentials = configuration => {
    turnConfigurations.push(configuration);
    return turnFactory?.(configuration) ?? turnCredentials ?? ({ start: async () => null, stop() {}, servers: () => [], leaseIdentity: () => null,
      snapshot: () => ({ phase: 'unavailable', available: false, remainingMs: 0, failures: 0 }) });
  };
  const createAdapter = (recordedLive, quality = 'full') => createPublicSwarm({ Hls, hls, video,
    playlistUrl: quality === 'full' ? full.playlistUrl : preview.playlistUrl,
    quality, signal: abort.signal, turnConfiguration, startupBufferTarget, startupBufferNeeded, startupBufferCommit, ...(recordedLive === undefined ? {} : { recordedLive }) }, { createSwarm, createTurnCredentials });
  adapter = createAdapter();
  const originLoader = hls.config.fLoader;
  return { get adapter() { return adapter; }, hls, video, originLoader, sockets, connections, cycles, abort, fetches, turnConfigurations,
    prepare: (quality = 'full', signal = abort.signal) => prepareRecordedSource({ quality,
      playlistUrl: quality === 'full' ? full.playlistUrl : preview.playlistUrl, signal }),
    useRecorded(value, quality = 'full') { adapter.stop(); adapter = createAdapter(value, quality); return adapter; },
    pagehide: () => page.dispatchEvent(new Event('pagehide')), pendingTimers: () => timers.size,
    advance(ms) {
      const end = at + ms;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry; at = timer.at;
        if (timer.period) timer.at += timer.period; else timers.delete(id);
        timer.fn();
      }
      at = end;
    } };
}

test('an omitted operator configuration leaves the real TURN provider unconfigured during peer playback', async t => {
  const f = lifecycleFixture(t, { turnFactory: createPublicTurnCredentials });
  assert.deepEqual(f.turnConfigurations, [{ endpoint: null, turnUrl: null }]);
  assert.equal(f.fetches.length, 0);
  await f.adapter.setEnabled(true);
  assert(f.fetches.length > 0, 'ordinary pinned catalogue metadata still loads');
  assert(f.fetches.every(({ options }) => options.method !== 'POST'), 'no public credential endpoint is queried');
  assert.deepEqual(f.connections[0].configuration.iceServers, PUBLIC_SWARM_ICE);
  await f.adapter.setEnabled(false); assert.equal(f.pendingTimers(), 0);
});

test('explicit operator configuration is captured before caller mutation and bound by the real TURN provider', async t => {
  const configuration = { endpoint: 'https://operator.test/v1/public/credentials', turnUrl: 'turns:relay.test:5350?transport=tcp' };
  const expected = { ...configuration }, requests = [];
  const f = lifecycleFixture(t, { turnConfiguration: configuration, turnFactory: captured => createPublicTurnCredentials({
    ...captured, fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return new Response(JSON.stringify({ urls: ['turns:ignored.test:5349?transport=tcp', expected.turnUrl],
        username: `${expiresAt}:pub-${'a'.repeat(24)}`, credential: `${'b'.repeat(26)}I=`, expiresAt }),
      { headers: { 'content-type': 'application/json' } });
    },
  }) });
  assert.deepEqual(f.turnConfigurations, [expected]); assert.notEqual(f.turnConfigurations[0], configuration);
  configuration.endpoint = 'https://changed.test/v1/public/credentials'; configuration.turnUrl = 'turns:changed.test:443?transport=tcp';
  assert.equal(requests.length, 0, 'constructing the adapter does not issue credentials');
  await f.adapter.setEnabled(true);
  assert.deepEqual(requests, [{ url: expected.endpoint, method: 'POST' }]);
  assert.deepEqual(f.connections[0].configuration.iceServers[1].urls, [expected.turnUrl]);
  assert.deepEqual(f.turnConfigurations, [expected], 'later caller changes cannot retarget the active provider');
  await f.adapter.setEnabled(false); assert.equal(f.pendingTimers(), 0);
});

test('native peer construction uses the current automatic lease and pause cancels its lifecycle', async t => {
  let identity = 'first-viewer', starts = 0, stops = 0;
  const fixture = lifecycleFixture(t, { turnCredentials: {
    async start() { starts++; }, stop() { stops++; },
    servers: () => [{ urls: ['turns:relay.invalid:5349?transport=tcp'], username: identity, credential: 'fixture-only' }],
    leaseIdentity: () => identity,
    snapshot: () => ({ phase: 'ready', available: true, remainingMs: 900000, failures: 0 }),
  } });
  await fixture.adapter.setEnabled(true);
  assert.equal(starts, 1);
  assert.equal(fixture.connections[0].configuration.iceServers[1].username, 'first-viewer');
  identity = 'renewed-viewer';
  const connection = new fixture.cycles[0].options.RTCPeerConnectionImpl({ iceServers: [] });
  assert.equal(connection.configuration.iceServers[1].username, 'renewed-viewer');
  connection.close();
  fixture.adapter.setEnabled(false); assert.equal(stops, 1);
  assert.equal(fixture.pendingTimers(), 0);
});

for (const { name, local, remote, kind, retired } of [
  { name: 'selected local relay', local: 'relay', remote: 'host', kind: 'relay', retired: true },
  { name: 'selected remote relay only', local: 'host', remote: 'relay', kind: 'relay', retired: false },
  { name: 'selected direct route', local: 'host', remote: 'srflx', kind: 'direct', retired: false },
  { name: 'unknown selected route', local: null, remote: null, kind: null, retired: false },
]) test(`automatic lease rotation retires only its local allocation: ${name}`, async t => {
  let identity = 'initial-viewer';
  const f = lifecycleFixture(t, { turnCredentials: {
    async start() {}, stop() {},
    servers: () => [{ urls: ['turns:relay.invalid:5349?transport=tcp'], username: identity, credential: 'fixture-only' }],
    leaseIdentity: () => identity,
    snapshot: () => ({ phase: 'ready', available: true, remainingMs: 90000, failures: 0 }),
  } });
  await f.adapter.setEnabled(true);
  const pc = f.connections[0], channel = pc.createDataChannel('fixture');
  if (local && remote) pc.stats = new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { id: 'selected', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', bytesSent: 0, bytesReceived: 0 }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: local }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: remote }],
  ]);
  // Use the adapter's ordinary stats sampling and original renewal timer.
  f.advance(750); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.metrics().topology.connections[0].kind, kind, 'aggregate route reporting remains unchanged');
  assert.equal(f.adapter.metrics().topology.connections[0].localCandidateType, local);
  const loader = f.hls.config.fLoader, media = { ...f.video };
  identity = 'renewed-viewer';
  f.advance(30249);
  assert.equal(channel.closeCalls, 0, 'the old lease is not retired before its scheduled boundary');
  f.advance(1);
  assert.equal(channel.closeCalls, Number(retired), 'only the selected local allocation belongs to the rotating lease');
  assert.equal(f.cycles.length, 1); assert.equal(f.cycles[0].stopped, false);
  assert.equal(f.hls.config.fLoader, loader); assert.deepEqual(f.video, media);
  assert.equal(f.adapter.metrics().resources.heldBytes, 1024, 'transport retirement preserves the active media cache');
  const next = new f.cycles[0].options.RTCPeerConnectionImpl({});
  assert.equal(next.configuration.iceServers[1].username, 'renewed-viewer', 'a subsequent dial takes the current lease');
  next.close();
  await f.adapter.setEnabled(false);
  assert.equal(f.pendingTimers(), 0, 'pause cancels all remaining sampling and lease timers');
});

test('pause cancels scheduled local relay retirement before a later lease rotation', async t => {
  let identity = 'initial-viewer', stops = 0;
  const f = lifecycleFixture(t, { turnCredentials: {
    async start() {}, stop() { stops++; },
    servers: () => [{ urls: ['turns:relay.invalid:5349?transport=tcp'], username: identity, credential: 'fixture-only' }],
    leaseIdentity: () => identity,
    snapshot: () => ({ phase: 'ready', available: true, remainingMs: 90000, failures: 0 }),
  } });
  await f.adapter.setEnabled(true);
  const pc = f.connections[0], channel = pc.createDataChannel('fixture');
  pc.stats = new Map([
    ['selected', { id: 'selected', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay' }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host' }],
  ]);
  f.advance(750); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.metrics().topology.connections[0].localCandidateType, 'relay');
  await f.adapter.setEnabled(false);
  identity = 'renewed-viewer'; f.advance(90000);
  assert.equal(channel.closeCalls, 0, 'a retired adapter cannot run its previous lease timer');
  assert.equal(stops, 1); assert.equal(pc.connectionState, 'closed'); assert.equal(f.pendingTimers(), 0);
});

test('a completed empty ICE gather reports no browser route without crediting peer delivery', async t => {
  const f = lifecycleFixture(t);
  await f.adapter.setEnabled(true);
  const pc = f.connections[0]; pc.connectionState = 'new';
  const candidate = value => { const event = new Event('icecandidate'); Object.defineProperty(event, 'candidate', { value }); return event; };
  pc.dispatchEvent(candidate(null)); pc.dispatchEvent(candidate(null));
  assert.equal(f.adapter.metrics().diagnostics.noLocalRoutes, 1);
  assert.equal(f.adapter.metrics().connectedPeers, 0);
  assert.equal(f.adapter.metrics().peerBytes, 0);
  await f.adapter.setEnabled(false); await f.adapter.setEnabled(true);
  f.connections[1].dispatchEvent(candidate({ type: 'host', protocol: 'udp' }));
  f.connections[1].dispatchEvent(candidate(null));
  assert.equal(f.adapter.metrics().diagnostics.noLocalRoutes, 1, 'a real candidate is not an empty gather');
  assert.equal(f.adapter.metrics().connectedPeers, 1);
});

test('active peer delivery survives fifteen minutes and multi-GiB incoming totals until explicit pause', async t => {
  const f = lifecycleFixture(t);
  assert.equal(f.adapter.metrics().uploadPacing, null);
  assert.equal(f.adapter.metrics().peerAdmission, null);
  assert.equal(f.adapter.metrics().latePeerRace, null);
  assert.equal(f.adapter.metrics().startupBuffer, null);
  await f.adapter.setEnabled(true);
  assert.equal(f.adapter.metrics().uploadPacing, null, 'older SDK snapshots remain unknown instead of reporting zero queue activity');
  assert.equal(f.adapter.metrics().peerAdmission, null);
  assert.equal(f.adapter.metrics().latePeerRace, null, 'an older SDK cannot claim a new-peer race happened');
  assert.equal(f.adapter.metrics().startupBuffer, null, 'an older SDK cannot claim startup headroom');
  const uploadPacing = { enabled: true, queued: 1, reservedBytes: 98304, waited: 1, granted: 0 };
  const peerAdmission = { claimedLinks: 1, waiting: 1, claims: 2, waited: 1 };
  const latePeerRace = { started: 1, delivered: 0 };
  const startupBuffer = { enabled: true, state: 'ready', released: 1, failures: 0 };
  Object.assign(f.cycles[0].live, { uploadPacing, peerAdmission, latePeerRace, startupBuffer });
  const identity = f.adapter.metrics().viewerId;
  for (let segment = 0; segment < 700; segment++) f.hls.loaded(4 * 1024 * 1024);
  f.advance(16 * 60 * 1000);
  const live = f.adapter.metrics();
  assert.deepEqual(live.library, { version: libraryBuild.version, sourceCommit: libraryBuild.sourceCommit });
  assert.equal(live.enabled, true); assert.equal(live.reason, 'opted-in'); assert.equal(live.serving, true);
  assert.equal(live.viewerId, identity); assert.equal(live.loadedMediaBytes, 700 * 4 * 1024 * 1024);
  assert.deepEqual(live.uploadPacing, uploadPacing, 'the current SDK supplies its bounded queue accounting');
  assert.deepEqual(live.peerAdmission, peerAdmission);
  assert.deepEqual(live.latePeerRace, latePeerRace);
  assert.deepEqual(live.startupBuffer, startupBuffer);
  assert.equal(live.resources.signallingConnections, 3); assert.equal(live.resources.activePeerConnections, 1);
  await f.adapter.setEnabled(true); assert.equal(f.cycles.length, 1, 'a later active enable does not replace the current peers');
  await f.adapter.setEnabled(false);
  assert.ok(f.sockets.every(socket => socket.readyState === 3));
  assert.ok(f.connections.every(connection => connection.connectionState === 'closed'));
  assert.equal(f.adapter.metrics().resources.heldBytes, 0); assert.equal(f.pendingTimers(), 0);
  assert.equal(f.adapter.metrics().uploadPacing, null, 'retired SDK queue counters are not presented as a live queue');
  assert.equal(f.adapter.metrics().peerAdmission, null);
  assert.equal(f.adapter.metrics().latePeerRace, null);
  assert.equal(f.adapter.metrics().startupBuffer, null);
  assert.equal(f.hls.config.fLoader, f.originLoader); assert.equal(f.video.currentTime, 123.25); assert.equal(f.video.volume, 0.4);
});

test('multi-GiB uploads keep serving across pause and resume with rate and cache bounds intact', async t => {
  const f = lifecycleFixture(t), gib = 1024 ** 3;
  await f.adapter.setEnabled(true); f.cycles[0].upload(3 * gib);
  assert.equal(f.adapter.metrics().acceptedUploadBytes, 3 * gib);
  assert.equal(f.adapter.metrics().uploadAllowanceRemaining, null);
  assert.equal(f.adapter.metrics().serving, true);
  await f.adapter.setEnabled(false); f.advance(20 * 60 * 1000);
  await f.adapter.setEnabled(true);
  f.cycles[1].upload(2 * gib); await f.adapter.setEnabled(false);
  await f.adapter.setEnabled(true);
  f.cycles[2].upload(gib);
  assert.equal(f.adapter.metrics().acceptedUploadBytes, 6 * gib, 'upload accounting remains cumulative');
  assert.equal(f.adapter.metrics().uploadAllowanceRemaining, null);
  assert.equal(f.adapter.metrics().serving, true);
  assert.equal(f.adapter.metrics().enabled, true);
  for (const { options } of f.cycles) {
    assert.equal(Object.hasOwn(options, 'maxUploadBytesPerSession'), false, 'use the SDK native no-quota mode');
    assert.equal(options.maxUploadBytesPerSecond, 4 * 1024 * 1024);
    assert.equal(options.maxUploadPeers, 2);
    assert.equal(options.maxHeldBytes, 64 * 1024 * 1024);
  }
});

test('page abort, pagehide and explicit stop immediately close peer resources and prevent re-enable', async t => {
  for (const end of ['abort', 'pagehide', 'stop']) await t.test(end, async t => {
    const f = lifecycleFixture(t); await f.adapter.setEnabled(true);
    if (end === 'abort') f.abort.abort(); else if (end === 'pagehide') f.pagehide(); else f.adapter.stop();
    assert.equal(f.adapter.metrics().phase, 'stopped'); assert.equal(f.adapter.metrics().enabled, false);
    assert.ok(f.sockets.every(socket => socket.readyState === 3));
    assert.ok(f.connections.every(connection => connection.connectionState === 'closed'));
    assert.equal(f.adapter.metrics().resources.heldBytes, 0); assert.equal(f.pendingTimers(), 0);
    await assert.rejects(f.adapter.setEnabled(true), /stopped/);
  });
});

test('recorded preparation verifies immutable metadata only and reuses a completed verdict', async t => {
  for (const quality of ['full', 'preview']) await t.test(quality, async t => {
    const f = lifecycleFixture(t, { origin: `https://metadata-${quality}.invalid/live-media.html` });
    const recording = await f.prepare(quality);
    assert(recording); assert(Object.isFrozen(recording)); assert(Object.isFrozen(recording.segments));
    assert(recording.segments.every(Object.isFrozen));
    assert.equal(recording.segments.length, quality === 'full' ? 134 : 30);
    assert.equal(recording.durationSeconds, quality === 'full' ? 267.32 : 29.96);
    if (quality === 'full') {
      assert.equal(recording.segments[133].durationUs, 720000);
      assert.equal(new URL(recording.segments[133].url).pathname.split('/').at(-1), 'segment-0133-audioend-v2.m4s');
    }
    assert.equal(new URL(recording.playlistUrl).pathname, quality === 'full' ? full.playlistUrl : '/media/dejavu-preview/rtmp/stream.m3u8');
    assert.equal(createHash('sha256').update(recordedManifests[quality]).digest('hex'), recording.manifestSha256);
    const timeline = createRecordedLive({ recording, epochMs: 0, now: () => 1000 });
    assert(timeline, 'preparation and the exported timeline factory share the private helper brand'); timeline.stop();
    assert.equal(f.fetches.length, 2, 'one catalogue plus one canonical media playlist; no init/segment body');
    assert(f.fetches.every(({ url }) => /\.(?:json|m3u8)$/.test(new URL(url).pathname)));
    assert(f.fetches.every(({ options }) => options.redirect === 'error' && options.credentials === 'same-origin'));
    assert.equal(f.fetches[0].options.cache, 'force-cache', 'the versioned catalogue remains immutable');
    assert.equal(f.fetches[1].options.cache, 'reload', 'the canonical playlist bypasses a previously stored old manifest');
    assert.equal(f.sockets.length, 0); assert.equal(f.connections.length, 0); assert.equal(f.pendingTimers(), 0);
    assert.equal(f.adapter.metrics().loadedMediaBytes, 0); assert.equal(f.adapter.metrics().peerBytes, 0);
    assert.equal(await f.prepare(quality), recording);
    assert.equal(f.fetches.length, 2, 'only verified immutable metadata is cached');
    const abort = new AbortController(); abort.abort();
    assert.equal(await f.prepare(quality, abort.signal), null, 'cancellation wins even for cached metadata');
  });
});

test('unverified, oversized and aborted recorded metadata cannot acquire a prepared brand', async t => {
  for (const failure of ['catalogue', 'manifest', 'header-size', 'body-size', 'abort']) await t.test(failure, async t => {
    let f, cancelled = false;
    f = lifecycleFixture(t, { origin: `https://bad-${failure}.invalid/`, fetchResponse: async (url, options) => {
      if (new URL(url).pathname.endsWith('/media/dejavu-swarm/catalogue-v3.json')) {
        const body = Buffer.from(bytes); if (failure === 'catalogue') body[body.length - 3] ^= 1;
        return new Response(body);
      }
      if (failure === 'header-size') return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { headers: { 'content-length': '65537' } });
      if (failure === 'abort') return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new DOMException('Cancelled fixture', 'AbortError')), { once: true });
        queueMicrotask(() => f.abort.abort());
      } }));
      const body = failure === 'body-size' ? new Uint8Array(65537) : Buffer.from(recordedManifests.full);
      if (failure === 'manifest') body[body.length - 3] ^= 1;
      return new Response(body);
    } });
    assert.equal(await f.prepare(), null, failure);
    if (failure === 'header-size') assert.equal(cancelled, true, 'the refused body is cancelled before downloading it');
    assert.equal(f.pendingTimers(), 0); assert.equal(f.connections.length, 0); assert.equal(f.sockets.length, 0);
  });
});

function recordedContext(recording, sn) {
  const entry = recording.segments[sn % recording.segments.length];
  return { url: entry.url, frag: { url: entry.url, sn, cc: Math.floor(sn / recording.segments.length),
    level: 0, type: 'main', duration: entry.durationUs / 1_000_000, baseurl: recording.playlistUrl } };
}

test('recorded mode signs actual global sequence and discontinuity against the unchanged canonical hashes', async t => {
  for (const quality of ['full', 'preview']) await t.test(quality, async t => {
    const f = lifecycleFixture(t), recording = await f.prepare(quality), count = recording.segments.length;
    f.useRecorded({ recording, epochId: 'a'.repeat(64) }, quality);
    await f.adapter.setEnabled(true);
    const options = f.cycles[0].options;
    assert.equal(options.warmAhead, false, 'steady speculative downloads cannot compete with playback');
    assert.equal(options.startupBufferTarget, null, 'startup buffering requires an explicit current-player target');
    assert.equal(options.startupBufferMaxBytes, 24 * 1024 * 1024, 'non-startup playback keeps the SDK default');
    assert.equal(options.uploadPacing, quality === 'full', 'bounded upload admission is enabled for full 4K only');
    assert.equal(options.latePeerRace, quality === 'full', 'a newly available peer may race only for the full 4K player');
    assert.equal(options.maxUploadBytesPerSecond, 4 * 1024 * 1024, 'pacing does not increase the existing upload rate');
    assert.match(options.swarmId, /^forgesworn-recorded-live-v2-[a-f0-9]{64}$/);
    assert(options.swarmId.length <= 128);
    assert.equal(f.fetches.length, 2, 'enabling reuses prepared metadata instead of fetching media');
    for (const sn of [0, count - 1, count, count * 2 + 1]) {
      const context = recordedContext(recording, sn), event = await options.getCommitment(context);
      assert(event); assert.equal(verifyEvent(structuredClone(event)), true);
      const value = JSON.parse(event.content), original = catalogue.qualities[quality].segments[sn % count];
      assert.equal(value.sequence, sn); assert.equal(value.discontinuity, Math.floor(sn / count));
      assert.equal(value.sha256, original.sha256); assert.equal(value.size, original.size);
      assert.equal(value.pieceSize, original.pieceSize); assert.deepEqual(value.pieces, original.pieces);
      assert.equal(value.key, createHash('sha256').update(`${options.swarmId}\n${new URL(context.url).pathname}`).digest('hex'));
      assert.equal(value.playlist, new URL(recording.playlistUrl).pathname); assert.equal(value.rendition, value.playlist);
      assert.equal(value.mediaType, 'main'); assert.equal(value.encryption, null); assert.equal(value.part, null);
      assert(value.expiresAt > Date.now() / 1000 && value.expiresAt <= Date.now() / 1000 + 120);
    }
  });
});

test('startup buffering is confined to the recorded full player and its live adapter generation', async t => {
  let target = 1.25, invalid = false;
  const f = lifecycleFixture(t, { startupBufferNeeded: () => true, startupBufferTarget: () => {
    if (invalid) throw new Error('Old player is unavailable');
    return target;
  } });
  await f.adapter.setEnabled(true);
  assert.equal(f.cycles[0].options.startupBufferTarget, null, 'plain VOD has no shared room target');
  assert.equal(f.cycles[0].options.startupBufferMaxBytes, 24 * 1024 * 1024);
  const recording = await f.prepare();
  f.useRecorded({ recording, epochId: 'a'.repeat(64) });
  await f.adapter.setEnabled(true);
  const first = f.cycles[1].options.startupBufferTarget;
  assert.equal(f.cycles[1].options.startupBufferMaxBytes, 32 * 1024 * 1024, 'the 4K reservoir includes the retained original');
  assert.equal(f.cycles[1].options.maxHeldBytes, 64 * 1024 * 1024, 'startup remains inside the existing shared budget');
  assert.equal(first(), 1.25);
  target = 3.75;
  assert.equal(first(), 3.75, 'the callback reads fresh programme time');
  for (const value of [null, undefined, NaN, Infinity, -1]) {
    target = value; assert.equal(first(), null, 'invalid geometry cannot release initial media');
  }
  invalid = true; assert.equal(first(), null, 'ownership errors fail closed');
  invalid = false; target = 4;
  await f.adapter.setEnabled(false);
  assert.equal(first(), null);
  await f.adapter.setEnabled(true);
  assert.equal(first(), null, 'a previous enabled generation cannot target the replacement');
  const current = f.cycles[2].options.startupBufferTarget;
  assert.equal(current(), 4);
  f.pagehide(); assert.equal(current(), null);
});

test('a fresh SDK on resume has no startup barrier after its current pipeline presented a frame', async t => {
  let needsFrame = true, targetReads = 0;
  const f = lifecycleFixture(t, { startupBufferNeeded: () => needsFrame, startupBufferTarget: () => { targetReads++; return 3; } });
  const recording = await f.prepare(); f.useRecorded({ recording, epochId: 'a'.repeat(64) });
  await f.adapter.setEnabled(true);
  assert.equal(typeof f.cycles[0].options.startupBufferTarget, 'function');
  needsFrame = false;
  await f.adapter.setEnabled(false); await f.adapter.setEnabled(true);
  assert.equal(f.cycles.length, 2, 'pause/resume really creates another SDK instance');
  assert.equal(f.cycles[1].options.startupBufferTarget, null, 'completed pipeline never starts a terminal-invalid barrier');
  assert.equal(targetReads, 0, 'eligibility is explicit and does not probe a null target');
  needsFrame = true;
  f.useRecorded({ recording, epochId: 'b'.repeat(64) }); await f.adapter.setEnabled(true);
  assert.equal(f.cycles[2].options.startupBufferTarget(), 3, 'a new current pipeline can need the barrier again');
});

test('startup room activation belongs to the current recorded adapter and original abort signal', async t => {
  let calls = 0, received, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = lifecycleFixture(t, { startupBufferNeeded: () => true, startupBufferTarget: () => 0,
    startupBufferCommit: value => { calls++; received = value; return gate; } });
  await f.adapter.setEnabled(true);
  assert.equal(f.cycles[0].options.startupBufferCommit, null, 'ordinary VOD cannot activate a prepared room');
  const recording = await f.prepare(); f.useRecorded({ recording, epochId: 'a'.repeat(64) });
  await f.adapter.setEnabled(true);
  const commit = f.cycles[1].options.startupBufferCommit;
  const signal = new AbortController().signal;
  const pending = commit(Object.freeze({ signal }));
  assert.equal(calls, 1); assert.equal(received.signal, signal); assert.equal(Object.isFrozen(received), true);
  await f.adapter.setEnabled(false);
  finish();
  await assert.rejects(pending, { name: 'AbortError' }, 'late activation settlement cannot approve an old SDK generation');
  await assert.rejects(commit({ signal }), { name: 'AbortError' });
  assert.equal(calls, 1, 'retired callbacks never invoke host activation');
  await f.adapter.setEnabled(true);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.cycles[2].options.startupBufferCommit({ signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(calls, 1, 'an already cancelled startup cannot publish room presence');
});

test('recorded mapping refuses wrong URI, duration, global identity and unsupported media contexts', async t => {
  const f = lifecycleFixture(t), recording = await f.prepare();
  f.useRecorded({ recording, epochId: 'a'.repeat(64) }); await f.adapter.setEnabled(true);
  const getCommitment = f.cycles[0].options.getCommitment;
  const valid = recordedContext(recording, recording.segments.length);
  for (const change of [
    value => { value.frag.sn = 'initSegment'; }, value => { value.frag.sn = -1; },
    value => { value.frag.sn = Number.MAX_SAFE_INTEGER + 1; }, value => { value.frag.sn = 134.5; },
    value => { value.frag.sn++; }, value => { value.frag.cc = 0; }, value => { value.frag.cc++; },
    value => { value.url += '?epoch=other'; }, value => { value.url = 'https://other.invalid/segment-0000.m4s'; },
    value => { value.frag.url = recording.segments[1].url; },
    value => { value.frag.baseurl += '?epoch=other'; },
    value => { value.frag.baseurl = 'https://other.invalid/media/dejavu-4k/index.m3u8'; },
    value => { value.frag.duration += 0.000001; }, value => { value.frag.duration += 0.024; },
    value => { value.frag.level = 1; }, value => { value.frag.type = 'audio'; },
    value => { value.part = { index: 0 }; }, value => { value.rangeStart = 1; }, value => { value.rangeEnd = 100; },
    value => { value.frag.byteRangeStartOffset = 1; }, value => { value.frag.byteRangeEndOffset = 100; },
    value => { value.frag.decryptdata = { method: 'AES-128' }; },
  ]) {
    const altered = structuredClone(valid); change(altered);
    assert.equal(await getCommitment(altered), null, 'unsupported contexts remain ordinary HTTP');
  }
  assert.equal(await getCommitment(valid) !== null, true);
  const pending = getCommitment(valid); await f.adapter.setEnabled(false);
  assert.equal(await pending, null, 'an in-flight digest cannot sign for a cancelled generation');
  assert.equal(await getCommitment(valid), null);
});

test('a pending digest signs one coherent recorded identity even when HLS mutates its context', async t => {
  const f = lifecycleFixture(t), recording = await f.prepare();
  f.useRecorded({ recording, epochId: 'a'.repeat(64) }); await f.adapter.setEnabled(true);
  const options = f.cycles[0].options, context = recordedContext(recording, 134);
  const original = structuredClone(context), digest = crypto.subtle.digest.bind(crypto.subtle);
  let release;
  t.mock.method(crypto.subtle, 'digest', (...args) => new Promise((resolve, reject) => {
    release = () => digest(...args).then(resolve, reject);
  }));
  const pending = options.getCommitment(context);
  assert.equal(typeof release, 'function', 'the real key digest is held at the async boundary');
  context.url = recording.segments[1].url;
  Object.assign(context.frag, { sn: 269, cc: 2, url: context.url, baseurl: 'https://other.invalid/other.m3u8',
    type: 'audio', duration: 1, decryptdata: { method: 'AES-128' } });
  release();
  const event = await pending;
  assert(event); assert.equal(verifyEvent(structuredClone(event)), true);
  const value = JSON.parse(event.content), canonical = catalogue.qualities.full.segments[0];
  assert.equal(value.sequence, original.frag.sn); assert.equal(value.discontinuity, original.frag.cc);
  assert.equal(value.playlist, new URL(original.frag.baseurl).pathname);
  assert.equal(value.rendition, value.playlist); assert.equal(value.mediaType, 'main'); assert.equal(value.encryption, null);
  assert.equal(value.sha256, canonical.sha256); assert.deepEqual(value.pieces, canonical.pieces);
  assert.equal(value.key, createHash('sha256').update(`${options.swarmId}\n${new URL(original.url).pathname}`).digest('hex'));
});

test('recorded cohorts bind source, quality and immutable epoch while retired generations cannot sign', async t => {
  const f = lifecycleFixture(t), recording = await f.prepare(), epochA = 'a'.repeat(64), epochB = 'b'.repeat(64);
  const input = { recording, epochId: epochA };
  f.useRecorded(input); input.epochId = epochB; await f.adapter.setEnabled(true);
  const first = f.cycles[0].options, expected = 'forgesworn-recorded-live-v2-' + createHash('sha256')
    .update(`forgesworn-recorded-live-v2\n${catalogue.sourceSha256}\nfull\n${epochA}\n${recording.manifestSha256}\n${recording.durationUs}`).digest('hex');
  assert.equal(first.swarmId, expected, 'mutating the caller cannot change an already-created adapter');
  f.useRecorded({ recording, epochId: epochB }); await f.adapter.setEnabled(true);
  assert.notEqual(f.cycles[1].options.swarmId, first.swarmId);
  assert.equal(await first.getCommitment(recordedContext(recording, 134)), null, 'a replaced epoch cannot keep signing');
  f.useRecorded({ recording, epochId: epochA }); await f.adapter.setEnabled(true);
  assert.equal(f.cycles[2].options.swarmId, first.swarmId, 'same source/quality/epoch converges independently of viewer keys');
  f.adapter.stop(); assert.equal(await f.cycles[2].options.getCommitment(recordedContext(recording, 134)), null);
});

test('hand-forged recordings and malformed opt-ins cannot widen the default VOD mapping', async t => {
  const f = lifecycleFixture(t), recording = await f.prepare();
  for (const value of [null, { recording: structuredClone(recording), epochId: 'a'.repeat(64) },
    { recording: { ...recording, manifestSha256: 'a'.repeat(64) }, epochId: 'a'.repeat(64) },
    { recording, epochId: '' }, { recording, epochId: 'A'.repeat(64) },
    { recording, epochId: 'a'.repeat(63) }, { recording, epochId: {}, extra: true }]) {
    assert.throws(() => f.useRecorded(value), /recorded timeline/);
  }
  assert.throws(() => f.useRecorded({ recording, epochId: 'a'.repeat(64) }, 'preview'), /recorded timeline/);
  f.useRecorded(undefined); await f.adapter.setEnabled(true);
  const options = f.cycles[0].options;
  assert.equal(options.swarmId, catalogue.qualities.full.swarmId);
  assert.equal(await options.getCommitment(recordedContext(recording, 134)), null, 'VOD does not acquire modulo acceptance');
  assert.equal(await options.getCommitment(recordedContext(recording, 0)) !== null, true);
});
