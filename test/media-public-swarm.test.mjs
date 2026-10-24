import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicSwarm, validatePublicSwarmCatalogue, catalogueSegment, PUBLIC_SWARM_CATALOGUE_SHA256,
  PUBLIC_SWARM_LIMITS, PUBLIC_SWARM_RELAYS, PUBLIC_SWARM_ICE } from '../site/media-public-swarm.mjs';

const bytes = await readFile(new URL('../site/media/dejavu-swarm/catalogue-v2.json', import.meta.url));
const catalogue = JSON.parse(bytes);
const libraryBuild = JSON.parse(await readFile(new URL('../site/vendor/media-peer-demo.build.json', import.meta.url)));
const preview = { quality: 'preview', playlistUrl: '/media/dejavu-preview/rtmp/index.m3u8', origin: 'https://forgesworn.dev/' };
const full = { quality: 'full', playlistUrl: '/media/dejavu-4k/index.m3u8', origin: 'https://forgesworn.dev/' };

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

test('public configuration has no TURN credentials, embedded secrets, or unlimited upload/cache policy', () => {
  assert.ok(PUBLIC_SWARM_RELAYS.every(value => new URL(value).protocol === 'wss:'));
  assert.deepEqual(PUBLIC_SWARM_ICE, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  assert.equal(PUBLIC_SWARM_LIMITS.maxPeers, 3);
  assert.equal(PUBLIC_SWARM_LIMITS.maxHeldBytes, 64 * 1024 * 1024);
  assert.equal(PUBLIC_SWARM_LIMITS.maxUploadBytesPerSession, 1024 * 1024 * 1024);
});

// Exercise the real adapter lifecycle with an injected SDK factory. Native
// resource ownership and SDK quota snapshots are simulated; no video/network
// benchmark or real GiB transfer is claimed by these unit tests.
function lifecycleFixture(t) {
  let at = 0, nextTimer = 0, adapter;
  const timers = new Map(), globals = new Map(), sockets = [], connections = [], cycles = [];
  const page = new EventTarget(), abort = new AbortController();
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
    constructor() { super(); this.connectionState = 'connected'; this.iceConnectionState = 'connected'; connections.push(this); }
    getStats() { return Promise.resolve(new Map()); }
    createDataChannel() { return { send() {} }; }
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
  install('location', { href: 'https://forgesworn.dev/live-media.html' });
  install('performance', { now: () => at });
  install('fetch', async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
  install('WebSocket', Socket); install('RTCPeerConnection', Connection);
  install('addEventListener', page.addEventListener.bind(page)); install('removeEventListener', page.removeEventListener.bind(page));
  install('setTimeout', (fn, ms) => schedule(fn, ms)); install('clearTimeout', id => timers.delete(id));
  install('setInterval', (fn, ms) => schedule(fn, ms, true)); install('clearInterval', id => timers.delete(id));
  const createSwarm = options => {
    const live = { mode: 'peer-first', pubkey: String(cycles.length + 1).repeat(64), core: { state: 'ready' },
      bytes: { peerFirst: 0, uploaded: 0, uploadRemaining: options.maxUploadBytesPerSession, held: 1024 },
      segments: {}, peers: {}, relays: {} };
    const ownedSockets = options.relays.map(url => new options.WebSocketImpl(new URL(url).href));
    const pc = new options.RTCPeerConnectionImpl({});
    const cycle = { options, live, stopped: false,
      charge(amount) { live.bytes.uploaded = amount; live.bytes.uploadRemaining = options.maxUploadBytesPerSession - amount; } };
    let originalLoader, installedLoader;
    cycles.push(cycle);
    return {
      metrics() { return { ...live, serving: live.bytes.uploadRemaining > 0 }; },
      peerConnectionDetails() { return cycle.stopped ? [] : [{ connection: pc, pubkey: 'f'.repeat(64) }]; },
      attach(player) { originalLoader = player.config.fLoader; installedLoader = class extends originalLoader {}; player.config.fLoader = installedLoader; },
      stop() {
        cycle.stopped = true;
        if (hls.config.fLoader === installedLoader) hls.config.fLoader = originalLoader;
        live.bytes.held = 0; ownedSockets.forEach(socket => socket.close()); pc.close();
      },
    };
  };
  adapter = createPublicSwarm({ Hls, hls, video, playlistUrl: '/media/dejavu-4k/index.m3u8', quality: 'full', signal: abort.signal }, { createSwarm });
  const originLoader = hls.config.fLoader;
  return { adapter, hls, video, originLoader, sockets, connections, cycles, abort,
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

test('active peer delivery survives fifteen minutes and multi-GiB incoming totals until explicit pause', async t => {
  const f = lifecycleFixture(t);
  await f.adapter.setEnabled(true);
  const identity = f.adapter.metrics().viewerId;
  for (let segment = 0; segment < 700; segment++) f.hls.loaded(4 * 1024 * 1024);
  f.advance(16 * 60 * 1000);
  const live = f.adapter.metrics();
  assert.deepEqual(live.library, { version: libraryBuild.version, sourceCommit: libraryBuild.sourceCommit });
  assert.equal(live.enabled, true); assert.equal(live.reason, 'opted-in'); assert.equal(live.serving, true);
  assert.equal(live.viewerId, identity); assert.equal(live.loadedMediaBytes, 700 * 4 * 1024 * 1024);
  assert.equal(live.resources.signallingConnections, 3); assert.equal(live.resources.activePeerConnections, 1);
  await f.adapter.setEnabled(true); assert.equal(f.cycles.length, 1, 'a later active enable does not replace the current peers');
  await f.adapter.setEnabled(false);
  assert.ok(f.sockets.every(socket => socket.readyState === 3));
  assert.ok(f.connections.every(connection => connection.connectionState === 'closed'));
  assert.equal(f.adapter.metrics().resources.heldBytes, 0); assert.equal(f.pendingTimers(), 0);
  assert.equal(f.hls.config.fLoader, f.originLoader); assert.equal(f.video.currentTime, 123.25); assert.equal(f.video.volume, 0.4);
});

test('pause and later resume retain the cumulative upload allowance including an exhausted budget', async t => {
  const f = lifecycleFixture(t), limit = PUBLIC_SWARM_LIMITS.maxUploadBytesPerSession;
  await f.adapter.setEnabled(true); f.cycles[0].charge(256 * 1024 * 1024);
  assert.equal(f.adapter.metrics().uploadAllowanceRemaining, limit - 256 * 1024 * 1024);
  await f.adapter.setEnabled(false); f.advance(20 * 60 * 1000);
  await f.adapter.setEnabled(true);
  assert.equal(f.cycles[1].options.maxUploadBytesPerSession, limit - 256 * 1024 * 1024);
  f.cycles[1].charge(128 * 1024 * 1024); await f.adapter.setEnabled(false);
  await f.adapter.setEnabled(true);
  assert.equal(f.cycles[2].options.maxUploadBytesPerSession, limit - 384 * 1024 * 1024);
  f.cycles[2].charge(f.cycles[2].options.maxUploadBytesPerSession);
  assert.equal(f.adapter.metrics().uploadAllowanceRemaining, 0); assert.equal(f.adapter.metrics().serving, false);
  assert.equal(f.adapter.metrics().enabled, true, 'upload exhaustion does not impose a receive time limit');
  await f.adapter.setEnabled(false); await f.adapter.setEnabled(true);
  assert.equal(f.cycles[3].options.maxUploadBytesPerSession, 0, 'reconnecting cannot mint a fresh upload allowance');
  assert.equal(f.adapter.metrics().uploadAllowanceRemaining, 0); assert.equal(f.adapter.metrics().serving, false);
  assert.equal(f.adapter.metrics().enabled, true);
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
