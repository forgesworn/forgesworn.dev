import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedTopology } from '../site/media-swarm-visual.mjs';

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
    { id: 'peer-2', state: 'connecting', mediaBytesSent: 0, verifiedMediaBytesReceived: 0, kind: 'direct' },
  ]);
});

test('protocol-only and unverified RTC traffic never becomes graph video traffic', () => {
  assert.deepEqual(observedTopology({ topology: { connections: [
    { id: 'peer-1', state: 'connected', bytesSent: 918, bytesReceived: 279479 },
  ] } }), [{ id: 'peer-1', state: 'connected', kind: 'direct', mediaBytesSent: 0, verifiedMediaBytesReceived: 0 }]);
});
