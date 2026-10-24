import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOriginLoader, transferBytes } from '../site/media-transfer-stats.mjs';

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
