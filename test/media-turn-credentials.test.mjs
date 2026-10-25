import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicTurnCredentials, validatePublicTurnLease, PUBLIC_TURN_ENDPOINT, PUBLIC_TURN_URL } from '../site/media-turn-credentials.mjs';

const EPOCH = 2000000000000;
const LIFETIME = 3599000;
const REFRESH = Math.floor(LIFETIME * 2 / 3);
const FIXTURE_ISSUER = 'https://issuer.test/v1/public/credentials';
function response(at = EPOCH) {
  const expiresAt = Math.floor(at / 1000) + 3600;
  return { urls: ['turn:relay.test:3478?transport=tcp', PUBLIC_TURN_URL],
    username: `${expiresAt}:pub-${'a'.repeat(24)}`, credential: `${'b'.repeat(26)}I=`, expiresAt };
}
function clock() {
  let at = 0, next = 0, wallOffset = EPOCH;
  const timers = new Map();
  return { endpoint: FIXTURE_ISSUER, now: () => at, wallNow: () => wallOffset + at,
    setWallOffset(value) { wallOffset = value; },
    setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, at: at + ms }); return id; },
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

test('an unconfigured viewer immediately remains unavailable across concurrent starts and pause/restart without networking or timers', async () => {
  assert.equal(PUBLIC_TURN_ENDPOINT, null);
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, endpoint: undefined,
    fetchImpl() { requests++; throw new Error('no issuer is configured'); } });
  try {
    assert.deepEqual(credentials.snapshot(), { phase: 'off', available: false, remainingMs: 0, failures: 0 });
    assert.deepEqual(await Promise.all(Array.from({ length: 32 }, () => credentials.start())), Array(32).fill(null));
    assert.deepEqual(credentials.snapshot(), { phase: 'unavailable', available: false, remainingMs: 0, failures: 0 });
    assert.equal(requests, 0); assert.equal(time.size(), 0);
    await time.advance(3600000); assert.equal(requests, 0); assert.equal(time.size(), 0);
    assert.deepEqual(credentials.servers(), []); assert.equal(credentials.leaseIdentity(), null);
    credentials.stop(); assert.equal(credentials.snapshot().phase, 'off');
    assert.equal(await credentials.start(), null); assert.equal(requests, 0); assert.equal(time.size(), 0);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('invalid configured issuer URLs cannot create credential requests or retries', async () => {
  for (const endpoint of ['not a URL', 'http://issuer.test/v1/public/credentials',
    'https://user:secret@issuer.test/v1/public/credentials', 'https://issuer.test/v1/public/credentials#fragment',
    'https://issuer.test:invalid/v1/public/credentials', 'https://issuer.test/' + 'x'.repeat(2048)]) {
    const time = clock(); let requests = 0;
    const credentials = createPublicTurnCredentials({ ...time, endpoint, fetchImpl() { requests++; throw new Error('invalid configured URL'); } });
    try {
      assert.equal(await credentials.start(), null); assert.equal(requests, 0); assert.equal(time.size(), 0);
      assert.equal(credentials.snapshot().phase, 'unavailable');
    } finally { credentials.stop(); assert.equal(time.size(), 0); }
  }
});

test('the direct public lease selects only the configured TLS route and fixed conservative lifetime', () => {
  const valid = response();
  const result = validatePublicTurnLease(valid);
  assert.deepEqual(result.server, { urls: [PUBLIC_TURN_URL], username: valid.username, credential: valid.credential });
  assert.equal(result.lifetimeMs, LIFETIME);
  assert.equal(result.refreshAfterMs, REFRESH);
  valid.urls[1] = 'changed';
  assert.deepEqual(result.server.urls, [PUBLIC_TURN_URL]);
});

test('public leases reject other contracts, wrong expiry units, labels, hashes and routes', () => {
  for (const change of [
    value => { value.urls = ['turns:evil.test:5349?transport=tcp']; },
    value => { value.urls = [PUBLIC_TURN_URL.replace('5349', '5350')]; },
    value => { value.urls = Array(9).fill(PUBLIC_TURN_URL); },
    value => { value.urls.push('x'.repeat(513)); },
    value => { value.urls.push(null); },
    value => { value.credential = 'password'; },
    value => { value.credential = `${'b'.repeat(27)}=`; },
    value => { value.username = `${value.expiresAt}:pub-${'a'.repeat(23)}`; },
    value => { value.username = `${value.expiresAt}:pub-${'A'.repeat(24)}`; },
    value => { value.username = `${value.expiresAt}:${'a'.repeat(32)}`; },
    value => { value.expiresAt++; },
    value => { value.expiresAt *= 1000; },
    value => { value.expiresAt += 0.5; },
    value => { value.expiresAt = -1; },
    value => { value.expiresAt = Number.MAX_SAFE_INTEGER; },
    value => { value.v = 1; },
    value => { delete value.credential; },
  ]) {
    const value = response(); change(value);
    assert.throws(() => validatePublicTurnLease(value), { message: 'Peer relay temporarily unavailable.' });
  }
  assert.throws(() => validatePublicTurnLease({ v: 1, iceServers: [], ttlSeconds: 3600,
    issuedAt: EPOCH, expiresAt: EPOCH + 3600000, refreshAt: EPOCH + 2400000, serverTime: EPOCH }));
});

test('issuance starts with playback, coalesces requests and keeps credentials out of diagnostics', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, async fetchImpl(url, options) {
    requests++;
    assert.equal(url, FIXTURE_ISSUER);
    assert.equal(options.method, 'POST'); assert.equal(options.mode, 'cors');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error'); assert.equal(options.body, '{"v":1}');
    assert.equal(options.headers['content-type'], 'application/json');
    return json(response());
  } });
  try {
    assert.equal(requests, 0); assert.deepEqual(credentials.servers(), []);
    await Promise.all(Array.from({ length: 32 }, () => credentials.start()));
    assert.equal(requests, 1);
    assert.deepEqual(credentials.snapshot(), { phase: 'ready', available: true, remainingMs: LIFETIME, failures: 0 });
    await credentials.start(); credentials.servers(); credentials.leaseIdentity();
    assert.equal(requests, 1, 'ordinary reads and new dials reuse one still-fresh viewer lease');
    const copy = credentials.servers(); copy[0].urls[0] = 'changed'; copy[0].username = 'changed';
    assert.equal(credentials.servers()[0].urls[0], PUBLIC_TURN_URL);
    assert.equal(credentials.leaseIdentity(), response().username);
    const diagnostics = JSON.stringify(credentials.snapshot());
    assert.equal(diagnostics.includes(response().credential), false);
    assert.equal(diagnostics.includes(response().username), false);
  } finally { credentials.stop(); assert.equal(time.size(), 0); assert.deepEqual(credentials.servers(), []); }
});

