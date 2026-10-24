// One visible player per visitor. Peer networking begins only at setEnabled(true).
// The immutable HTTPS catalogue, pinned below, supplies the expected media hash.
// A receiver's ephemeral key wraps that digest for the existing live-commitment
// verifier; this is local attestation, not a live broadcaster signing service.
import { createHlsSwarm, commitmentContent, KIND_SEGMENT_COMMITMENT, finalizeEvent,
  generateSecretKey } from './vendor/media-peer-demo.js';

export const PUBLIC_SWARM_LIMITS = Object.freeze({
  maxDurationMs: 15 * 60 * 1000,
  maxPeers: 3,
  maxUploadPeers: 2,
  maxUploadBytesPerSecond: 4 * 1024 * 1024,
  maxUploadBytesPerSession: 1024 * 1024 * 1024,
  maxHeldBytes: 64 * 1024 * 1024,
  maxHeldSegments: 12,
  maxSegmentBytes: 16 * 1024 * 1024,
  maxCatalogueBytes: 64 * 1024,
});
export const PUBLIC_SWARM_CATALOGUE_SHA256 = '8b8276556c7aaaaac8fe61716c51648ce00bfdfb8d5a81a2d81490d97b21b7d4';
export const PUBLIC_SWARM_RELAYS = Object.freeze(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
export const PUBLIC_SWARM_ICE = Object.freeze([{ urls: 'stun:stun.cloudflare.com:3478' }]);
const SOURCE_SHA256 = '76d90719a756c77d1008088c58ca6b28a74eb0ef01e5337906cfb68d3e2b13aa';
const FULL_PLAYLIST = 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/index.m3u8';
const PREVIEW_PLAYLIST = '/media/dejavu-preview/rtmp/index.m3u8';
const HEX = /^[a-f0-9]{64}$/;
const n = value => Number.isFinite(value) && value >= 0 ? value : 0;
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
const encoded = value => new TextEncoder().encode(value);

export function validatePublicSwarmCatalogue(catalogue, { quality, playlistUrl, origin }) {
  const expectedPath = quality === 'full' ? FULL_PLAYLIST : quality === 'preview' ? PREVIEW_PLAYLIST : null;
  if (!expectedPath || catalogue?.schema !== 1 || catalogue.sourceSha256 !== SOURCE_SHA256 || catalogue.licensed !== true) throw new Error('Unrecognised public media catalogue.');
  const expected = new URL(expectedPath, origin);
  const playlist = new URL(playlistUrl, origin);
  const descriptor = catalogue.qualities?.[quality];
  const expectedSwarm = `forgesworn-dejavu-${quality === 'full' ? '4k' : '1080'}-v1-76d90719a756c77d`;
  const count = quality === 'full' ? 134 : 30;
  if (playlist.href !== expected.href || descriptor?.playlist !== expectedPath || descriptor.swarmId !== expectedSwarm ||
      !Array.isArray(descriptor.segments) || descriptor.segments.length !== count) throw new Error('The public media identity does not match its catalogue.');
  const segments = new Map();
  for (let index = 0; index < descriptor.segments.length; index++) {
    const entry = descriptor.segments[index];
    const path = quality === 'full' ? `segment-${String(index).padStart(4, '0')}.m4s` : `segment-${String(index).padStart(3, '0')}.mp4`;
    if (entry?.path !== path || entry.sn !== index || entry.cc !== 0 || !HEX.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > PUBLIC_SWARM_LIMITS.maxSegmentBytes) throw new Error('Invalid public segment identity.');
    const url = new URL(path, playlist);
    segments.set(url.href, { ...entry, url: url.href });
  }
  return { playlist: playlist.href, swarmId: descriptor.swarmId, segments };
}

// Muxed H.264/AAC VOD uses RelaySwarm's existing v1 commitment context. The
// exact URL, sequence, discontinuity and unencrypted main track are checked
// here before any local signature is made. Peer claims cannot choose a hash.
export function catalogueSegment(plan, context) {
  const frag = context?.frag;
  if (!frag || !Number.isSafeInteger(frag.sn) || frag.sn < 0 || !Number.isSafeInteger(frag.level) || frag.level < 0 ||
      context.part || context.rangeStart !== undefined && context.rangeStart !== 0 || context.rangeEnd ||
      frag.type && frag.type !== 'main' || frag.decryptdata?.method && frag.decryptdata.method !== 'NONE') return null;
  let url;
  try { url = new URL(context.url || frag.url, plan.playlist); } catch { return null; }
  const segment = plan.segments.get(url.href);
  return segment && frag.sn === segment.sn && (frag.cc ?? 0) === segment.cc ? segment : null;
}

async function readCatalogue(signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(new URL('./media/dejavu-swarm/catalogue-v1.json', import.meta.url),
      { signal: requestSignal, credentials: 'same-origin', cache: 'force-cache', redirect: 'error' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > PUBLIC_SWARM_LIMITS.maxCatalogueBytes) throw new Error('Public media catalogue unavailable.');
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PUBLIC_SWARM_LIMITS.maxCatalogueBytes) throw new Error('Public media catalogue too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (await digest(bytes) !== PUBLIC_SWARM_CATALOGUE_SHA256) throw new Error('The public media catalogue failed its integrity check.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { clearTimeout(timer); }
}

/** Add opt-in peer delivery to an existing, visible hls.js instance.
 * Neither construction nor origin-only playback opens a socket or peer.
 * setEnabled(false) restores the normal HTTP loader without replacing the
 * video, seeking, muting, or destroying its current MediaSource. */
export function createPublicSwarm({ Hls, hls, video, playlistUrl, quality, signal, onStats = () => {} }) {
  if (!Hls || !hls?.config || !video) throw new Error('An existing video and HLS player are required.');
  const origin = globalThis.location?.href;
  if (!origin) throw new Error('The public swarm needs a browser.');
  const expected = new URL(quality === 'full' ? FULL_PLAYLIST : quality === 'preview' ? PREVIEW_PLAYLIST : '/invalid', origin);
  if (!['full', 'preview'].includes(quality) || new URL(playlistUrl, origin).href !== expected.href) throw new Error('Unrecognised public film source.');
  const lifetime = new AbortController();
  const sockets = new Set(), connections = new Set(), peerObservations = new Map();
  const totals = { peerBytes: 0, uploadedBytes: 0, verifiedPeerSegments: 0, integrityRejected: 0, originFallbacks: 0 };
  const observedChannels = new WeakSet();
  let stopped = false, enabled = false, enabling = null, generation = 0, swarm, key, plan, tick, cap, catalogueAbort;
  let lastDelivery = 'origin', lastReason = 'off', peerLoadsSeen = 0, receivedOriginBytes = 0;
  let highWaterBytes = 0, signalErrors = 0, lastSnapshot = null, nextPeer = 1, observing = false, request = 0;
  let firstEnabledAt = null, uploadChargedBytes = 0, cycleUploadLimit = 0;
  let sentMediaBytes = 0;

  const metrics = () => {
    const live = swarm?.metrics();
    const connectedPeers = n(live?.peers.connected);
    const peerBytes = totals.peerBytes + n(live?.bytes.peerFirst);
    highWaterBytes = Math.max(highWaterBytes, n(live?.bytes.held));
    return { enabled, phase: stopped ? 'stopped' : !enabled ? 'origin' : enabling && !swarm ? 'connecting' :
      connectedPeers > 0 && lastDelivery === 'peer' ? 'peer' : connectedPeers > 0 ? 'connected' : 'waiting',
      lastDelivery, reason: lastReason, connectedPeers, serving: live?.serving === true,
      peerBytes, originBytes: receivedOriginBytes,
      uploadedBytes: sentMediaBytes,
      acceptedUploadBytes: totals.uploadedBytes + n(live?.bytes.uploaded),
      verifiedPeerSegments: totals.verifiedPeerSegments + n(live?.segments.peerFirstLoaded),
      originFallbacks: totals.originFallbacks + n(live?.segments.originFallbacks),
      integrityRejected: totals.integrityRejected + n(live?.segments.peerCorrupt) + n(live?.segments.commitmentRejected),
      peerShare: peerBytes + receivedOriginBytes > 0 ? peerBytes / (peerBytes + receivedOriginBytes) : 0,
      resources: { activePeerConnections: [...connections].filter(connection => connection.connectionState !== 'closed').length,
        signallingConnections: [...sockets].filter(socket => socket.readyState < 2).length,
        heldBytes: n(live?.bytes.held), heldHighWaterBytes: highWaterBytes },
      diagnostics: { signalErrors, dialling: n(live?.peers.dialling), dialsStarted: n(live?.peers.dialsStarted),
        disabledReason: live?.disabledReason ?? null, commitmentUnavailable: n(live?.segments.commitmentUnavailable),
        signallingConnected: n(live?.relays.connected), signallingPublished: n(live?.relays.published),
        signallingPublishErrors: n(live?.relays.publishErrors), relayRejected: n(live?.relays.rejected) },
      topology: { connections: [...connections].filter(connection => connection.connectionState !== 'closed').slice(0, PUBLIC_SWARM_LIMITS.maxPeers + 2).map(connection => {
        const observation = peerObservations.get(connection);
        return { id: observation.id, state: connection.connectionState, iceState: connection.iceConnectionState,
          bytesSent: observation.sentBytes, bytesReceived: observation.receivedBytes, kind: observation.kind, trafficBasis: observation.trafficBasis,
          observedAtMs: observation.observedAtMs };
      }) },
      uploadAllowanceRemaining: Math.max(0, PUBLIC_SWARM_LIMITS.maxUploadBytesPerSession - uploadChargedBytes - (swarm ? cycleUploadLimit - n(live?.bytes.uploadRemaining) : 0)),
      limits: PUBLIC_SWARM_LIMITS,
      trust: 'site-pinned HTTPS digest catalogue; fresh receiver-local commitment',
      signalling: 'public Nostr relays; encrypted peer signals',
      topologyLabel: 'one visible player per visitor',
    };
  };
  const emit = () => { lastSnapshot = metrics(); try { onStats(lastSnapshot); } catch {} return lastSnapshot; };
  const observeChannel = channel => {
    if (observedChannels.has(channel)) return;
    observedChannels.add(channel);
    const send = channel.send;
    channel.send = function (data) {
      const result = send.call(this, data);
      // RelaySwarm uses text for protocol messages and binary chunks for media.
      // Count only binary bytes successfully submitted to the native channel.
      // Remote verification is reported by the receiving visitor separately.
      if (this === channel && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) sentMediaBytes += data.byteLength;
      return result;
    };
  };
  const observeTraffic = async () => {
    if (observing || stopped || !enabled) return;
    observing = true;
    try {
      await Promise.allSettled([...connections].map(async connection => {
        const observation = peerObservations.get(connection);
        if (!observation || connection.connectionState === 'closed') return;
        const reports = [...(await connection.getStats()).values()];
        if (!enabled || !connections.has(connection)) return;
        const channels = reports.filter(report => report.type === 'data-channel');
        const transport = reports.find(report => report.type === 'transport' && report.selectedCandidatePairId);
        const pair = reports.find(report => report.id === transport?.selectedCandidatePairId) ??
          reports.find(report => report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected));
        const local = pair ? reports.find(report => report.id === pair.localCandidateId) : null;
        const remote = pair ? reports.find(report => report.id === pair.remoteCandidateId) : null;
        const rows = channels.length ? channels : pair ? [pair] : [];
        Object.assign(observation, { sentBytes: rows.length ? rows.reduce((sum, row) => sum + n(row.bytesSent), 0) : null,
          receivedBytes: rows.length ? rows.reduce((sum, row) => sum + n(row.bytesReceived), 0) : null,
          kind: pair ? local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct' : null,
          trafficBasis: channels.length ? 'data-channel' : pair ? 'candidate-pair' : null,
          observedAtMs: rows.length ? Math.round(performance.now()) : null });
      }));
    } finally { observing = false; }
  };
  const fold = () => {
    const live = swarm?.metrics();
    if (!live) return;
    totals.peerBytes += n(live.bytes.peerFirst);
    totals.uploadedBytes += n(live.bytes.uploaded);
    totals.verifiedPeerSegments += n(live.segments.peerFirstLoaded);
    totals.integrityRejected += n(live.segments.peerCorrupt) + n(live.segments.commitmentRejected);
    totals.originFallbacks += n(live.segments.originFallbacks);
    uploadChargedBytes += Math.max(0, cycleUploadLimit - n(live.bytes.uploadRemaining));
  };
  const disable = (reason = 'off') => {
    generation++; enabled = false; lastReason = reason;
    clearInterval(tick); clearTimeout(cap); catalogueAbort?.abort();
    if (swarm) { fold(); swarm.stop(); swarm = undefined; }
    for (const connection of connections) { try { connection.close(); } catch {} }
    for (const socket of sockets) { try { socket.close(); } catch {} }
    connections.clear(); sockets.clear(); peerObservations.clear();
    key?.fill(0); key = undefined; peerLoadsSeen = 0; lastDelivery = 'origin';
    emit();
  };
  const onFragment = (_event, detail) => {
    const peerLoads = n(swarm?.metrics().segments.peerFirstLoaded);
    if (peerLoads > peerLoadsSeen) lastDelivery = 'peer';
    else { lastDelivery = 'origin'; receivedOriginBytes += n(detail?.payload?.byteLength); }
    peerLoadsSeen = peerLoads;
    emit();
  };
  hls.on(Hls.Events.FRAG_LOADED, onFragment);

  async function setEnabled(value) {
    const requested = ++request;
    if (value !== true) { disable(); return metrics(); }
    if (stopped || lifetime.signal.aborted || signal?.aborted) throw new Error('This public player has stopped.');
    if (enabled && swarm) return metrics();
    if (enabling) {
      try { await enabling; } catch {}
      if (requested !== request) return metrics();
      return setEnabled(true);
    }
    if (typeof RTCPeerConnection !== 'function' || typeof WebSocket !== 'function' || !crypto?.subtle) throw new Error('Peer delivery is unavailable in this browser.');
    if (firstEnabledAt !== null && performance.now() - firstEnabledAt >= PUBLIC_SWARM_LIMITS.maxDurationMs) { disable('time-limit'); return metrics(); }
    firstEnabledAt ??= performance.now();
    enabled = true; lastReason = 'opted-in';
    const ownGeneration = ++generation;
    catalogueAbort = new AbortController();
    enabling = (async () => {
      try {
        plan ??= validatePublicSwarmCatalogue(await readCatalogue(AbortSignal.any([lifetime.signal, catalogueAbort.signal])), { quality, playlistUrl, origin });
        if (ownGeneration !== generation || !enabled || stopped) return metrics();
        key = generateSecretKey();
        const localKey = key;
        const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
          tags: [['d', plan.swarmId], ['relayswarm', 'redistribute', '1']],
          content: 'Receiver-local authorisation of the site-pinned licensed Deja Vu digest catalogue.' }, localKey);
        const getCommitment = async context => {
          if (!enabled || stopped || ownGeneration !== generation) return null;
          const segment = catalogueSegment(plan, context);
          if (!segment) return null;
          const fragmentKey = await digest(encoded(`${plan.swarmId}\n${new URL(segment.url).pathname}`));
          if (!enabled || stopped || ownGeneration !== generation) return null;
          const seconds = Math.floor(Date.now() / 1000);
          return finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds,
            tags: [['x', plan.swarmId], ['e', streamEvent.id]],
            content: commitmentContent({ v: 1, streamEventId: streamEvent.id, swarmId: plan.swarmId,
              key: fragmentKey, rendition: String(context.frag.level), sequence: segment.sn, discontinuity: segment.cc,
              part: null, sha256: segment.sha256, size: segment.size, expiresAt: seconds + 120 }) }, localKey);
        };
        class ObservedSocket extends WebSocket {
          constructor(url, protocols) {
            if (!PUBLIC_SWARM_RELAYS.some(allowed => new URL(allowed).href === url) || sockets.size >= PUBLIC_SWARM_RELAYS.length) throw new Error('Unexpected public signalling relay.');
            super(url, protocols);
            sockets.add(this);
            this.addEventListener('error', () => { signalErrors++; });
            this.addEventListener('close', () => { sockets.delete(this); });
          }
        }
        class ObservedConnection extends RTCPeerConnection {
          constructor(config) {
            if (connections.size >= PUBLIC_SWARM_LIMITS.maxPeers + 2) throw new Error('Public peer connection limit reached.');
            super(config);
            connections.add(this);
            peerObservations.set(this, { id: `peer-${nextPeer++}`, sentBytes: null, receivedBytes: null, kind: null, trafficBasis: null, observedAtMs: null });
            this.addEventListener('datachannel', event => observeChannel(event.channel));
            this.addEventListener('connectionstatechange', () => { if (this.connectionState === 'closed') { connections.delete(this); peerObservations.delete(this); } });
          }
          createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel); return channel; }
          close() { super.close(); connections.delete(this); peerObservations.delete(this); }
        }
        cycleUploadLimit = Math.max(0, PUBLIC_SWARM_LIMITS.maxUploadBytesPerSession - uploadChargedBytes);
        swarm = createHlsSwarm({ mode: 'peer-first', swarmId: plan.swarmId, relays: [...PUBLIC_SWARM_RELAYS],
          streamEvent, getCommitment, serve: true, serveOnCellular: false,
          iceServers: PUBLIC_SWARM_ICE.map(entry => ({ ...entry })), iceTransportPolicy: 'all',
          WebSocketImpl: ObservedSocket, RTCPeerConnectionImpl: ObservedConnection,
          maxPeers: PUBLIC_SWARM_LIMITS.maxPeers, maxUploadPeers: PUBLIC_SWARM_LIMITS.maxUploadPeers,
          maxUploadBytesPerSecond: PUBLIC_SWARM_LIMITS.maxUploadBytesPerSecond,
          maxUploadBytesPerSession: cycleUploadLimit,
          maxHeldBytes: PUBLIC_SWARM_LIMITS.maxHeldBytes, maxHeldSegments: PUBLIC_SWARM_LIMITS.maxHeldSegments,
          maxSegmentBytes: PUBLIC_SWARM_LIMITS.maxSegmentBytes, maxDialsInFlight: 2, maxConcurrentRaces: 4,
          originFallbackMs: 1200, originReserveMs: 2000, maxPeerWaitMs: 2500, lateWindowMs: 4000,
          dialTimeoutMs: 8000, presenceIntervalMs: 15000, metricsIntervalMs: 750,
        });
        swarm.attach(hls);
        if (swarm.metrics().mode === 'off') throw new Error('Peer delivery could not start with this browser configuration.');
        tick = setInterval(() => { emit(); void observeTraffic(); }, 750);
        cap = setTimeout(() => disable('time-limit'), Math.max(0, PUBLIC_SWARM_LIMITS.maxDurationMs - (performance.now() - firstEnabledAt)));
        emit();
        return metrics();
      } catch (error) {
        if (ownGeneration === generation) disable('unavailable');
        throw error;
      }
    })();
    const pending = enabling;
    emit();
    try { return await pending; }
    finally { if (enabling === pending) enabling = null; }
  }

  const ended = () => disable('ended');
  const stop = () => {
    if (stopped) return;
    stopped = true; lifetime.abort(); disable('stopped');
    signal?.removeEventListener('abort', stop);
    video.removeEventListener('ended', ended);
    globalThis.removeEventListener?.('pagehide', stop);
    hls.off(Hls.Events.FRAG_LOADED, onFragment);
  };
  signal?.addEventListener('abort', stop, { once: true });
  video.addEventListener('ended', ended);
  globalThis.addEventListener?.('pagehide', stop);
  if (signal?.aborted) stop();
  emit();
  return { setEnabled, metrics, stop };
}
