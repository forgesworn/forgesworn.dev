// Manual DOM regressions for traffic attribution and current listener labels.
// These are explicit input observations, not a simulated media benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { chromium } from 'playwright';

const output = process.argv[2] && resolve(process.argv[2]);
assert(output, 'Use node test/media-swarm-visual-browser.mjs PRIVATE-RECEIPT.json');
const receipt = { measuredAt: new Date().toISOString(), scope: 'Graph rendering regression with explicit observation inputs; no media or peers simulated as real',
  passed: false, checks: {}, pageErrors: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', error => receipt.pageErrors.push(String(error)));
  await page.route('https://forgesworn.dev/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/graph-regression') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0}#map{width:100%;height:400px}</style><div id="map"></div>' });
    assert(['/media-swarm-visual.mjs', '/media-transfer-stats.mjs'].includes(path));
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../site' + path, import.meta.url)) });
  });
  await page.goto('https://forgesworn.dev/graph-regression');
  receipt.checks.controlOnly = await page.evaluate(async () => {
    const { createSwarmVisual } = await import('/media-swarm-visual.mjs');
    const map = document.getElementById('map');
    window.graphNow = Date.now();
    Date.now = () => graphNow;
    window.visual = createSwarmVisual(map);
    window.render = () => { graphNow += 1000; visual.update(observations); };
    window.observations = { active: true, playing: true, enabled: true, serving: true, peerBytes: 0, uploadedBytes: 0, originBytes: 0,
      topology: { connections: [
        { id: 'peer-1', state: 'connected', bytesSent: 1008, bytesReceived: 279479 },
        { id: 'peer-2', state: 'connecting' }, { id: 'peer-3', state: 'new' },
      ] } };
    render();
    return { peerNodes: map.querySelectorAll('[data-peer-id]').length, flights: map.querySelectorAll('[data-flight-source]').length,
      label: map.querySelector('[data-peer-id] .swarm-sub').textContent,
      listener: map.querySelector('[data-peer-id] .swarm-label').textContent };
  });
  assert.deepEqual(receipt.checks.controlOnly, { peerNodes: 1, flights: 0, label: 'Connected to you', listener: 'Listener 1' });
  receipt.checks.hostOnly = await page.evaluate(() => {
    observations.originBytes = 6206410; render();
    return { hostFlights: document.querySelectorAll('[data-flight-source="origin"]').length,
      peerFlights: document.querySelectorAll('[data-flight-source^="peer-"]').length };
  });
  assert.equal(receipt.checks.hostOnly.hostFlights, 1); assert.equal(receipt.checks.hostOnly.peerFlights, 0);
  receipt.checks.media = await page.evaluate(() => {
    Object.assign(observations.topology.connections[0], { mediaBytesSent: 918, verifiedMediaBytesReceived: 6206410 });
    Object.assign(observations, { uploadedBytes: 918, peerBytes: 6206410 }); render();
    return { up: document.querySelector('[data-flight-source="peer-upload"]').dataset.bytes,
      down: document.querySelector('[data-flight-source="peer-download"]').dataset.bytes,
      label: document.querySelector('[data-peer-id] .swarm-sub').textContent };
  });
  assert.deepEqual(receipt.checks.media, { up: '918', down: '6206410', label: 'Connected to you' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => Number(document.querySelector('svg').getAttribute('viewBox').split(' ')[2]) === document.getElementById('map').clientWidth);
  receipt.checks.resize = await page.evaluate(() => ({ flights: document.querySelectorAll('[data-flight-source]').length,
    label: document.querySelector('[data-peer-id] .swarm-sub').textContent }));
  assert.equal(receipt.checks.resize.flights, 0); assert.equal(receipt.checks.resize.label, receipt.checks.media.label);
  receipt.checks.paused = await page.evaluate(() => {
    observations.playing = false; observations.topology.connections = []; render();
    return { peerNodes: document.querySelectorAll('[data-peer-id]').length, flights: document.querySelectorAll('[data-flight-source]').length };
  });
  assert.deepEqual(receipt.checks.paused, { peerNodes: 0, flights: 0 });
  receipt.checks.tenListeners = await page.evaluate(() => {
    window.numberedConnections = Array.from({ length: 10 }, (_, index) => ({
      id: `peer-${index + 101}`, state: 'connected', mediaBytesSent: (index + 1) * 1024,
      verifiedMediaBytesReceived: (index + 1) * 2048,
    }));
    observations.playing = false;
    observations.topology.connections = numberedConnections;
    render();
    const map = document.getElementById('map'), nodes = [...map.querySelectorAll('[data-peer-id]')];
    window.retainedNodes = new Map(nodes.map(node => [node.dataset.peerId, node]));
    return { count: nodes.length, labels: nodes.map(node => node.querySelector('.swarm-label').textContent),
      observedPeers: map.dataset.observedPeers, connectedPeers: map.dataset.connectedPeers };
  });
  assert.equal(receipt.checks.tenListeners.count, 10);
  assert.deepEqual(receipt.checks.tenListeners.labels, Array.from({ length: 10 }, (_, index) => `Listener ${index + 1}`));
  assert.equal(receipt.checks.tenListeners.observedPeers, '10');
  assert.equal(receipt.checks.tenListeners.connectedPeers, '10');
  receipt.checks.fiveRemaining = await page.evaluate(() => {
    observations.topology.connections = numberedConnections.slice(5);
    render();
    const nodes = [...document.querySelectorAll('[data-peer-id]')];
    return { count: nodes.length, ids: nodes.map(node => node.dataset.peerId),
      labels: nodes.map(node => node.querySelector('.swarm-label').textContent),
      sameNodes: nodes.every(node => retainedNodes.get(node.dataset.peerId) === node),
      mediaBytesSent: nodes.map(node => node.dataset.mediaBytesSent) };
  });
  assert.equal(receipt.checks.fiveRemaining.count, 5);
  assert.deepEqual(receipt.checks.fiveRemaining.ids, ['peer-106', 'peer-107', 'peer-108', 'peer-109', 'peer-110']);
  assert.deepEqual(receipt.checks.fiveRemaining.labels, ['Listener 1', 'Listener 2', 'Listener 3', 'Listener 4', 'Listener 5']);
  assert.equal(receipt.checks.fiveRemaining.sameNodes, true);
  assert.deepEqual(receipt.checks.fiveRemaining.mediaBytesSent, ['6144', '7168', '8192', '9216', '10240']);
  receipt.checks.retainedTraffic = await page.evaluate(() => {
    observations.playing = true; render();
    const flightsBefore = document.querySelectorAll('[data-flight-source]').length;
    observations.topology.connections[0].mediaBytesSent += 42;
    render();
    return { flightsBefore, uploadDelta: document.querySelector('[data-flight-source="peer-upload"]').dataset.bytes,
      listener: document.querySelector('[data-peer-id="peer-106"] .swarm-label').textContent };
  });
  assert.deepEqual(receipt.checks.retainedTraffic, { flightsBefore: 0, uploadDelta: '42', listener: 'Listener 1' });
  receipt.checks.negotiatingOnly = await page.evaluate(() => {
    observations.playing = false;
    observations.topology.connections = [{ id: 'peer-201', state: 'new' }, { id: 'peer-202', state: 'connecting' }];
    render();
    const map = document.getElementById('map');
    return { peerNodes: map.querySelectorAll('[data-peer-id]').length, flights: map.querySelectorAll('[data-flight-source]').length,
      connectedPeers: map.dataset.connectedPeers, observedPeers: map.dataset.observedPeers };
  });
  assert.deepEqual(receipt.checks.negotiatingOnly, { peerNodes: 0, flights: 0, connectedPeers: '0', observedPeers: '0' });
  receipt.checks.roomBaseline = await page.evaluate(() => {
    const authors = ['a', 'b', 'c'].map(value => value.repeat(64)), sdk = ['1', '2', '3'].map(value => value.repeat(64));
    window.fixtureAuthors = authors; window.fixtureSdk = sdk;
    window.observations = { active: true, playing: true, enabled: true, serving: true, viewerId: sdk[0], originBytes: 0, peerBytes: 0, uploadedBytes: 0,
      topology: { connections: [
        { id: 'room-b', peerId: sdk[1], state: 'connected', mediaBytesSent: 0, verifiedMediaBytesReceived: 0 },
        { id: 'room-c', peerId: sdk[2], state: 'connected', mediaBytesSent: 0, verifiedMediaBytesReceived: 0 },
      ] }, room: { id: authors[0], observed: true, listeners: 3, ready: true, members: authors.map((id, index) => ({
        id, isSelf: index === 0, expiresAt: graphNow + 60_000, telemetryExpiresAt: graphNow + 12_000,
        telemetry: { peerId: sdk[index], sampledAt: graphNow, positionMs: 10_000, following: true, originBytes: 0, peerBytes: 0, uploadedBytes: 0,
          connections: index === 1 ? [{ peerId: sdk[2], sentBytes: 0, receivedBytes: 0 }] :
            index === 2 ? [{ peerId: sdk[1], sentBytes: 0, receivedBytes: 0 }] : [] },
      })) } };
    render();
    window.roomNodes = new Map([...document.querySelectorAll('[data-room-member-id]')].map(node => [node.dataset.roomMemberId, node]));
    return { members: roomNodes.size,
      kinds: [...document.querySelectorAll('[data-edge-kind]')].map(node => node.dataset.edgeKind).sort(),
      names: [...roomNodes.values()].map(node => node.querySelector('.swarm-label').textContent),
      strength: document.querySelector('[data-swarm-strength-value]').textContent };
  });
  assert.equal(receipt.checks.roomBaseline.members, 3);
  assert.deepEqual(receipt.checks.roomBaseline.kinds, ['native-peer', 'native-peer', 'origin', 'reported-origin', 'reported-origin', 'reported-peer'].sort());
  assert.deepEqual(receipt.checks.roomBaseline.names, ['You', 'Listener 2', 'Listener 3']);
  assert.equal(receipt.checks.roomBaseline.strength, 'Waiting for video traffic');
  receipt.checks.measuredRates = await page.evaluate(() => {
    Object.assign(observations, { originBytes: 40_000, peerBytes: 60_000, uploadedBytes: 6000 });
    Object.assign(observations.topology.connections[0], { mediaBytesSent: 5000, verifiedMediaBytesReceived: 20_000 });
    Object.assign(observations.topology.connections[1], { mediaBytesSent: 1000, verifiedMediaBytesReceived: 40_000 });
    for (const [index, member] of observations.room.members.entries()) {
      member.telemetry.sampledAt = graphNow + 1000; member.telemetryExpiresAt = graphNow + 13_000;
      member.telemetry.originBytes = (index + 1) * 10_000;
      if (index === 1) Object.assign(member.telemetry.connections[0], { sentBytes: 8000, receivedBytes: 2000 });
      if (index === 2) Object.assign(member.telemetry.connections[0], { sentBytes: 3000, receivedBytes: 7000 });
    }
    render();
    const uploads = [...document.querySelectorAll('[data-edge-kind="native-peer"] path[data-direction="upload"]')].map(node => ({
      rate: Number(node.dataset.bytesPerSecond), width: Number(node.getAttribute('stroke-width')),
    }));
    return { uploads, strength: document.querySelector('[data-swarm-strength-value]').textContent,
      scope: document.getElementById('map').dataset.strengthScope,
      reported: [...document.querySelectorAll('[data-edge-kind^="reported"]')].every(node => node.dataset.attribution === 'listener-reported' && [...node.querySelectorAll('path')].every(path => path.getAttribute('stroke-dasharray') === '3 7')),
      received: Number(document.querySelector('[data-edge-kind="reported-peer"] path[data-direction="forward"]').dataset.cumulativeBytes) };
  });
  assert(receipt.checks.measuredRates.uploads[0].rate > receipt.checks.measuredRates.uploads[1].rate);
  assert(receipt.checks.measuredRates.uploads[0].width > receipt.checks.measuredRates.uploads[1].width);
  assert.equal(receipt.checks.measuredRates.strength, '60%');
  assert.equal(receipt.checks.measuredRates.scope, 'local-verified-video-share-10s');
  assert.equal(receipt.checks.measuredRates.reported, true);
  assert.equal(receipt.checks.measuredRates.received, 7000);
  receipt.checks.unchangedReports = await page.evaluate(() => {
    const before = document.querySelectorAll('[data-flight-source^="reported-"]').length;
    render(); render();
    return { before, after: document.querySelectorAll('[data-flight-source^="reported-"]').length };
  });
  assert.equal(receipt.checks.unchangedReports.after, receipt.checks.unchangedReports.before);
  receipt.checks.replayNames = await page.evaluate(() => {
    observations.topology.connections[0].id = 'room-b-reconnected'; render();
    const nodes = [...document.querySelectorAll('[data-room-member-id]')];
    return { sameNodes: nodes.every(node => roomNodes.get(node.dataset.roomMemberId) === node),
      labels: nodes.map(node => node.querySelector('.swarm-label').textContent), members: nodes.length };
  });
  assert.equal(receipt.checks.replayNames.sameNodes, true);
  assert.deepEqual(receipt.checks.replayNames.labels, ['You', 'Listener 2', 'Listener 3']);
  assert.equal(receipt.checks.replayNames.members, 3);
  receipt.checks.staleReports = await page.evaluate(() => {
    graphNow += 13_000; render();
    return { remoteEdges: document.querySelectorAll('[data-edge-kind^="reported"]').length,
      nativeEdges: document.querySelectorAll('[data-edge-kind="native-peer"]').length,
      members: document.querySelectorAll('[data-room-member-id]').length,
      strength: document.querySelector('[data-swarm-strength-value]').textContent };
  });
  assert.deepEqual(receipt.checks.staleReports, { remoteEdges: 0, nativeEdges: 2, members: 3, strength: 'Waiting for video traffic' });
  receipt.checks.passiveObserver = await page.evaluate(() => {
    observations.active = observations.playing = false;
    observations.viewerId = observations.room.id = null;
    observations.topology.connections = [];
    observations.room.members.shift(); observations.room.listeners = 2;
    render();
    return { members: document.querySelectorAll('[data-room-member-id]').length,
      selfLabel: document.querySelector('[data-swarm-node="self"] .swarm-label').textContent,
      observerCounted: document.querySelector('[data-swarm-node="self"]').hasAttribute('data-room-member-id') };
  });
  assert.deepEqual(receipt.checks.passiveObserver, { members: 2, selfLabel: 'You', observerCounted: false });
  receipt.checks.emptyInvitation = await page.evaluate(() => {
    observations.room.members = []; observations.room.listeners = 0; render();
    return { inviting: document.getElementById('map').dataset.inviting,
      members: document.querySelectorAll('[data-room-member-id]').length,
      flights: document.querySelectorAll('[data-flight-source]').length,
      names: [...document.querySelectorAll('svg .swarm-label')].map(node => node.textContent) };
  });
  assert.deepEqual(receipt.checks.emptyInvitation, { inviting: 'true', members: 0, flights: 0, names: ['Broadcast', 'You'] });
  receipt.checks.pausedInvitation = await page.evaluate(() => {
    observations.active = true; observations.playing = false; render();
    return { inviting: document.getElementById('map').dataset.inviting,
      members: document.querySelectorAll('[data-room-member-id]').length, flights: document.querySelectorAll('[data-flight-source]').length };
  });
  assert.deepEqual(receipt.checks.pausedInvitation, { inviting: 'true', members: 0, flights: 0 });
  receipt.checks.unknownInvitation = await page.evaluate(() => {
    observations.room.observed = false; observations.room.ready = false; render();
    return { inviting: document.getElementById('map').dataset.inviting, flights: document.querySelectorAll('[data-flight-source]').length };
  });
  assert.deepEqual(receipt.checks.unknownInvitation, { inviting: 'false', flights: 0 });
  receipt.checks.proportionalBatches = await page.evaluate(() => {
    observations = { active: true, playing: false, enabled: true, serving: true, originBytes: 0, peerBytes: 0, uploadedBytes: 0,
      topology: { connections: [{ id: 'batch-a', state: 'connected', mediaBytesSent: 0, verifiedMediaBytesReceived: 0 }] } };
    render(); observations.playing = true;
    observations.topology.connections[0].mediaBytesSent = 100_000; render();
    observations.topology.connections[0].mediaBytesSent = 1_100_000; render();
    return [...document.querySelectorAll('[data-flight-source="peer-upload"]')].map(node => ({ bytes: Number(node.dataset.bytes), radius: Number(node.getAttribute('r')) }));
  });
  assert.equal(receipt.checks.proportionalBatches.length, 2);
  const [small, large] = receipt.checks.proportionalBatches;
  assert.equal(small.bytes, 100_000); assert.equal(large.bytes, 1_000_000);
  assert(Math.abs(large.radius ** 2 / small.radius ** 2 - 10) < .001, 'visible batch area scales across different updates');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  receipt.checks.reducedMotion = await page.evaluate(() => {
    observations.playing = false; render(); observations.playing = true;
    observations.topology.connections[0].mediaBytesSent += 10_000; render();
    return { flights: document.querySelectorAll('[data-flight-source]').length };
  });
  assert.deepEqual(receipt.checks.reducedMotion, { flights: 0 });
  await page.evaluate(() => visual.destroy());
  assert.equal(receipt.pageErrors.length, 0);
  receipt.passed = true;
} catch (error) { receipt.failure = String(error); process.exitCode = 1; }
finally {
  await browser?.close(); receipt.browserClosed = true;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks, browserClosed: true }));
}
