import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRecordedLive, parseRecordedManifest } from '../site/media-recorded-live.mjs';

const url = 'https://media.example/media/recording/stream.m3u8';
const media = [0, 1, 2, 3].map(index => new URL(`segment-${index}.m4s`, url).href);
const init = new URL('init.mp4', url).href;
const original = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init.mp4"\n' +
  media.map((_, index) => `#EXTINF:${index === 3 ? '0.960000' : '1.000000'},\nsegment-${index}.m4s\n`).join('') + '#EXT-X-ENDLIST\n';
const digest = text => createHash('sha256').update(text).digest('hex');
const parse = (text = original, extra = {}) => parseRecordedManifest({ text, playlistUrl: url, expectedSha256: digest(text), allowedUrls: [init, ...media], ...extra });
const epoch = 1_700_000_000_000;

test('canonical duration, init and media identities are verified and deeply frozen', async () => {
  const recording = await parse();
  assert.equal(recording.durationSeconds, 3.96);
  assert.equal(recording.manifestSha256, digest(original));
  assert.equal(recording.initUrl, init);
  assert.deepEqual(recording.segments.map(segment => segment.url), media);
  assert.deepEqual(recording.segments.map(segment => segment.startUs), [0, 1_000_000, 2_000_000, 3_000_000]);
  assert(Object.isFrozen(recording) && Object.isFrozen(recording.segments) && recording.segments.every(Object.isFrozen));
  assert.equal(await parse(original, { expectedSha256: '0'.repeat(64) }), null);
  assert.equal(await parse(original, { allowedUrls: media }), null);
  assert.equal(await parse(original, { allowedUrls: [init, ...media.slice(1)] }), null);
});

test('unsupported manifests and non-canonical URLs decline without fallback mutation', async () => {
  for (const text of [original.replace('#EXT-X-ENDLIST', ''), original.replace('VOD', 'EVENT'), original.replace('SEQUENCE:0', 'SEQUENCE:1'),
    original.replace('#EXTINF:1.000000,', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1.000000,'),
    original.replace('#EXTINF:1.000000,', '#EXT-X-BYTERANGE:20@0\n#EXTINF:1.000000,'),
    original.replace('#EXTINF:1.000000,', '#EXT-X-DISCONTINUITY\n#EXTINF:1.000000,'),
    original.replace('0.960000', 'NaN'), original + '#EXTINF:1,\nextra.m4s\n']) assert.equal(await parse(text), null);
  for (const playlistUrl of [url + '?epoch=1', url + '#x', url.replace('https:', 'http:'), 'https://user@media.example/media/a.m3u8']) assert.equal(await parse(original, { playlistUrl }), null);
  assert.equal(createRecordedLive({ recording: Object.freeze({}), epochMs: epoch }), null);
});

test('fixed player time origin is distinct from global SN and survives sliding windows', async () => {
  const recording = await parse(); let at = epoch + 3_000;
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => at, aheadSeconds: 5, backSeconds: 2 });
  assert(plan); assert.equal(plan.originSequence, 3); assert.equal(plan.timelineOriginMs, at); assert.equal(plan.startPosition, 0);
  assert.equal(plan.mediaTimeAt(epoch + 8_000), 5);
  assert(Math.abs(plan.recordingPosition(1) - 0.04) < 1e-9);
  const first = plan.windowAt(at);
  assert.equal(first.startSequence, 3); assert.match(first.text, /#EXT-X-DISCONTINUITY-SEQUENCE:0\n/);
  assert(!first.text.includes('ENDLIST') && !first.text.includes('PLAYLIST-TYPE'));
  assert(!first.text.split('#EXT-X-MAP')[0].includes('#EXT-X-DISCONTINUITY\n'));
  assert.equal(first.fragments[0].mediaStart, 0);
  at += 7_000;
  const next = plan.windowAt(at);
  assert(next.startSequence > first.startSequence);
  for (const fragment of next.fragments) {
    assert.equal(fragment.index, fragment.sn % 4); assert.equal(fragment.cc, Math.floor(fragment.sn / 4));
    assert.equal(fragment.url, media[fragment.index]);
    assert.equal(fragment.mediaStart, (fragment.programmeTimeMs - plan.timelineOriginMs) / 1000);
  }
  assert.equal(plan.timelineOriginMs, epoch + 3_000);
  assert(next.fragments.length <= 64); plan.stop();
});

