// Real RelaySwarm peer-first HLS with a rolling cache for the local 4K lab.
// Two logical viewers share in-page Nostr signalling and a native local TURN.
import { createHlsSwarm, commitmentContent, KIND_SEGMENT_COMMITMENT, segmentMediaContext,
  finalizeEvent, generateSecretKey } from './vendor/media-peer-demo.js';
import { createInPageRelay, demoIceConfiguration } from './media-peer-demo.mjs';
import { readInitialLiveStart } from './media-live-start.mjs';

export const LAB_PEER_LIMITS = Object.freeze({ maxDurationMs: 330_000,
  maxHeldBytes: 64 * 1024 * 1024, maxHeldSegments: 12, maxSegmentBytes: 16 * 1024 * 1024,
  maxUploadBytesPerSecond: 8 * 1024 * 1024, maxUploadBytesPerSession: 1024 * 1024 * 1024 });
export const LAB_MSE_TARGETS = Object.freeze({ viewerSeconds: 4, viewerMaxSeconds: 6, viewerBytes: 8 * 1024 * 1024,
  holderSeconds: 8, holderMaxSeconds: 10, holderBytes: 16 * 1024 * 1024 });
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function bufferedSeconds(video) {
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.currentTime >= video.buffered.start(index) && video.currentTime <= video.buffered.end(index)) return video.buffered.end(index) - video.currentTime;
  }
  return 0;
}

export function labPlaylist(playlistUrl, origin) {
  const page = new URL(origin), playlist = new URL(playlistUrl, page);
  if (!['127.0.0.1', 'localhost'].includes(page.hostname) || page.protocol !== 'http:' ||
      playlist.origin !== page.origin || playlist.username || playlist.password || playlist.search || playlist.hash ||
      !/^\/media\/lab\/hls\/[a-f0-9]{16,64}\/index\.m3u8$/.test(playlist.pathname)) {
    throw new Error('Use the active loopback lab playlist.');
  }
  return { playlist: playlist.href, prefix: playlist.pathname.slice(0, playlist.pathname.lastIndexOf('/') + 1) };
}

export function labIceConfiguration(runtime, hostname) {
  if (!runtime || !['spry', 'coturn'].includes(runtime.engine)) throw new Error('Select a native local TURN operator.');
  const ice = demoIceConfiguration(runtime, hostname);
  if (ice[0].iceServers[0].username === ice[1].iceServers[0].username) throw new Error('Use separate local viewer credentials.');
  return ice;
}

export function createLabCommitmentProvider({ playlistUrl, origin, swarmId, streamEvent, publisherKey, signal,
  fetchImpl = globalThis.fetch }) {
  const plan = labPlaylist(playlistUrl, origin);
  return async (context, { signal: operationSignal } = {}) => {
    if (signal?.aborted || operationSignal?.aborted || context.part || context.rangeEnd) return null;
    const media = segmentMediaContext(context);
    const url = new URL(context.url || context.frag?.url, plan.playlist);
    if (!media || !media.playlist.startsWith(plan.prefix) || url.origin !== new URL(plan.playlist).origin ||
        !url.pathname.startsWith(plan.prefix) || !/^[a-z0-9_./-]+$/i.test(url.pathname) || url.search || url.hash ||
        !Number.isSafeInteger(context.frag?.sn) || context.frag.sn < 0 ||
        !Number.isSafeInteger(context.frag.cc ?? 0) || (context.frag.cc ?? 0) < 0) return null;
    const combined = AbortSignal.any([signal, operationSignal].filter(Boolean));
    const endpoint = new URL('/lab/hash', plan.playlist);
    endpoint.searchParams.set('path', url.pathname);
    // The proxy hashes bytes while the holder fetches normally. A short miss
    // waits for that response; this endpoint never starts a media prefetch.
    const deadline = performance.now() + 2500;
    let metadata;
    do {
      if (combined.aborted) return null;
      const response = await fetchImpl(endpoint, { signal: combined, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (response.ok) { metadata = await response.json(); break; }
      if (response.status !== 404) return null;
      await wait(50);
    } while (performance.now() < deadline);
    if (combined.aborted || !metadata || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > LAB_PEER_LIMITS.maxSegmentBytes) return null;
    const key = await digest(`${swarmId}\n${url.pathname}`);
    if (combined.aborted) return null;
    const seconds = Math.floor(Date.now() / 1000);
    return finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds,
      tags: [['x', swarmId], ['e', streamEvent.id]],
      content: commitmentContent({ v: 2, streamEventId: streamEvent.id, swarmId, key,
        rendition: media.playlist, sequence: context.frag.sn, discontinuity: context.frag.cc ?? 0, part: null,
        sha256: metadata.sha256, size: metadata.size, expiresAt: seconds + 120, ...media }) }, publisherKey);
  };
}

