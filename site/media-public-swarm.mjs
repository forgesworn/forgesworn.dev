// One visible player per visitor. Peer networking begins only at setEnabled(true).
// The immutable HTTPS catalogue, pinned below, supplies the expected media hash.
// A receiver's ephemeral key wraps that digest for the existing live-commitment
// verifier; this is local attestation, not a live broadcaster signing service.
import { createHlsSwarm, commitmentContent, commitmentPieceSize, segmentMediaContext, KIND_SEGMENT_COMMITMENT, finalizeEvent,
  generateSecretKey, relayswarmBuild } from './vendor/media-peer-demo.js?v=20261025-warm-ahead';
import { observeOriginLoader } from './media-transfer-stats.mjs?v=20261025-warm-ahead';
import { createPublicTurnCredentials } from './media-turn-credentials.mjs?v=20261025-warm-ahead';
import { parseRecordedManifest, createRecordedLive } from './media-recorded-live.mjs?v=20261025-warm-ahead';
export { createRecordedLive };

export const PUBLIC_SWARM_LIMITS = Object.freeze({
  maxPeers: 3,
  maxUploadPeers: 2,
  maxUploadBytesPerSecond: 4 * 1024 * 1024,
  maxHeldBytes: 64 * 1024 * 1024,
  maxHeldSegments: 12,
  maxSegmentBytes: 16 * 1024 * 1024,
  maxCatalogueBytes: 1024 * 1024,
});
export const PUBLIC_SWARM_CATALOGUE_SHA256 = '2b4da6df26ff5e503282e999f7066fa8b61fafdfd3f42051184dde874260a5af';
export const PUBLIC_SWARM_RELAYS = Object.freeze(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
export const PUBLIC_SWARM_ICE = Object.freeze([{ urls: 'stun:stun.cloudflare.com:3478' }]);
const SOURCE_SHA256 = '76d90719a756c77d1008088c58ca6b28a74eb0ef01e5337906cfb68d3e2b13aa';
export { SOURCE_SHA256 as PUBLIC_SWARM_SOURCE_SHA256 };
const FULL_PLAYLIST = '/media/dejavu-4k/index.m3u8';
const FULL_MEDIA_BASE = 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/';
const FULL_TAIL_PATH = 'segment-0133-audioend-v2.m4s';
const PREVIEW_PLAYLIST = '/media/dejavu-preview/rtmp/index.m3u8';
const HEX = /^[a-f0-9]{64}$/;
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const RELAY_PROTOCOLS = new Set(['udp', 'tcp', 'tls']);
const RECORDED_MANIFESTS = Object.freeze({
  full: Object.freeze({ sha256: 'ad78fc006bc131da3dcbf10656d4b8023e3fde71cbe5dba7a39a1f3af7ae238c',
    durationUs: 267_320_000, init: FULL_MEDIA_BASE + 'init.mp4' }),
  preview: Object.freeze({ sha256: '3dcafff28b09ace0ce218d242eef4681e4c0f69f0bd222aa797eddda3f2ea5a5',
    durationUs: 29_960_000, init: '/media/dejavu-preview/rtmp/init.mp4' }),
});
const preparedRecordings = new WeakSet(), recordingMetadata = new WeakMap(), recordedSources = new Map();
const MAX_RECORDED_MANIFEST_BYTES = 65_536;
const n = value => Number.isFinite(value) && value >= 0 ? value : 0;
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
const encoded = value => new TextEncoder().encode(value);

export function validatePublicSwarmCatalogue(catalogue, { quality, playlistUrl, origin }) {
  const expectedPath = quality === 'full' ? FULL_PLAYLIST : quality === 'preview' ? PREVIEW_PLAYLIST : null;
  if (!expectedPath || catalogue?.schema !== 3 || catalogue.sourceSha256 !== SOURCE_SHA256 || catalogue.licensed !== true) throw new Error('Unrecognised public media catalogue.');
  const expected = new URL(expectedPath, origin);
  const playlist = new URL(playlistUrl, origin);
  const descriptor = catalogue.qualities?.[quality];
  const expectedSwarm = quality === 'full' ? 'forgesworn-dejavu-4k-pieces-v3-76d90719a756c77d' : 'forgesworn-dejavu-1080-pieces-v2-76d90719a756c77d';
  const mediaPlaylist = quality === 'full' ? FULL_PLAYLIST : '/media/dejavu-preview/rtmp/stream.m3u8';
  const mediaBase = quality === 'full' ? FULL_MEDIA_BASE : '/media/dejavu-preview/rtmp/';
  const count = quality === 'full' ? 134 : 30;
  if (playlist.href !== expected.href || descriptor?.playlist !== expectedPath || descriptor.swarmId !== expectedSwarm ||
      descriptor.mediaPlaylist !== mediaPlaylist || descriptor.mediaBase !== mediaBase ||
      !Array.isArray(descriptor.segments) || descriptor.segments.length !== count) throw new Error('The public media identity does not match its catalogue.');
  const segments = new Map();
  for (let index = 0; index < descriptor.segments.length; index++) {
    const entry = descriptor.segments[index];
    const path = quality === 'full' ? index === 133 ? FULL_TAIL_PATH : `segment-${String(index).padStart(4, '0')}.m4s` : `segment-${String(index).padStart(3, '0')}.mp4`;
    if (entry?.path !== path || entry.sn !== index || entry.cc !== 0 || !HEX.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > PUBLIC_SWARM_LIMITS.maxSegmentBytes ||
        entry.pieceSize !== commitmentPieceSize(entry.size) || !Array.isArray(entry.pieces) ||
        entry.pieces.length !== Math.ceil(entry.size / entry.pieceSize) || entry.pieces.some(hash => !HEX.test(hash))) throw new Error('Invalid public segment identity.');
    const url = new URL(path, new URL(mediaBase, origin));
    segments.set(url.href, { ...entry, url: url.href });
  }
  return { playlist: playlist.href, mediaPlaylist: new URL(mediaPlaylist, origin).href, swarmId: descriptor.swarmId, segments };
}

// Schema 3 binds the real media playlist, exact object and each small piece.
// Peer claims cannot choose the expected whole-object or piece hashes.
export function catalogueSegment(plan, context) {
  const frag = context?.frag;
  if (!frag || !Number.isSafeInteger(frag.sn) || frag.sn < 0 || !Number.isSafeInteger(frag.level) || frag.level < 0 ||
      context.part || context.rangeStart !== undefined && context.rangeStart !== 0 || context.rangeEnd ||
      frag.type && frag.type !== 'main' || frag.decryptdata?.method && frag.decryptdata.method !== 'NONE') return null;
  let url;
  try { url = new URL(context.url || frag.url, plan.playlist); } catch { return null; }
  try { if (new URL(frag.baseurl || frag.base?.url).href !== plan.mediaPlaylist) return null; } catch { return null; }
  const segment = plan.segments.get(url.href);
  return segment && frag.sn === segment.sn && (frag.cc ?? 0) === segment.cc ? segment : null;
}

async function readCatalogue(signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(new URL('./media/dejavu-swarm/catalogue-v3.json', import.meta.url),
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

async function readRecordedManifest(url, signal) {
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 5000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    // This canonical playlist URL can acquire a newly reviewed immutable tail.
    // Refresh it once before trusting the pinned digest; successful metadata is
    // reused in memory without another request for the rest of this page.
    const response = await fetch(url, { signal: requestSignal, credentials: 'same-origin', cache: 'reload', redirect: 'error' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RECORDED_MANIFEST_BYTES) {
      await response.body?.cancel().catch(() => {}); return null;
    }
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RECORDED_MANIFEST_BYTES) return null;
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (requestSignal.aborted) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { clearTimeout(timer); }
}

/** Metadata-only opt-in, called after Play. No media body or peer is prefetched.
 * The controller owns epoch authority and uses this module's createRecordedLive
 * re-export so the helper's private recording brand stays in one instance. */
export async function prepareRecordedSource({ quality, playlistUrl, signal } = {}) {
  try {
    if (signal?.aborted || !['full', 'preview'].includes(quality) || !globalThis.location?.href) return null;
    const origin = globalThis.location.href;
    const expected = new URL(quality === 'full' ? FULL_PLAYLIST : PREVIEW_PLAYLIST, origin);
    if (new URL(playlistUrl, origin).href !== expected.href) return null;
    const cacheKey = `${quality}\n${expected.href}`;
    if (recordedSources.has(cacheKey)) return recordedSources.get(cacheKey);
    const plan = validatePublicSwarmCatalogue(await readCatalogue(signal), { quality, playlistUrl, origin });
    if (signal?.aborted) return null;
    const descriptor = RECORDED_MANIFESTS[quality], initUrl = new URL(descriptor.init, origin).href;
    const text = await readRecordedManifest(plan.mediaPlaylist, signal);
    if (text === null || signal?.aborted) return null;
    const sourceUrls = [...plan.segments.keys()];
    const recording = await parseRecordedManifest({ text, playlistUrl: plan.mediaPlaylist, expectedSha256: descriptor.sha256,
      allowedUrls: [...sourceUrls, initUrl], signal });
    if (!recording || signal?.aborted || recording.initUrl !== initUrl || recording.durationUs !== descriptor.durationUs || recording.segments.length !== plan.segments.size ||
        recording.segments.some((segment, index) => segment.url !== sourceUrls[index])) return null;
    preparedRecordings.add(recording);
    recordingMetadata.set(recording, { quality, plan });
    if (recordedSources.size >= 2) recordedSources.delete(recordedSources.keys().next().value);
    recordedSources.set(cacheKey, recording);
    return recording;
  } catch { return null; }
}

function recordedCatalogueSegment(recording, plan, context) {
  const frag = context?.frag;
  if (!frag || !Number.isSafeInteger(frag.sn) || frag.sn < 0 || !Number.isSafeInteger(frag.cc) || frag.cc < 0 ||
      frag.level !== 0 || frag.type !== 'main' || context.part ||
      context.rangeStart !== undefined && context.rangeStart !== 0 || context.rangeEnd ||
      frag.byteRangeStartOffset !== undefined && frag.byteRangeStartOffset !== 0 || frag.byteRangeEndOffset ||
      frag.decryptdata?.method && frag.decryptdata.method !== 'NONE' || !Number.isFinite(frag.duration)) return null;
  const canonical = recording.segments[frag.sn % recording.segments.length];
  if (frag.cc !== Math.floor(frag.sn / recording.segments.length) || Math.round(frag.duration * 1_000_000) !== canonical.durationUs) return null;
  try {
    const url = new URL(context.url || frag.url, plan.playlist).href;
    if (url !== canonical.url || frag.url && new URL(frag.url, plan.playlist).href !== url ||
        new URL(frag.baseurl || frag.base?.url).href !== plan.mediaPlaylist) return null;
    return plan.segments.get(url) ?? null;
  } catch { return null; }
}

/** Add opt-in peer delivery to an existing, visible hls.js instance.
 * Neither construction nor origin-only playback opens a socket or peer.
 * Active playback has no elapsed-time or cumulative-upload cutoff; upload
 * rate, peer count and cache remain bounded until this adapter is stopped.
 * setEnabled(false) restores the normal HTTP loader without replacing the
 * video, seeking, muting, or destroying its current MediaSource. */
export function createPublicSwarm({ Hls, hls, video, playlistUrl, quality, signal, onStats = () => {}, recordedLive, turnConfiguration },
  { createSwarm = createHlsSwarm, createTurnCredentials = createPublicTurnCredentials } = {}) {
  if (!Hls || !hls?.config || !video) throw new Error('An existing video and HLS player are required.');
  const origin = globalThis.location?.href;
  if (!origin) throw new Error('The public swarm needs a browser.');
  const expected = new URL(quality === 'full' ? FULL_PLAYLIST : quality === 'preview' ? PREVIEW_PLAYLIST : '/invalid', origin);
  if (!['full', 'preview'].includes(quality) || new URL(playlistUrl, origin).href !== expected.href) throw new Error('Unrecognised public film source.');
  const prepared = recordedLive && recordingMetadata.get(recordedLive.recording);
  if (recordedLive !== undefined && (!recordedLive || typeof recordedLive !== 'object' ||
      !preparedRecordings.has(recordedLive.recording) || !prepared || prepared.quality !== quality ||
      prepared.plan.playlist !== expected.href || typeof recordedLive.epochId !== 'string' || !HEX.test(recordedLive.epochId) ||
      Object.keys(recordedLive).some(key => !['recording', 'epochId'].includes(key)))) throw new Error('Unrecognised recorded timeline.');
  // Freeze this adapter's authority. A new room epoch requires a new adapter;
  // mutating the caller's options cannot retarget an already active cohort.
  const recording = recordedLive?.recording, epochId = recordedLive?.epochId;
  const lifetime = new AbortController();
  const sockets = new Set(), connections = new Set(), peerObservations = new Map();
  const totals = { peerBytes: 0, uploadedBytes: 0, verifiedPeerSegments: 0, integrityRejected: 0, originFallbacks: 0 };
  const observedChannels = new WeakSet();
  let stopped = false, enabled = false, enabling = null, generation = 0, swarm, key, plan, tick, catalogueAbort;
  let lastDelivery = null, lastReason = 'off', receivedOriginBytes = 0, loadedMediaBytes = 0, lastPeerBytes = 0;
  let highWaterBytes = 0, signalErrors = 0, lastSnapshot = null, nextPeer = 1, observing = false, request = 0;
  let sentMediaBytes = 0, noLocalRoutes = 0;
  const { endpoint = null, turnUrl = null } = turnConfiguration ?? {};
  const turn = createTurnCredentials({ endpoint: typeof endpoint === 'string' ? endpoint : null,
    turnUrl: typeof turnUrl === 'string' ? turnUrl : null });
  const connectionLeases = new Map();

  const metrics = () => {
    const live = swarm?.metrics();
    const acceptedDetails = (swarm?.peerConnectionDetails?.() ?? []).filter(({ connection }) => connection.connectionState === 'connected');
    const acceptedConnections = acceptedDetails.map(({ connection }) => connection);
    const identities = new Map(acceptedDetails.map(({ connection, pubkey }) => [connection, pubkey]));
    const connectedPeers = acceptedConnections.length;
    const peerBytes = totals.peerBytes + n(live?.bytes.peerFirst);
    highWaterBytes = Math.max(highWaterBytes, n(live?.bytes.held));
    return { enabled, phase: stopped ? 'stopped' : !enabled ? 'origin' : enabling && !swarm ? 'connecting' :
      connectedPeers > 0 && ['peer', 'mixed'].includes(lastDelivery) ? 'peer' : connectedPeers > 0 ? 'connected' : 'waiting',
      library: relayswarmBuild,
      lastDelivery, reason: lastReason, connectedPeers, serving: live?.serving === true,
      viewerId: live?.pubkey ?? null,
      peerBytes, originBytes: Math.max(0, loadedMediaBytes - peerBytes), loadedMediaBytes,
      originTransferredBytes: receivedOriginBytes,
      uploadedBytes: sentMediaBytes,
      acceptedUploadBytes: totals.uploadedBytes + n(live?.bytes.uploaded),
      verifiedPeerSegments: totals.verifiedPeerSegments + n(live?.segments.peerFirstLoaded),
      originFallbacks: totals.originFallbacks + n(live?.segments.originFallbacks),
      integrityRejected: totals.integrityRejected + n(live?.segments.peerCorrupt) + n(live?.segments.commitmentRejected),
      peerShare: loadedMediaBytes > 0 ? Math.min(1, peerBytes / loadedMediaBytes) : 0,
      core: live?.core ? { state: live.core.state, decided: live.core.decided, multiHolder: live.core.multiHolder,
        transferWorker: live.core.transferWorker } : null,
      warmAhead: live?.warmAhead ?? null,
      uploadPacing: live?.uploadPacing ?? null,
      peerAdmission: live?.peerAdmission ?? null,
      resources: { activePeerConnections: [...connections].filter(connection => connection.connectionState !== 'closed').length,
        signallingConnections: [...sockets].filter(socket => socket.readyState < 2).length,
        heldBytes: n(live?.bytes.held), heldHighWaterBytes: highWaterBytes },
      diagnostics: { signalErrors, noLocalRoutes, turn: turn.snapshot(), dialling: n(live?.peers.dialling), dialsStarted: n(live?.peers.dialsStarted),
        disabledReason: live?.disabledReason ?? null, commitmentUnavailable: n(live?.segments.commitmentUnavailable),
        signallingConnected: n(live?.relays.connected), signallingPublished: n(live?.relays.published),
        signallingPublishErrors: n(live?.relays.publishErrors), relayRejected: n(live?.relays.rejected),
        eligibility: live?.peerEligibilityDiagnostics?.counters, requests: live?.peerRequestDiagnostics?.counters,
        uploadRefusals: live?.uploadRefusalDiagnostics?.counters,
        zeroBudgetPeerRaces: n(live?.segments.zeroBudgetPeerRaces), zeroBudgetPeerRaceWins: n(live?.segments.zeroBudgetPeerRaceWins) },
      topology: { connections: acceptedConnections.filter(connection => peerObservations.has(connection)).map(connection => {
        const observation = peerObservations.get(connection);
        return { id: observation.id, peerId: identities.get(connection), state: connection.connectionState, iceState: connection.iceConnectionState,
          bytesSent: observation.sentBytes, bytesReceived: observation.receivedBytes, kind: observation.kind, trafficBasis: observation.trafficBasis,
          localCandidateType: observation.localCandidateType, remoteCandidateType: observation.remoteCandidateType,
          localRelayProtocol: observation.localRelayProtocol, remoteRelayProtocol: observation.remoteRelayProtocol,
          mediaBytesSent: observation.mediaBytesSent, verifiedMediaBytesReceived: observation.verifiedMediaBytesReceived,
          observedAtMs: observation.observedAtMs };
      }) },
      uploadAllowanceRemaining: null,
      limits: PUBLIC_SWARM_LIMITS,
      trust: 'site-pinned HTTPS digest catalogue; fresh receiver-local commitment',
      signalling: 'public Nostr relays; encrypted peer signals',
      topologyLabel: 'one visible player per visitor',
    };
  };
  const emit = () => { lastSnapshot = metrics(); try { onStats(lastSnapshot); } catch {} return lastSnapshot; };
  const observeChannel = (channel, connection) => {
    if (observedChannels.has(channel)) return;
    observedChannels.add(channel);
    connectionLeases.get(connection)?.channels.add(channel);
    const send = channel.send;
    channel.send = function (data) {
      const result = send.call(this, data);
      // RelaySwarm uses text for protocol messages and binary chunks for media.
      // Count only binary bytes successfully submitted to the native channel.
      // Remote verification is reported by the receiving visitor separately.
      if (this === channel && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
        sentMediaBytes += data.byteLength;
        const observation = peerObservations.get(connection);
        if (observation) observation.mediaBytesSent += data.byteLength;
      }
      return result;
    };
  };
  const originalFragmentLoader = hls.config.fLoader;
  const OriginLoader = observeOriginLoader(originalFragmentLoader || hls.config.loader, bytes => {
    receivedOriginBytes += bytes;
  });
  hls.config.fLoader = OriginLoader;
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
          localCandidateType: CANDIDATE_TYPES.has(local?.candidateType) ? local.candidateType : null,
          remoteCandidateType: CANDIDATE_TYPES.has(remote?.candidateType) ? remote.candidateType : null,
          localRelayProtocol: RELAY_PROTOCOLS.has(local?.relayProtocol) ? local.relayProtocol : null,
          remoteRelayProtocol: RELAY_PROTOCOLS.has(remote?.relayProtocol) ? remote.relayProtocol : null,
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
  };
  const disable = (reason = 'off') => {
    generation++; enabled = false; lastReason = reason;
    clearInterval(tick); catalogueAbort?.abort(); turn.stop();
    for (const record of connectionLeases.values()) clearTimeout(record.timer);
    connectionLeases.clear();
    if (swarm) { fold(); swarm.stop(); swarm = undefined; }
    for (const connection of connections) { try { connection.close(); } catch {} }
    for (const socket of sockets) { try { socket.close(); } catch {} }
    connections.clear(); sockets.clear(); peerObservations.clear();
    key?.fill(0); key = undefined;
    emit();
  };
  const onFragment = (_event, detail) => {
    const size = n(detail?.frag?.stats?.loaded) || n(detail?.payload?.byteLength);
    loadedMediaBytes += size;
    const peerBytes = totals.peerBytes + n(swarm?.metrics().bytes.peerFirst);
    const peerDelta = Math.max(0, peerBytes - lastPeerBytes);
    lastDelivery = peerDelta > 0 ? peerDelta < size ? 'mixed' : 'peer' : 'origin';
    lastPeerBytes = peerBytes;
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
    enabled = true; lastReason = 'opted-in';
    const ownGeneration = ++generation;
    catalogueAbort = new AbortController();
    enabling = (async () => {
      try {
        await Promise.all([
          (async () => {
            if (recording) {
              plan ??= { ...prepared.plan, swarmId: 'forgesworn-recorded-live-v2-' +
                await digest(encoded(`forgesworn-recorded-live-v2\n${SOURCE_SHA256}\n${quality}\n${epochId}\n${recording.manifestSha256}\n${recording.durationUs}`)) };
            } else plan ??= validatePublicSwarmCatalogue(await readCatalogue(AbortSignal.any([lifetime.signal, catalogueAbort.signal])), { quality, playlistUrl, origin });
          })(),
          turn.start(),
        ]);
        if (ownGeneration !== generation || !enabled || stopped) return metrics();
        key = generateSecretKey();
        const localKey = key;
        const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
          tags: [['d', plan.swarmId], ['relayswarm', 'redistribute', '1']],
          content: 'Receiver-local authorisation of the site-pinned licensed Deja Vu digest catalogue.' }, localKey);
        const getCommitment = async context => {
          if (!enabled || stopped || ownGeneration !== generation) return null;
          const segment = recording ? recordedCatalogueSegment(recording, plan, context) : catalogueSegment(plan, context);
          if (!segment) return null;
          // HLS may reuse its mutable fragment while the key digest yields.
          // Capture the validated identity before signing that immutable object.
          const mediaContext = segmentMediaContext(context);
          const sequence = recording ? context.frag.sn : segment.sn;
          const discontinuity = recording ? context.frag.cc : segment.cc;
          const fragmentKey = await digest(encoded(`${plan.swarmId}\n${new URL(segment.url).pathname}`));
          if (!enabled || stopped || ownGeneration !== generation) return null;
          const seconds = Math.floor(Date.now() / 1000);
          return finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds,
            tags: [['x', plan.swarmId], ['e', streamEvent.id]],
            content: commitmentContent({ v: 3, streamEventId: streamEvent.id, swarmId: plan.swarmId,
              key: fragmentKey, ...mediaContext, rendition: new URL(plan.mediaPlaylist).pathname,
              sequence, discontinuity,
              part: null, sha256: segment.sha256, size: segment.size,
              pieceSize: segment.pieceSize, pieces: segment.pieces, expiresAt: seconds + 120 }) }, localKey);
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
            super({ ...config, iceServers: [...PUBLIC_SWARM_ICE.map(entry => ({ ...entry })), ...turn.servers()] });
            connections.add(this);
            const record = { identity: turn.leaseIdentity(), channels: new Set(), timer: null };
            connectionLeases.set(this, record);
            const renew = () => {
              if (!enabled || stopped || this.connectionState === 'closed' || !record.identity) return;
              const current = turn.leaseIdentity();
              if (current && current !== record.identity && peerObservations.get(this)?.kind === 'relay') {
                // Retire just this expiring transport. The SDK reconnects with
                // the latest lease; the playing HLS instance and cache survive.
                for (const channel of record.channels) { try { channel.close(); } catch {} }
                return;
              }
              record.timer = setTimeout(renew, 15000);
            };
            if (record.identity) record.timer = setTimeout(renew, Math.max(1000, turn.snapshot().remainingMs - 60000 + connections.size * 1000));
            let candidates = 0, complete = false;
            this.addEventListener('icecandidate', event => {
              if (event.candidate) candidates++;
              else if (!complete) {
                complete = true;
                if (!candidates) { noLocalRoutes++; emit(); }
              }
            });
            peerObservations.set(this, { id: `peer-${nextPeer++}`, sentBytes: null, receivedBytes: null, mediaBytesSent: 0,
              verifiedMediaBytesReceived: 0, kind: null, trafficBasis: null, observedAtMs: null,
              localCandidateType: null, remoteCandidateType: null, localRelayProtocol: null, remoteRelayProtocol: null });
            this.addEventListener('datachannel', event => observeChannel(event.channel, this));
            this.addEventListener('connectionstatechange', () => {
              if (this.connectionState === 'closed') {
                clearTimeout(connectionLeases.get(this)?.timer); connectionLeases.delete(this);
                connections.delete(this); peerObservations.delete(this);
              }
            });
          }
          createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel, this); return channel; }
          close() {
            clearTimeout(connectionLeases.get(this)?.timer); connectionLeases.delete(this);
            super.close(); connections.delete(this); peerObservations.delete(this);
          }
        }
        swarm = createSwarm({ mode: 'peer-first', swarmId: plan.swarmId, relays: [...PUBLIC_SWARM_RELAYS],
          streamEvent, getCommitment, serve: true, serveOnCellular: false,
          coreWasm: new URL('./vendor/relayswarm-core.wasm?v=20261025-warm-ahead', import.meta.url), multiHolder: true,
          transferWorkerUrl: new URL('./vendor/relayswarm-transfer-worker.js?v=20261025-warm-ahead', import.meta.url),
          zeroBudgetPeerRace: true, lateHaveRace: true, sustainablePeerWait: true,
          warmAhead: quality === 'full',
          uploadPacing: quality === 'full',
          maxHoldersPerObject: PUBLIC_SWARM_LIMITS.maxPeers,
          iceServers: PUBLIC_SWARM_ICE.map(entry => ({ ...entry })), iceTransportPolicy: 'all',
          WebSocketImpl: ObservedSocket, RTCPeerConnectionImpl: ObservedConnection,
          onPeerDelivery({ connection, bytes }) {
            if (!enabled || stopped || ownGeneration !== generation) return;
            const observation = peerObservations.get(connection);
            if (observation) observation.verifiedMediaBytesReceived += n(bytes);
          },
          maxPeers: PUBLIC_SWARM_LIMITS.maxPeers, maxUploadPeers: PUBLIC_SWARM_LIMITS.maxUploadPeers,
          maxUploadBytesPerSecond: PUBLIC_SWARM_LIMITS.maxUploadBytesPerSecond,
          maxHeldBytes: PUBLIC_SWARM_LIMITS.maxHeldBytes, maxHeldSegments: PUBLIC_SWARM_LIMITS.maxHeldSegments,
          maxSegmentBytes: PUBLIC_SWARM_LIMITS.maxSegmentBytes, maxDialsInFlight: 2, maxConcurrentRaces: 4,
          originFallbackMs: 1200, originReserveMs: 2000, maxPeerWaitMs: 2500, lateWindowMs: 4000,
          dialTimeoutMs: 8000, presenceIntervalMs: 15000, metricsIntervalMs: 750,
        });
        swarm.attach(hls);
        if (swarm.metrics().mode === 'off') throw new Error('Peer delivery could not start with this browser configuration.');
        tick = setInterval(() => { emit(); void observeTraffic(); }, 750);
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

  // The player owns pause/end policy. A shared recording can wrap without
  // closing healthy connections, discarding its cache or changing identity.
  const stop = () => {
    if (stopped) return;
    stopped = true; lifetime.abort(); disable('stopped');
    if (hls.config.fLoader === OriginLoader) hls.config.fLoader = originalFragmentLoader;
    signal?.removeEventListener('abort', stop);
    globalThis.removeEventListener?.('pagehide', stop);
    hls.off(Hls.Events.FRAG_LOADED, onFragment);
  };
  signal?.addEventListener('abort', stop, { once: true });
  globalThis.addEventListener?.('pagehide', stop);
  if (signal?.aborted) stop();
  emit();
  return { setEnabled, metrics, stop };
}