test('every wrap has one discontinuity and repeated MAP while first-window DS carries earlier wraps', async () => {
  const recording = await parse(); const at = epoch + 3_960 * 25 + 3_000;
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => at, aheadSeconds: 10, backSeconds: 4 });
  const window = plan.windowAt(at);
  assert.equal(window.startSequence, 103);
  assert.match(window.text, /#EXT-X-DISCONTINUITY-SEQUENCE:25\n/);
  const wraps = window.fragments.filter((fragment, index) => index > 0 && fragment.index === 0).length;
  assert.equal((window.text.match(/#EXT-X-DISCONTINUITY\n/g) ?? []).length, wraps);
  assert.equal((window.text.match(/#EXT-X-MAP:/g) ?? []).length, wraps + 1);
  assert(window.fragments.some(fragment => fragment.cc >= 27));
  plan.stop();
});

test('sequence windows and state remain bounded after many wraps and invalid clocks decline', async () => {
  const recording = await parse(); let at = epoch + 3_000;
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => at, aheadSeconds: 10, backSeconds: 4 });
  for (const cycle of [1, 100, 10_000, 1_000_000]) {
    at = epoch + cycle * 3_960;
    const window = plan.windowAt(at);
    assert(window.fragments.length <= 18); assert(window.text.length < 6000);
  }
  assert.equal(recording.segments.length, 4); plan.stop();
  assert.throws(() => plan.windowAt(at), /stopped/);
  for (const extra of [{ aheadSeconds: 31 }, { aheadSeconds: 1 }, { backSeconds: -1 }, { now: () => epoch - 1 }, { epochMs: NaN }])
    assert.equal(createRecordedLive({ recording, epochMs: epoch, now: () => epoch, ...extra }), null);
});

test('public loader answers only the exact media URL and delegates only explicit approved master URLs', async () => {
  const recording = await parse(); const master = new URL('index.m3u8', url).href;
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => epoch + 3_000, aheadSeconds: 5, passthroughUrls: [master] });
  const delegated = [];
  class Parent { constructor() { this.stats = {}; } load(context, config, callbacks) { delegated.push(context.url); callbacks.onSuccess({ data: 'master' }, this.stats, context, null); } destroy() {} }
  const Loader = plan.createPlaylistLoader(Parent);
  const request = address => new Promise(resolve => new Loader({}).load({ url: address, type: 'level' }, {}, {
    onSuccess: (response, stats) => resolve({ response, stats }), onError: error => resolve({ error }),
  }));
  const response = await request(url);
  assert.match(response.response.data, /MEDIA-SEQUENCE:3/); assert.equal(response.response.url, url);
  assert.equal(response.stats.loaded, new TextEncoder().encode(response.response.data).length);
  assert.equal((await request(master)).response.data, 'master'); assert.deepEqual(delegated, [master]);
  assert((await request(url + '?epoch=1')).error); assert((await request('https://other.example/media/a.m3u8')).error);
  plan.stop();
});

test('abort, destroy and session cancellation suppress queued responses', async () => {
  const recording = await parse(), controller = new AbortController();
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => epoch, signal: controller.signal, aheadSeconds: 5 });
  const Loader = plan.createPlaylistLoader(); let successes = 0, aborts = 0;
  const callbacks = { onSuccess: () => successes++, onError: () => successes++, onAbort: () => aborts++ };
  const first = new Loader({}); first.load({ url, type: 'level' }, {}, callbacks); first.abort(); first.destroy();
  const second = new Loader({}); second.load({ url, type: 'level' }, {}, callbacks); controller.abort(); plan.stop();
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(successes, 0); assert.equal(aborts, 2);
  assert.equal(createRecordedLive({ recording, epochMs: epoch, now: () => epoch, signal: controller.signal }), null);
});

test('old queued errors cannot poison a reused loader and cancelled delegates release their resources', async () => {
  const recording = await parse(), controller = new AbortController(), master = new URL('index.m3u8', url).href;
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => epoch, signal: controller.signal, aheadSeconds: 5, passthroughUrls: [master] });
  let destroyed = 0, held;
  class Parent { constructor() { this.stats = {}; } load(context, config, callbacks) { held = callbacks; } destroy() { destroyed++; } }
  const Loader = plan.createPlaylistLoader(Parent); let successes = 0, errors = 0, aborts = 0;
  const callbacks = { onSuccess: () => successes++, onError: () => errors++, onAbort: () => aborts++ };
  const reused = new Loader({});
  reused.load({ url: url + '?wrong', type: 'level' }, {}, callbacks);
  reused.load({ url, type: 'level' }, {}, callbacks);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(successes, 1); assert.equal(errors, 0);
  const delegated = new Loader({}); delegated.load({ url: master, type: 'manifest' }, {}, callbacks);
  controller.abort(); delegated.destroy(); held.onSuccess({}, {}, {}, null);
  assert.equal(destroyed, 1); assert.equal(successes, 1); assert.equal(aborts, 2);
});

test('manifest verification cancellation and a clock before the fixed origin decline', async () => {
  const controller = new AbortController();
  const pending = parse(original, { signal: controller.signal }); controller.abort();
  assert.equal(await pending, null);
  const recording = await parse();
  const plan = createRecordedLive({ recording, epochMs: epoch, now: () => epoch + 3_000, aheadSeconds: 5 });
  assert.throws(() => plan.windowAt(epoch + 2_999), /precedes timeline/);
  plan.stop();
});
