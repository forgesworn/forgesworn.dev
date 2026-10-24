import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VISUAL_PEERS, observedTopology, observedRoomTopology, createTrafficWindow, peerDeliveryShare, swarmLayout } from '../site/media-swarm-visual.mjs';

const NOW = 1_800_000_000_000;
const authors = ['a', 'b', 'c'].map(value => value.repeat(64));
const sdkKeys = ['1', '2', '3'].map(value => value.repeat(64));
function roomFixture() {
  return { active: true, playing: true, viewerId: sdkKeys[0], originBytes: 1000, peerBytes: 400,
    topology: { connections: [
      { id: 'peer-b', peerId: sdkKeys[1], state: 'connected', mediaBytesSent: 42, verifiedMediaBytesReceived: 100 },
      { id: 'peer-c', peerId: sdkKeys[2], state: 'connected', mediaBytesSent: 84, verifiedMediaBytesReceived: 300 },
    ] }, room: { id: authors[0], observed: true, ready: true, listeners: 3, members: authors.map((id, index) => ({
      id, isSelf: index === 0, expiresAt: NOW + 30_000, telemetryExpiresAt: NOW + 12_000,
      telemetry: { peerId: sdkKeys[index], sampledAt: NOW, positionMs: 10_000, following: true,
        originBytes: (index + 1) * 1000, peerBytes: 400, uploadedBytes: 100,
        connections: index === 1 ? [{ peerId: sdkKeys[2], sentBytes: 5000, receivedBytes: 2000 },
          { peerId: sdkKeys[0], sentBytes: 9_999_999, receivedBytes: 9_999_999 }] :
          index === 2 ? [{ peerId: sdkKeys[1], sentBytes: 2400, receivedBytes: 4800 }] : [],
      },
    })) } };
}

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

test('the room picture distinguishes local measurements, reported peer links and reported source feeds', () => {
  const model = observedRoomTopology(roomFixture(), NOW);
  assert.equal(model.self.label, 'You · Listener 1');
  assert.deepEqual(model.members.map(member => member.label), ['Listener 2', 'Listener 3']);
  assert.equal(model.edges.filter(edge => edge.kind === 'native-peer').length, 2);
  assert.equal(model.edges.filter(edge => edge.kind === 'origin').length, 1);
  assert.equal(model.edges.filter(edge => edge.kind === 'reported-origin').length, 2);
  const reported = model.edges.filter(edge => edge.kind === 'reported-peer');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].from, authors[1]); assert.equal(reported[0].to, authors[2]);
  assert.equal(reported[0].forward.value, 4800, 'the receiver-reported verified total takes priority over a sender report');
  assert.equal(reported[0].reverse.value, 2000);
  assert.equal(model.edges.find(edge => edge.id === 'native-peer-b').forward.value, 42, 'remote reports never overwrite locally measured bytes');
});

test('room presence alone supplies hollow members and never invents their media links', () => {
  const metrics = roomFixture();
  for (const member of metrics.room.members) member.telemetry = null;
  const model = observedRoomTopology(metrics, NOW);
  assert.equal(model.members.length, 2);
  assert(model.members.every(member => !member.connected && !member.report));
  assert.equal(model.edges.length, 1, 'only the known host-to-this-browser path remains');
  assert.equal(model.unmappedConnections, 2, 'unmapped native connections do not duplicate known room members');
});

test('an observer sees the real room roster without becoming an extra listener', () => {
  const metrics = roomFixture(); metrics.active = metrics.playing = false;
  metrics.viewerId = metrics.room.id = null;
  metrics.topology.connections = [];
  metrics.room.members.shift(); metrics.room.listeners = 2;
  const model = observedRoomTopology(metrics, NOW);
  assert.equal(model.roomAvailable, true); assert.equal(model.roomMemberCount, 2);
  assert.equal(model.self.label, 'You · not listening'); assert.equal(model.self.roomMember, false);
  assert.deepEqual(model.members.map(member => member.label), ['Listener 1', 'Listener 2']);
  assert.equal(model.edges.filter(edge => edge.kind === 'reported-peer').length, 1);
  metrics.room.members = []; metrics.room.listeners = 0;
  const empty = observedRoomTopology(metrics, NOW);
  assert.equal(empty.roomAvailable, true); assert.equal(empty.roomMemberCount, 0); assert.equal(empty.members.length, 0);
});

