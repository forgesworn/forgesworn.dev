import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LAB_PEER_LIMITS, labPlaylist, labIceConfiguration, createLabCommitmentProvider } from '../site/media-lab-peer.mjs';
import { finalizeEvent, generateSecretKey, verifyEvent } from '../site/vendor/media-peer-demo.js';

const origin = 'http://127.0.0.1:12345/media-lab.html';
const playlist = '/media/lab/hls/0123456789abcdef/index.m3u8';
const context = () => ({ url: new URL('media_0.mp4', new URL(playlist, origin)).href,
  frag: { baseurl: new URL(playlist, origin).href, sn: 4, cc: 2, type: 'main' } });
const runtime = () => ({ engine: 'coturn', transport: 'udp', iceTransportPolicy: 'relay', iceServersByViewer: [0, 1].map(index => [{
  urls: ['turn:127.0.0.1:3478?transport=udp'], username: `generated-viewer-${index}`, credential: `generated-password-${index}` }]) });

test('rolling lab plans require an active same-origin /media playlist and separate loopback TURN viewers', () => {
  assert.equal(labPlaylist(playlist, origin).playlist, new URL(playlist, origin).href);
  for (const value of ['/lab/hls/0123456789abcdef/index.m3u8', `${playlist}?source=elsewhere`,
    '/media/lab/hls/invalid/index.m3u8', 'http://other.invalid' + playlist]) assert.throws(() => labPlaylist(value, origin));
  assert.throws(() => labPlaylist(playlist, 'https://forgesworn.dev/media-lab.html'));
  assert.equal(labIceConfiguration(runtime(), '127.0.0.1')[0].iceTransportPolicy, 'relay');
  const duplicate = runtime(); duplicate.iceServersByViewer[1][0].username = duplicate.iceServersByViewer[0][0].username;
  assert.throws(() => labIceConfiguration(duplicate, 'localhost'));
  assert.throws(() => labIceConfiguration(runtime(), 'forgesworn.dev'));
  assert.equal(LAB_PEER_LIMITS.maxHeldBytes, 64 * 1024 * 1024);
  assert.equal(LAB_PEER_LIMITS.maxDurationMs, 330_000);
});

test('real signed v2 commitments bind streamed hash metadata to the actual HLS context', async () => {
  const key = generateSecretKey(), swarmId = 'generated-lab-test';
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', swarmId], ['relayswarm', 'redistribute', '1']], content: 'Generated test' }, key);
  let requests = 0;
  const provider = createLabCommitmentProvider({ playlistUrl: playlist, origin, swarmId, streamEvent, publisherKey: key,
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url.pathname, '/lab/hash'); assert.equal(url.searchParams.get('path'), '/media/lab/hls/0123456789abcdef/media_0.mp4');
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
      if (requests === 1) return new Response('', { status: 404 });
      return Response.json({ sha256: 'a'.repeat(64), size: 3 * 1024 * 1024 });
    } });
  const event = await provider(context()), value = JSON.parse(event.content);
  assert(verifyEvent(event));
  assert.equal(value.v, 2); assert.equal(value.playlist, playlist); assert.equal(value.rendition, playlist);
  assert.equal(value.sequence, 4); assert.equal(value.discontinuity, 2); assert.equal(value.part, null);
  assert.equal(value.sha256, 'a'.repeat(64)); assert.equal(value.size, 3 * 1024 * 1024);
  assert.equal(value.key, createHash('sha256').update(`${swarmId}\n/media/lab/hls/0123456789abcdef/media_0.mp4`).digest('hex'));
  assert.equal(requests, 2);
  for (const invalid of [{ ...context(), part: { index: 0 } }, { ...context(), rangeEnd: 100 },
    { ...context(), url: 'http://other.invalid/media_0.mp4' },
    { ...context(), url: 'http://127.0.0.1:12345/media/lab/hls/fedcba9876543210/media_0.mp4' }]) assert.equal(await provider(invalid), null);
  assert.equal(requests, 2);
  const cancellation = new AbortController(); cancellation.abort();
  assert.equal(await provider(context(), { signal: cancellation.signal }), null);
  assert.equal(requests, 2);
});

test('oversized or malformed proxy metadata cannot become a commitment', async () => {
  const key = generateSecretKey(), streamEvent = finalizeEvent({ kind: 30311, created_at: 1, tags: [], content: '' }, key);
  for (const metadata of [{ sha256: 'a'.repeat(64), size: LAB_PEER_LIMITS.maxSegmentBytes + 1 },
    { sha256: 'not-a-hash', size: 100 }, { sha256: 'a'.repeat(64), size: 0 }]) {
    const provider = createLabCommitmentProvider({ playlistUrl: playlist, origin, swarmId: 'generated-test', streamEvent, publisherKey: key,
      fetchImpl: async () => Response.json(metadata) });
    assert.equal(await provider(context()), null);
  }
});
