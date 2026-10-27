import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackReport } from '../site/media-playback-report.mjs';

function fixture(options = {}) {
  let at = 0;
  const report = createPlaybackReport({ now: () => at, ...options });
  return { report, at(value) { at = value; } };
}

test('a bounded history samples the existing tick at one-second intervals and exposes truncation', () => {
  const p = fixture({ maxSamples: 3 });
  for (let at = 0; at <= 5_600; at += 400) { p.at(at); p.report.record({ position: at / 1000 }); }
  const result = p.report.snapshot();
  assert.equal(result.totalSamples, 5);
  assert.equal(result.droppedSamples, 2);
  assert.deepEqual(result.samples.map(row => row.elapsedMs), [2400, 3600, 4800]);
  assert.equal(result.retainedWindowMs, 2400);
  assert.equal(result.captureElapsedMs, 4800);
  assert.equal(result.kind, 'forgesworn-playback-report');
});

test('unavailable observations stay null while genuine measured zeros survive', () => {
  const p = fixture(); p.report.record({ peerBytes: 0, uploadedBytes: null, sourceNetworkBodyBytes: undefined,
    width: 0, paused: false, stallCount: 0, position: 0, buffered: [] });
  const sample = p.report.snapshot().samples[0];
  assert.equal(sample.peerBytes, 0); assert.equal(sample.uploadedBytes, null); assert.equal(sample.sourceNetworkBodyBytes, null);
  assert.equal(sample.width, null); assert.equal(sample.paused, false); assert.equal(sample.stallCount, 0);
  assert.deepEqual(sample.buffered, []); assert.equal(sample.bufferedSeconds, 0);
  assert.equal(sample.totalVideoFrames, null); assert.equal(sample.connections, null);
});

test('peer attempts distinguish verified pieces lost to HTTP from commitment refusal without crediting playback', () => {
  const p = fixture();
  p.report.record({ peerBytes: 0, peerAttemptDiagnostics: {
    integrityRejected: 0,
    diagnostics: { zeroBudgetPeerRaces: 3, zeroBudgetPeerRaceWins: 0, commitmentUnavailable: 0,
      commitmentRejected: 0, peerCorrupt: 0, peerNoFit: 1,
      eligibility: { 'no-have-no-wait': 2, 'have-at-entry': 3, 'no-budget': 4 } },
    core: { multiHolder: { transfers: 3, delivered: 0, failed: 1, bans: 0, abandoned: 2,
      peerBytes: 131072, unusedBytes: 65536, originRangesIgnored: 0 } },
  } });
  p.at(1200);
  p.report.record({ peerBytes: 0, peerAttemptDiagnostics: {
    integrityRejected: 7, diagnostics: { commitmentRejected: 7, peerCorrupt: 0, commitmentUnavailable: 1 },
    core: { multiHolder: { transfers: 0, delivered: 0, peerBytes: 0 } },
  } });
  const [partial, rejected] = p.report.snapshot().samples;
  assert.equal(partial.peerBytes, 0, 'attempted verified pieces are not accepted playback bytes');
  assert.deepEqual(partial.peerAttemptDiagnostics, {
    zeroBudgetPeerRaces: 3, zeroBudgetPeerRaceWins: 0,
    multiHolderTransfers: 3, multiHolderDelivered: 0, multiHolderFailed: 1, multiHolderBans: 0,
    multiHolderAbandoned: 2, multiHolderPeerBytes: 131072, multiHolderUnusedBytes: 65536,
    multiHolderOriginRangesIgnored: 0, commitmentUnavailable: 0, integrityRejected: 0,
    commitmentRejected: 0, peerCorrupt: 0, peerNoFit: 1,
    noHaveNoWait: 2, haveAtEntry: 3, noBudget: 4,
  });
  assert.equal(rejected.peerAttemptDiagnostics.commitmentRejected, 7);
  assert.equal(rejected.peerAttemptDiagnostics.multiHolderTransfers, 0);
  assert.equal(rejected.peerAttemptDiagnostics.multiHolderPeerBytes, 0);
  assert.equal(rejected.peerBytes, 0);
});

