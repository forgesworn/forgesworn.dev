import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceResponseStats, observeOriginLoader, publicSourceResource, sourceResponseTransfer, transferBytes } from '../site/media-transfer-stats.mjs';

const sourceBody = 6_005_991;
const cacheResponse = bodyBytes => ({ bodyBytes, networkBodyBytes: 0, cacheBodyBytes: bodyBytes, known: true });

test('a network response counts its encoded body without normalised headers or decoded-size inflation', () => {
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, decodedBodySize: sourceBody * 3,
    transferSize: sourceBody + 300, deliveryType: '', responseStatus: 200 }),
  { bodyBytes: sourceBody, networkBodyBytes: sourceBody, cacheBodyBytes: 0, known: true });
  assert.equal(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: sourceBody + 299 }), null);
  assert.equal(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: sourceBody }), null);
});

test('a zero-transfer cache hit is not another six-megabyte network download', () => {
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 0, deliveryType: 'cache' }), cacheResponse(sourceBody));
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 0 }), cacheResponse(sourceBody));
});

test('a revalidated cached body excludes its300-byte response overhead from network body totals', () => {
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 300, deliveryType: 'cache', responseStatus: 304 }), cacheResponse(sourceBody));
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 300, responseStatus: 200 }), cacheResponse(sourceBody));
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: 100, transferSize: 300 }), cacheResponse(100));
});

test('explicit cached or304 delivery may expose revalidation headers without a network body', () => {
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 240, deliveryType: 'cache' }), cacheResponse(sourceBody));
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 240, responseStatus: 304 }), cacheResponse(sourceBody));
  assert.equal(sourceResponseTransfer({ encodedBodySize: sourceBody, transferSize: 240 }), null, 'unexplained partial sizes remain unknown');
});

test('concealed zero sizes never masquerade as measured zero network traffic', () => {
  for (const entry of [
    { encodedBodySize: 0, transferSize: 0 },
    { encodedBodySize: 0, decodedBodySize: 0, transferSize: 0, responseStatus: 0, deliveryType: '' },
    { encodedBodySize: 0, transferSize: 0, deliveryType: 'cache' },
  ]) assert.equal(sourceResponseTransfer(entry), null);
});

test('a disclosed empty response can have zero body bytes while still transferring headers', () => {
  assert.deepEqual(sourceResponseTransfer({ encodedBodySize: 0, transferSize: 300, responseStatus: 204 }),
    { bodyBytes: 0, networkBodyBytes: 0, cacheBodyBytes: 0, known: true });
});

test('invalid, absent and contradictory timing fields cannot enter byte totals', () => {
  for (const entry of [null, undefined, 0, {},
    { encodedBodySize: sourceBody }, { transferSize: sourceBody + 300 },
    { encodedBodySize: -1, transferSize: 0 }, { encodedBodySize: NaN, transferSize: 300 },
    { encodedBodySize: 1.5, transferSize: 301.5 }, { encodedBodySize: '10', transferSize: 310 },
    { encodedBodySize: 10, transferSize: -1 }, { encodedBodySize: 10, transferSize: Infinity },
    { encodedBodySize: Number.MAX_SAFE_INTEGER + 1, transferSize: 0 },
    { encodedBodySize: 10, transferSize: 310, deliveryType: 'cache' },
    { encodedBodySize: 10, transferSize: 310, responseStatus: 304 },
    { encodedBodySize: 10, transferSize: 310, responseStatus: -1 },
    { encodedBodySize: 10, transferSize: 310, deliveryType: 5 },
    { get encodedBodySize() { throw new Error('unavailable'); } },
  ]) assert.equal(sourceResponseTransfer(entry), null);
});

test('repeated playback keeps logical source bytes separate from network and cache bodies', () => {
  const results = [
    { encodedBodySize: sourceBody, transferSize: sourceBody + 300 },
    { encodedBodySize: sourceBody, transferSize: 0, deliveryType: 'cache' },
    { encodedBodySize: sourceBody, transferSize: 300, responseStatus: 304 },
  ].map(sourceResponseTransfer);
  assert.equal(results.reduce((sum, row) => sum + row.bodyBytes, 0), sourceBody * 3);
  assert.equal(results.reduce((sum, row) => sum + row.networkBodyBytes, 0), sourceBody);
  assert.equal(results.reduce((sum, row) => sum + row.cacheBodyBytes, 0), sourceBody * 2);
});

test('public source accounting includes only the pinned init and numbered media objects', () => {
  const full = { quality: 'full', baseUrl: 'https://media.example/dejavu-4k-v1/' };
  const preview = { quality: 'preview', baseUrl: 'https://site.example/media/dejavu-preview/rtmp/' };
  for (const name of ['init.mp4', 'segment-0000.m4s', 'segment-0133.m4s']) assert.equal(publicSourceResource(full.baseUrl + name, full), true);
  for (const name of ['init.mp4', 'segment-000.mp4', 'segment-029.mp4']) assert.equal(publicSourceResource(preview.baseUrl + name, preview), true);
  for (const name of ['index.m3u8', 'stream.m3u8', 'catalogue-v2.json', 'player.js', 'poster.jpg',
    'segment-0134.m4s', 'segment-001.mp4', 'sub/init.mp4', 'init.mp4?other=1', 'segment-0000.m4s#other']) {
    assert.equal(publicSourceResource(full.baseUrl + name, full), false, name);
  }
  assert.equal(publicSourceResource(preview.baseUrl + 'segment-030.mp4', preview), false);
  assert.equal(publicSourceResource('https://other.example/dejavu-4k-v1/init.mp4', full), false);
  assert.equal(publicSourceResource('https://media.example/dejavu-4k-v1-other/init.mp4', full), false);
  assert.equal(publicSourceResource('https://user@media.example/dejavu-4k-v1/init.mp4', full), false);
  assert.equal(publicSourceResource(full.baseUrl + 'init.mp4', { ...full, quality: 'unknown' }), false);
});

