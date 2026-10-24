import { readInitialLiveStart } from './media-live-start.mjs';
import { transferBytes } from './media-transfer-stats.mjs';
import { createNativePlaybackFallback } from './media-playback-fallback.mjs';

const DASH = '—';
export const observed = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function reading(value, suffix = '', digits = 1) {
  return observed(value) === null ? DASH : `${value.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits })}${suffix}`;
}
export const megabytes = (value) => observed(value) === null ? DASH : reading(value / 1e6, ' MB');
export function clock(value) {
  if (observed(value) === null) return DASH;
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function approvedMediaUrl(value, pageUrl, mediaOrigin = '') {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('No media URL');
  const page = new URL(pageUrl);
  const url = new URL(value, page);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Media URL not approved');
  if (url.origin === page.origin) return url;
  const origins = new Set();
  if (mediaOrigin) {
    const allowed = new URL(mediaOrigin);
    if (allowed.protocol !== 'https:' || allowed.pathname !== '/' || allowed.search || allowed.hash || allowed.username || allowed.password) throw new Error('Expected one HTTPS media origin');
    origins.add(allowed.origin);
  }
  if (!origins.has(url.origin)) throw new Error('Media origin not approved');
  return url;
}
export function invitedPlaybackStart(search, now, duration, quality) {
  const query = new URLSearchParams(search);
  if (query.get('q') !== quality || !['full', 'preview'].includes(quality) || !query.has('t') || !query.has('at')) return 0;
  const position = Number(query.get('t')), created = Number(query.get('at'));
  if (![position, created, now, duration].every(Number.isFinite) || position < 0 || position >= duration ||
      created < now - 15 * 60 * 1000 || created > now + 5000) return 0;
  const joined = position + Math.max(0, now - created) / 1000;
  return joined < duration - 2 ? joined : 0;
}
// The shared recording repeats: compare the nearest positions across its end
// instead of treating the next loop as an entire recording of drift.
export function sharedPositionDifference(current, target, duration) {
  if (![current, target, duration].every(Number.isFinite) || duration <= 0) return null;
  return ((target - current + duration / 2) % duration + duration) % duration - duration / 2;
}
// A wall clock advances while a decoder buffers. Repeatedly seeking to catch
// it can keep a slower player buffering indefinitely, especially on iPhone.
export function createSharedPlaybackSync(video, { now = () => performance.now(), signal, onSeek = () => {} } = {}) {
  let stableAt = null, driftAt = null, driftDirection = 0, lastSeekAt = -Infinity, nextCheckAt = 0, pendingAlignment = false;
  const reset = () => { stableAt = null; driftAt = null; driftDirection = 0; };
  for (const event of ['waiting', 'stalled', 'seeking', 'pause', 'emptied']) video.addEventListener(event, reset, { signal });
  return {
    align(target, duration, force = false) {
      const difference = sharedPositionDifference(video.currentTime, target, duration);
      const result = { difference, corrected: false };
      if (difference === null) return result;
      pendingAlignment ||= force;
      force = pendingAlignment;
      const at = now();
      if (!force && at < nextCheckAt) return result;
      nextCheckAt = at + 800;
      if (video.seeking) { reset(); return result; }
      // Coalesce explicit requests made during an existing seek. The next
      // check uses the latest room position rather than a stale saved target.
      pendingAlignment = false;
      if (!force) {
        if (video.paused || video.ended || video.readyState < 3) { reset(); return result; }
        // Both positions must share a continuous buffer with two seconds to
        // spare, avoiding a jump into missing media or the edge of the buffer.
        const start = Math.min(video.currentTime, target), end = Math.max(video.currentTime, target) + 2;
        let buffered = false;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= start && video.buffered.end(i) >= end) { buffered = true; break; }
        }
        if (!buffered) { reset(); return result; }
        stableAt ??= at;
        if (Math.abs(difference) <= 0.75) { driftAt = null; driftDirection = 0; return result; }
        const direction = Math.sign(difference);
        if (direction !== driftDirection) { driftAt = at; driftDirection = direction; }
        if (at - stableAt < 5000 || at - driftAt < 3000 || at - lastSeekAt < 15000) return result;
      } else if (Math.abs(difference) < 0.1 && !video.ended) return result;
      reset();
      lastSeekAt = at;
      onSeek(at);
      video.currentTime = Math.max(0, Math.min(target, video.duration - 0.05));
      result.corrected = true;
      return result;
    },
  };
}

// hls.js 1.7.3 handles holes between ranges, but can leave a decoder frozen
// inside one continuous range after late media arrives. Use the existing
// observation timer for a small, bounded recovery entirely inside that range.
export function createBufferedPlaybackRecovery(video, { now = () => performance.now(), onSeek = () => {} } = {}) {
  let lastTime = null, movedAt = 0, bufferedAt = null, lastRecovery = -Infinity, attempts = 0;
  let healthyAt = null, healthyTime = 0, healthyFrames = null;
  return {
    check(presentedFrames = null) {
      const at = now(), time = video.currentTime;
      if (!Number.isFinite(time)) return false;
      if (lastTime === null || time > lastTime + 0.01 || time < lastTime - 0.25 || video.paused || video.ended) {
        if (lastTime !== null && time < lastTime - 0.25) healthyAt = null;
        lastTime = time; movedAt = at; bufferedAt = null;
      }
      if (video.paused || video.ended || video.seeking || video.error) { bufferedAt = null; healthyAt = null; return false; }
      if (video.readyState >= 3) {
        if (healthyAt === null) { healthyAt = at; healthyTime = time; healthyFrames = presentedFrames; }
        // A seek changes currentTime too. Only sustained actual playback can
        // replenish the three-attempt budget after a recovery.
        if (at - healthyAt >= 1000 && time - healthyTime >= 0.75 &&
            (presentedFrames === null || healthyFrames === null || presentedFrames - healthyFrames >= 10)) attempts = 0;
        bufferedAt = null; return false;
      }
      healthyAt = null;
      if (video.readyState !== 2) { bufferedAt = null; return false; }
      let end = null;
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= time && buffered.end(i) - time >= 1) { end = buffered.end(i); break; }
      }
      if (end === null) { bufferedAt = null; return false; }
      bufferedAt ??= at;
      if (at - movedAt < 1500 || at - bufferedAt < 750 || at - lastRecovery < 3000 || attempts >= 3) return false;
      const target = time + 0.1 * (attempts + 1);
      if (target >= end - 0.25) return false;
      onSeek(at);
      video.currentTime = target;
      lastTime = video.currentTime; movedAt = at; bufferedAt = null; lastRecovery = at; attempts++;
      return true;
    },
  };
}
const mean = (samples) => samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
const max = (samples) => samples.length ? Math.max(...samples) : null;
const human = (value, fallback = DASH) => typeof value === 'string' && value.length <= 120 && !/[\r\n\\/<>]/.test(value) ? value : fallback;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : null;

export function publicSource(source = {}) {
  const result = { label: human(source.label, 'Licensed source'), sha256: sha(source.sha256) };
  for (const key of ['bytes', 'durationSeconds', 'width', 'height', 'fps', 'bitrateBps', 'audioSampleRate']) result[key] = observed(source[key]);
  for (const key of ['videoCodec', 'audioCodec']) result[key] = human(source[key], null);
  return result;
}

function publicProfile(profile = {}) {
  const result = {};
  for (const key of ['hlsMode', 'sapflowHttpImpl', 'httpImpl', 'viewerDelivery']) result[key] = human(profile[key], null);
  for (const key of ['segmentCount', 'segmentDurationSeconds', 'partDurationSeconds', 'httpWorkers', 'endDrainSeconds', 'publisherCompletionToleranceSeconds']) result[key] = observed(profile[key]);
  for (const key of ['transcode', 'recording', 'viewerLowLatencyMode']) result[key] = typeof profile[key] === 'boolean' ? profile[key] : null;
  return result;
}

function publicHost(host = {}) {
  return {
    cpu: human(host.cpu, null), architecture: human(host.architecture, null),
    platform: human(host.platform, null), release: human(host.release, null), logicalCpus: observed(host.logicalCpus),
  };
}

const publicLoad = (load = {}) => Object.fromEntries(['oneMinute', 'fiveMinutes', 'fifteenMinutes'].map(key => [key, observed(load[key])]));

export function sourceRetiredError(error) {
  return error?.type === 'networkError' && [404, 410].includes(Number(error.response?.code ?? error.networkDetails?.status));
}

export function confirmedPublisherEnd(snapshot, id) {
  let value;
  if (['running', 'ended'].includes(snapshot?.state)) value = snapshot;
  else if (snapshot?.state === 'idle' && !snapshot.run && snapshot.lastRun?.state === 'ended') value = snapshot.lastRun;
  return Boolean(id && value && !value.error && value.run?.id === id && value.run.publisherEnded === true &&
    value.run.publisherCompletedWindow === true && value.run.publisherProgressEnded === true);
}

export function videoDimensions(browser) {
  const width = observed(browser.width), height = observed(browser.height);
  const mediaWidth = observed(browser.mediaWidth), mediaHeight = observed(browser.mediaHeight);
  if (mediaWidth > 0 && mediaHeight > 0) return `${mediaWidth.toLocaleString('en-GB')} × ${mediaHeight.toLocaleString('en-GB')} video${
    width > 0 && height > 0 && (width !== mediaWidth || height !== mediaHeight) ? ` · ${width.toLocaleString('en-GB')} × ${height.toLocaleString('en-GB')} display` : ''}`;
  return width > 0 && height > 0 ? `${width.toLocaleString('en-GB')} × ${height.toLocaleString('en-GB')} display` : 'Browser video dimensions';
}