test('peer diagnostics keep missing or invalid counters unknown and never serialize SDK payloads', () => {
  const p = fixture(); p.report.record({});
  p.at(1200); p.report.record({ peerAttemptDiagnostics: { integrityRejected: 0, diagnostics: {} } });
  p.at(2400); p.report.record({ peerAttemptDiagnostics: [] });
  const missing = p.report.snapshot().samples;
  assert.equal(missing[0].peerAttemptDiagnostics, null);
  assert.equal(missing[2].peerAttemptDiagnostics, null);
  assert.equal(Object.keys(missing[1].peerAttemptDiagnostics).length, 18);
  assert.ok(Object.values(missing[1].peerAttemptDiagnostics).every(value => value === null),
    'an older SDK cannot manufacture zero diagnostics');
  let serializedUnknown = false;
  const secret = { toJSON() { serializedUnknown = true; return 'credential-secret'; } };
  const poisoned = { integrityRejected: 8, diagnostics: {
    zeroBudgetPeerRaces: '0', zeroBudgetPeerRaceWins: -1, commitmentUnavailable: NaN,
    commitmentRejected: Number.MAX_SAFE_INTEGER + 1, peerCorrupt: Infinity, peerNoFit: 0.5,
    eligibility: { 'no-have-no-wait': 0, 'have-at-entry': Number.MAX_SAFE_INTEGER, 'no-budget': secret,
      'private-key': secret }, records: [secret], ticket: 'ticket-secret', credential: 'credential-secret',
  }, core: { multiHolder: { transfers: 0, delivered: 0, failed: null, bans: false, abandoned: {},
    peerBytes: -1, unusedBytes: 0, originRangesIgnored: '1', holder: secret, key: secret,
    url: 'https://private.invalid/credential-secret' } },
    topology: secret, sdp: 'sdp-secret', addresses: '192.0.2.1', owner: secret };
  p.at(3600); p.report.record({ peerAttemptDiagnostics: poisoned });
  const row = p.report.snapshot().samples.at(-1), d = row.peerAttemptDiagnostics;
  assert.equal(d.multiHolderTransfers, 0); assert.equal(d.multiHolderUnusedBytes, 0);
  assert.equal(d.noHaveNoWait, 0); assert.equal(d.haveAtEntry, Number.MAX_SAFE_INTEGER);
  for (const name of ['zeroBudgetPeerRaces', 'zeroBudgetPeerRaceWins', 'commitmentUnavailable',
    'commitmentRejected', 'peerCorrupt', 'peerNoFit', 'multiHolderFailed', 'multiHolderBans',
    'multiHolderAbandoned', 'multiHolderPeerBytes', 'multiHolderOriginRangesIgnored', 'integrityRejected', 'noBudget']) {
    assert.equal(d[name], null, name);
  }
  const output = JSON.stringify(p.report.snapshot());
  assert.equal(serializedUnknown, false);
  assert.doesNotMatch(output, /secret|private-key|private\.invalid|192\.0\.2\.1|"(?:records|ticket|credential|topology|sdp|addresses|owner)"\s*:/);
  assert.equal(p.report.snapshot().maxSamples, 240);
  p.at(4800); p.report.record({ peerAttemptDiagnostics: {
    core: { multiHolder: Object.assign([], { transfers: 3 }) },
  } });
  assert.equal(p.report.snapshot().samples.at(-1).peerAttemptDiagnostics.multiHolderTransfers, null);
});

