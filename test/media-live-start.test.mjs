import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMediaStart, readInitialLiveStart } from '../site/media-live-start.mjs';

const playlist = 'http://127.0.0.1:12345/media/lab/hls/0123456789abcdef/index.m3u8';
const media = (gaps = 7, finite = false) => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n' +
  Array.from({ length: gaps }, (_, index) => `#EXT-X-GAP\n#EXTINF:1.0,\ngap${index}.mp4\n`).join('') +
  '#EXTINF:1.0,\nreal.mp4\n' + (finite ? '#EXT-X-ENDLIST\n' : '');

test('manifest preflight derives a constructor position from real durations and preserves actual sequence', () => {
  assert.deepEqual(initialMediaStart(media()), { live: true, startPosition: 7, mediaSequence: 17, firstMediaDuration: 1 });
  assert.equal(initialMediaStart(media(0)).startPosition, 0);
  assert.equal(initialMediaStart(media(7, true)).startPosition, -1);
  assert.equal(initialMediaStart(media(2).replaceAll('1.0', '1.5')).startPosition, 3);
  assert.throws(() => initialMediaStart('not a playlist'));
  assert.throws(() => initialMediaStart('#EXTM3U\n#EXTINF:0,\nreal.mp4\n'));
});

test('constructor preflight follows only the active main playlist and never fetches media bytes', async () => {
  const requests = [];
  const initial = await readInitialLiveStart(playlist, { fetchImpl: async (url, options) => {
    requests.push(url.pathname); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'same-origin');
    if (url.pathname.endsWith('/index.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:CODECS="mp4a.40.2"\naudio.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"\nstream.m3u8\n');
    assert(url.pathname.endsWith('/stream.m3u8')); return new Response(media());
  } });
  assert.equal(initial.startPosition, 7); assert.equal(initial.mediaSequence, 17);
  assert.equal(initial.playlistUrl, playlist);
  assert.equal(initial.mediaPlaylistUrl, playlist.replace('index.m3u8', 'stream.m3u8'));
  assert.deepEqual(requests, ['/media/lab/hls/0123456789abcdef/index.m3u8', '/media/lab/hls/0123456789abcdef/stream.m3u8']);
});

test('manifest preflight rejects other origins, oversized manifests and cancelled work', async () => {
  let requests = 0;
  await assert.rejects(readInitialLiveStart(playlist, { fetchImpl: async () => {
    requests++; return new Response('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nhttp://outside.invalid/stream.m3u8\n');
  } }), /outside/);
  assert.equal(requests, 1);
  await assert.rejects(readInitialLiveStart(playlist, { fetchImpl: async () => new Response('x'.repeat(128 * 1024 + 1)) }), /limit/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readInitialLiveStart(playlist, { signal: abort.signal, fetchImpl: async () => { assert.fail('Cancelled work fetched a playlist.'); } }));
});

test('padding-only startup polls manifests until actual media exists without fetching a fragment', async () => {
  let requests = 0;
  const initial = await readInitialLiveStart(playlist, { fetchImpl: async url => {
    assert(url.pathname.endsWith('.m3u8')); requests++;
    return new Response(requests === 1 ? '#EXTM3U\n#EXTINF:1,\n#EXT-X-GAP\ngap.mp4\n' : media(2));
  } });
  assert.equal(requests, 2); assert.equal(initial.startPosition, 2); assert.equal(initial.mediaSequence, 12);
});

test('manifest loops and other active-run paths stop at the metadata boundary', async () => {
  for (const uri of ['index.m3u8', '../other/stream.m3u8', '/media/lab/hls/fedcba9876543210/stream.m3u8']) {
    let requests = 0;
    await assert.rejects(readInitialLiveStart(playlist, { fetchImpl: async () => {
      requests++; return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\n${uri}\n`);
    } }));
    assert.equal(requests, 1);
  }
});