test('automatic renewal supplies new dials and cannot expire the replacement with an older timer', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, async fetchImpl() {
    requests++; return json(response(EPOCH + time.now()));
  } });
  try {
    await credentials.start(); const first = credentials.leaseIdentity();
    await time.advance(REFRESH);
    assert.equal(requests, 2); assert.notEqual(credentials.leaseIdentity(), first);
    assert.equal(credentials.snapshot().remainingMs, LIFETIME);
    await time.advance(LIFETIME - REFRESH);
    assert.equal(credentials.snapshot().available, true);
    assert.equal(requests, 2);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('issuer failure preserves the remaining fresh lease but never returns it after expiry', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, async fetchImpl() {
    return ++requests === 1 ? json(response()) : new Response('', { status: 503 });
  } });
  try {
    await credentials.start(); const first = credentials.leaseIdentity();
    await time.advance(REFRESH);
    assert.equal(credentials.snapshot().available, true); assert.equal(credentials.snapshot().failures, 1);
    assert.equal(credentials.leaseIdentity(), first);
    await time.advance(15000);
    assert.equal(requests, 3, 'failed mint retries are spaced by at least fifteen seconds');
    await time.advance(LIFETIME - REFRESH - 15000);
    assert.deepEqual(credentials.servers(), []); assert.equal(credentials.leaseIdentity(), null);
    assert.equal(credentials.snapshot().available, false);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('expired credentials are rejected even when their four fields are well formed', async () => {
  const time = clock(), value = response(EPOCH - 3601000);
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => json(value) });
  try {
    assert.equal(await credentials.start(), null);
    assert.equal(credentials.snapshot().available, false);
    assert.deepEqual(credentials.servers(), []);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('repeated starts after failure cannot bypass the viewer retry deadline', async () => {
  const time = clock(); let requests = 0;
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => {
    requests++; return new Response('', { status: 429 });
  } });
  try {
    assert.equal(await credentials.start(), null);
    for (let i = 0; i < 20; i++) assert.equal(await credentials.start(), null);
    assert.equal(requests, 1);
    await time.advance(14999); await credentials.start(); assert.equal(requests, 1);
    await time.advance(1); assert.equal(requests, 2);
    assert.equal(credentials.snapshot().failures, 2);
    assert.equal(time.size(), 1, 'one retry timer remains; no request fan-out');
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('wall-clock shortening is sticky and a backwards clock cannot extend the fixed monotonic lease', async () => {
  const time = clock(); let requests = 0;
  time.setWallOffset(EPOCH + 3595000);
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => ++requests === 1 ? json(response()) : new Response('', { status: 503 }) });
  try {
    await credentials.start(); assert.equal(credentials.snapshot().remainingMs, 5000);
    time.setWallOffset(EPOCH - 86400000);
    assert.equal(credentials.snapshot().remainingMs, 5000);
    await time.advance(4000); assert.equal(credentials.snapshot().remainingMs, 1000);
    await time.advance(1000); assert.deepEqual(credentials.servers(), []);
    assert.equal(credentials.snapshot().available, false);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
  const noWall = createPublicTurnCredentials({ ...time, wallNow: null, fetchImpl: async () => json(response()) });
  try { await noWall.start(); assert.equal(noWall.snapshot().remainingMs, LIFETIME); }
  finally { noWall.stop(); assert.equal(time.size(), 0); }
});

test('a later forward clock correction may shorten but never restore a lease', async () => {
  const time = clock(), credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => json(response()) });
  try {
    await credentials.start();
    time.setWallOffset(EPOCH + 3599000); assert.equal(credentials.snapshot().remainingMs, 1000);
    time.setWallOffset(EPOCH); assert.equal(credentials.snapshot().remainingMs, 1000);
    time.setWallOffset(EPOCH + 3600000); assert.deepEqual(credentials.servers(), []);
    assert.equal(credentials.snapshot().phase, 'unavailable');
    time.setWallOffset(EPOCH); assert.deepEqual(credentials.servers(), []);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('malformed and oversized responses stay unavailable without exposing their contents', async () => {
  for (const fetchImpl of [
    async () => json({ ...response(), v: 1 }),
    async () => json('private-content'.repeat(400)),
    async () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
    async () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '4097' } }),
    async () => new Response('', { status: 429 }),
    async () => { const value = json(response()); Object.defineProperty(value, 'redirected', { value: true }); return value; },
  ]) {
    const time = clock(), seen = [];
    const credentials = createPublicTurnCredentials({ ...time, fetchImpl, onChange: value => seen.push(value) });
    try {
      assert.equal(await credentials.start(), null);
      assert.equal(credentials.snapshot().phase, 'unavailable');
      assert.equal(credentials.snapshot().failures, 1);
      assert.deepEqual(credentials.servers(), []);
      assert.equal(JSON.stringify(seen).includes('private-content'), false);
    } finally { credentials.stop(); assert.equal(time.size(), 0); }
  }
});

