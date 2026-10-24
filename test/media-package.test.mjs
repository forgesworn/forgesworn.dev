import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot, replayPlaylist } from '../scripts/package-media-demo.mjs';

test('live capture skips placeholder gaps while preserving complete segment durations', () => {
  const snapshot = '#EXTM3U\n#EXT-X-MAP:URI="epoch_init.mp4"\n#EXT-X-GAP\n#EXTINF:2.0,\nepoch_seg0.mp4\n#EXTINF:1.984,\nepoch_seg1.mp4\n#EXT-X-PART:DURATION=0.2,URI="epoch_part2.mp4"\n';
  const captured = parseSnapshot(snapshot);
  assert.equal(captured.init, 'epoch_init.mp4');
  assert.deepEqual(captured.segments, [{ name: 'epoch_seg1.mp4', duration: 1.984 }]);
  const replay = replayPlaylist(captured.segments);
  assert.match(replay, /#EXTINF:1\.984000,\nsegment-000.mp4/);
  assert.match(replay, /#EXT-X-TARGETDURATION:2/);
  assert.match(replay, /#EXT-X-ENDLIST\n$/);
  assert.doesNotMatch(replay, /GAP|PRELOAD|PART:/);
});

test('capture rejects a playlist that could fetch outside the loopback media path', () => {
  for (const path of ['../private.mp4', 'https://elsewhere.example/media.mp4', 'file:///etc/data.mp4', '%2e%2e/private.mp4', 'media.mp4?token=secret']) {
    assert.throws(() => parseSnapshot(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\n${path}\n`), /Unsafe media path/);
    assert.throws(() => parseSnapshot(`#EXTM3U\n#EXT-X-MAP:URI="${path}"\n`), /Unsafe initialisation path/);
  }
});

test('capture rejects missing, invalid and unbounded durations', () => {
  for (const duration of ['', 'NaN', '-1', 'Infinity', '1000']) assert.throws(() => parseSnapshot(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:${duration},\nseg.mp4\n`), /Invalid segment duration/);
  assert.throws(() => replayPlaylist([]));
  assert.throws(() => replayPlaylist(Array.from({length:65}, () => ({duration:2}))));
});