test('unreadable peer diagnostics remain unknown without discarding or aliasing playback observations', () => {
  const p = fixture();
  const input = { position: 3, peerAttemptDiagnostics: { core: {}, diagnostics: {
    commitmentRejected: 0, peerCorrupt: 0, peerNoFit: 2 }, integrityRejected: 0 } };
  Object.defineProperty(input.peerAttemptDiagnostics.core, 'multiHolder', { get() { throw new Error('private getter'); } });
  Object.defineProperty(input.peerAttemptDiagnostics.diagnostics, 'commitmentUnavailable', { get() { throw new Error('private getter'); } });
  assert.equal(p.report.record(input), true);
  input.peerAttemptDiagnostics.diagnostics.peerNoFit = 99;
  const first = p.report.snapshot().samples[0];
  assert.equal(first.position, 3); assert.equal(first.peerAttemptDiagnostics.multiHolderTransfers, null);
  assert.equal(first.peerAttemptDiagnostics.commitmentUnavailable, null);
  assert.equal(first.peerAttemptDiagnostics.peerNoFit, 2);
  first.peerAttemptDiagnostics.peerNoFit = 100;
  assert.equal(p.report.snapshot().samples[0].peerAttemptDiagnostics.peerNoFit, 2);
});

test('skipped ticks do not invoke native observation work', () => {
  const p = fixture(); let reads = 0;
  const observe = () => { reads++; return { position: reads }; };
  p.report.record(observe); p.at(400); p.report.record(observe); p.at(800); p.report.record(observe);
  assert.equal(reads, 1);
  p.at(1200); p.report.record(observe);
  assert.equal(reads, 2);
});

test('play rejection diagnostics retain only fixed error names and never messages or arbitrary values', () => {
  const p = fixture();
  p.report.record({ lastPlayError: 'NotAllowedError', playErrorMessage: 'credential-secret' });
  p.at(1200); p.report.record({ lastPlayError: 'https://private.invalid/credential-secret' });
  p.at(2400); p.report.record({ lastPlayError: null });
  assert.deepEqual(p.report.snapshot().samples.map(row => row.lastPlayError), ['NotAllowedError', null, null]);
  assert.doesNotMatch(JSON.stringify(p.report.snapshot()), /secret|private[.]invalid|playErrorMessage/);
});

test('player failures retain fixed engine codes and fallback state without error payloads or identities', () => {
  const p = fixture();
  p.report.record({ lastPlayerError: { type: 'mediaError', detail: 'bufferAppendError', fatal: true,
    message: 'credential-secret', url: 'https://private.invalid' }, playbackFailed: true, playbackFallback: 'player-error' });
  p.at(1200); p.report.record({ lastPlayerError: { type: 'native', mediaErrorCode: 3 } });
  p.at(2400); p.report.record({ lastPlayerError: { type: 'device-secret', detail: 'credential-secret',
    fatal: 'true', mediaErrorCode: 99 }, playbackFailed: 'true', playbackFallback: 'private-secret' });
  const rows = p.report.snapshot().samples;
  assert.deepEqual(rows[0].lastPlayerError, { type: 'mediaError', detail: 'bufferAppendError', fatal: true, mediaErrorCode: null, fragment: null });
  assert.equal(rows[0].playbackFailed, true); assert.equal(rows[0].playbackFallback, 'player-error');
  assert.deepEqual(rows[1].lastPlayerError, { type: 'native', detail: null, fatal: null, mediaErrorCode: 3, fragment: null });
  assert.deepEqual(rows[2].lastPlayerError, { type: null, detail: null, fatal: null, mediaErrorCode: null, fragment: null });
  assert.equal(rows[2].playbackFailed, null); assert.equal(rows[2].playbackFallback, null);
  assert.doesNotMatch(JSON.stringify(p.report.snapshot()), /secret|private[.]invalid|message|url/);
});