test('streamed response limits cancel the body even without a content-length header', async () => {
  const time = clock(); let cancelled = 0;
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(2000)); },
    cancel() { cancelled++; },
  }), { headers: { 'content-type': 'application/json' } }) });
  try {
    assert.equal(await credentials.start(), null); assert.equal(cancelled, 1);
    assert.equal(credentials.snapshot().available, false);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('stopping cancels pending issuance and late old replies cannot replace a restarted lease', async () => {
  const time = clock(); let requests = 0, release, firstSignal;
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async (_url, options) => {
    requests++;
    if (requests > 1) { const value = response(); value.username = `${value.expiresAt}:pub-${'c'.repeat(24)}`; return json(value); }
    firstSignal = options.signal;
    return new Promise(resolve => { release = () => resolve(json(response())); });
  } });
  try {
    const initial = credentials.start(); credentials.stop();
    assert.equal(firstSignal.aborted, true); assert.equal(await initial, null);
    await credentials.start(); const identity = credentials.leaseIdentity();
    release(); await new Promise(setImmediate);
    assert.equal(requests, 2); assert.equal(credentials.snapshot().available, true);
    assert.equal(credentials.leaseIdentity(), identity); assert.ok(identity.endsWith('c'.repeat(24)));
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('the four-second deadline bounds a request even when a fetch implementation ignores abort', async () => {
  const time = clock(); let requests = 0, signal;
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return ++requests === 1 ? new Promise(() => {}) : json(response());
  } });
  try {
    const initial = credentials.start(); await time.advance(4000);
    assert.equal(await initial, null); assert.equal(signal.aborted, true);
    assert.equal(credentials.snapshot().failures, 1);
    await credentials.start(); assert.equal(requests, 1);
    await time.advance(15000); assert.equal(requests, 2); assert.equal(credentials.snapshot().available, true);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('the same four-second deadline bounds a stalled response body and cancellation cleanup', async () => {
  const time = clock(); let cancelled = 0;
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled++; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'application/json' } }) });
  try {
    const initial = credentials.start(); await new Promise(setImmediate); await time.advance(4000);
    assert.equal(await initial, null); assert.equal(cancelled, 1);
    assert.equal(credentials.snapshot().phase, 'unavailable');
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
});

test('slow issuance and body delivery consume the fresh duration instead of extending expiry', async () => {
  const time = clock();
  const credentials = createPublicTurnCredentials({ ...time, fetchImpl: () => new Promise(resolve => time.setTimer(() => resolve(json(response(EPOCH + time.now()))), 3500)) });
  try {
    const initial = credentials.start(); await time.advance(3500); await initial;
    assert.equal(credentials.snapshot().remainingMs, LIFETIME - 3500);
  } finally { credentials.stop(); assert.equal(time.size(), 0); }
  const otherTime = clock();
  const body = new TextEncoder().encode(JSON.stringify(response()));
  const streamed = createPublicTurnCredentials({ ...otherTime, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body.slice(0, 10));
      otherTime.setTimer(() => { controller.enqueue(body.slice(10)); controller.close(); }, 3000);
    },
  }), { headers: { 'content-type': 'application/json' } }) });
  try {
    const initial = streamed.start(); await otherTime.advance(3000); await initial;
    assert.equal(streamed.snapshot().remainingMs, LIFETIME - 3000);
  } finally { streamed.stop(); assert.equal(otherTime.size(), 0); }
});