test('stale reports lose remote edges while cached unique identity keeps authoritative local nodes stable', () => {
  const remembered = new Map(), metrics = roomFixture();
  const first = observedRoomTopology(metrics, NOW, remembered);
  const stale = observedRoomTopology(metrics, NOW + 13_000, remembered);
  assert.deepEqual(stale.members.map(member => member.id), first.members.map(member => member.id));
  assert(stale.members.every(member => member.connected && member.report === null));
  assert.equal(stale.edges.filter(edge => edge.kind.startsWith('reported')).length, 0);
  assert.equal(stale.edges.filter(edge => edge.kind === 'native-peer').length, 2);
  metrics.topology.connections[0].id = 'peer-b-replay';
  assert.deepEqual(observedRoomTopology(metrics, NOW + 13_000, remembered).members.map(member => member.label), ['Listener 2', 'Listener 3']);
});

test('ambiguous SDK identity claims cannot assign native bytes or remote reports to a room member', () => {
  const metrics = roomFixture(); metrics.room.members[2].telemetry.peerId = sdkKeys[1];
  const model = observedRoomTopology(metrics, NOW);
  assert.equal(model.ambiguousClaims, 1);
  assert.equal(model.edges.filter(edge => edge.kind.startsWith('reported')).length, 0);
  assert.equal(model.edges.filter(edge => edge.kind === 'native-peer').length, 0);
  assert.equal(model.members.length, 2);
});

test('listener telemetry accepts the coordinator clock allowance and rejects expired reports', () => {
  const metrics = roomFixture();
  metrics.room.members[1].telemetry.sampledAt = NOW + 4000;
  metrics.room.members[1].telemetryExpiresAt = NOW + 16_000;
  assert(observedRoomTopology(metrics, NOW).members[0].report);
  metrics.room.members[1].telemetryExpiresAt = NOW;
  assert.equal(observedRoomTopology(metrics, NOW).members[0].report, null);
});

test('the rolling video window ignores repeated reports, gaps and counter resets', () => {
  const traffic = createTrafficWindow();
  assert.deepEqual(traffic.observe('reported-a', 0, NOW, NOW), { delta: 0, rate: 0 });
  assert.deepEqual(traffic.observe('reported-a', 1000, NOW + 1000, NOW + 1000), { delta: 1000, rate: 100 });
  assert.deepEqual(traffic.observe('reported-a', 1000, NOW + 1000, NOW + 2000), { delta: 0, rate: 100 });
  assert.deepEqual(traffic.observe('reported-a', 99_999, NOW + 1000, NOW + 3000), { delta: 0, rate: 100 });
  assert.deepEqual(traffic.observe('reported-a', 1000, NOW + 1000, NOW + 11_000), { delta: 0, rate: 0 });
  assert.deepEqual(traffic.observe('reported-a', 2000, NOW + 12_000, NOW + 12_000), { delta: 0, rate: 0 });
  assert.deepEqual(traffic.observe('reported-a', 10, NOW + 12_500, NOW + 12_500), { delta: 0, rate: 0 });
  assert.deepEqual(traffic.observe('reported-a', 35, NOW + 13_000, NOW + 13_000), { delta: 25, rate: 2.5 });
});

test('peer delivery strength is received verified video share, with no health score for empty or unknown traffic', () => {
  assert.equal(peerDeliveryShare(600, 400), .4);
  assert.equal(peerDeliveryShare(1000, 0), 0);
  assert.equal(peerDeliveryShare(0, 0), null);
  assert.equal(peerDeliveryShare(null, 400), null);
  assert.equal(peerDeliveryShare(-1, 400), null);
});

test('small and wide room pictures reserve enough space for every listener instead of shrinking crowded labels', () => {
  for (const width of [240, 288, 320, 358, 390, 600, 780, 1024, 1440]) for (let count = 0; count <= 10; count++) {
    const layout = swarmLayout(width, count), points = [layout.origin, layout.self, ...layout.positions];
    assert.equal(layout.positions.length, count);
    for (const point of points) {
      assert(point.x - point.radius >= 0 && point.x + point.radius <= layout.width, `${width}px: horizontal node clipping`);
      assert(point.y - point.radius >= 0 && point.y + 50 <= layout.height, `${width}px: vertical node or label clipping`);
    }
    for (let first = 0; first < points.length; first++) for (let second = first + 1; second < points.length; second++) {
      const a = points[first], b = points[second];
      assert(Math.abs(a.x - b.x) >= 75 || Math.abs(a.y - b.y) >= 95, `${width}px / ${count} listeners: crowding`);
    }
  }
});
