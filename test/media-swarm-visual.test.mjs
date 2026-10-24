import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VISUAL_PEERS, observedTopology } from '../site/media-swarm-visual.mjs';

test('the connection picture uses observed connections rather than aggregate or invented viewer counts', () => {
  assert.deepEqual(observedTopology({ connectedPeers: 500, uploadedBytes: 1000 }), []);
  assert.deepEqual(observedTopology({ topology: { connections: [
    { id: 'peer-1', state: 'connected', bytesSent: 500, bytesReceived: 200, mediaBytesSent: 50, verifiedMediaBytesReceived: 20, kind: 'direct' },
    { id: 'peer-2', state: 'connecting', bytesSent: null, bytesReceived: null },
    { id: 'peer-1', state: 'connected', bytesSent: 800 },
    { id: 'peer-3', state: 'closed', bytesSent: 1 },
    { id: '<script>', state: 'connected' },
  ] } }), [
    { id: 'peer-1', state: 'connected', mediaBytesSent: 50, verifiedMediaBytesReceived: 20, kind: 'direct' },
  ]);
});

test('negotiating and retired connections never appear as additional listeners', () => {
  assert.deepEqual(observedTopology({ topology: { connections: [
    { id: 'peer-21', state: 'new' },
    { id: 'peer-22', state: 'connecting' },
    { id: 'peer-23', state: 'failed' },
    { id: 'peer-24', state: 'disconnected' },
    { id: 'peer-25', state: 'closed' },
    { id: 'peer-26', state: 'connected', mediaBytesSent: 81 },
    { id: 'peer-26', state: 'connecting' },
  ] } }), [{ id: 'peer-26', state: 'connected', kind: 'direct', mediaBytesSent: 81, verifiedMediaBytesReceived: 0 }]);
  assert.deepEqual(observedTopology({ topology: { connections: [
    { id: 'peer-7', state: 'connecting' }, { id: 'peer-7', state: 'connected' },
  ] } }), [{ id: 'peer-7', state: 'connected', kind: 'direct', mediaBytesSent: 0, verifiedMediaBytesReceived: 0 }]);
});

test('the bounded picture can display ten current listeners without lifetime-id truncation', () => {
  const connections = Array.from({ length: 15 }, (_, index) => ({ id: `peer-${index + 101}`, state: 'connected' }));
  const observed = observedTopology({ topology: { connections } });
  assert.equal(MAX_VISUAL_PEERS, 10);
  assert.equal(observed.length, 10);
  assert.deepEqual(observed.map(peer => peer.id), connections.slice(0, 10).map(peer => peer.id));
  const remaining = observedTopology({ topology: { connections: connections.slice(5, 10) } });
  assert.equal(remaining.length, 5);
  assert.deepEqual(remaining.map(peer => peer.id), ['peer-106', 'peer-107', 'peer-108', 'peer-109', 'peer-110']);
});

test('protocol-only and unverified RTC traffic never becomes graph video traffic', () => {
  assert.deepEqual(observedTopology({ topology: { connections: [
    { id: 'peer-1', state: 'connected', bytesSent: 918, bytesReceived: 279479 },
  ] } }), [{ id: 'peer-1', state: 'connected', kind: 'direct', mediaBytesSent: 0, verifiedMediaBytesReceived: 0 }]);
});