function peerRecord(metrics) {
  if (!metrics) return null;
  return {
    phase: human(metrics.phase, null),
    peerBytes: observed(metrics.viewer?.peerBytes), originBytes: observed(metrics.viewer?.originBytes),
    verifiedPeerSegments: observed(metrics.viewer?.verifiedPeerSegments),
    originFallbacks: observed(metrics.viewer?.originFallbacks), integrityRejected: observed(metrics.viewer?.integrityRejected),
    holderUploadedBytes: observed(metrics.holder?.uploadedBytes), holderOriginBytes: observed(metrics.holder?.originBytes),
    cachePeakBytes: observed(metrics.resources?.heldHighWaterBytes), cacheBytes: observed(metrics.resources?.heldBytes),
    activePeerConnections: observed(metrics.resources?.activePeerConnections),
    requestedProtocol: human(metrics.transport?.requestedProtocol, null),
    selectedPairs: (Array.isArray(metrics.transport?.selectedPairs) ? metrics.transport.selectedPairs : []).slice(0, 8).map((pair) => ({
      localType: human(pair.localType, null), remoteType: human(pair.remoteType, null), relayProtocol: human(pair.relayProtocol, null),
      bytesSent: observed(pair.bytesSent), bytesReceived: observed(pair.bytesReceived),
    })),
  };
}

function recordedPeer(peer) {
  if (!peer || typeof peer !== 'object') return null;
  return {
    ...Object.fromEntries(['peerBytes', 'originBytes', 'verifiedPeerSegments', 'originFallbacks', 'integrityRejected', 'holderUploadedBytes', 'holderOriginBytes', 'cachePeakBytes', 'cacheBytes', 'activePeerConnections'].map((key) => [key, observed(peer[key])])),
    phase: human(peer.phase, null), requestedProtocol: human(peer.requestedProtocol, null),
    selectedPairs: (Array.isArray(peer.selectedPairs) ? peer.selectedPairs : []).slice(0, 8).map((pair) => ({
      localType: human(pair.localType, null), remoteType: human(pair.remoteType, null), relayProtocol: human(pair.relayProtocol, null),
      bytesSent: observed(pair.bytesSent), bytesReceived: observed(pair.bytesReceived),
    })),
  };
}

function processRecord(processes, samples = {}) {
  return Object.fromEntries(['origin', 'publisher', 'srtSender', 'turn'].map((name) => {
    const process = processes?.[name];
    return [name, process ? {
      cpuPercentLast: observed(process.cpuPercent), cpuMeanPercent: mean(samples[name] ?? []),
      cpuSeconds: observed(process.cpuSeconds), rssBytes: observed(process.rssBytes),
      peakSampledRssBytes: observed(process.peakSampledRssBytes), uptimeSeconds: observed(process.uptimeSeconds),
    } : null];
  }));
}

export function completedRecord(snapshot, session, config, browser) {
  if (snapshot?.state !== 'ended' || snapshot.run?.id !== session?.id || snapshot.run?.publisherCompletedWindow !== true ||
      snapshot.run?.publisherProgressEnded !== true || session.offsetSeconds !== 0 || !browser?.seenFrame ||
      !((observed(browser.decodedFrames) ?? 0) > 0) || session.interrupted || session.playbackFailed) return null;
  const engine = config.engines?.find((entry) => entry.id === session.engine);
  return {
    state: 'ended', completion: 'source-window-ended', measuredAt: new Date().toISOString(), offsetSeconds: 0,
    engine: human(session.engine), engineLabel: human(engine?.label, human(session.engine)),
    version: human(engine?.version), binarySha256: sha(engine?.binarySha256),
    transport: human(session.transport), turnEngine: human(session.turnEngine, 'off'), turnTransport: human(session.turnTransport),
    durationSeconds: observed(snapshot.run.durationSeconds) ?? observed(session.durationSeconds) ?? observed(snapshot.run.uptimeSeconds),
    publisherMediaSeconds: observed(snapshot.run.publisherMediaSeconds), publisherProgressEnded: true, publisherCompletedWindow: true,
    publisherVideoFrames: observed(snapshot.run.publisherVideoFrames), expectedVideoFrames: observed(snapshot.run.expectedVideoFrames),
    expectedProgressSeconds: observed(snapshot.run.expectedProgressSeconds), expectedProgressBasis: human(snapshot.run.expectedProgressBasis, null),
    measurementScope: 'shared-host-observation', hostLoadAtStart: publicLoad(snapshot.run.hostLoadAtStart),
    hostLoadAtEnd: publicLoad(snapshot.host?.loadAverage),
    source: publicSource(config.source), host: publicHost(config.host),
    profile: publicProfile({ ...(snapshot.run.profile ?? session.profile ?? engine?.profile ?? config.profile), viewerDelivery: 'full-segment-hls', viewerLowLatencyMode: false }),
    originCpuMeanPercent: mean(session.cpuSamples),
    originPeakSampledRssBytes: observed(snapshot.processes?.origin?.peakSampledRssBytes) ?? max(session.rssSamples),
    originCpuSeconds: observed(snapshot.processes?.origin?.cpuSeconds),
    processes: processRecord(snapshot.processes, session.processSamples), peer: recordedPeer(session.peerMetrics),
    browser: {
      firstFrameMs: observed(browser.firstFrameMs), decodedFpsMean: mean(browser.fpsSamples),
      decodedFrames: observed(browser.decodedFrames), width: observed(browser.width), height: observed(browser.height),
      mediaWidth: observed(browser.mediaWidth), mediaHeight: observed(browser.mediaHeight),
      videoTimeSeconds: observed(browser.videoTimeSeconds), playbackEndObserved: browser.playbackEndObserved === true,
      stallCount: observed(browser.stallCount), stallSeconds: observed(browser.stallSeconds),
      responseBytes: observed(browser.responseBytes), requests: observed(browser.requests),
      playerErrors: observed(browser.playerErrors), httpErrors: observed(browser.httpErrors),
    },
    http: {
      requests: observed(snapshot.http?.requests), completed: observed(snapshot.http?.completed),
      originRequests: observed(snapshot.http?.originRequests), redirectsFollowed: observed(snapshot.http?.redirectsFollowed),
      errors: observed(snapshot.http?.errors), bytes: observed(snapshot.http?.bytes),
    },
  };
}

// Published receipts use this deliberately small schema, never a raw API response.
export function recordedRuns(receipt) {
  if (receipt?.schema !== 1 || !Array.isArray(receipt.runs)) return [];
  return receipt.runs.slice(0, 100).filter((run) => run?.state === 'ended' && run.offsetSeconds === 0 &&
    run.publisherCompletedWindow === true && run.publisherProgressEnded === true && (observed(run.browser?.decodedFrames) ?? 0) > 0).map((run) => ({
    state: 'ended', completion: 'source-window-ended', measuredAt: human(run.measuredAt, null), offsetSeconds: 0,
    engine: human(run.engine), engineLabel: human(run.engineLabel, human(run.engine)), version: human(run.version),
    binarySha256: sha(run.binarySha256), transport: human(run.transport), turnEngine: human(run.turnEngine, 'off'), turnTransport: human(run.turnTransport),
    durationSeconds: observed(run.durationSeconds), source: publicSource(run.source ?? receipt.source), host: publicHost(run.host ?? receipt.host), profile: publicProfile(run.profile ?? receipt.profile),
    publisherMediaSeconds: observed(run.publisherMediaSeconds), publisherProgressEnded: true, publisherCompletedWindow: true,
    publisherVideoFrames: observed(run.publisherVideoFrames), expectedVideoFrames: observed(run.expectedVideoFrames),
    expectedProgressSeconds: observed(run.expectedProgressSeconds), expectedProgressBasis: human(run.expectedProgressBasis, null),
    measurementScope: 'shared-host-observation', hostLoadAtStart: publicLoad(run.hostLoadAtStart), hostLoadAtEnd: publicLoad(run.hostLoadAtEnd),
    originCpuMeanPercent: observed(run.originCpuMeanPercent), originPeakSampledRssBytes: observed(run.originPeakSampledRssBytes), originCpuSeconds: observed(run.originCpuSeconds),
    processes: Object.fromEntries(['origin', 'publisher', 'srtSender', 'turn'].map((name) => [name, run.processes?.[name] ? Object.fromEntries(['cpuPercentLast', 'cpuMeanPercent', 'cpuSeconds', 'rssBytes', 'peakSampledRssBytes', 'uptimeSeconds'].map((key) => [key, observed(run.processes[name][key])])) : null])),
    peer: recordedPeer(run.peer),
    browser: {
      ...Object.fromEntries(['firstFrameMs', 'decodedFpsMean', 'decodedFrames', 'width', 'height', 'mediaWidth', 'mediaHeight', 'videoTimeSeconds', 'stallCount', 'stallSeconds', 'responseBytes', 'requests', 'playerErrors', 'httpErrors'].map((key) => [key, observed(run.browser?.[key])])),
      playbackEndObserved: run.browser?.playbackEndObserved === true,
    },
    http: Object.fromEntries(['requests', 'originRequests', 'redirectsFollowed', 'completed', 'errors', 'bytes'].map((key) => [key, observed(run.http?.[key])])),
  }));
}

