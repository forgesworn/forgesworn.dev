import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedTopology } from '../site/media-swarm-visual.mjs';

test('the connection picture uses observed connections rather than aggregate or invented viewer counts', () => {
  assert.deepEqual(observedTopology({ connectedPeers: 500, uploadedBytes: 1000 }), []);
  assert.deepEqual(observedTopology({ topology: { connections: [
    { id: 'peer-1', state: 'connected', bytesSent: 50, bytesReceived: 20, kind: 'direct' },
    { id: 'peer-2', state: 'connecting', bytesSent: null, bytesReceived: null },
    { id: 'peer-1', state: 'connected', bytesSent: 800 },
    { id: 'peer-3', state: 'closed', bytesSent: 1 },
    { id: '<script>', state: 'connected' },
  ] } }), [
    { id: 'peer-1', state: 'connected', bytesSent: 50, bytesReceived: 20, kind: 'direct' },
    { id: 'peer-2', state: 'connecting', bytesSent: 0, bytesReceived: 0, kind: 'direct' },
  ]);
});
