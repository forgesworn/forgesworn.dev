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

test('skipped ticks do not invoke native observation work', () => {
  const p = fixture(); let reads = 0;
  const observe = () => { reads++; return { position: reads }; };
  p.report.record(observe); p.at(400); p.report.record(observe); p.at(800); p.report.record(observe);
  assert.equal(reads, 1);
  p.at(1200); p.report.record(observe);
  assert.equal(reads, 2);
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
