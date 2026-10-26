const SAMPLE_INTERVAL_MS = 1_000;
const MAX_SAMPLES = 240;
const value = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
const number = input => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null;
const integer = input => Number.isSafeInteger(input) && input >= 0 ? input : null;
const positiveInteger = input => integer(input) > 0 ? input : null;
const boolean = input => typeof input === 'boolean' ? input : null;
const choice = (input, values) => values.includes(input) ? input : null;
const candidate = input => choice(input, ['host', 'srflx', 'prflx', 'relay']);
const protocol = input => choice(input, ['udp', 'tcp', 'tls']);

function playerError(input) {
  if (!input || typeof input !== 'object') return null;
  // Fixed engine codes only. Error messages, URLs and arbitrary SDK objects
  // can contain private source, transport or credential data.
  return {
    type: choice(value(input, 'type'), ['native', 'networkError', 'mediaError', 'keySystemError', 'muxError', 'otherError']),
    detail: choice(value(input, 'detail'), ['manifestLoadError', 'manifestLoadTimeOut', 'manifestParsingError',
      'manifestIncompatibleCodecsError', 'levelLoadError', 'levelLoadTimeOut', 'levelParsingError',
      'fragLoadError', 'fragLoadTimeOut', 'fragParsingError', 'fragGap', 'remuxAllocError',
      'bufferAddCodecError', 'bufferIncompatibleCodecsError', 'bufferAppendError', 'bufferAppendingError',
      'bufferAppendNoProgress', 'bufferStalledError', 'bufferFullError', 'bufferSeekOverHole',
      'bufferNudgeOnStall', 'internalException', 'aborted', 'attachMediaError', 'mediaSourceRequiresReset', 'unknown']),
    fatal: boolean(value(input, 'fatal')),
    mediaErrorCode: choice(value(input, 'mediaErrorCode'), [1, 2, 3, 4]),
  };
}

function ranges(input) {
  if (!Array.isArray(input) || input.length > 8) return null;
  const result = [];
  for (const range of input) {
    if (!Array.isArray(range) || range.length !== 2 || number(range[0]) === null ||
        number(range[1]) === null || range[1] <= range[0]) return null;
    result.push([range[0], range[1]]);
  }
  return result;
}

function library(input) {
  const version = value(input, 'version'), commit = value(input, 'sourceCommit');
  return {
    version: typeof version === 'string' && version.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version : null,
    sourceCommit: typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit) ? commit : null,
  };
}

function connections(input) {
  if (!Array.isArray(input) || input.length > 10) return null;
  return input.filter(row => value(row, 'state') === 'connected').slice(0, 3).map(row => ({
    kind: choice(value(row, 'kind'), ['direct', 'relay']),
    localCandidateType: candidate(value(row, 'localCandidateType')),
    remoteCandidateType: candidate(value(row, 'remoteCandidateType')),
    localRelayProtocol: protocol(value(row, 'localRelayProtocol')),
    remoteRelayProtocol: protocol(value(row, 'remoteRelayProtocol')),
    mediaBytesSent: integer(value(row, 'mediaBytesSent')),
    verifiedMediaBytesReceived: integer(value(row, 'verifiedMediaBytesReceived')),
  }));
}