async function initialise() {
  const root = document.getElementById('main');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const text = (id, value) => { $(id).textContent = value; };
  const video = $('lab-video');
  const local = !root.hasAttribute('data-showcase') && ['127.0.0.1', 'localhost'].includes(location.hostname);
  root.dataset.mode = local ? 'local' : 'public';
  const pageAbort = new AbortController();
  const runs = [];
  const saved = new Set();
  let config = null;
  let session = null;
  let busy = false;
  let polling = null;
  let foreignRun = false;
  let Hls;
  let fullscreenReady = false;
  let detachFullscreen;
  let swarmVisual;
  let publicRoom = null, publicRoomQuality = null, publicRoomLoading = null, publicRoomRequest = 0;
  let invitationUsed = false;
  const publicPlay = $('public-play');
  if (!local) video.controls = false;
  const optionalText = (id, value) => { const node = $(id); if (node && node.textContent !== value) node.textContent = value; };

  function listenerStatus(s) {
    if (local) return;
    const state = s?.listener?.snapshot() ?? publicRoom?.snapshot() ?? s?.listenerState;
    const joined = Boolean(state?.ready && state.joined && s?.listenerWanted);
    const known = Boolean(state?.observed && state.connectedRelays > 0);
    root.dataset.roomActivity = !known ? 'unknown' : state.listeners ? 'active' : 'empty';
    root.dataset.watcherCount = known ? String(state.listeners) : '';
    root.dataset.sharedSession = !s ? 'idle' : s.listenerFailed ? 'unavailable' : !s.listenerWanted ? 'paused' : joined ? 'live' : 'joining';
    root.dataset.sharedEpoch = state?.epochId ?? '';
    root.dataset.sharedStartedAt = String(state?.startedAt ?? '');
    root.dataset.sharedPosition = String(state?.position ?? '');
    root.dataset.sharedListeners = String(state?.listeners ?? 0);
    const count = known ? `${state.listeners}${state.truncated ? '+' : ''}` : '—';
    optionalText('public-peers', count);
    optionalText('public-watchers', count);
    optionalText('public-watchers-label', !known ? 'Checking the room…' : state.listeners ? 'listening now' : 'listening · Be the first');
    optionalText('public-session-status', !s ? 'Press Play to start or join the shared stream.' :
      s.listenerFailed ? 'Shared stream unavailable · playing on your own' :
      !s.listenerWanted ? 'You left the stream · Play to rejoin live' :
      !joined ? 'Joining the shared stream…' :
      !state.connectedRelays ? 'Room connection interrupted · the music continues' :
      s.followLive === false ? 'Away from the live stream' :
      state.role === 'starter' ? 'You started the stream · live' : 'Shared stream · live');
    if ($('public-live-edge')) $('public-live-edge').hidden = !joined || s.followLive !== false;
    if (publicPlay && !busy && !s?.browser?.seenFrame) {
      const label = publicPlay.querySelector('[data-play-label]');
      if (label) label.textContent = known && !state.listeners ? 'Start the room' : 'Play & join';
    }
  }

  async function ensureListenerRoom(quality) {
    if (publicRoomQuality === quality && publicRoom) return publicRoom;
    if (publicRoomQuality === quality && publicRoomLoading) return publicRoomLoading;
    publicRoomQuality = quality;
    const request = ++publicRoomRequest;
    publicRoom?.stop(); publicRoom = null;
    const pending = (async () => {
      const [{ createListenerSession }, { PUBLIC_SWARM_SOURCE_SHA256, PUBLIC_SWARM_RELAYS }] = await Promise.all([
        import('./media-listener-session.mjs?v=20261024-buffer-continuity'), import('./media-public-swarm.mjs?v=20261024-active-sharing'),
      ]);
      if (request !== publicRoomRequest || pageAbort.signal.aborted) return null;
      const clock = createListenerSession({ room: `forgesworn-dejavu-listening-v1-${quality}`, source: PUBLIC_SWARM_SOURCE_SHA256,
        duration: choices[quality].durationSeconds, relays: [...PUBLIC_SWARM_RELAYS], signal: pageAbort.signal,
        getTelemetry() {
          const s = session;
          const metrics = s?.quality === quality && s.listenerWanted ? s.publicPeer?.metrics() : null;
          if (!metrics?.viewerId) return null;
          return { peerId: metrics.viewerId, sampledAt: Date.now(),
            positionMs: Math.min(Math.round(video.currentTime * 1000), Math.round(s.durationSeconds * 1000) - 1),
            following: s.followLive !== false, originBytes: metrics.originBytes, peerBytes: metrics.peerBytes,
            uploadedBytes: metrics.uploadedBytes,
            connections: metrics.topology.connections.slice(0, 3).map(peer => ({
              peerId: peer.peerId, sentBytes: peer.mediaBytesSent, receivedBytes: peer.verifiedMediaBytesReceived,
            })) };
        },
        onChange(state) {
          if (request !== publicRoomRequest || pageAbort.signal.aborted) return;
          const s = session?.quality === quality ? session : null;
          if (s && !s.finishing) {
            const previous = s.listenerState?.epochId;
            s.listenerState = state;
            if (previous && state.ready && state.epochId !== previous) {
              s.followLive = true;
              if (s.mediaReady) s.listenerAlignedEpoch = state.epochId;
              followListener(s, true);
            }
          }
          publicDelivery(s);
        } });
      publicRoom = clock;
      clock.observe();
      publicDelivery(session);
      return clock;
    })();
    publicRoomLoading = pending;
    try { return await pending; }
    finally { if (publicRoomLoading === pending) publicRoomLoading = null; }
  }

  function followListener(s, force = false) {
    if (local || session !== s || s.finishing || s.switchingPlayback || !s.listenerWanted || !s.listener?.snapshot().ready ||
        !s.mediaReady || video.readyState < 1 || !Number.isFinite(video.duration)) return;
    if (!force && s.followLive === false) return;
    const target = s.listener.position();
    const duration = s.durationSeconds;
    if (!Number.isFinite(target) || !(duration > 0)) return;
    const { difference } = s.playbackSync.align(target, duration, force);
    if (difference === null) return;
    root.dataset.sharedDrift = String(difference);
    optionalText('browser-sync', `${difference > 0 ? '+' : ''}${difference.toFixed(2)} s to the room clock`);
    listenerStatus(s);
  }

  async function joinListener(s, align = true) {
    if (local || session !== s || s.finishing || s.abort.signal.aborted) return;
    s.listenerWanted = true;
    if (s.listener?.snapshot().ready) {
      const epoch = s.listener.snapshot().epochId;
      if (align && s.mediaReady && s.listenerAlignedEpoch !== epoch) {
        s.listenerAlignedEpoch = epoch;
        followListener(s, true);
      }
      listenerStatus(s); return;
    }
    if (s.listenerJoining) {
      await s.listenerJoining;
      if (session === s && s.listenerWanted && !s.finishing && !s.listenerFailed && !s.listener?.snapshot().ready) return joinListener(s, align);
      return;
    }
    const request = s.listenerRequest = (s.listenerRequest ?? 0) + 1;
    s.listenerFailed = false;
    listenerStatus(s);
    const pending = (async () => {
      try {
        s.listener = await ensureListenerRoom(s.quality);
        if (!s.listener || session !== s || !s.listenerWanted || request !== s.listenerRequest || s.abort.signal.aborted) return;
        await s.listener.join();
        if (session !== s || !s.listenerWanted || request !== s.listenerRequest || s.abort.signal.aborted) {
          if (session !== s || !s.listenerWanted) s.listener.leave();
          return;
        }
        s.listenerFailed = false; s.followLive = true;
        if (align) { s.listenerAlignedEpoch = s.listener.snapshot().epochId; followListener(s, true); }
      } catch {
        if (session === s && s.listenerWanted && request === s.listenerRequest && !s.abort.signal.aborted) s.listenerFailed = true;
      } finally { if (session === s && !s.finishing) listenerStatus(s); }
    })();
    s.listenerJoining = pending;
    try { await pending; }
    finally { if (s.listenerJoining === pending) s.listenerJoining = null; }
  }

  function leaveListener(s) {
    s.listenerWanted = false;
    s.listenerRequest = (s.listenerRequest ?? 0) + 1;
    s.listener?.leave();
    listenerStatus(s);
  }

  function publicDelivery(s, metrics = s?.publicPeer?.metrics() ?? s?.fallbackPeerMetrics) {
    if (local) return;
    const peerBytes = observed(metrics?.peerBytes) ?? 0;
    const uploaded = observed(metrics?.uploadedBytes) ?? 0;
    const peers = observed(metrics?.connectedPeers) ?? 0;
    const originBytes = s?.nativeHls ? null : observed(metrics?.originBytes) ?? observed(s?.browser?.responseBytes) ?? (s ? null : 0);
    for (const [id, bytes] of [['public-origin-bytes', originBytes], ['public-peer-bytes', peerBytes], ['public-upload-bytes', uploaded]]) {
      optionalText(id, transferBytes(bytes));
      if ($(id)) { $(id).dataset.bytes = bytes === null ? '' : String(bytes); $(id).title = bytes === null ? 'Byte count unavailable' : `${bytes.toLocaleString('en-GB')} bytes this playback`; }
    }
    optionalText('public-local-peers', `${peers} connected to you`);
    optionalText('browser-swarm-version', metrics?.library ? `RelaySwarm ${metrics.library.version} · ${metrics.library.sourceCommit.slice(0, 8)}` : DASH);
    const playing = s && !video.paused && !video.ended;
    const enabled = metrics?.enabled === true;
    optionalText('public-delivery', !s ? 'Ready when you are' : video.ended ? 'Mix finished' : !playing && s.browser?.seenFrame ? 'Paused' :
      s.nativeHls ? 'Playing from the media host' :
      metrics?.lastDelivery === 'mixed' ? 'Latest segment: viewers + media host' :
      metrics?.lastDelivery === 'peer' ? 'Latest segment: from a viewer' : metrics?.lastDelivery === 'origin' ? 'Latest segment: from the media host' :
      peers > 0 ? 'Connected to other viewers' : 'Waiting for the first segment');
    optionalText('public-share-status', !s ? 'Press Play & join. Your browser can pass verified video segments to other viewers.' :
      video.ended ? 'Thanks for listening. Peer connections are closed.' : !playing && s.browser?.seenFrame ? 'Sharing is paused with the music. Press play to rejoin.' :
      enabled && peers > 0 ? `${peers} viewer${peers === 1 ? '' : 's'} connected to you. A connection counts towards delivery only when video moves.` :
      enabled ? 'Looking for other viewers. The media host keeps the music playing while peers connect.' :
      s.publicSharingFailed ? 'Playing from the media host. Peer sharing could not connect in this browser.' :
      s.nativeFallback ? 'Your browser switched to native playback to recover the stream. The media host supplies this playback; peer sharing is unavailable in this mode.' :
      s.nativeHls ? 'Your browser is using native HLS. Peer sharing needs a browser with Media Source Extensions and WebRTC.' :
      'Playing from the media host. Peer sharing is starting.');
    const loadedBytes = originBytes === null ? null : peerBytes + originBytes;
    optionalText('public-transfer-summary', s?.nativeHls ?
      'Native playback does not expose complete transfer totals. Earlier verified peer downloads and uploads are retained.' : loadedBytes > 0 ?
      `${(100 * peerBytes / loadedBytes).toLocaleString('en-GB', { maximumFractionDigits: 1 })}% of your loaded video came from viewers. Totals include buffered video; sent bytes may still be in transfer.` :
      'Totals for this playback. Peer downloads count only complete, verified video segments.');
    root.dataset.delivery = !s ? 'ready' : metrics?.phase ?? 'origin';
    root.dataset.peerEngine = metrics?.core?.state ?? '';
    root.dataset.multiHolderDelivered = String(metrics?.core?.multiHolder?.delivered ?? 0);
    root.dataset.originTransferredBytes = s?.nativeHls ? '' : String(metrics?.originTransferredBytes ?? 0);
    root.dataset.loadedMediaBytes = s?.nativeHls ? '' : String(metrics?.loadedMediaBytes ?? 0);
    root.dataset.cacheHighWaterBytes = String(metrics?.resources?.heldHighWaterBytes ?? 0);
    swarmVisual?.update({ ...metrics, active: Boolean(s), playing: Boolean(playing), originBytes,
      room: s?.listener?.snapshot() ?? publicRoom?.snapshot() ?? null });
    listenerStatus(s);
  }

  function shareWhilePlaying(s, enabled) {
    if (local || session !== s || s.finishing || !s.publicPeer) return;
    const peer = s.publicPeer;
    void peer.setEnabled(enabled).then(() => {
      if (session === s && s.publicPeer === peer) { s.publicSharingFailed = false; publicDelivery(s); }
    }).catch(() => {
      if (session === s && s.publicPeer === peer && !s.abort.signal.aborted) { s.publicSharingFailed = true; publicDelivery(s); }
    });
  }
  const choices = {};
  if (!local) {
    for (const [id, label] of [['preview', '1080p preview'], ['full', '4K full mix']]) {
      try {
        const url = approvedMediaUrl(root.dataset[`${id}Url`], location.href, root.dataset.mediaOrigin);
        const attr = (suffix) => {
          const value = root.dataset[`${id}${suffix}`];
          return value === undefined || value === '' ? null : observed(Number(value));
        };
        choices[id] = { id, label, url, bytes: attr('Bytes'), bitrateBps: attr('BitrateBps'), durationSeconds: attr('DurationSeconds') };
      } catch { /* An unconfigured or unapproved source stays unavailable. */ }
    }
  }
  const status = (message, error = false) => { text('lab-status', message); $('lab-status').classList.toggle('error', error); };

  function sameSiteUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('No media URL');
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('A same-origin media URL is required');
    return url;
  }

  async function api(route, body, timeoutMs) {
    if (!local || pageAbort.signal.aborted) throw new Error('The local runner is unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    pageAbort.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs ?? (route === '/lab/run' ? 45000 : 12000));
    try {
      const reply = await fetch(route, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      if (!reply.ok) throw new Error('The local runner could not complete that request');
      return await reply.json();
    } finally { clearTimeout(timeout); pageAbort.signal.removeEventListener('abort', abort); }
  }

  function controls() {
    const running = Boolean(session);
    const preview = !local && Boolean(choices[$('lab-quality').value]);
    const engineAvailable = config?.engines?.some((entry) => entry.id === $('lab-engine').value && entry.available);
    $('lab-run').disabled = busy || foreignRun || running || (!engineAvailable && !preview);
    $('lab-run').textContent = preview ? `Play ${choices[$('lab-quality').value].label} with sound` : 'Run & play with sound ↗';
    for (const id of ['lab-engine', 'lab-transport', 'lab-duration', 'lab-relay', 'lab-turn-transport']) $(id).disabled = !config || busy || running || foreignRun;
    $('lab-turn-transport').disabled ||= $('lab-relay').value === 'off';
    $('lab-play').disabled = !session?.mediaReady || busy || Boolean(session?.sourceEof);
    $('lab-stop').disabled = !session || busy;
    $('lab-stop').textContent = local ? 'Stop run' : 'Stop preview';
    if (!local) $('lab-quality').disabled = busy;
    $('lab-fullscreen').disabled = !fullscreenReady || !session?.mediaReady;
    if ($('public-invite')) $('public-invite').disabled = !session?.mediaReady || Boolean(video.ended);
    if (!local && publicPlay) {
      const ready = Boolean(session?.mediaReady);
      const finished = video.ended || session?.playbackFailed;
      publicPlay.disabled = busy && !ready;
      publicPlay.hidden = Boolean(session?.browser?.seenFrame) && !finished;
      publicPlay.setAttribute('aria-label', busy && !ready ? 'Loading the mix' : finished ? 'Replay the mix and join the swarm' : ready ? 'Play the mix and join the swarm' : 'Play the mix and join the swarm');
      const label = publicPlay.querySelector('[data-play-label]');
      if (label) label.textContent = busy && !ready ? 'Loading the mix…' : finished ? 'Play again' : 'Play & join';
      video.controls = ready;
      listenerStatus(session);
    }
    $('lab-clear').disabled = !runs.length;
    $('lab-export').disabled = !runs.length;
  }

  function qualityDetails() {
    const choice = choices[$('lab-quality').value];
    if (!choice) return;
    const parts = [choice.label];
    if (choice.durationSeconds !== null) parts.push(clock(choice.durationSeconds));
    if (choice.bytes !== null) parts.push(`${megabytes(choice.bytes)} full asset`);
    if (choice.bitrateBps !== null) parts.push(reading(choice.bitrateBps / 1e6, ' Mbps'));
    text('lab-quality-note', `${parts.join(' · ')}. The full mix streams at about 24 Mb/s.`);
    const corner = root.querySelector('.film-corner');
    if (corner) corner.textContent = choice.id === 'full' ? '4K / ORIGINAL MIX' : '1080P / EXCERPT';
    controls();
  }

  function sourceDetails(source) {
    const data = publicSource(source);
    text('source-title', data.label);
    const parts = [];
    if (data.width && data.height) parts.push(`${data.width.toLocaleString('en-GB')} × ${data.height.toLocaleString('en-GB')}`);
    if (data.fps !== null) parts.push(`${reading(data.fps, '', 2).replace(/\.00$/, '')} fps`);
    if (data.durationSeconds !== null) parts.push(clock(data.durationSeconds));
    if (data.bytes !== null) parts.push(megabytes(data.bytes));
    if (data.bitrateBps !== null) parts.push(reading(data.bitrateBps / 1e6, ' Mbps'));
    if (data.videoCodec || data.audioCodec) parts.push([data.videoCodec, data.audioCodec].filter(Boolean).join(' + ').toUpperCase());
    text('source-meta', parts.length ? parts.join(' · ') : 'Technical source metadata has not been supplied.');
    text('source-tag', 'Owner-licensed media · offset 0');
  }

  function profileDetails(profile) {
    const parts = [];
    if (profile?.hlsMode) parts.push(human(profile.hlsMode));
    if (observed(profile?.segmentDurationSeconds) !== null) parts.push(`${profile.segmentDurationSeconds}s segments`);
    if (observed(profile?.partDurationSeconds) !== null) parts.push(`${profile.partDurationSeconds}s parts`);
    if (profile?.transcode === false) parts.push('No transcoding');
    if (profile?.recording === false) parts.push('Recording off');
    parts.push('Full-segment browser playback');
    if (profile?.sapflowHttpImpl) parts.push(`Sapflow HTTP: ${human(profile.sapflowHttpImpl)}`);
    if (observed(profile?.httpWorkers) !== null) parts.push(`${profile.httpWorkers} HTTP worker`);
    if (observed(profile?.endDrainSeconds) !== null) parts.push(`${profile.endDrainSeconds}s matched end drain`);
    text('profile-note', parts.length ? `Matched profile · ${parts.join(' · ')}. Browser decoding is measured separately from server resource use.` : 'Read the source, host and profile alongside each completed run.');
  }

  function showEngineVersion() {
    const entry = config?.engines?.find((engine) => engine.id === $('lab-engine').value);
    text('engine-version', entry ? `${human(entry.label)} · ${human(entry.version)}${sha(entry.binarySha256) ? ` · SHA-256 ${entry.binarySha256.slice(0, 12)}…` : ''}` : 'Select a locally installed server to see its version.');
  }

  function processStats(processes) {
    for (const name of ['origin', 'publisher', 'srtSender', 'relay']) {
      const process = processes?.[name] ?? (name === 'relay' ? processes?.turn : null);
      text(`process-${name}-cpu`, reading(process?.cpuPercent, '%'));
      text(`process-${name}-seconds`, reading(process?.cpuSeconds, ' s', 2));
      text(`process-${name}-rss`, megabytes(process?.rssBytes));
      text(`process-${name}-peak`, megabytes(process?.peakSampledRssBytes));
      if (name === 'relay') $('process-relay-row').hidden = !process && (!session || session.turnEngine === 'off');
    }
    text('origin-cpu', reading(processes?.origin?.cpuPercent, '%'));
    text('origin-rss', megabytes(processes?.origin?.rssBytes));
    text('origin-uptime', clock(processes?.origin?.uptimeSeconds));
  }

  function httpStats(http) {
    const percentile = (group) => group && group.samples > 0 ? ['p50', 'p95', 'p99'].map((key) => reading(group[key], '', 1)).join(' / ') + ' ms' : DASH;
    text('http-bytes', megabytes(http?.bytes));
    text('http-requests', http ? [http.requests, http.completed, http.active].map((n) => reading(n, '', 0)).join(' / ') : DASH);
    text('http-hops', http ? [http.originRequests, http.redirectsFollowed].map((n) => reading(n, '', 0)).join(' / ') : DASH);
    text('http-errors', reading(http?.errors, '', 0));
    text('http-rate', observed(http?.bytesPerSecond) === null ? DASH : reading(http.bytesPerSecond / 1e6, ' MB/s', 2));
    text('http-first-byte', percentile(http?.firstByteMs));
    text('http-response', percentile(http?.responseMs));
  }

  function renderTable() {
    const tbody = $('comparison-runs');
    tbody.replaceChildren();
    if (!runs.length) {
      const td = document.createElement('td'); td.colSpan = 9; td.className = 'empty-cell';
      td.textContent = 'Complete a local run, or open a published receipt, to put real measurements here.';
      const tr = document.createElement('tr'); tr.append(td); tbody.append(tr);
    }
    for (const run of runs) {
      const tr = document.createElement('tr');
      const values = [
        `${run.engineLabel} · ${run.version}`, run.transport.toUpperCase(),
        run.turnEngine === 'off' ? 'Direct HLS' : `${run.turnEngine} · ${run.turnTransport.toUpperCase()}`,
        clock(run.durationSeconds), reading(run.originCpuMeanPercent, '%'), megabytes(run.originPeakSampledRssBytes),
        reading(run.browser.firstFrameMs, ' ms', 0), reading(run.browser.decodedFpsMean, ' fps'),
        run.browser.stallCount === null ? DASH : `${run.browser.stallCount} / ${reading(run.browser.stallSeconds, ' s')}`,
      ];
      values.forEach((value, index) => {
        const td = document.createElement('td'); td.textContent = value;
        if (index === 0 && typeof run.measuredAt === 'string' && Number.isFinite(Date.parse(run.measuredAt))) {
          const date = document.createElement('time'); date.dateTime = run.measuredAt;
          date.style.cssText = 'display:block;color:var(--muted);font-size:.62rem;margin-top:5px';
          date.textContent = new Date(run.measuredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          td.append(date);
        }
        tr.append(td);
      });
      tbody.append(tr);
    }
    controls();
  }

  function browserReadings(s) {
    if (!s) {
      for (const id of ['browser-fps', 'browser-time', 'browser-buffer', 'browser-stalls', 'browser-stall-time', 'browser-bytes', 'browser-requests', 'browser-errors', 'first-frame']) text(id, DASH);
      text('browser-dimensions', 'Browser video dimensions');
      optionalText('browser-engine', DASH); delete root.dataset.playbackEngine;
      optionalText('browser-recoveries', DASH); delete root.dataset.bufferedRecoveries;
      return;
    }
    const b = s.browser;
    optionalText('browser-engine', s.playbackEngine ?? DASH);
    root.dataset.playbackEngine = s.playbackEngine ?? '';
    root.dataset.bufferedRecoveries = String(s.bufferedRecoveries ?? 0);
    optionalText('browser-recoveries', String(s.bufferedRecoveries ?? 0));
    if (s.sourceEof) {
      text('browser-bytes', megabytes(b.responseBytes));
      text('browser-requests', reading(b.requests, '', 0));
      text('browser-errors', `${reading(b.playerErrors, '', 0)} / ${reading(b.httpErrors, '', 0)}`);
      return;
    }
    const now = performance.now();
    const decoded = observed(video.webkitDecodedFrameCount);
    if (decoded !== null && (video.readyState > 0 || !b.seenFrame)) {
      if (decoded < b.frameBaseline) b.frameBaseline = 0;
      b.decodedFrames = Math.max(0, decoded - b.frameBaseline);
      if (b.seenFrame && b.lastDecodeAt !== null && now - b.lastDecodeAt >= 800) {
        b.fps = Math.max(0, decoded - b.lastDecoded) * 1000 / (now - b.lastDecodeAt);
        if (!video.paused && !video.ended) b.fpsSamples.push(b.fps);
        b.lastDecodeAt = now; b.lastDecoded = decoded;
      }
      if (b.decodedFrames > 0 && b.lastDecodeAt === null) { b.lastDecodeAt = now; b.lastDecoded = decoded; }
    }
    if (video.videoWidth > 0 && video.videoHeight > 0) { b.width = video.videoWidth; b.height = video.videoHeight; }
    if (video.readyState > 0) b.videoTimeSeconds = observed(video.currentTime);
    b.playbackEndObserved = video.ended;
    if (!local) text('run-clock', `${clock(video.currentTime)} / ${clock(video.duration)}`);
    b.stallSeconds = b.finishedStallSeconds + (b.waitingAt === null ? 0 : (now - b.waitingAt) / 1000);
    let buffer = video.readyState > 0 ? 0 : null;
    for (let i = 0; i < video.buffered.length; i++) if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) buffer = video.buffered.end(i) - video.currentTime;
    text('browser-fps', reading(b.fps, ' fps'));
    text('browser-dimensions', videoDimensions(b));
    text('first-frame', reading(b.firstFrameMs, ' ms', 0));
    text('browser-time', video.readyState > 0 ? clock(video.currentTime) : DASH);
    text('browser-buffer', reading(buffer, ' s', 2));
    text('browser-stalls', reading(b.stallCount, '', 0));
    text('browser-stall-time', reading(b.stallSeconds, ' s', 2));
    text('browser-bytes', megabytes(b.responseBytes));
    text('browser-requests', reading(b.requests, '', 0));
    text('browser-errors', `${reading(b.playerErrors, '', 0)} / ${reading(b.httpErrors, '', 0)}`);
    publicDelivery(s);
  }

  function trackBrowser(s, playlist) {
    delete root.dataset.playbackFallback;
    s.playbackSync = createSharedPlaybackSync(video, { signal: s.abort.signal, onSeek: at => { s.roomSeekAt = at; } });
    s.bufferedRecovery = createBufferedPlaybackRecovery(video, { onSeek: at => { s.roomSeekAt = at; } });
    s.nativeFallbackPolicy = createNativePlaybackFallback(video);
    s.playlistUrl = playlist.href;
    const b = s.browser = {
      seenFrame: false, firstFrameMs: null, decodedFrames: null, presentedFrames: null, frameBaseline: observed(video.webkitDecodedFrameCount) ?? 0,
      lastDecoded: 0, lastDecodeAt: null, fps: null, fpsSamples: [],
      width: null, height: null, mediaWidth: null, mediaHeight: null, stallCount: 0, waitingAt: null, finishedStallSeconds: 0, stallSeconds: 0,
      responseBytes: null, requests: null, playerErrors: 0, httpErrors: null,
    };
    const endStall = () => {
      if (b.waitingAt !== null) { b.finishedStallSeconds += (performance.now() - b.waitingAt) / 1000; b.waitingAt = null; }
    };
    const waiting = () => {
      if (session === s && !s.sourceEof && b.seenFrame && !video.paused && !video.ended && b.waitingAt === null) { b.waitingAt = performance.now(); b.stallCount++; }
    };
    video.addEventListener('waiting', waiting, { signal: s.abort.signal });
    video.addEventListener('stalled', waiting, { signal: s.abort.signal });
    video.addEventListener('playing', endStall, { signal: s.abort.signal });
    if (!local) {
      video.addEventListener('playing', () => {
        s.switchingPlayback = false;
        controls();
        status(`${s.quality === 'full' ? '4K' : '1080p'} mix playing. Pause to leave, or use the native controls for volume and full screen.`);
        void joinListener(s).then(() => { if (session === s && !video.paused && !s.finishing) shareWhilePlaying(s, true); });
      }, { signal: s.abort.signal });
      video.addEventListener('ended', () => {
        if (s.listenerWanted && s.listener?.snapshot().ready && !s.finishing) {
          s.followLive = true; followListener(s, true); void play(s);
        } else shareWhilePlaying(s, false);
        controls(); publicDelivery(s);
      }, { signal: s.abort.signal });
    }
    video.addEventListener('pause', () => {
      endStall();
      s.nativeFallbackPolicy.reset();
      if (s.switchingPlayback) {
        if ((s.userInteractionAt ?? -Infinity) <= s.nativeTransitionStartedAt) return;
        s.switchingPlayback = false;
        s.nativeAutoplayCancelled = true;
      }
      // A natural boundary pauses the media element before ended. Keep room
      // membership and peer delivery through the shared recording's next loop.
      if (!local && video.ended && s.listenerWanted && s.listener?.snapshot().ready) return;
      if (!local && !s.finishing) { leaveListener(s); shareWhilePlaying(s, false); }
      if (!s.finishing && !s.sourceEof && b.seenFrame) {
        if (local) { s.interrupted = true; status('Playback paused. This interrupted run will not enter the comparison table.'); }
        else { status('Paused. Press play on the video to keep listening and rejoin.'); publicDelivery(s); }
      }
    }, { signal: s.abort.signal });
    let lastInteraction = -Infinity;
    const interacted = () => { s.userInteractionAt = lastInteraction = performance.now(); };
    video.addEventListener('pointerdown', interacted, { signal: s.abort.signal });
    video.addEventListener('pointerup', interacted, { signal: s.abort.signal });
    video.addEventListener('keydown', interacted, { signal: s.abort.signal });
    document.addEventListener('visibilitychange', () => s.nativeFallbackPolicy.reset(), { signal: s.abort.signal });
    video.addEventListener('seeking', () => {
      // HLS latency corrections can seek too; exclude deliberate viewer seeks.
      if (b.seenFrame && !s.finishing && performance.now() - lastInteraction < 1500) {
        s.nativeFallbackPolicy.reset();
        s.interrupted = true;
        if (!local && lastInteraction > (s.roomSeekAt ?? -Infinity)) { s.followLive = false; listenerStatus(s); }
      }
    }, { signal: s.abort.signal });
    video.addEventListener('error', () => {
      if (session !== s || s.finishing) return;
      if (s.switchingPlayback && !video.error) return;
      s.switchingPlayback = false;
      b.playerErrors++;
      if (s.sourceEof && video.error?.code === 2) return;
      if (!local && s.hls && b.seenFrame && video.canPlayType('application/vnd.apple.mpegurl')) {
        switchPublicToNative(s, 'decode-error'); return;
      }
      s.playbackFailed = true;
      if (!local) { leaveListener(s); shareWhilePlaying(s, false); }
      status(local ? 'Playback could not continue. Stop the run, check the local runner and try again.' : 'The selected source could not be decoded. Try the preview or check the media-host response.', true);
    }, { signal: s.abort.signal });
    if (typeof video.requestVideoFrameCallback === 'function') {
      const frame = (_now, metadata) => {
        if (session !== s || s.finishing || s.sourceEof) return;
        b.presentedFrames = (b.presentedFrames ?? 0) + 1;
        if (observed(metadata?.width) > 0 && observed(metadata?.height) > 0) { b.mediaWidth = metadata.width; b.mediaHeight = metadata.height; }
        if (!b.seenFrame) {
          b.seenFrame = true; b.firstFrameMs = performance.now() - s.clickAt;
          b.lastDecodeAt = performance.now(); b.lastDecoded = observed(video.webkitDecodedFrameCount) ?? 0;
          $('video-empty').hidden = true;
          controls();
        }
        endStall();
        s.frameCallback = video.requestVideoFrameCallback(frame);
      };
      s.frameCallback = video.requestVideoFrameCallback(frame);
    } else {
      video.addEventListener('timeupdate', () => {
        if (video.videoWidth > 0 && video.currentTime > 0) { b.seenFrame = true; $('video-empty').hidden = true; }
      }, { signal: s.abort.signal });
    }
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('resource')) {
      b.requests = 0;
      const prefix = playlist.pathname.slice(0, playlist.pathname.lastIndexOf('/') + 1);
      let mediaBase;
      if (!local && s.quality === 'full') {
        try { mediaBase = approvedMediaUrl(root.dataset.fullMediaBase, location.href, root.dataset.mediaOrigin); } catch {}
      }
      const entries = (list) => {
        for (const entry of list) {
          let url; try { url = new URL(entry.name); } catch { continue; }
          if (!(url.origin === playlist.origin && url.pathname.startsWith(prefix)) &&
              !(mediaBase && url.origin === mediaBase.origin && url.pathname.startsWith(mediaBase.pathname))) continue;
          b.requests++;
          // Cross-origin entries without Timing-Allow-Origin can hide sizes/status.
          if (observed(entry.encodedBodySize) !== null && (url.origin === location.origin || entry.encodedBodySize > 0)) b.responseBytes = (b.responseBytes ?? 0) + entry.encodedBodySize;
          if (observed(entry.responseStatus) !== null && entry.responseStatus > 0) b.httpErrors = (b.httpErrors ?? 0) + (entry.responseStatus >= 400 ? 1 : 0);
        }
      };
      s.resourceEntries = entries;
      s.observer = new PerformanceObserver((list) => entries(list.getEntries()));
      s.observer.observe({ type: 'resource', buffered: false });
    }
    const tick = () => { if (session === s && !s.finishing) {
      followListener(s);
      const nativeCapable = !local && Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
      const nativeEligible = nativeCapable && Boolean(s.hls) && !s.nativeHls && !s.sourceEof && b.seenFrame && !document.hidden;
      if (s.nativeFallbackPolicy.check(nativeEligible)) switchPublicToNative(s);
      if (!local && !nativeCapable && s.hls && b.seenFrame && !s.sourceEof && s.bufferedRecovery.check(b.presentedFrames)) s.bufferedRecoveries = (s.bufferedRecoveries ?? 0) + 1;
      browserReadings(s); s.browserTimer = setTimeout(tick, 400);
    } };
    tick();
  }

  function peerStats(s, metrics) {
    if (session !== s) return;
    const errors = observed(metrics?.diagnostics?.hlsErrorCount) ?? 0;
    s.browser.playerErrors += Math.max(0, errors - (s.peerHlsErrors ?? 0));
    s.peerHlsErrors = errors;
    if (metrics.phase === 'error') { browserReadings(s); s.playbackFailed = true; }
    s.peerMetrics = peerRecord(metrics);
    const viewer = metrics?.viewer;
    const transport = metrics?.transport;
    const pairs = Array.isArray(transport?.selectedPairs) ? transport.selectedPairs : [];
    const selected = pairs.map((pair) => `${human(pair.localType)} → ${human(pair.remoteType)} (${human(pair.relayProtocol)})`).join(', ');
    text('relay-summary', `Viewer path · ${human(s.turnEngine)} ${s.turnTransport.toUpperCase()} requested · ${selected || 'Waiting for a selected path'} · Verified peer bytes: ${megabytes(viewer?.peerBytes)} · Origin bytes: ${megabytes(viewer?.originBytes)} · Verified peer segments: ${reading(viewer?.verifiedPeerSegments, '', 0)} · Origin fallbacks: ${reading(viewer?.originFallbacks, '', 0)} · Phase: ${human(metrics?.phase)}`);
    $('relay-summary').hidden = false;
  }

  async function confirmNormalSourceEnd(s, error) {
    if (!local || session !== s || s.abort.signal.aborted || s.finishing || s.interrupted || s.playbackFailed || !sourceRetiredError(error)) return false;
    if (s.sourceEof) return true;
    let snapshot;
    try { snapshot = await api('/lab/stats', undefined, 2000); } catch { return false; }
    if (session !== s || s.abort.signal.aborted || s.finishing || s.interrupted || s.playbackFailed || !confirmedPublisherEnd(snapshot, s.id)) return false;
    browserReadings(s);
    if (s.observer) s.resourceEntries(s.observer.takeRecords());
    s.sourceEof = true;
    controls();
    status('The source window has ended. Keeping its final playback observations while the runner finishes.');
    return true;
  }

  async function play(s = session) {
    if (!s || session !== s || !s.mediaReady || s.sourceEof) return;
    const playbackVersion = s.playbackVersion ?? 0;
    if (local) { video.muted = false; if (video.volume === 0) video.volume = 1; }
    try { await video.play(); if (session === s && local) status('Playing with sound. Server and browser observations update separately.'); }
    catch { if (session === s && !s.finishing && !s.abort.signal.aborted && playbackVersion === (s.playbackVersion ?? 0)) {
      s.switchingPlayback = false;
      if (!local) { leaveListener(s); shareWhilePlaying(s, false); }
      status('The mix is ready. Press play to start listening.'); controls();
    } }
  }

  function switchPublicToNative(s, reason = 'stalls') {
    if (local || session !== s || s.finishing || s.nativeHls || !s.hls || s.abort.signal.aborted) return;
    const position = video.currentTime;
    const previous = s.publicPeer?.metrics();
    s.playbackVersion = (s.playbackVersion ?? 0) + 1;
    s.switchingPlayback = true;
    s.nativeTransitionStartedAt = performance.now();
    s.nativeFallback = true;
    s.nativeHls = true;
    root.dataset.playbackFallback = reason;
    // Keep the room, visible video and verified historical byte counts. Native
    // HLS cannot use the fragment loader, so release all peer resources first.
    s.fallbackPeerMetrics = previous ? { ...previous, enabled: false, serving: false, phase: 'origin',
      connectedPeers: 0, viewerId: null, library: null, core: null, lastDelivery: null,
      originBytes: null, originTransferredBytes: null, loadedMediaBytes: null, peerShare: null,
      topology: { connections: [] }, resources: { activePeerConnections: 0, signallingConnections: 0,
        heldBytes: 0, heldHighWaterBytes: previous.resources?.heldHighWaterBytes ?? 0 } } : null;
    const peer = s.publicPeer; s.publicPeer = null;
    try { peer?.stop(); } catch {}
    const hls = s.hls; s.hls = null;
    try { hls.destroy(); } catch {}
    s.publicSharingFailed = false;
    s.playbackEngine = 'Native HLS';
    video.addEventListener('loadedmetadata', () => {
      if (session !== s || s.finishing || s.abort.signal.aborted) return;
      if (Number.isFinite(position) && position > 0 && Number.isFinite(video.duration)) {
        s.roomSeekAt = performance.now();
        video.currentTime = Math.min(position, Math.max(0, video.duration - 0.1));
      }
      if (!s.nativeAutoplayCancelled) void play(s);
    }, { once: true, signal: s.abort.signal });
    video.src = s.playlistUrl;
    status('Switching to your browser’s native player to recover playback.');
    browserReadings(s);
  }

  async function attach(s, url, runtime) {
    if (!local && /\.mp4$/i.test(url.pathname)) {
      s.playbackEngine = 'Native MP4';
      trackBrowser(s, url);
      video.crossOrigin = url.origin === location.origin ? '' : 'anonymous';
      video.src = url.href; s.mediaReady = true; controls(); await play(s);
      return;
    }
    Hls ??= (await import(local ? './vendor/hls.min.mjs' : './vendor/hls.light.min.mjs')).default;
    if (session !== s || s.abort.signal.aborted) return;
    trackBrowser(s, url);
    const room = !local ? s.listener?.snapshot() : null;
    const initial = local ? await readInitialLiveStart(url.href, { signal: s.abort.signal }) :
      { startPosition: room?.ready ? s.listener.position() : s.invitedStart || -1, epochId: room?.ready ? room.epochId : null };
    if (session !== s || s.abort.signal.aborted) return;
    if (s.turnEngine !== 'off') {
      if (!runtime || !local) throw new Error('A local per-viewer relay runtime is required');
      const { startLabPeer } = await import('./media-lab-peer.mjs');
      if (session !== s || s.abort.signal.aborted) return;
      s.mediaReady = true; controls();
      s.peer = await startLabPeer({ Hls, video, playlistUrl: url.href, runtime, startPosition: initial.startPosition,
        signal: s.abort.signal, onStats: (metrics) => peerStats(s, metrics), confirmSourceEnd: error => confirmNormalSourceEnd(s, error) });
      await play(s);
    } else if (Hls.isSupported()) {
      const player = s.hls = new Hls({ lowLatencyMode: false, progressive: false, maxBufferLength: local ? 4 : 20, maxMaxBufferLength: local ? 6 : 24,
        maxBufferSize: (local ? 8 : 64) * 1024 * 1024, backBufferLength: local ? 0 : 4, enableWorker: true, startPosition: initial.startPosition });
      s.playbackEngine = 'hls.js';
      s.hls.on(Hls.Events.MEDIA_ATTACHED, (_, { mediaSource }) => {
        if (session !== s || s.hls !== player) return;
        s.playbackEngine = typeof ManagedMediaSource === 'function' && mediaSource instanceof ManagedMediaSource ?
          'hls.js · ManagedMediaSource' : 'hls.js · MediaSource';
      });
      // HLS already seeks to startPosition. A second forced jump on the first
      // playing event can discard the freshly downloaded startup fragment.
      if (!local && initial.epochId && initial.startPosition >= 0) s.listenerAlignedEpoch = initial.epochId;
      if (!local) {
        try {
          const { createPublicSwarm } = await import('./media-public-swarm.mjs?v=20261024-active-sharing');
          if (session !== s || s.abort.signal.aborted || s.hls !== player) return;
          s.publicPeer = createPublicSwarm({ Hls, hls: s.hls, video, playlistUrl: url.href, quality: s.quality,
            signal: s.abort.signal, onStats: metrics => { if (session === s && !s.nativeHls && !s.finishing) publicDelivery(s, metrics); } });
          shareWhilePlaying(s, true);
        } catch { s.publicSharingFailed = true; publicDelivery(s); }
      }
      s.hls.on(Hls.Events.ERROR, (_, data) => {
        if (session !== s || s.finishing || s.hls !== player) return;
        s.browser.playerErrors++;
        if (data.fatal && !local && s.browser.seenFrame && video.canPlayType('application/vnd.apple.mpegurl')) {
          switchPublicToNative(s, 'player-error'); return;
        }
        if (data.fatal && !s.directErrorPending) {
          s.directErrorPending = true;
          void confirmNormalSourceEnd(s, data).then(normal => {
            if (session !== s || s.finishing || s.abort.signal.aborted || s.hls !== player) return;
            if (normal) { s.hls.stopLoad(); video.pause(); }
            else {
              s.playbackFailed = true;
              if (!local) { leaveListener(s); shareWhilePlaying(s, false); }
              status(local ? 'The player could not continue. Stop this run and check the local runner.' : 'The selected source could not continue. Stop playback and try the preview.', true);
            }
          }).finally(() => { s.directErrorPending = false; });
        }
      });
      s.hls.on(Hls.Events.MANIFEST_PARSED, () => { if (session === s && s.hls === player) { s.mediaReady = true; controls(); void play(s); } });
      s.hls.loadSource(url.href); s.hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      s.nativeHls = true;
      s.playbackEngine = 'Native HLS';
      video.addEventListener('loadedmetadata', () => {
        s.listenerAlignedEpoch = s.listener?.snapshot().epochId;
        followListener(s, true);
      }, { once: true, signal: s.abort.signal });
      video.src = url.href; s.mediaReady = true; controls(); await play(s); publicDelivery(s);
    } else throw new Error('This browser cannot play the HLS stream');
  }

  function dispose(s) {
    s.finishing = true;
    clearTimeout(s.browserTimer);
    if (s.frameCallback !== undefined) video.cancelVideoFrameCallback?.(s.frameCallback);
    if (s.observer) { s.resourceEntries(s.observer.takeRecords()); s.observer.disconnect(); }
    s.abort.abort();
    try { if (s.listener === publicRoom) s.listener.leave(); else s.listener?.stop(); } catch {}
    try { Promise.resolve(s.peer?.stop()).catch(() => {}); } catch {}
    try { s.publicPeer?.stop(); } catch {}
    try { s.hls?.destroy(); } catch {}
    video.pause(); video.removeAttribute('src'); video.load();
    video.removeAttribute('crossorigin');
  }

  function finish(snapshot) {
    const s = session;
    if (!s || s.finishing) return;
    browserReadings(s);
    if (s.observer) s.resourceEntries(s.observer.takeRecords());
    const record = completedRecord(snapshot, s, config, s.browser);
    if (record && !saved.has(s.id)) { runs.push(record); saved.add(s.id); renderTable(); }
    const ended = snapshot?.state === 'ended';
    dispose(s); session = null; foreignRun = false;
    processStats(snapshot?.processes); httpStats(snapshot?.http);
    text('run-clock', ended ? 'Measurement complete' : 'Run stopped');
    status(!local ? 'Playback stopped. Choose a quality and press Play to restart.' : record ? 'Run complete and recorded below. Choose the other server with the same settings to compare.' : ended ? 'Run finished. Playback was interrupted or no frame was observed, so it was not added to the comparison table.' : 'Run stopped. Partial runs stay out of the comparison table.');
    controls();
    publicDelivery(null);
  }

  async function poll() {
    if (!local || !config || pageAbort.signal.aborted) return;
    try {
      const snapshot = await api('/lab/stats');
      if (pageAbort.signal.aborted) return;
      if (session?.id) {
        const final = snapshot.lastRun;
        if (final?.run?.id === session.id && ['ended', 'stopped', 'error'].includes(final.state)) finish(final);
        else if (snapshot.run?.id === session.id) {
          processStats(snapshot.processes); httpStats(snapshot.http);
          const cpu = observed(snapshot.processes?.origin?.cpuPercent);
          const rss = observed(snapshot.processes?.origin?.rssBytes);
          if (cpu !== null) session.cpuSamples.push(cpu);
          if (rss !== null) session.rssSamples.push(rss);
          for (const name of ['origin', 'publisher', 'srtSender', 'turn']) {
            const value = observed(snapshot.processes?.[name]?.cpuPercent);
            if (value !== null) (session.processSamples[name] ??= []).push(value);
          }
          text('run-clock', snapshot.run.publisherEnded ? `${clock(snapshot.run.uptimeSeconds)} · draining final media` : `${clock(snapshot.run.uptimeSeconds)} elapsed · ${clock(snapshot.run.remainingSeconds)} budget`);
        }
      } else {
        foreignRun = Boolean(snapshot.run);
        if (foreignRun) { status('The local runner already has an active run. Let it finish before starting another comparison.'); processStats(snapshot.processes); httpStats(snapshot.http); }
        controls();
      }
    } catch {
      if (!pageAbort.signal.aborted) {
        status('Live readings are unavailable. Check that the local runner is still running.', true);
        processStats(null); httpStats(null);
      }
    } finally { if (!pageAbort.signal.aborted) polling = setTimeout(poll, 1000); }
  }

  async function start() {
    if (busy || session || foreignRun) return;
    const clickAt = performance.now();
    busy = true; controls();
    $('video-empty').hidden = false;
    $('relay-summary').hidden = true;
    processStats(null); httpStats(null); browserReadings(null);
    try {
      if (!local) {
        const choice = choices[$('lab-quality').value];
        if (!choice) throw new Error('No configured public source');
        session = { id: null, engine: 'preview', quality: choice.id, durationSeconds: choice.durationSeconds, turnEngine: 'off', clickAt, abort: new AbortController(), cpuSamples: [], rssSamples: [],
          invitedStart: invitationUsed ? 0 : invitedPlaybackStart(location.search, Date.now(), choice.durationSeconds, choice.id) };
        invitationUsed = true;
        text('player-label', `${choice.label} · licensed source`);
        await joinListener(session, false);
        if (!session || session.finishing || session.abort.signal.aborted) return;
        await attach(session, choice.url);
        return;
      }
      const engine = $('lab-engine').value;
      const transport = $('lab-transport').value;
      const turnEngine = $('lab-relay').value;
      const turnTransport = $('lab-turn-transport').value;
      const duration = $('lab-duration').value;
      status('Starting the selected server and publisher. Playback will begin with sound.');
      const body = { engine, transport, turnEngine, turnTransport, offsetSeconds: 0 };
      if (duration !== 'full') body.durationSeconds = Number(duration);
      const run = await api('/lab/run', body);
      if (!run.runId || run.state !== 'running') throw new Error('No active run returned');
      const url = sameSiteUrl(run.playlistUrl);
      session = {
        id: run.runId, engine, transport, turnEngine, turnTransport, offsetSeconds: 0,
        durationSeconds: duration === 'full' ? config.source?.durationSeconds : Number(duration),
        profile: run.profile,
        clickAt, abort: new AbortController(), cpuSamples: [], rssSamples: [], processSamples: {}, interrupted: false,
      };
      text('player-label', `${human(config.engines.find((entry) => entry.id === engine)?.label, engine)} · ${transport.toUpperCase()}`);
      profileDetails(run.profile ?? config.engines.find((entry) => entry.id === engine)?.profile ?? config.profile);
      await attach(session, url, run.runtime);
    } catch {
      if (session?.id) await api('/lab/stop', { runId: session.id }).catch(() => {});
      if (session) dispose(session);
      session = null;
      status(local ? 'Could not start playback. Check the selected binaries and the local runner output, then try again.' : 'This source could not be played. Try the preview or open the reproduction guide.', true);
    } finally { busy = false; controls(); }
  }

  async function stop() {
    if (busy || !session) return;
    busy = true; controls();
    const s = session;
    let confirmed = true;
    let final = { state: 'stopped', run: { id: s.id } };
    try {
      if (s.id) {
        const result = await api('/lab/stop', { runId: s.id });
        if (result?.lastRun?.run?.id === s.id) final = result.lastRun;
      }
    } catch { confirmed = false; }
    finally {
      // A lost API connection must not prevent the user's local Stop action.
      if (session === s) finish(final);
      busy = false; controls();
      if (!confirmed) status('Player stopped. Server shutdown could not be confirmed; the runner retains its configured time limit.', true);
    }
  }

  $('lab-run').addEventListener('click', () => { void start(); });
  $('lab-play').addEventListener('click', () => {
    if (!local && session && session.quality !== $('lab-quality').value) {
      dispose(session); session = null; void start();
    } else void play();
  });
  $('lab-stop').addEventListener('click', () => { void stop(); });
  $('lab-engine').addEventListener('change', showEngineVersion);
  $('lab-relay').addEventListener('change', controls);
  $('lab-quality').addEventListener('change', qualityDetails);
  if (!local) {
    publicPlay?.addEventListener('click', () => {
      if (!session) { void start(); return; }
      if (session.playbackFailed) { dispose(session); session = null; void start(); return; }
      if (video.ended) video.currentTime = 0;
      void play();
    });
    $('lab-quality').addEventListener('change', () => {
      if (!session) { void ensureListenerRoom($('lab-quality').value).catch(() => listenerStatus(null)); return; }
      if (session.quality === $('lab-quality').value) return;
      // A quality choice replaces playback only after that deliberate gesture.
      dispose(session); session = null; controls(); publicDelivery(null); void start();
    });
    $('public-invite')?.addEventListener('click', () => {
      if (!session?.mediaReady) return;
      const invitation = new URL('https://forgesworn.dev/live-media.html');
      invitation.searchParams.set('q', session.quality);
      if (!navigator.clipboard?.writeText) {
        optionalText('public-invite-status', 'Share this listening link: ' + invitation.href);
        return;
      }
      void navigator.clipboard.writeText(invitation.href).then(() => {
        optionalText('public-invite-status', 'Link copied. They’ll join the shared stream live.');
      }).catch(() => {
        optionalText('public-invite-status', 'Share this listening link: ' + invitation.href);
      });
    });
    $('public-live-edge')?.addEventListener('click', () => {
      if (!session) return;
      session.followLive = true;
      void joinListener(session).then(() => { if (session) { followListener(session, true); void play(session); } });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && session && !video.paused && session.followLive !== false) followListener(session);
    }, { signal: pageAbort.signal });
    try {
      const { createSwarmVisual } = await import('./media-swarm-visual.mjs?v=20261024-swarm-calm');
      if (!pageAbort.signal.aborted && $('public-swarm-map')) {
        swarmVisual = createSwarmVisual($('public-swarm-map'));
        publicDelivery(session);
        try {
          const { createMusicPulse } = await import('./media-music-pulse.mjs?v=20261024-swarm-calm');
          if (!pageAbort.signal.aborted) createMusicPulse({ video, container: $('public-swarm-map'), signal: pageAbort.signal,
            getQuality: () => session?.quality ?? $('lab-quality').value, onPulse: value => swarmVisual?.setAudioPulse?.(value) });
        } catch { /* Playback and measured transfers remain available without the decorative pulse. */ }
      }
    } catch { /* Playback and counters remain available without the diagram. */ }
  }
  $('lab-clear').addEventListener('click', () => { runs.length = 0; renderTable(); });
  $('lab-export').addEventListener('click', () => {
    const data = { schema: 1, exportedAt: new Date().toISOString(), runs };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'forgesworn-media-comparison.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && session?.id) session.interrupted = true; });
  window.addEventListener('pagehide', () => {
    clearTimeout(polling); pageAbort.abort();
    detachFullscreen?.();
    swarmVisual?.destroy();
    if (session) {
      if (local && session.id) navigator.sendBeacon?.('/lab/stop', new Blob([JSON.stringify({ runId: session.id })], { type: 'application/json' }));
      dispose(session); session = null;
    }
  }, { once: true });

  try { if (local) {
    const { attachFullscreen } = await import('./media-fullscreen.mjs');
    if (!pageAbort.signal.aborted) {
      detachFullscreen = attachFullscreen({
        container: $('lab-video-wrap'), video, button: $('lab-fullscreen'),
        onError: () => status('Full screen is unavailable here. Playback continues inline.'),
      });
      fullscreenReady = true;
      controls();
    }
  } } catch { /* Playback remains available if this browser cannot offer the fullscreen helper. */ }

  if (root.dataset.resultsUrl) {
    try {
      const url = sameSiteUrl(root.dataset.resultsUrl);
      const response = await fetch(url, { cache: 'no-cache', signal: pageAbort.signal });
      if (response.ok) {
        const receipt = await response.json();
        runs.push(...recordedRuns(receipt)); renderTable();
        if (!local && receipt.source) sourceDetails(receipt.source);
        if (!local && receipt.profile) profileDetails(receipt.profile);
        if (runs.length) text('comparison-note', 'Published completed measurements. Each downloadable row retains its source, profile and date. Compare like-for-like windows and hosts; these are recorded observations, not live process readings.');
      }
    } catch { /* A missing optional receipt does not turn the public page into a failed live dashboard. */ }
  }
  if (local) {
    if ($('public-stats-details')) $('public-stats-details').open = true;
    if ($('recorded-details')) $('recorded-details').open = true;
    $('title').innerHTML = 'Same broadcast.<br><em>Compare the servers.</em>';
    text('mode-label', 'Local runner · same-machine measurement');
    try {
      config = await api('/lab/config');
      sourceDetails(config.source); profileDetails(config.profile);
      const host = publicHost(config.host);
      text('mode-label', ['Local runner', host.cpu, host.platform, host.architecture].filter(Boolean).join(' · '));
      const engineSelect = $('lab-engine'); engineSelect.replaceChildren();
      for (const engine of config.engines ?? []) {
        const option = document.createElement('option'); option.value = engine.id; option.textContent = `${human(engine.label)}${engine.available ? '' : ' · not installed'}`; option.disabled = !engine.available; engineSelect.append(option);
      }
      const available = (config.engines ?? []).find((entry) => entry.available);
      if (available) engineSelect.value = available.id;
      const transports = (config.transports ?? []).map((entry) => typeof entry === 'string' ? entry : entry.id).filter((entry) => ['rtmp', 'srt'].includes(entry));
      if (transports.length) {
        $('lab-transport').replaceChildren(...transports.map((entry) => { const option = document.createElement('option'); option.value = entry; option.textContent = entry.toUpperCase(); return option; }));
      }
      if (Array.isArray(config.relays)) {
        $('lab-relay').replaceChildren(...config.relays.map((entry) => { const option = document.createElement('option'); option.value = entry.id; option.textContent = `${human(entry.label)}${entry.available ? '' : ' · not installed'}`; option.disabled = !entry.available; return option; }));
        $('relay-controls').hidden = false;
      }
      text('measurement-scope', 'Live process readings from the local runner. Browser observations come from this player; missing measurements remain a dash.');
      $('public-guide').hidden = true;
      $('lab-mode').dataset.live = 'true';
      showEngineVersion(); controls();
      if (!available) { status('No media server is configured. Supply a Sapflow or MediaMTX executable to the local runner.'); $('lab-run').disabled = true; }
      else status('Ready. Choose a server and press Run to begin the same source at offset 0.');
      void poll();
    } catch {
      config = null;
      status('The comparison runner is not connected. Open the URL printed by the local runner to use your full source.');
      $('public-guide').hidden = false;
      controls();
    }
  } else {
    // Public hosting has recordings, not access to a live server process.
    $('settings-title').textContent = 'Watch the mix';
    document.querySelector('.settings-fields').hidden = true;
    $('engine-version').hidden = true;
    const settingsNote = document.querySelector('.settings > .settings-note:last-child');
    if (settingsNote) settingsNote.textContent = 'Use the video controls for playback, volume and full screen.';
    $('mode-label').textContent = 'Your browser · real playback observations';
    $('comparison-title').closest('section').hidden = !runs.length;
    $('origin-cpu').closest('.metric').hidden = true;
    $('origin-rss').closest('.metric').hidden = true;
    $('http-bytes').closest('.panel').hidden = true;
    $('process-origin-cpu').closest('.processes').hidden = true;
    $('readings-title').closest('section').hidden = !Object.keys(choices).length;
    text('readings-title', 'What this browser plays.');
    text('measurement-scope', 'Live observations from your browser. Server resource measurements belong to the dated recorded runs below.');
    $('first-frame').nextElementSibling.textContent = 'From this Play click to the first frame';
    if (Object.keys(choices).length) {
      $('lab-quality-field').hidden = false;
      $('lab-quality-note').hidden = false;
      for (const option of $('lab-quality').options) option.disabled = !choices[option.value];
      const requested = new URLSearchParams(location.search).get('q');
      $('lab-quality').value = ['full', 'preview'].includes(requested) && choices[requested] ? requested : choices.full ? 'full' : 'preview';
      qualityDetails();
      void ensureListenerRoom($('lab-quality').value).catch(() => listenerStatus(session));
    }
    controls();
    publicDelivery(null);
  }
}

if (typeof document !== 'undefined') void initialise();