function observedPeer(ice, connections) {
  const expected = JSON.stringify(ice);
  const check = config => {
    if (JSON.stringify({ iceServers: config?.iceServers, iceTransportPolicy: config?.iceTransportPolicy }) !== expected) {
      throw new Error('The lab refused an unexpected ICE configuration.');
    }
  };
  return class extends globalThis.RTCPeerConnection {
    constructor(config) {
      check(config);
      if ([...connections].filter(connection => connection.connectionState !== 'closed').length >= 4) throw new Error('The lab peer connection limit was reached.');
      super(config); connections.add(this);
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
      const local = reports.find(report => report.id === pair.localCandidateId), remote = reports.find(report => report.id === pair.remoteCandidateId);
      pairs.push({ localType: local?.candidateType ?? 'unknown', remoteType: remote?.candidateType ?? 'unknown',
        relayProtocol: local?.relayProtocol ?? null, bytesSent: number(pair.bytesSent), bytesReceived: number(pair.bytesReceived) });
    } catch {}
  }
  return pairs;
}

export async function startLabPeer({ Hls, video, playlistUrl, runtime, startPosition, onStats = () => {}, signal }) {
  if (!Hls?.isSupported?.() || typeof globalThis.RTCPeerConnection !== 'function' || !globalThis.crypto?.subtle || !video) {
    throw new Error('Use a browser with HLS Media Source and WebRTC support.');
  }
  if (signal?.aborted) throw new DOMException('Lab cancelled', 'AbortError');
  const plan = labPlaylist(playlistUrl, location.href), ice = labIceConfiguration(runtime, location.hostname);
  if (startPosition === undefined) startPosition = (await readInitialLiveStart(plan.playlist, { signal })).startPosition;
  if (!Number.isFinite(startPosition) || startPosition < -1 || startPosition > LAB_PEER_LIMITS.maxDurationMs / 1000) throw new Error('The initial media position is invalid.');
  if (signal?.aborted) throw new DOMException('Lab cancelled', 'AbortError');
  const swarmId = `forgesworn-lab-${hex(crypto.getRandomValues(new Uint8Array(12)))}`, publisherKey = generateSecretKey();
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', swarmId], ['relayswarm', 'redistribute', '1']], content: 'Licensed media, local rolling-cache comparison.' }, publisherKey);
  const relay = createInPageRelay(swarmId), connections = new Set(), players = [], swarms = [], cancellation = new AbortController();
  const holderVideo = document.createElement('video');
  holderVideo.muted = true; holderVideo.playsInline = true; holderVideo.hidden = true;
  const started = performance.now();
  let stopped = false, holderDropped = false, startedViewer = false, fatal = false, polling = false;
  let pairs = [], lastDelivery = null, observedPeerLoads = 0, heldHighWaterBytes = 0, tick, cap;
  const snapshot = () => {
    const holder = swarms[0]?.metrics(), viewer = swarms[1]?.metrics();
    const heldBytes = number(holder?.bytes.held) + number(viewer?.bytes.held);
    heldHighWaterBytes = Math.max(heldHighWaterBytes, heldBytes);
    return { phase: fatal ? 'error' : stopped ? 'stopped' : !startedViewer ? 'loading-holder'
      : lastDelivery === 'peer' && viewer?.peers.connected > 0 && !holderDropped ? 'peer'
      : viewer?.segments.originLoaded > 0 ? 'origin-fallback' : 'connecting',
      elapsedMs: Math.round(performance.now() - started),
      viewer: { peerBytes: number(viewer?.bytes.peerFirst), originBytes: number(viewer?.bytes.fromOrigin),
        verifiedPeerSegments: number(viewer?.segments.peerFirstLoaded), originFallbacks: number(viewer?.segments.originFallbacks),
        connectedPeers: number(viewer?.peers.connected), integrityRejected: number(viewer?.segments.peerCorrupt) + number(viewer?.segments.commitmentRejected) },
      holder: { uploadedBytes: number(holder?.bytes.uploaded), originBytes: number(holder?.bytes.fromOrigin), connectedPeers: number(holder?.peers.connected),
        currentTime: number(holderVideo.currentTime) },
      transport: { mode: 'local-turn', requestedEngine: runtime.engine, requestedProtocol: runtime.transport, selectedPairs: pairs,
        signalling: 'in-page Nostr adapter' },
      playback: { currentTime: number(video.currentTime), readyState: number(video.readyState), paused: video.paused,
        decodedFrames: number(video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount) },
      resources: { activePeerConnections: [...connections].filter(connection => connection.connectionState !== 'closed').length,
        signallingConnections: relay.metrics().connections, heldBytes, heldHighWaterBytes,
        viewerBufferedSeconds: bufferedSeconds(video), holderBufferedSeconds: bufferedSeconds(holderVideo) },
      diagnostics: { holderErrors: holder?.errors ?? null, viewerErrors: viewer?.errors ?? null,
        peerMisses: number(viewer?.segments.peerMiss), commitmentRejected: number(viewer?.segments.commitmentRejected),
        commitmentUnavailable: number(viewer?.segments.commitmentUnavailable), eligibility: viewer?.peerEligibilityDiagnostics?.counters ?? null },
      limits: LAB_PEER_LIMITS, mseTargets: LAB_MSE_TARGETS };
  };
  const emit = () => { const value = snapshot(); try { onStats(value); } catch {} return value; };
  const disconnectPeer = () => {
    if (holderDropped) return;
    holderDropped = true; swarms[0]?.stop(); players[0]?.destroy();
    holderVideo.pause(); holderVideo.removeAttribute('src'); holderVideo.load(); emit();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; cancellation.abort(); clearInterval(tick); clearTimeout(cap);
    signal?.removeEventListener('abort', stop); video.removeEventListener('ended', stop);
    for (const swarm of swarms) swarm.stop();
    for (const player of players) player.destroy();
    for (const connection of connections) connection.close();
    relay.close();
    for (const element of [holderVideo, video]) { element.pause(); element.removeAttribute('src'); element.load(); }
    publisherKey.fill(0); emit();
  };
  const controller = { stop, disconnectPeer, metrics: () => snapshot() };
  try {
    const common = { swarmId, relays: [relay.url], WebSocketImpl: relay.WebSocketImpl, maxPeers: 1, maxUploadPeers: 1,
      maxDialsInFlight: 1, maxHeldSegments: LAB_PEER_LIMITS.maxHeldSegments / 2, maxHeldBytes: LAB_PEER_LIMITS.maxHeldBytes / 2,
      maxSegmentBytes: LAB_PEER_LIMITS.maxSegmentBytes, maxUploadBytesPerSecond: LAB_PEER_LIMITS.maxUploadBytesPerSecond,
      maxUploadBytesPerSession: LAB_PEER_LIMITS.maxUploadBytesPerSession, swarmParts: false,
      maxConcurrentRaces: 4, metricsIntervalMs: 500, presenceIntervalMs: 1000, dialTimeoutMs: 6000,
      originFallbackMs: 3000, maxPeerWaitMs: 6000, originReserveMs: 1000, lateWindowMs: 5000 };
    // The seeding viewer holds the longer buffer. Its nine entries cover an
    // eight-second window even with one-second segments; the receiving viewer
    // has three entries. The combined bounds stay 64 MiB and twelve entries.
    swarms.push(createHlsSwarm({ ...common, ...ice[0], maxHeldSegments: 9, maxHeldBytes: 48 * 1024 * 1024,
      mode: 'shadow', shadowSampleRate: 0, serve: true,
      RTCPeerConnectionImpl: observedPeer(ice[0], connections) }));
    swarms.push(createHlsSwarm({ ...common, ...ice[1], maxHeldSegments: 3, maxHeldBytes: 16 * 1024 * 1024,
      mode: 'peer-first', serve: false, streamEvent,
      getCommitment: createLabCommitmentProvider({ playlistUrl: plan.playlist, origin: location.href, swarmId, streamEvent, publisherKey, signal: cancellation.signal }),
      RTCPeerConnectionImpl: observedPeer(ice[1], connections) }));
    const options = { enableWorker: false, lowLatencyMode: false, backBufferLength: 0, startPosition, liveSyncDuration: 6, liveMaxLatencyDuration: 15 };
    // hls.js may overshoot a time/byte target by a complete fragment. These
    // settings govern MSE buffering; peer caches and decoder memory are separate.
    players.push(new Hls({ ...options, maxBufferLength: LAB_MSE_TARGETS.holderSeconds,
      maxMaxBufferLength: LAB_MSE_TARGETS.holderMaxSeconds, maxBufferSize: LAB_MSE_TARGETS.holderBytes }));
    players.push(new Hls({ ...options, autoStartLoad: false, maxBufferLength: LAB_MSE_TARGETS.viewerSeconds,
      maxMaxBufferLength: LAB_MSE_TARGETS.viewerMaxSeconds, maxBufferSize: LAB_MSE_TARGETS.viewerBytes }));
    players[1].on(Hls.Events.FRAG_LOADED, (_event, detail) => {
      if (detail.frag?.sn === 'initSegment') return;
      const loaded = swarms[1].metrics().segments.peerFirstLoaded;
      lastDelivery = loaded > observedPeerLoads ? 'peer' : 'origin'; observedPeerLoads = loaded;
    });
    for (let index = 0; index < 2; index++) {
      players[index].on(Hls.Events.ERROR, (_event, detail) => {
        if (detail.fatal && !(holderDropped && index === 0)) { fatal = true; stop(); }
      });
      swarms[index].attach(players[index]);
      if (swarms[index].metrics().mode === 'off') throw new Error('RelaySwarm could not start in this browser.');
      players[index].loadSource(plan.playlist); players[index].attachMedia(index === 0 ? holderVideo : video);
    }
    signal?.addEventListener('abort', stop, { once: true }); video.addEventListener('ended', stop);
    cap = setTimeout(stop, LAB_PEER_LIMITS.maxDurationMs);
    tick = setInterval(() => {
      emit();
      if (!holderDropped && startedViewer && video.readyState >= 2 && holderVideo.readyState >= 2) {
        // Keep the holder about one second ahead. Correct the hidden player;
        // the visible comparison never seeks merely to manufacture peer hits.
        if (video.paused) holderVideo.pause();
        else {
          if (holderVideo.paused) void holderVideo.play().catch(() => {});
          const target = video.currentTime + 1, gap = holderVideo.currentTime - target;
          if (Math.abs(gap) > 3 && holderVideo.seekable.length && target >= holderVideo.seekable.start(0) &&
              target <= holderVideo.seekable.end(holderVideo.seekable.length - 1)) holderVideo.currentTime = target;
          holderVideo.playbackRate = Math.abs(gap) < 0.15 ? 1 : Math.min(1.25, Math.max(0.75, 1 - gap / 4));
        }
      }
      if (!polling) {
        polling = true;
        void selectedPairs(connections).then(value => { pairs = value; }).finally(() => { polling = false; });
      }
    }, 500);
    emit(); void holderVideo.play().catch(() => {});
    const warmDeadline = performance.now() + 5000;
    while (!stopped && performance.now() < warmDeadline &&
        (swarms[0].metrics().bytes.held === 0 || swarms[1].metrics().peers.connected < 1)) await wait(100);
    if (fatal) throw new Error('The lab media could not be decoded.');
    if (stopped) return controller;
    startedViewer = true;
    players[1].startLoad(Math.max(0, startPosition, holderVideo.currentTime - 1));
    // The caller is a Play gesture. Retain its audible/mute/volume preference.
    void video.play().catch(() => {}); emit();
    const readyDeadline = performance.now() + 12_000;
    while (!stopped && video.readyState < 2 && performance.now() < readyDeadline) await wait(100);
    if (fatal || !stopped && video.readyState < 2) throw new Error('The lab media could not start playback.');
    return controller;
  } catch (error) { stop(); throw error; }
}