test('startup diagnostics distinguish a cancelled barrier, suspended buffering and an uncommitted room', () => {
  const p = fixture();
  p.report.record({ startupPending: true, playbackWanted: true, roomPrepared: true, roomReady: false,
    startupBuffer: { enabled: true, state: 'cancelled', reason: 'caller-abort', released: 0, failures: 0,
      cancellations: 1, commitStarted: false, commitCompleted: false, owner: 'private-owner' },
    hls: { loadingEnabled: true, bufferingEnabled: false, main: { state: 'FRAG_LOADING', sn: 0, cc: 0, type: 'main', url: 'https://private.invalid' } },
    mediaSource: { readyState: 'open', streaming: false },
    lastPlayerError: { type: 'networkError', detail: 'aborted', fatal: false,
      fragment: { sn: 'initSegment', cc: 0, type: 'main', url: 'https://private.invalid' } } });
  const row = p.report.snapshot().samples[0];
  assert.deepEqual(row.startupBuffer, { enabled: true, state: 'cancelled', reason: 'caller-abort',
    released: 0, failures: 0, cancellations: 1, commitStarted: false, commitCompleted: false });
  assert.deepEqual(row.hls, { loadingEnabled: true, bufferingEnabled: false,
    main: { state: 'FRAG_LOADING', sn: 0, cc: 0, type: 'main' } });
  assert.deepEqual(row.mediaSource, { readyState: 'open', streaming: false });
  assert.deepEqual(row.lastPlayerError.fragment, { sn: 'initSegment', cc: 0, type: 'main' });
  assert.equal(row.startupPending, true); assert.equal(row.playbackWanted, true);
  assert.equal(row.roomPrepared, true); assert.equal(row.roomReady, false);
  assert.doesNotMatch(JSON.stringify(row), /private|owner|https?:/);
});

test('missing and older-engine diagnostics remain unavailable while genuine false and zero survive', () => {
  const p = fixture(); p.report.record({});
  const missing = p.report.snapshot().samples[0];
  for (const key of ['startupBuffer', 'hls', 'mediaSource', 'startupPending', 'playbackWanted', 'roomPrepared', 'roomReady']) {
    assert.equal(missing[key], null, key);
  }
  p.at(1200); p.report.record({ startupPending: false, playbackWanted: false, roomPrepared: false, roomReady: false,
    startupBuffer: { enabled: false, state: 'off', released: 0, failures: 0, cancellations: 0, commitStarted: false, commitCompleted: false },
    hls: { loadingEnabled: false, bufferingEnabled: false, main: { state: 'STOPPED' } }, mediaSource: { readyState: 'closed' } });
  const row = p.report.snapshot().samples[1];
  assert.equal(row.startupBuffer.released, 0); assert.equal(row.startupBuffer.enabled, false);
  assert.equal(row.startupPending, false); assert.equal(row.playbackWanted, false);
  assert.equal(row.roomPrepared, false); assert.equal(row.roomReady, false);
  assert.deepEqual(row.hls.main, { state: 'STOPPED', sn: null, cc: null, type: null });
  assert.deepEqual(row.mediaSource, { readyState: 'closed', streaming: null });
});

test('diagnostic enums, one-shot counters and fragment numbers cannot carry arbitrary payloads', () => {
  const p = fixture(); p.report.record({ startupPending: 'true', playbackWanted: 1, roomPrepared: 'false', roomReady: 'secret',
    startupBuffer: { enabled: 'yes', state: 'private-state', reason: 'credential-secret', released: 2, failures: -1,
      cancellations: 0.5, commitStarted: 'true', commitCompleted: 1, context: { key: 'private-key' } },
    hls: { loadingEnabled: 1, bufferingEnabled: 'false', main: { state: 'private-state', sn: '42', cc: Infinity,
      type: 'https://private.invalid', address: '192.0.2.1', sdp: 'secret' } },
    mediaSource: { readyState: 'private-state', streaming: 0, objectUrl: 'blob:private' },
    lastPlayerError: { fragment: { sn: Number.MAX_SAFE_INTEGER + 1, cc: -1, type: 'private-type' } } });
  const row = p.report.snapshot().samples[0];
  assert.deepEqual(row.startupBuffer, { enabled: null, state: null, reason: null, released: null,
    failures: null, cancellations: null, commitStarted: null, commitCompleted: null });
  assert.deepEqual(row.hls, { loadingEnabled: null, bufferingEnabled: null,
    main: { state: null, sn: null, cc: null, type: null } });
  assert.deepEqual(row.mediaSource, { readyState: null, streaming: null });
  assert.deepEqual(row.lastPlayerError.fragment, { sn: null, cc: null, type: null });
  assert.equal(row.startupPending, null); assert.equal(row.playbackWanted, null);
  assert.equal(row.roomPrepared, null); assert.equal(row.roomReady, null);
  assert.doesNotMatch(JSON.stringify(row), /private|secret|192\.0\.2\.1|blob:/);
});