function sample(input, elapsedMs) {
  const position = number(value(input, 'position')), buffered = ranges(value(input, 'buffered'));
  const sourceDuration = number(value(input, 'recordingDuration'));
  const recordingDuration = sourceDuration > 0 ? sourceDuration : null;
  const sourcePosition = number(value(input, 'recordingPosition'));
  const sourceTimingCoverage = choice(value(input, 'sourceTimingCoverage'), ['complete', 'partial', 'unavailable']);
  let bufferedSeconds = buffered === null || position === null ? null : 0;
  if (buffered && position !== null) for (const [start, end] of buffered) {
    if (start <= position && end >= position) { bufferedSeconds = end - position; break; }
  }
  return {
    elapsedMs,
    position, duration: number(value(input, 'duration')),
    playbackMode: choice(value(input, 'playbackMode'), ['recorded-live', 'recorded-vod', 'live-server']),
    recordingDuration,
    recordingPosition: recordingDuration !== null && sourcePosition !== null && sourcePosition < recordingDuration ? sourcePosition : null,
    readyState: choice(value(input, 'readyState'), [0, 1, 2, 3, 4]),
    paused: boolean(value(input, 'paused')), seeking: boolean(value(input, 'seeking')), ended: boolean(value(input, 'ended')),
    lastPlayError: choice(value(input, 'lastPlayError'), ['NotAllowedError', 'AbortError', 'NotSupportedError', 'InvalidStateError', 'SecurityError', 'Error']),
    lastPlayerError: playerError(value(input, 'lastPlayerError')),
    playbackFailed: boolean(value(input, 'playbackFailed')),
    playbackFallback: choice(value(input, 'playbackFallback'), ['stalls', 'unexpected-end', 'decode-error', 'player-error']),
    visibility: choice(value(input, 'visibility'), ['visible', 'hidden', 'prerender']),
    quality: choice(value(input, 'quality'), ['full', 'preview']),
    engine: choice(value(input, 'engine'), ['hls.js', 'hls.js · ManagedMediaSource', 'hls.js · MediaSource', 'Native HLS', 'Native MP4']),
    library: library(value(input, 'library')),
    width: positiveInteger(value(input, 'width')), height: positiveInteger(value(input, 'height')),
    presentedWidth: positiveInteger(value(input, 'presentedWidth')), presentedHeight: positiveInteger(value(input, 'presentedHeight')),
    hasPresentedFrame: boolean(value(input, 'hasPresentedFrame')), firstFrameMs: number(value(input, 'firstFrameMs')),
    decodedFrames: integer(value(input, 'decodedFrames')), presentedFrames: integer(value(input, 'presentedFrames')),
    totalVideoFrames: integer(value(input, 'totalVideoFrames')), droppedVideoFrames: integer(value(input, 'droppedVideoFrames')),
    buffered, bufferedSeconds, playbackRate: number(value(input, 'playbackRate')),
    priming: boolean(value(input, 'priming')),
    primingReason: choice(value(input, 'primingReason'), ['buffering', 'buffered', 'buffered-current', 'next-loop', 'timeout-current', 'timeout-unbuffered', 'bootstrap-demand', 'clock-unavailable', 'cancelled', 'complete']),
    following: boolean(value(input, 'following')), sharedDriftSeconds: typeof value(input, 'sharedDriftSeconds') === 'number' && Number.isFinite(value(input, 'sharedDriftSeconds')) ? value(input, 'sharedDriftSeconds') : null,
    waiting: boolean(value(input, 'waiting')), stallCount: integer(value(input, 'stallCount')), stallSeconds: number(value(input, 'stallSeconds')),
    playerErrors: integer(value(input, 'playerErrors')),
    peerBytes: integer(value(input, 'peerBytes')), uploadedBytes: integer(value(input, 'uploadedBytes')),
    loadedSourceBytes: integer(value(input, 'loadedSourceBytes')),
    sourceNetworkBodyBytes: sourceTimingCoverage === 'complete' ? integer(value(input, 'sourceNetworkBodyBytes')) : null,
    sourceCacheBodyBytes: sourceTimingCoverage === 'complete' ? integer(value(input, 'sourceCacheBodyBytes')) : null,
    sourceTimingCoverage,
    peerEnabled: boolean(value(input, 'peerEnabled')), connectedPeers: integer(value(input, 'connectedPeers')),
    transferWorkerState: choice(value(input, 'transferWorkerState'), ['off', 'waiting-core', 'loading', 'ready', 'failed', 'stopped']),
    roomListeners: integer(value(input, 'roomListeners')), connections: connections(value(input, 'connections')),
  };
}

// One observation per second from the controller's existing tick. Inputs are
// copied through an allowlist; no identifiers or arbitrary SDK objects survive.
// This helper owns no timers, browser APIs, network requests or upload path.
export function createPlaybackReport({ now = () => performance.now(), startedAt = null, maxSamples = MAX_SAMPLES } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > MAX_SAMPLES) {
    throw new TypeError('Invalid playback report bounds');
  }
  let origin = number(startedAt), lastAt = null, totalSamples = 0;
  const samples = [];
  return {
    record(input) {
      const at = number(now());
      if (at === null || lastAt !== null && at - lastAt < SAMPLE_INTERVAL_MS) return false;
      origin ??= at;
      if (at < origin) return false;
      // Expensive observations can be supplied lazily; skipped ticks do not
      // perform another native query or build another SDK metrics snapshot.
      try { samples.push(sample(typeof input === 'function' ? input() : input, at - origin)); }
      catch { return false; }
      totalSamples++; lastAt = at;
      if (samples.length > maxSamples) samples.shift();
      return true;
    },
    snapshot() {
      return {
        schema: 1, kind: 'forgesworn-playback-report', sampleIntervalMs: SAMPLE_INTERVAL_MS, maxSamples,
        totalSamples, droppedSamples: totalSamples - samples.length,
        captureElapsedMs: lastAt === null || origin === null ? null : lastAt - origin,
        retainedWindowMs: samples.length < 2 ? 0 : samples.at(-1).elapsedMs - samples[0].elapsedMs,
        notes: [
          'Samples describe this browser playback, not a controlled benchmark or proof of a cold cache.',
          'Loaded source includes browser cache. Network/cache figures are completed response bodies, not total wire traffic.',
          'Null means unavailable. Only connected routes are included; route identities and network addresses are omitted.',
        ],
        samples: structuredClone(samples),
      };
    },
  };
}
