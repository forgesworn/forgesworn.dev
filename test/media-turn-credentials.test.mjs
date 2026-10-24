import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicTurnCredentials, validatePublicTurnLease, PUBLIC_TURN_ENDPOINT, PUBLIC_TURN_URL } from '../site/media-turn-credentials.mjs';

function response(at = 2000000000000, ttl = 30) {
  return { v: 1, iceServers: [{ urls: [PUBLIC_TURN_URL], username: `${(at + ttl * 1000) / 1000}:${'a'.repeat(32)}`,
    credential: `${'b'.repeat(27)}=` }], ttlSeconds: ttl, issuedAt: at, expiresAt: at + ttl * 1000,
    refreshAt: at + Math.floor(ttl * 1000 * 2 / 3), serverTime: at };
}
function clock() {
  let at = 0, next = 0;
  const timers = new Map();
  return { now: () => at, setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, at: at + ms }); return id; },
    clearTimer: id => timers.delete(id), size: () => timers.size,
    async advance(ms) {
      const end = at + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; at = timer.at; timers.delete(id); timer.fn();
        await new Promise(setImmediate);
      }
      at = end;
      await new Promise(setImmediate);
    } };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('public TURN leases bind the exact independent TLS route and bounded lifetime', () => {
  const valid = response();
  assert.equal(validatePublicTurnLease(valid).lifetimeMs, 30000);
  for (const change of [
    value => { value.iceServers[0].urls[0] = 'turns:evil.test:5349?transport=tcp'; },
    value => { value.iceServers[0].credential = 'password'; },
    value => { value.iceServers[0].username = `2000000000:${'a'.repeat(32)}`; },
    value => { value.iceServers.push(value.iceServers[0]); },
    value => { value.ttlSeconds = 3600; },
    value => { value.refreshAt++; }, value => { value.serverTime = value.expiresAt; },
    value => { value.unrecognised = true; },
  ]) { const value = structuredClone(valid); change(value); assert.throws(() => validatePublicTurnLease(value)); }
});

test('issuance starts with playback, coalesces requests and keeps credentials out of diagnostics', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, async fetchImpl(url, options) {
    requests++; assert.equal(url, PUBLIC_TURN_ENDPOINT); assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.body, '{"v":1}');
    return json(response());
  } });
  assert.equal(requests, 0); assert.deepEqual(credentials.servers(), []);
  await Promise.all([credentials.start(), credentials.start()]); assert.equal(requests, 1);
  assert.equal(credentials.snapshot().available, true);
  const copy = credentials.servers(); copy[0].urls[0] = 'changed';
  assert.equal(credentials.servers()[0].urls[0], PUBLIC_TURN_URL);
  assert.equal(JSON.stringify(credentials.snapshot()).includes('credential'), false);
  credentials.stop(); assert.equal(time.size(), 0); assert.deepEqual(credentials.servers(), []);
});

test('automatic renewal supplies new dials before the first credential expires', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, async fetchImpl() {
    requests++; return json(response(2000000000000 + time.now(), requests === 1 ? 30 : 60));
  } });
  await credentials.start(); const first = credentials.leaseIdentity();
  await time.advance(20000);
  assert.equal(requests, 2); assert.notEqual(credentials.leaseIdentity(), first);
  assert.equal(credentials.snapshot().remainingMs, 60000);
  await time.advance(11000); assert.equal(credentials.snapshot().available, true);
  credentials.stop();
});

test('issuer failure preserves a fresh lease and never returns expired credentials', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, async fetchImpl() {
    return ++requests === 1 ? json(response()) : new Response('', { status: 503 });
  } });
  await credentials.start(); await time.advance(20000);
  assert.equal(credentials.snapshot().available, true); assert.equal(credentials.snapshot().failures, 1);
  await time.advance(10000);
  assert.deepEqual(credentials.servers(), []); assert.equal(credentials.leaseIdentity(), null);
  assert.equal(credentials.snapshot().available, false);
  credentials.stop(); assert.equal(time.size(), 0);
});

test('malformed and oversized issuer responses fall back without disclosing content', async () => {
  for (const value of [{ ...response(), v: 2 }, 'x'.repeat(5000)]) {
    const time = clock(); const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => json(value) });
    assert.equal(await credentials.start(), null); assert.equal(credentials.snapshot().phase, 'unavailable');
    assert.deepEqual(credentials.servers(), []); credentials.stop(); assert.equal(time.size(), 0);
  }
});

test('stopping cancels pending issuance and a later playback gets a new request', async () => {
  const time = clock(); let requests = 0, release;
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async (_url, options) => {
    requests++;
    if (requests > 1) return json(response());
    return new Promise((resolve, reject) => {
      release = () => resolve(json(response())); options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  const initial = credentials.start(); credentials.stop();
  await credentials.start(); release(); await initial;
  assert.equal(requests, 2); assert.equal(credentials.snapshot().available, true);
  credentials.stop(); assert.equal(time.size(), 0);
});

test('slow issuance consumes the returned lease instead of extending its expiry', async () => {
  const time = clock(); let elapsed = 0;
  const credentials = createPublicTurnCredentials({ ...time, now: () => time.now() + elapsed,
    async fetchImpl() { elapsed = 3500; return json(response()); } });
  await credentials.start();
  assert.equal(credentials.snapshot().remainingMs, 26500);
  credentials.stop(); assert.equal(time.size(), 0);
});