test('unreadable diagnostic getters cannot discard the rest of a sample or mutate stored readings', () => {
  const p = fixture();
  const startup = { state: 'failed', reason: 'deadline', failures: 1 };
  Object.defineProperty(startup, 'released', { get() { throw new Error('private getter'); } });
  const main = { state: 'WAITING_LEVEL', sn: 7, cc: 1, type: 'main' };
  const input = { position: 4, startupBuffer: startup, hls: { main }, mediaSource: { readyState: 'ended', streaming: false } };
  Object.defineProperty(input, 'roomReady', { get() { throw new Error('private getter'); } });
  assert.equal(p.report.record(input), true);
  startup.reason = 'private-mutation'; main.sn = 999;
  const row = p.report.snapshot().samples[0];
  assert.equal(row.position, 4); assert.equal(row.startupBuffer.reason, 'deadline'); assert.equal(row.startupBuffer.released, null);
  assert.equal(row.hls.main.sn, 7); assert.equal(row.roomReady, null);
  row.hls.main.sn = 123; row.startupBuffer.failures = 0;
  assert.equal(p.report.snapshot().samples[0].hls.main.sn, 7);
  assert.equal(p.report.snapshot().samples[0].startupBuffer.failures, 1);
});

test('a continuous recording retains raw media time and independently bounded programme phase', () => {
  const p = fixture();
  p.report.record({ position: 701.75, duration: Infinity, buffered: [[699, 721]],
    playbackMode: 'recorded-live', recordingPosition: 12.55, recordingDuration: 268.6 });
  p.at(1200); p.report.record({ playbackMode: 'https://private.invalid', recordingPosition: 268.6, recordingDuration: 268.6 });
  p.at(2400); p.report.record({ recordingPosition: 0, recordingDuration: 0 });
  const [first, boundary, invalid] = p.report.snapshot().samples;
  assert.equal(first.position, 701.75); assert.equal(first.duration, null);
  assert.equal(first.bufferedSeconds, 19.25); assert.equal(first.playbackMode, 'recorded-live');
  assert.equal(first.recordingPosition, 12.55); assert.equal(first.recordingDuration, 268.6);
  assert.equal(boundary.recordingPosition, null); assert.equal(boundary.playbackMode, null);
  assert.equal(invalid.recordingPosition, null); assert.equal(invalid.recordingDuration, null);
  assert.doesNotMatch(JSON.stringify(p.report.snapshot()), /private[.]invalid/);
});

test('partial source classification cannot present known subset bytes as complete network totals', () => {
  for (const coverage of ['partial', 'unavailable', undefined]) {
    const p = fixture(); p.report.record({ sourceTimingCoverage: coverage, sourceNetworkBodyBytes: 0, sourceCacheBodyBytes: 6000 });
    const row = p.report.snapshot().samples[0];
    assert.equal(row.sourceNetworkBodyBytes, null); assert.equal(row.sourceCacheBodyBytes, null);
  }
  const p = fixture(); p.report.record({ sourceTimingCoverage: 'complete', sourceNetworkBodyBytes: 0, sourceCacheBodyBytes: 6000 });
  assert.equal(p.report.snapshot().samples[0].sourceNetworkBodyBytes, 0);
});

test('buffer coverage is continuous and unreadable or incomplete ranges are unavailable', () => {
  for (const [buffered, position, expected] of [
    [[[0, 2], [2.2, 8]], 1, 1], [[[0, 2], [2.2, 8]], 2.1, 0],
    [null, 1, null], [[[1, 1]], 1, null], [Array.from({ length: 9 }, (_, i) => [i, i + 1]), 1, null],
  ]) {
    const p = fixture(); p.report.record({ buffered, position });
    assert.equal(p.report.snapshot().samples[0].bufferedSeconds, expected);
  }
});

