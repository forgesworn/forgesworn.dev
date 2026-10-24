// Real RelaySwarm HLS loaders and native WebRTC, with same-page signalling.
// The two logical viewers share this page's origin; no public relay is used.
import { createHlsSwarm, commitmentContent, KIND_SEGMENT_COMMITMENT, segmentMediaContext,
  finalizeEvent, generateSecretKey, verifyEvent, matchFilter } from './vendor/media-peer-demo.js';

export const PEER_DEMO_LIMITS = Object.freeze({ maxDurationMs: 90_000, maxUploadBytes: 32 * 1024 * 1024,
  maxSegmentBytes: 4 * 1024 * 1024, maxSegments: 64, maxSignalBytes: 128 * 1024, maxPreplayWarmupMs: 1500 });
const RELAY_URL = 'wss://browser-local.invalid/relayswarm-demo';
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;

export function validateMediaManifest(manifest, playlistUrl, origin) {
  const playlist = new URL(playlistUrl, origin);
  if (!['https:', 'http:'].includes(playlist.protocol) || playlist.origin !== new URL(origin).origin ||
      !playlist.pathname.startsWith('/media/') || playlist.search || playlist.hash) throw new Error('Use the same-origin demo playlist.');
  if (manifest?.schema !== 1 || !Array.isArray(manifest.segments) || !manifest.segments.length ||
      manifest.segments.length > PEER_DEMO_LIMITS.maxSegments) throw new Error('The demo segment manifest is invalid.');
  const segments = new Map();
  let bytes = 0;
  for (const entry of manifest.segments) {
    if (!entry || typeof entry.path !== 'string' || !/^[a-z0-9_./-]+$/i.test(entry.path) ||
        entry.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > PEER_DEMO_LIMITS.maxSegmentBytes ||
        !Number.isSafeInteger(entry.sn) || entry.sn < 0 || !Number.isSafeInteger(entry.cc) || entry.cc < 0) {
      throw new Error('The demo segment manifest is invalid.');
    }
    const url = new URL(entry.path, playlist);
    if (url.origin !== playlist.origin || !url.pathname.startsWith('/media/') || segments.has(url.pathname)) throw new Error('The demo segment manifest is invalid.');
    segments.set(url.pathname, { ...entry, url: url.href });
    bytes += entry.size;
  }
  if (bytes > PEER_DEMO_LIMITS.maxUploadBytes) throw new Error('This clip exceeds the bounded peer demo.');
  return { playlist: playlist.href, segments, totalBytes: bytes };
}

export function demoIceConfiguration(runtime, hostname) {
  if (runtime === undefined || runtime === null) return [0, 1].map(() => ({ iceServers: [], iceTransportPolicy: 'all' }));
  if (!loopback(hostname) || runtime.iceTransportPolicy !== 'relay' || !['udp', 'tcp'].includes(runtime.transport) ||
      !Array.isArray(runtime.iceServersByViewer) || runtime.iceServersByViewer.length !== 2) {
    throw new Error('A local relay demo needs its local operator configuration.');
  }
  return runtime.iceServersByViewer.map(servers => {
    if (!Array.isArray(servers) || servers.length !== 1) throw new Error('The local relay configuration is invalid.');
    const server = servers[0];
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || urls.length !== 1 || !/^turn:127\.0\.0\.1:[0-9]{1,5}\?transport=(udp|tcp)$/.test(urls[0]) ||
        !urls[0].endsWith(`?transport=${runtime.transport}`) ||
        typeof server.username !== 'string' || !server.username || server.username.length > 256 ||
        typeof server.credential !== 'string' || !server.credential || server.credential.length > 256 ||
        /[\x00-\x1f\x7f]/.test(server.username + server.credential)) throw new Error('The local relay configuration is invalid.');
    const port = Number(/:([0-9]+)\?/.exec(urls[0])[1]);
    if (port < 1 || port > 65535) throw new Error('The local relay configuration is invalid.');
    return { iceServers: [{ urls: [...urls], username: server.username, credential: server.credential }], iceTransportPolicy: 'relay' };
  });
}