test('aggregate timing totals stay unavailable before observations and classify cache replay separately', () => {
  const stats = createSourceResponseStats();
  assert.equal(stats.snapshot().networkBodyBytes, null);
  assert.equal(stats.snapshot().coverage, 'unavailable');
  stats.add({ encodedBodySize: sourceBody, transferSize: sourceBody + 300 });
  stats.add({ encodedBodySize: sourceBody, transferSize: 0, deliveryType: 'cache' });
  assert.deepEqual(stats.snapshot(), { responses: 2, knownResponses: 2, unknownResponses: 0, missing: false,
    covered: true, coverage: 'complete', bodyBytes: sourceBody * 2, networkBodyBytes: sourceBody, cacheBodyBytes: sourceBody });
});

test('a concealed response invalidates complete totals rather than publishing the known subset', () => {
  const stats = createSourceResponseStats();
  stats.add({ encodedBodySize: sourceBody, transferSize: sourceBody + 300 });
  stats.add({ encodedBodySize: 0, transferSize: 0 });
  const result = stats.snapshot();
  assert.equal(result.coverage, 'partial'); assert.equal(result.knownResponses, 1); assert.equal(result.unknownResponses, 1);
  assert.equal(result.bodyBytes, null); assert.equal(result.networkBodyBytes, null); assert.equal(result.cacheBodyBytes, null);
});

test('missing observer records and pending loader response bytes prevent complete coverage', () => {
  const stats = createSourceResponseStats();
  stats.add({ encodedBodySize: sourceBody, transferSize: 0 });
  assert.equal(stats.snapshot(sourceBody + 1).covered, false);
  assert.equal(stats.snapshot(sourceBody + 1).networkBodyBytes, null);
  assert.equal(stats.snapshot(sourceBody).networkBodyBytes, 0, 'zero network body is valid when every observed response was cached');
  stats.invalidate();
  assert.equal(stats.snapshot().covered, false); assert.equal(stats.snapshot().missing, true);
});

test('small real transfers remain nonzero and unavailable byte readings remain unavailable', () => {
  for (const [value, label] of [[0, '0 B'], [918, '918 B'], [1000, '1 KB'], [279479, '279.5 KB'],
    [6206410, '6.2 MB'], [1e9, '1 GB'], [null, '—'], [NaN, '—'], [-1, '—'], ['1000', '—']]) {
    assert.equal(transferBytes(value), label);
  }
});

test('HTTP media accounting precedes worker buffer transfer and preserves loader callbacks and lifecycle', () => {
  const calls = [], stats = { loaded: 4096 };
  const context = { url: 'https://media.example/segment.mp4' }, details = { status: 200 };
  class Loader {
    constructor(config) { this.config = config; this.stats = stats; }
    load(ctx, config, callbacks) {
      this.callbacks = callbacks;
      const data = new ArrayBuffer(4096);
      callbacks.onProgress?.(stats, ctx, data, details);
      callbacks.onSuccess({ data }, stats, ctx, details);
      assert.equal(data.byteLength, 0, 'The player really detached the loader buffer.');
    }
    abort() { calls.push('abort'); }
    destroy() { calls.push('destroy'); }
  }
  const MeasuredLoader = observeOriginLoader(Loader, bytes => calls.push(bytes));
  const config = {}, loader = new MeasuredLoader(config);
  assert.equal(loader.stats, stats); assert.equal(loader.config, config);
  loader.load(context, config, {
    onProgress: (s, ctx, data, d) => { assert.equal(s, stats); assert.equal(ctx, context); assert.equal(d, details); calls.push('progress'); },
    onSuccess: (response, s, ctx, d) => {
      assert.equal(s, stats); assert.equal(ctx, context); assert.equal(d, details);
      structuredClone(response.data, { transfer: [response.data] }); calls.push('success');
    },
  });
  loader.abort(); loader.destroy();
  assert.deepEqual(calls, ['progress', 4096, 'success', 'abort', 'destroy']);
});

test('HTTP failures and partial data do not inflate completed origin media', () => {
  let bytes = 0, errors = 0;
  class Loader {
    load(ctx, config, callbacks) {
      callbacks.onProgress?.({ loaded: 1024 }, ctx, new ArrayBuffer(1024), null);
      callbacks.onError({ code: 500 }, ctx, null);
    }
  }
  const MeasuredLoader = observeOriginLoader(Loader, size => { bytes += size; });
  new MeasuredLoader().load({}, {}, { onProgress() {}, onError: () => { errors++; }, onSuccess: () => assert.fail() });
  assert.equal(bytes, 0); assert.equal(errors, 1);
});