test('only vetted route enums and media counters survive, with no peer or transport identity', () => {
  const p = fixture(); p.report.record({ connections: [
    { state: 'connected', id: 'transport-secret', peerId: 'peer-secret', kind: 'relay', localCandidateType: 'relay',
      remoteCandidateType: 'srflx', localRelayProtocol: 'tls', remoteRelayProtocol: null, mediaBytesSent: 64, verifiedMediaBytesReceived: 12,
      address: '192.0.2.1', sdp: 'sdp-secret', credentials: { username: 'turn-secret' } },
    { state: 'connecting', kind: 'direct', mediaBytesSent: 999 },
    { state: 'connected', kind: 'https://private.invalid', localCandidateType: 'device-secret', localRelayProtocol: 'credential-secret' },
  ] });
  const routes = p.report.snapshot().samples[0].connections;
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0], { kind: 'relay', localCandidateType: 'relay', remoteCandidateType: 'srflx',
    localRelayProtocol: 'tls', remoteRelayProtocol: null, mediaBytesSent: 64, verifiedMediaBytesReceived: 12 });
  assert.equal(routes[1].kind, null); assert.equal(routes[1].localCandidateType, null); assert.equal(routes[1].localRelayProtocol, null);
  assert.doesNotMatch(JSON.stringify(p.report.snapshot()), /secret|192\.0\.2\.1|private[.]invalid/);
});

test('reports copy only explicit playback fields, never source paths, identities or credentials', () => {
  const p = fixture(); p.report.record({ engine: 'hls.js · ManagedMediaSource', quality: 'full', width: 3840, height: 2160,
    library: { version: '0.4.4', sourceCommit: 'a'.repeat(40), privateKey: 'key-secret', url: 'file:///private/source' },
    transferWorkerState: 'ready', transferWorkerReason: 'credential-secret',
    source: '/Users/private/source.mp4', location: 'https://private.invalid', sdk: { ticket: 'ticket-secret' },
    peerId: 'peer-secret', userAgent: 'device-secret', peerBytes: 123, stallCount: 1, stallSeconds: 0.22 });
  const result = p.report.snapshot(), row = result.samples[0];
  assert.equal(row.engine, 'hls.js · ManagedMediaSource'); assert.equal(row.width, 3840); assert.equal(row.height, 2160);
  assert.deepEqual(row.library, { version: '0.4.4', sourceCommit: 'a'.repeat(40) });
  assert.equal(row.stallSeconds, 0.22);
  assert.equal(row.transferWorkerState, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /secret|\/Users|file:\/\/|private[.]invalid/);
});

test('export snapshots cannot mutate retained observations or the supplied buffer and route objects', () => {
  const p = fixture(), buffered = [[0, 8]], routes = [{ state: 'connected', mediaBytesSent: 8 }];
  p.report.record({ position: 1, buffered, connections: routes });
  buffered[0][1] = 500; routes[0].mediaBytesSent = 999;
  const first = p.report.snapshot(); first.samples[0].buffered[0][1] = 100; first.samples.length = 0;
  const second = p.report.snapshot();
  assert.equal(second.samples.length, 1); assert.equal(second.samples[0].buffered[0][1], 8);
  assert.equal(second.samples[0].connections[0].mediaBytesSent, 8);
});

test('invalid values and clock readings cannot fabricate measurements', () => {
  const p = fixture({ startedAt: 100 });
  p.at(99); assert.equal(p.report.record({}), false);
  p.at(NaN); assert.equal(p.report.record({}), false);
  p.at(100); assert.equal(p.report.record({ peerBytes: '0', uploadedBytes: -1, width: Infinity, visibility: 'private-data', library: {} }), true);
  p.at(50); assert.equal(p.report.record({}), false);
  const row = p.report.snapshot().samples[0];
  assert.equal(row.peerBytes, null); assert.equal(row.uploadedBytes, null); assert.equal(row.width, null); assert.equal(row.visibility, null);
  assert.deepEqual(row.library, { version: null, sourceCommit: null });
  for (const maxSamples of [0, 241, Infinity, 1.5]) assert.throws(() => fixture({ maxSamples }), TypeError);
});