// A small in-page Nostr wire adapter, passed through RelaySwarm's supported
// WebSocketImpl option. RelaySwarm still creates and authenticates its presence,
// encrypts SDP with NIP-44 and transfers media through its actual PeerLink.
// This is not an internet Nostr service or a substitute media implementation.
export function createInPageRelay(swarmId) {
  const sockets = new Set(), presences = new Map();
  const counts = { published: 0, delivered: 0, rejected: 0 };
  let closed = false;
  const deliver = (socket, frame) => queueMicrotask(() => {
    if (socket.readyState === 1 && !closed) {
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
      counts.delivered++;
    }
  });
  const matches = (event, filter) => { try { return matchFilter(filter, event); } catch { return false; } };
  class LocalSocket extends EventTarget {
    constructor(url) {
      super();
      if (url !== RELAY_URL || closed || sockets.size >= 2) throw new Error('The in-page relay is unavailable.');
      this.url = url;
      this.readyState = 0;
      this.subscriptions = new Map();
      this.publisher = null;
      sockets.add(this);
      queueMicrotask(() => {
        if (!closed && this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    send(text) {
      if (this.readyState !== 1 || typeof text !== 'string' || new TextEncoder().encode(text).length > PEER_DEMO_LIMITS.maxSignalBytes) {
        counts.rejected++; return;
      }
      let frame;
      try { frame = JSON.parse(text); } catch { counts.rejected++; return; }
      if (!Array.isArray(frame)) { counts.rejected++; return; }
      const [operation, id, filter] = frame;
      if (operation === 'CLOSE') { this.subscriptions.delete(id); return; }
      if (operation === 'REQ') {
        if (typeof id !== 'string' || id.length > 64 || this.subscriptions.size >= 8 || !filter ||
            Array.isArray(filter) || typeof filter !== 'object' || Object.keys(filter).length > 12) {
          counts.rejected++; return;
        }
        this.subscriptions.set(id, filter);
        for (const event of presences.values()) if (matches(event, filter)) deliver(this, ['EVENT', id, event]);
        deliver(this, ['EOSE', id]);
        return;
      }
      const event = id;
      let verified = false;
      try {
        verified = operation === 'EVENT' && [24170, 24171].includes(event?.kind) &&
          Number.isSafeInteger(event.created_at) && Math.abs(Date.now() / 1000 - event.created_at) < 90 &&
          event.tags.some(tag => tag[0] === 'x' && tag[1] === swarmId) && verifyEvent(event);
      } catch {}
      if (!verified || this.publisher && this.publisher !== event.pubkey) { counts.rejected++; return; }
      this.publisher = event.pubkey;
      counts.published++;
      if (event.kind === 24170) presences.set(event.pubkey, event);
      deliver(this, ['OK', event.id, true, '']);
      for (const socket of sockets) for (const [subscription, requested] of socket.subscriptions) {
        if (matches(event, requested)) deliver(socket, ['EVENT', subscription, event]);
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this);
      presences.delete(this.publisher);
      this.subscriptions.clear();
      this.dispatchEvent(new Event('close'));
    }
  }
  return { WebSocketImpl: LocalSocket, url: RELAY_URL,
    metrics: () => ({ ...counts, connections: sockets.size, retainedPresences: presences.size }),
    close() { closed = true; for (const socket of [...sockets]) socket.close(); presences.clear(); } };
}

function observedPeer(ice, connections) {
  const expected = JSON.stringify(ice);
  const check = config => {
    if (JSON.stringify({ iceServers: config?.iceServers, iceTransportPolicy: config?.iceTransportPolicy }) !== expected) {
      throw new Error('The peer demo refused an unexpected ICE configuration.');
    }
  };
  return class extends globalThis.RTCPeerConnection {
    constructor(config) {
      check(config);
      if ([...connections].filter(connection => connection.connectionState !== 'closed').length >= 4) throw new Error('Peer demo connection limit reached.');
      super(config);
      connections.add(this);
    }
    setConfiguration(config) { check(config); return super.setConfiguration(config); }
  };
}

async function selectedPairs(connections) {
  const pairs = [];
  for (const connection of connections) {
    if (connection.connectionState === 'closed') continue;
    try {
      const reports = [...(await connection.getStats()).values()];
      const pair = reports.find(report => report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected));
      if (!pair) continue;
      const local = reports.find(report => report.id === pair.localCandidateId);
      const remote = reports.find(report => report.id === pair.remoteCandidateId);
      pairs.push({ localType: local?.candidateType ?? 'unknown', remoteType: remote?.candidateType ?? 'unknown',
        relayProtocol: local?.relayProtocol ?? null });
    } catch {}
  }
  return pairs;
}

export async function startPeerDemo({ Hls, video, playlistUrl, manifest, runtime, onStats = () => {}, signal }) {
  if (!Hls?.isSupported?.() || typeof globalThis.RTCPeerConnection !== 'function' || !globalThis.crypto?.subtle) {
    throw new Error('Peer-assisted playback is unavailable in this browser.');
  }
  if (!video || !globalThis.document) throw new Error('The demo needs its video player.');
  if (signal?.aborted) throw new DOMException('Demo cancelled', 'AbortError');
  const plan = validateMediaManifest(manifest, playlistUrl, location.href);
  const ice = demoIceConfiguration(runtime, location.hostname);
  const swarmId = `forgesworn-demo-${hex(crypto.getRandomValues(new Uint8Array(12)))}`;
  const publisherKey = generateSecretKey();
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', swarmId], ['relayswarm', 'redistribute', '1']], content: 'Generated, browser-local media demonstration.' }, publisherKey);
  const relay = createInPageRelay(swarmId);
  const connections = new Set(), players = [], swarms = [];
  const started = performance.now();
  let stopped = false, holderDropped = false, startedViewer = false, polling = false, fatal = false, pairs = [], last;
  let lastDelivery = null, observedPeerLoads = 0;
  let tick, cap;
  const holderVideo = document.createElement('video');
  holderVideo.muted = true; holderVideo.playsInline = true; holderVideo.hidden = true;
  const getCommitment = async context => {
    if (stopped) return null;
    const path = new URL(context.url || context.frag.url, plan.playlist).pathname;
    const segment = plan.segments.get(path);
    if (!segment || context.rangeEnd || context.frag.sn !== segment.sn || (context.frag.cc ?? 0) !== segment.cc || context.part) return null;
    const media = segmentMediaContext(context);
    if (!media) return null;
    const key = await digest(`${swarmId}\n${path}`);
    if (stopped) return null;
    const seconds = Math.floor(Date.now() / 1000);
    return finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds, tags: [['x', swarmId], ['e', streamEvent.id]],
      content: commitmentContent({ v: 2, streamEventId: streamEvent.id, swarmId, key, rendition: media.playlist,
        sequence: segment.sn, discontinuity: segment.cc, part: null, sha256: segment.sha256, size: segment.size,
        expiresAt: seconds + 120, ...media }) }, publisherKey);
  };
  const snapshot = () => {
    const holder = swarms[0]?.metrics(), viewer = swarms[1]?.metrics();
    const phase = fatal ? 'error' : stopped ? 'stopped' : !startedViewer ? 'loading-holder'
      : lastDelivery === 'peer' && viewer?.peers.connected > 0 && !holderDropped ? 'peer'
      : viewer?.segments.originLoaded > 0 ? 'origin-fallback' : 'connecting';
    return { phase, elapsedMs: Math.round(performance.now() - started),
      viewer: { peerBytes: number(viewer?.bytes.peerFirst), originBytes: number(viewer?.bytes.fromOrigin),
        verifiedPeerSegments: number(viewer?.segments.peerFirstLoaded), originFallbacks: number(viewer?.segments.originFallbacks),
        connectedPeers: number(viewer?.peers.connected), integrityRejected: number(viewer?.segments.peerCorrupt) + number(viewer?.segments.commitmentRejected) },
      holder: { uploadedBytes: number(holder?.bytes.uploaded), connectedPeers: number(holder?.peers.connected) },
      transport: { mode: runtime ? 'local-turn' : 'host-direct', requestedProtocol: runtime?.transport ?? null, selectedPairs: pairs,
        signalling: 'in-page Nostr adapter', signallingEvents: relay.metrics().published },
      playback: { currentTime: number(video.currentTime), readyState: number(video.readyState), paused: video.paused,
        decodedFrames: number(video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount) },
      resources: { activePeerConnections: [...connections].filter(connection => connection.connectionState !== 'closed').length,
        signallingConnections: relay.metrics().connections, heldBytes: number(holder?.bytes.held) + number(viewer?.bytes.held) },
      diagnostics: { holderErrors: holder?.errors ?? null, viewerErrors: viewer?.errors ?? null,
        holderHeldBytes: number(holder?.bytes.held), viewerDials: number(viewer?.peers.dialsStarted),
        viewerMisses: number(viewer?.segments.peerMiss), viewerCommitmentRejected: number(viewer?.segments.commitmentRejected),
        viewerCommitmentUnavailable: number(viewer?.segments.commitmentUnavailable),
        eligibility: viewer?.peerEligibilityDiagnostics.counters ?? null,
        connections: [...connections].map(connection => ({ state: connection.connectionState, ice: connection.iceConnectionState })),
        localRelay: relay.metrics() },
      limits: { maxDurationMs: PEER_DEMO_LIMITS.maxDurationMs, maxUploadBytes: PEER_DEMO_LIMITS.maxUploadBytes } };
  };
  const emit = () => { last = snapshot(); try { onStats(last); } catch {} return last; };
  const disconnectPeer = () => {
    if (holderDropped) return;
    holderDropped = true;
    swarms[0]?.stop();
    players[0]?.destroy();
    holderVideo.pause(); holderVideo.removeAttribute('src'); holderVideo.load();
    emit();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick); clearTimeout(cap);
    signal?.removeEventListener('abort', stop);
    video.removeEventListener('ended', stop);
    for (const swarm of swarms) swarm.stop();
    for (const player of players) player.destroy();
    for (const connection of connections) connection.close();
    relay.close();
    holderVideo.pause(); holderVideo.removeAttribute('src'); holderVideo.load();
    publisherKey.fill(0);
    emit();
  };
  try {
    const common = { swarmId, relays: [relay.url], WebSocketImpl: relay.WebSocketImpl,
      maxPeers: 1, maxUploadPeers: 1, maxDialsInFlight: 1, maxHeldSegments: PEER_DEMO_LIMITS.maxSegments,
      maxHeldBytes: PEER_DEMO_LIMITS.maxUploadBytes, maxSegmentBytes: PEER_DEMO_LIMITS.maxSegmentBytes,
      maxUploadBytesPerSecond: 2 * 1024 * 1024, maxUploadBytesPerSession: PEER_DEMO_LIMITS.maxUploadBytes,
      maxConcurrentRaces: 8, metricsIntervalMs: 500, presenceIntervalMs: 1000, dialTimeoutMs: 6000,
      originFallbackMs: 1000, originReserveMs: 250, maxPeerWaitMs: 1500, lateWindowMs: 2000 };
    swarms.push(createHlsSwarm({ ...common, ...ice[0], mode: 'shadow', shadowSampleRate: 0, serve: true,
      RTCPeerConnectionImpl: observedPeer(ice[0], connections) }));
    swarms.push(createHlsSwarm({ ...common, ...ice[1], mode: 'peer-first', serve: false, streamEvent, getCommitment,
      RTCPeerConnectionImpl: observedPeer(ice[1], connections) }));
    const playerOptions = { enableWorker: false, backBufferLength: 0, maxBufferSize: PEER_DEMO_LIMITS.maxUploadBytes };
    players.push(new Hls({ ...playerOptions, maxBufferLength: 90, maxMaxBufferLength: 90 }));
    players.push(new Hls({ ...playerOptions, autoStartLoad: false, maxBufferLength: 3, maxMaxBufferLength: 6 }));
    players[1].on(Hls.Events.FRAG_LOADED, (_event, detail) => {
      if (detail.frag?.sn === 'initSegment') return;
      // RelaySwarm increments this counter before its successful loader callback.
      // An unchanged counter identifies a real origin load, not a peer estimate.
      const delivered = swarms[1].metrics().segments.peerFirstLoaded;
      lastDelivery = delivered > observedPeerLoads ? 'peer' : 'origin';
      observedPeerLoads = delivered;
    });
    for (let index = 0; index < 2; index++) {
      players[index].on(Hls.Events.ERROR, (_event, detail) => {
        if (detail.fatal && !(holderDropped && index === 0)) { fatal = true; stop(); }
      });
      swarms[index].attach(players[index]);
      if (swarms[index].metrics().mode === 'off') throw new Error('RelaySwarm could not start in this browser.');
      players[index].loadSource(plan.playlist);
      players[index].attachMedia(index === 0 ? holderVideo : video);
    }
    signal?.addEventListener('abort', stop, { once: true });
    video.addEventListener('ended', stop);
    cap = setTimeout(stop, PEER_DEMO_LIMITS.maxDurationMs);
    tick = setInterval(() => {
      emit();
      if (!polling) {
        polling = true;
        void selectedPairs(connections).then(value => { pairs = value; }).finally(() => { polling = false; });
      }
    }, 500);
    emit();
    void holderVideo.play().catch(() => {});
    // Give an already-warmed holder and peer a brief head start. Playback does
    // not wait for the whole clip or for an unavailable host-only ICE path;
    // the real loader can adopt verified peers as they become available.
    const warmDeadline = performance.now() + PEER_DEMO_LIMITS.maxPreplayWarmupMs;
    while (!stopped && performance.now() < warmDeadline &&
      (swarms[0].metrics().bytes.held === 0 || swarms[1].metrics().peers.connected < 1)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (fatal) throw new Error('The generated clip could not be decoded.');
    if (stopped) return { stop, disconnectPeer, metrics: () => snapshot() };
    startedViewer = true;
    players[1].startLoad(0);
    void video.play().catch(() => {});
    emit();
    const mediaDeadline = performance.now() + 8000;
    while (!stopped && video.readyState < 2 && performance.now() < mediaDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (fatal || !stopped && video.readyState < 2) throw new Error('The generated clip could not start playback.');
    return { stop, disconnectPeer, metrics: () => snapshot() };
  } catch (failure) {
    stop();
    throw failure;
  }
}
