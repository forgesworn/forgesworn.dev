import test from 'node:test';
import assert from 'node:assert/strict';
import { createInPageRelay, demoIceConfiguration, validateMediaManifest, PEER_DEMO_LIMITS } from '../site/media-peer-demo.mjs';
import { finalizeEvent, generateSecretKey } from '../site/vendor/media-peer-demo.js';

const entry = () => ({ path: 'media_0.mp4', sha256: '0'.repeat(64), size: 200, sn: 0, cc: 0 });
const manifest = () => ({ schema: 1, segments: [entry()] });
const origin = 'https://demo.invalid/live-media.html';
const playlist = '/media/demo/rtmp/index.m3u8';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the media plan binds finite unique fragments to the same-origin playlist', () => {
  const plan = validateMediaManifest(manifest(), playlist, origin);
  assert.equal(plan.totalBytes, 200);
  assert.equal(plan.segments.get('/media/demo/rtmp/media_0.mp4').sn, 0);
  for (const invalid of [
    { schema: 1, segments: [{ ...entry(), path: '../media_0.mp4' }] },
    { schema: 1, segments: [entry(), entry()] },
    { schema: 1, segments: [{ ...entry(), sn: -1 }] },
    { schema: 1, segments: [{ ...entry(), size: PEER_DEMO_LIMITS.maxSegmentBytes + 1 }] },
    { schema: 1, segments: [] },
  ]) assert.throws(() => validateMediaManifest(invalid, playlist, origin));
  assert.throws(() => validateMediaManifest(manifest(), 'https://other.invalid/media/index.m3u8', origin));
  assert.throws(() => validateMediaManifest(manifest(), '/private/index.m3u8', origin));
});

function runtime(transport = 'udp') {
  return { transport, iceTransportPolicy: 'relay', iceServersByViewer: [0, 1].map(index => [{
    urls: [`turn:127.0.0.1:12345?transport=${transport}`], username: `generated-viewer-${index}`, credential: `generated-credential-${index}`,
  }]) };
}

test('public playback has no ICE servers; operator relay credentials are loopback-only', () => {
  assert.deepEqual(demoIceConfiguration(undefined, 'forgesworn.dev'), [0, 1].map(() => ({ iceServers: [], iceTransportPolicy: 'all' })));
  for (const protocol of ['udp', 'tcp']) {
    const config = demoIceConfiguration(runtime(protocol), '127.0.0.1');
    assert.equal(config[0].iceTransportPolicy, 'relay');
    assert.notEqual(config[0].iceServers[0].username, config[1].iceServers[0].username);
  }
  assert.throws(() => demoIceConfiguration(runtime(), 'forgesworn.dev'));
  const foreign = runtime(); foreign.iceServersByViewer[0][0].urls = ['turn:relay.invalid:3478?transport=udp'];
  assert.throws(() => demoIceConfiguration(foreign, 'localhost'));
  const mismatched = runtime(); mismatched.transport = 'tcp';
  assert.throws(() => demoIceConfiguration(mismatched, 'localhost'));
  const outside = runtime(); outside.iceServersByViewer[0][0].urls = ['turn:127.0.0.1:65536?transport=udp'];
  assert.throws(() => demoIceConfiguration(outside, 'localhost'));
});

test('the in-page adapter carries signed Nostr frames, filters subscriptions and stops', async () => {
  const swarmId = 'generated-media-demo';
  const relay = createInPageRelay(swarmId);
  const a = new relay.WebSocketImpl(relay.url), b = new relay.WebSocketImpl(relay.url);
  const frames = [];
  b.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  await flush();
  b.send(JSON.stringify(['REQ', 'generated-subscription', { kinds: [24170], '#x': [swarmId] }]));
  const signed = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [['x', swarmId]], content: '{}' }, generateSecretKey());
  a.send(JSON.stringify(['EVENT', signed]));
  await flush();
  assert(frames.some(frame => frame[0] === 'EVENT' && frame[2].id === signed.id));
  assert.equal(relay.metrics().published, 1);
  a.send(JSON.stringify(['EVENT', { ...signed, content: 'tampered' }]));
  a.send('not json');
  a.send('x'.repeat(PEER_DEMO_LIMITS.maxSignalBytes + 1));
  assert.equal(relay.metrics().published, 1);
  assert.equal(relay.metrics().rejected, 3);
  assert.throws(() => new relay.WebSocketImpl(relay.url));
  assert.throws(() => new relay.WebSocketImpl('wss://other.invalid/relay'));
  relay.close();
  assert.equal(a.readyState, 3); assert.equal(b.readyState, 3);
  assert.equal(relay.metrics().connections, 0); assert.equal(relay.metrics().retainedPresences, 0);
});
