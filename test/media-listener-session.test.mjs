import test from 'node:test';
import assert from 'node:assert/strict';
import { createListenerSession, LISTENER_SESSION_KIND, LISTENER_SESSION_DEFAULTS,
  LISTENER_TELEMETRY_KIND, LISTENER_TELEMETRY_LIMITS } from '../site/media-listener-session.mjs';
import { finalizeEvent, generateSecretKey } from '../site/vendor/media-peer-demo.js';

const source = 'a'.repeat(64), room = 'dejavu-full-v1';
const defaults = { room, source, duration: 268.5, relays: ['wss://one.test', 'wss://two.test'] };

function fixture() {
  let at = 1800000000000, next = 0;
  const timers = new Map(), sockets = [], published = [], stored = new Map(), policies = new Map(), acks = new Map(), eose = new Map();
  const later = (fn, ms = 0) => { const id = ++next; timers.set(id, { at: at + ms, fn }); return id; };
  const cancel = id => timers.delete(id);
  function advance(ms) {
    const target = at + ms;
    for (let steps = 0; ; steps++) {
      const entry = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      if (steps > 10000) throw new Error('Unbounded fixture timers.');
      timers.delete(entry[0]); at = entry[1].at; entry[1].fn();
    }
    at = target;
  }
  const tag = (event, name) => event.tags.find(value => value[0] === name)?.[1];
  const relayRows = url => {
    if (!stored.has(url)) stored.set(url, new Map());
    return stored.get(url);
  };
  function deliver(socket, event) {
    if (socket.readyState !== 1 || !socket.sub || !socket.filter.kinds.includes(event.kind)
      || !socket.filter['#d'].includes(tag(event, 'd'))) return;
    const timer = later(() => {
      socket.pending.delete(timer);
      if (socket.readyState === 1) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EVENT', socket.sub, event]) }));
    });
    socket.pending.add(timer);
  }
  function inject(url, event) {
    const rows = relayRows(url), address = `${event.pubkey}:${event.kind}:${tag(event, 'd')}`, old = rows.get(address);
    if ((event.kind < 20000 || event.kind >= 30000)
      && (!old || old.created_at < event.created_at || old.created_at === event.created_at && old.id > event.id)) rows.set(address, event);
    for (const socket of sockets) if (socket.url === url) deliver(socket, event);
  }
  function runtime(label = '') {
    class Socket extends EventTarget {
      constructor(url) {
        super(); this.url = url; this.label = label; this.readyState = 0; this.pending = new Set(); sockets.push(this);
        const delay = policies.has(`${label}:${url}`) ? policies.get(`${label}:${url}`) : 0;
        if (delay !== null) {
          const timer = later(() => { this.pending.delete(timer); this.open(); }, delay);
          this.pending.add(timer);
        }
      }
      open() { if (this.readyState !== 0) return; this.readyState = 1; this.dispatchEvent(new Event('open')); }
      send(data) {
        assert.equal(this.readyState, 1);
        const frame = JSON.parse(data);
        if (frame[0] === 'REQ') {
          this.sub = frame[1]; this.filter = frame[2];
          for (const event of relayRows(this.url).values()) if (event.created_at >= this.filter.since) deliver(this, event);
          if (eose.get(this.url) !== false) this.respond(['EOSE', this.sub]);
        } else if (frame[0] === 'EVENT') {
          published.push({ url: this.url, label, event: frame[1] }); inject(this.url, frame[1]);
          const ack = acks.has(this.url) ? acks.get(this.url) : true;
          if (ack !== null) this.respond(['OK', frame[1].id, ack, ack ? '' : 'read-only']);
        }
      }
      respond(frame, delay = 0) {
        const timer = later(() => {
          this.pending.delete(timer);
          if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
        }, delay);
        this.pending.add(timer);
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        for (const timer of this.pending) cancel(timer);
        this.pending.clear();
        this.dispatchEvent(new Event('close'));
      }
    }
    return { now: () => at, setTimeout: later, clearTimeout: cancel, WebSocketImpl: Socket, page: new EventTarget() };
  }
  const create = (options = {}, label) => createListenerSession({ ...defaults, ...options }, runtime(label));
  const signed = ({ secret = generateSecretKey(), status = 'active', created_at = Math.floor(at / 1000),
    epoch = { id: 'b'.repeat(64), startedAt: at - 10000 }, extra = {}, tags, ...patch } = {}) => {
    const body = { v: 1, room, source, durationMs: 268500, status, epoch, ...extra };
    return finalizeEvent({ kind: LISTENER_SESSION_KIND, created_at,
      tags: tags ?? [['d', `forgesworn-listener:${room}`], ['source', source], ['expiration', String(created_at + 24)]],
      content: JSON.stringify(body), ...patch }, secret);
  };
  const report = (peerId = '1'.repeat(64)) => ({ peerId, sampledAt: at, positionMs: 1000, following: true,
    originBytes: 1000000, peerBytes: 500000, uploadedBytes: 123456, connections: [] });
  const telemetry = ({ secret = generateSecretKey(), epoch, value = report(), body = {}, ...patch }) => {
    const created_at = Math.floor(value.sampledAt / 1000);
    return finalizeEvent({ kind: LISTENER_TELEMETRY_KIND, created_at,
      tags: [['d', `forgesworn-listener:${room}`], ['source', source], ['expiration', String(created_at + 12)]],
      content: JSON.stringify({ v: 1, room, source, durationMs: 268500, epoch, ...value, ...body }), ...patch }, secret);
  };
  async function join(session) { const pending = session.join(); advance(1250); return pending; }
  return { now: () => at, advance, runtime, create, join, signed, report, telemetry, inject, sockets, published, policies, acks, eose,
    activeTimers: () => timers.size, rows: relayRows };
}

test('listener session is lazy, binds its public source and counts one signed viewer across duplicate relays', async () => {
  const f = fixture(), changes = [];
  const session = f.create({ relays: ['wss://one.test', 'wss://one.test/', 'wss://two.test'], onChange: value => changes.push(value) });
  assert.equal(f.sockets.length, 0); assert.equal(f.activeTimers(), 0); assert.equal(session.snapshot().listeners, 0);
  const joined = await f.join(session);
  assert.equal(joined.ready, true); assert.equal(joined.role, 'starter'); assert.equal(joined.position, 0);
  assert.equal(joined.listeners, 1); assert.equal(joined.connectedRelays, 2); assert.equal(f.sockets.length, 2);
  f.advance(10000); assert.equal(session.position(), 10); assert.equal(session.snapshot().listeners, 1);
  const event = f.published.at(-1).event;
  assert.equal(event.kind, 30378); assert.deepEqual(JSON.parse(event.content).epoch.id, joined.epochId);
  assert.deepEqual(event.tags.map(value => value[0]), ['d', 'source', 'expiration']);
  assert.ok(changes.length > 1);
  session.stop(); assert.equal(f.activeTimers(), 0); assert.ok(f.sockets.every(socket => socket.readyState === 3));
});

test('late listener joins the live position and a successor keeps the same epoch after its starter leaves', async () => {
  const f = fixture(), a = f.create({}, 'a'), b = f.create({}, 'b');
  const first = await f.join(a); f.advance(10000);
  const second = await f.join(b);
  assert.equal(second.epochId, first.epochId); assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.role, 'joined'); assert.equal(second.position, 11.25);
  f.advance(0); assert.equal(a.snapshot().listeners, 2); assert.equal(b.snapshot().listeners, 2);
  a.leave(); f.advance(0);
  assert.equal(b.snapshot().listeners, 1); assert.equal(b.snapshot().epochId, first.epochId);
  f.advance(30000); assert.equal(b.position(), 41.25); assert.equal(b.snapshot().listeners, 1);
  b.stop(); a.stop(); assert.equal(f.activeTimers(), 0);
});

test('concurrent starts converge deterministically and later messages do not rewind their common clock', async () => {
  const f = fixture(), a = f.create({}, 'a'), b = f.create({}, 'b');
  const pa = a.join(), pb = b.join(); f.advance(1250);
  const initialA = await pa, initialB = await pb;
  assert.equal(initialA.startedAt, initialB.startedAt);
  const winner = [initialA.id, initialB.id].sort()[0];
  f.advance(1000);
  assert.equal(a.snapshot().epochId, winner); assert.equal(b.snapshot().epochId, winner);
  assert.equal(a.snapshot().listeners, 2); assert.equal(b.snapshot().listeners, 2);
  const start = a.snapshot().startedAt; f.advance(12000);
  assert.equal(a.snapshot().startedAt, start); assert.equal(b.snapshot().startedAt, start);
  assert.equal(a.position(), b.position()); a.stop(); b.stop(); assert.equal(f.activeTimers(), 0);
});

test('same-second leave supersedes active presence, refresh adopts its grace epoch, and an empty expired room restarts', async () => {
  const f = fixture(), a = f.create(), first = await f.join(a);
  const active = f.published.at(-1).event;
  a.leave();
  const left = f.published.at(-1).event;
  assert.equal(JSON.parse(left.content).status, 'left'); assert.ok(left.created_at > active.created_at);
  assert.ok(left.created_at * 1000 <= f.now() + 2000, 'one final tombstone cannot grow an unbounded future lease');
  const b = f.create(), refreshed = await f.join(b);
  assert.equal(refreshed.epochId, first.epochId); assert.equal(refreshed.listeners, 1);
  assert.equal(refreshed.position, 1.25); b.leave(); f.advance(30000);
  const c = f.create(), fresh = await f.join(c);
  assert.notEqual(fresh.epochId, first.epochId); assert.equal(fresh.position, 0); assert.equal(fresh.role, 'starter');
  c.stop(); a.stop(); b.stop(); assert.equal(f.activeTimers(), 0);
});

test('verified latest-per-author state rejects replay, signature changes, stale leases and other room/source/duration bindings', async () => {
  const f = fixture(), a = f.create(); await f.join(a);
  const secret = generateSecretKey();
  const valid = f.signed({ secret });
  for (const bad of [
    { ...valid, sig: '0'.repeat(128) },
    f.signed({ extra: { source: 'c'.repeat(64) } }), f.signed({ extra: { room: 'other' } }),
    f.signed({ extra: { durationMs: 1 } }), f.signed({ created_at: Math.floor(f.now() / 1000) - 25 }),
    f.signed({ created_at: Math.floor(f.now() / 1000) + 6 }),
    f.signed({ tags: [['d', `forgesworn-listener:${room}`], ['source', source], ['expiration', '9999999999']] }),
    f.signed({ kind: 30078 }), f.signed({ epoch: { id: 'x'.repeat(64), startedAt: f.now() } }),
    f.signed({ epoch: { id: 'b'.repeat(64), startedAt: f.now() + 6000 } }),
  ]) { f.inject('wss://one.test/', bad); f.advance(0); assert.equal(a.snapshot().listeners, 1); }
  f.inject('wss://one.test/', valid); f.inject('wss://two.test/', valid); f.advance(0);
  assert.equal(a.snapshot().listeners, 2, 'the same signed viewer relayed twice is one listener');
  const left = f.signed({ secret, status: 'left', created_at: valid.created_at + 1 });
  f.inject('wss://one.test/', left); f.advance(0); assert.equal(a.snapshot().listeners, 1);
  f.inject('wss://two.test/', valid); f.advance(0); assert.equal(a.snapshot().listeners, 1, 'old active replay cannot revive a departed viewer');
  a.stop(); assert.equal(f.activeTimers(), 0);
});

test('late common relay immediately receives the current signed clock without replaying to healthy sockets', async () => {
  const f = fixture();
  f.policies.set('a:wss://two.test/', 3000); f.policies.set('b:wss://one.test/', 3000);
  const a = f.create({}, 'a'), b = f.create({}, 'b');
  const pa = a.join(), pb = b.join(); f.advance(1250); await pa; await pb;
  const published = f.published.length, initial = new Set(f.published.map(row => row.event.id)); f.advance(1750);
  const replayed = f.published.slice(published).filter(row => initial.has(row.event.id));
  assert.deepEqual(replayed.map(row => [row.label, row.url]), [['a', 'wss://two.test/'], ['b', 'wss://one.test/']],
    'old presence is replayed only to new sockets; converging a different epoch may publish a fresh event');
  f.advance(1000);
  assert.equal(a.snapshot().epochId, b.snapshot().epochId); assert.equal(a.snapshot().listeners, 2);
  a.stop(); b.stop(); assert.equal(f.activeTimers(), 0);
});

test('discovery begins after a usable subscription, all-relay failure is bounded, and stop prevents late startup', async () => {
  const f = fixture(); f.policies.set('slow:wss://one.test/', 2000); f.policies.set('slow:wss://two.test/', null);
  const session = f.create({}, 'slow'), pending = session.join();
  f.advance(2000); assert.equal(session.snapshot().ready, false); f.advance(1250);
  assert.equal((await pending).ready, true); session.stop(); assert.equal(f.activeTimers(), 0);
  const g = fixture(); g.policies.set('fail:wss://one.test/', null); g.policies.set('fail:wss://two.test/', null);
  const failed = g.create({}, 'fail'), rejection = assert.rejects(failed.join(), /No listening relay/);
  g.advance(5000); await rejection; assert.equal(failed.snapshot().status, 'unavailable'); assert.equal(g.activeTimers(), 0);
  const h = fixture(), stopped = h.create(), aborted = assert.rejects(stopped.join(), { name: 'AbortError' });
  stopped.stop(); h.advance(10000); await aborted;
  assert.equal(h.published.length, 0); assert.equal(h.activeTimers(), 0); assert.equal(stopped.snapshot().ready, false);
});

test('losing every usable relay during discovery rejects the shared claim and clears pending retries', async () => {
  const f = fixture(), session = f.create(), rejection = assert.rejects(session.join(), /disconnected during discovery/);
  f.advance(500);
  for (const socket of f.sockets) socket.close();
  f.advance(750); await rejection;
  assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().status, 'unavailable');
  assert.equal(f.published.length, 0); assert.equal(f.activeTimers(), 0);
});

test('a shared join requires a matching positive publication ACK; reject-only and silent relays fail within a bound', async t => {
  for (const ack of [false, null]) await t.test(ack === false ? 'read-only relays' : 'no acknowledgement', async () => {
    const f = fixture(); f.acks.set('wss://one.test/', ack); f.acks.set('wss://two.test/', ack);
    const session = f.create(), rejected = assert.rejects(session.join(), /did not accept/);
    f.advance(1250);
    assert.equal(session.snapshot().status, 'publishing'); assert.equal(session.snapshot().ready, false);
    assert.equal(session.snapshot().listeners, 0, 'an unaccepted own event is not a shared listener');
    f.advance(5000); await rejected;
    assert.equal(session.snapshot().status, 'unavailable'); assert.equal(session.snapshot().ready, false);
    assert.equal(f.activeTimers(), 0); assert.ok(f.sockets.every(socket => socket.readyState === 3));
  });
  const f = fixture(); f.acks.set('wss://one.test/', false); f.acks.set('wss://two.test/', null);
  const session = f.create(), pending = session.join(); f.advance(1250);
  const event = f.published[0].event, socket = f.sockets[1];
  for (const malformed of [['OK', 'f'.repeat(64), true], ['OK', event.id, 'true'], ['OK', event.id, {}], ['OK', event.id, true, '', 'extra']]) {
    socket.respond(malformed); f.advance(0); assert.equal(session.snapshot().ready, false);
  }
  socket.respond(['OK', event.id, true, 'accepted']); f.advance(0);
  assert.equal((await pending).ready, true); assert.equal(session.snapshot().listeners, 1);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('leaving while its publication ACK is pending rejects join and supersedes any stored active event', async () => {
  const f = fixture(); f.acks.set('wss://one.test/', null); f.acks.set('wss://two.test/', null);
  const session = f.create(), rejected = assert.rejects(session.join(), { name: 'AbortError' }); f.advance(1250);
  session.leave(); await rejected;
  assert.equal(JSON.parse(f.published.at(-1).event.content).status, 'left');
  assert.equal(f.activeTimers(), 0); assert.equal(session.snapshot().ready, false);
});

test('reusable leave, abort, pagehide and throwing observers close owned sockets and timers', async () => {
  const f = fixture(), controller = new AbortController(), runtime = f.runtime();
  const session = createListenerSession({ ...defaults, signal: controller.signal, onChange() { throw new Error('host observer'); } }, runtime);
  const first = await f.join(session); session.leave(); assert.equal(f.activeTimers(), 0);
  const again = await f.join(session); assert.notEqual(again.id, first.id);
  controller.abort(); assert.equal(session.snapshot().status, 'stopped'); assert.equal(f.activeTimers(), 0);
  await assert.rejects(session.join(), { name: 'AbortError' });
  const g = fixture(), pageRuntime = g.runtime(), page = createListenerSession(defaults, pageRuntime);
  await g.join(page); pageRuntime.page.dispatchEvent(new Event('pagehide'));
  assert.equal(page.snapshot().status, 'stopped'); assert.equal(g.activeTimers(), 0);
  assert.ok(g.sockets.every(socket => socket.readyState === 3));
});

test('listener leases/state and event input remain bounded, and playback loops within its source duration', async () => {
  const f = fixture(), session = f.create({ maxRecords: 4, duration: 2 }); await f.join(session);
  f.advance(5500); assert.equal(session.position(), 1.5);
  for (let i = 0; i < 10; i++) f.inject('wss://one.test/', f.signed({ extra: { durationMs: 2000 } }));
  f.advance(0); assert.equal(session.snapshot().listeners, 4); assert.equal(session.snapshot().truncated, true);
  session.stop(); assert.equal(f.activeTimers(), 0);
  for (const patch of [{ source: 'wrong' }, { duration: Infinity }, { room: '../other' }, { ttlMs: 100000 },
    { relays: [] }, { relays: ['ws://untrusted.test'] }, { heartbeatMs: 0 }, { maxRecords: 257 }]) {
    assert.throws(() => f.create(patch), TypeError);
  }
  assert.equal(LISTENER_SESSION_DEFAULTS.ttlMs, 24000);
});

test('three actual signed listeners retain their identities, epoch and room total across repeated source wraps', async () => {
  const f = fixture(), sessions = [f.create({ duration: 2 }, 'a'), f.create({ duration: 2 }, 'b'), f.create({ duration: 2 }, 'c')];
  const pending = sessions.map(session => session.join()); f.advance(1250); await Promise.all(pending); f.advance(1000);
  const identities = sessions.map(session => session.snapshot().id), epoch = sessions[0].snapshot().epochId;
  for (let wrap = 0; wrap < 20; wrap++) {
    f.advance(2000);
    for (const [index, session] of sessions.entries()) {
      const state = session.snapshot();
      assert.equal(state.listeners, 3, 'room presence includes this listener, independently of RTC links');
      assert.equal(state.id, identities[index], 'a recording wrap does not create a new listener');
      assert.equal(state.epochId, epoch, 'the common clock continues across the recording boundary');
      assert.equal(state.ready, true); assert.ok(state.position >= 0 && state.position < 2);
    }
  }
  assert.ok(f.published.every(row => JSON.parse(row.event.content).status === 'active'), 'no wrap publishes a departure');
  for (const session of sessions) session.stop(); assert.equal(f.activeTimers(), 0);
});

test('healthy acknowledged relay sessions recover after more than a lifetime of isolated disconnections', async () => {
  const f = fixture(), session = f.create({ relays: ['wss://one.test'] }); await f.join(session);
  const identity = session.snapshot().id, epoch = session.snapshot().epochId;
  try {
    for (let outage = 0; outage < 8; outage++) {
      f.sockets.at(-1).close(); f.advance(17000);
      assert.equal(session.snapshot().connectedRelays, 1, `healthy reconnection ${outage + 1} is not blocked by an exhausted lifetime budget`);
      assert.equal(session.snapshot().id, identity); assert.equal(session.snapshot().epochId, epoch);
    }
  } finally { session.stop(); }
  assert.equal(f.activeTimers(), 0);
});

test('unacknowledged relay reconnections retain their bounded consecutive-failure budget', async () => {
  const f = fixture(), session = f.create({ relays: ['wss://one.test'] }); await f.join(session);
  f.acks.set('wss://one.test/', false);
  try {
    for (let outage = 0; outage < 8; outage++) { f.sockets.at(-1).close(); f.advance(17000); }
    const attempts = f.sockets.length;
    assert.equal(session.snapshot().connectedRelays, 0); assert.ok(attempts <= 7);
    f.advance(60000); assert.equal(f.sockets.length, attempts, 'opening alone never renews an exhausted failure budget');
  } finally { session.stop(); }
  assert.equal(f.activeTimers(), 0);
});

test('optional signed telemetry uses existing sockets and exposes copied fresh reports for active room members', async () => {
  const f = fixture(); let reportA = true;
  const a = f.create({ getTelemetry: () => reportA ? { ...f.report('1'.repeat(64)), connections: [
    { peerId: '2'.repeat(64), sentBytes: 123456, receivedBytes: 400000 }] } : null });
  const b = f.create({ getTelemetry: () => f.report('2'.repeat(64)) });
  await f.join(a); await f.join(b); f.advance(6000);
  assert.equal(f.sockets.length, 4, 'telemetry adds no socket beside each viewer existing relay connections');
  const state = b.snapshot(); assert.equal(state.listeners, 2); assert.equal(state.members.length, 2);
  assert.ok(state.members.every(member => member.telemetry !== null));
  const remote = state.members.find(member => !member.isSelf);
  assert.equal(remote.id, a.snapshot().id); assert.equal(remote.telemetry.peerId, '1'.repeat(64));
  assert.equal(remote.telemetry.connections[0].receivedBytes, 400000);
  assert.ok(remote.telemetryExpiresAt <= f.now() + 12000);
  remote.telemetry.connections[0].receivedBytes = 0; state.members.pop();
  assert.equal(b.snapshot().members.find(member => !member.isSelf).telemetry.connections[0].receivedBytes, 400000);
  const presence = f.published.find(row => row.event.kind === LISTENER_SESSION_KIND).event;
  assert.deepEqual(Object.keys(JSON.parse(presence.content)).sort(), ['durationMs', 'epoch', 'room', 'source', 'status', 'v'], 'existing presence wire is unchanged');
  const telemetry = f.published.find(row => row.event.kind === LISTENER_TELEMETRY_KIND).event;
  assert.ok(Buffer.byteLength(telemetry.content) <= 4096); assert.ok(f.sockets.every(socket => socket.filter.kinds.includes(20378)));
  assert.ok([...f.rows('wss://one.test/').values()].every(event => event.kind !== 20378), 'ephemeral telemetry is not replayed as stored presence');
  reportA = false; f.advance(13000);
  assert.equal(b.snapshot().listeners, 2); assert.equal(b.snapshot().members.find(member => !member.isSelf).telemetry, null, 'report expiry does not remove live membership');
  a.stop(); f.advance(0); assert.equal(b.snapshot().members.length, 1); b.stop(); assert.equal(f.activeTimers(), 0);
});

test('telemetry defaults off and observer failure or malformed local samples never disrupt presence', async () => {
  for (const callback of [undefined, () => { throw new Error('observer'); }, () => ({ ...fixture().report(), ip: '192.0.2.1' })]) {
    const f = fixture(), session = f.create({ getTelemetry: callback }); await f.join(session); f.advance(12000);
    assert.equal(session.snapshot().ready, true); assert.equal(session.snapshot().listeners, 1);
    assert.ok(f.published.every(row => row.event.kind === LISTENER_SESSION_KIND)); session.stop(); assert.equal(f.activeTimers(), 0);
  }
});

test('remote telemetry requires active signed membership, current epoch, strict fields and bounded values', async () => {
  const f = fixture(), session = f.create(); await f.join(session);
  const state = session.snapshot(), epoch = { id: state.epochId, startedAt: state.startedAt }, secret = generateSecretKey();
  f.inject('wss://one.test/', f.telemetry({ secret, epoch })); f.advance(0);
  assert.equal(session.snapshot().members.length, 1, 'telemetry cannot create room membership');
  const member = f.signed({ secret, epoch }); f.inject('wss://one.test/', member); f.advance(0);
  const memberReport = () => session.snapshot().members.find(value => value.id === member.pubkey)?.telemetry;
  for (const value of [
    { ...f.report(), peerId: 'https://example.test' }, { ...f.report(), positionMs: 268501 },
    { ...f.report(), following: 'yes' }, { ...f.report(), uploadedBytes: -1 },
    { ...f.report(), peerBytes: 2 ** 49 }, { ...f.report(), originBytes: '100' },
    { ...f.report(), sampledAt: f.now() - 13000 }, { ...f.report(), sampledAt: f.now() + 6000 },
    { ...f.report(), connections: Array.from({ length: 4 }, (_, index) => ({ peerId: String(index + 2).repeat(64), sentBytes: 1, receivedBytes: 1 })) },
    { ...f.report(), connections: [{ peerId: '2'.repeat(64), sentBytes: 1, receivedBytes: 1, address: '192.0.2.1' }] },
    { ...f.report(), connections: [{ peerId: '1'.repeat(64), sentBytes: 1, receivedBytes: 1 }] },
    { ...f.report(), connections: [{ peerId: '2'.repeat(64), sentBytes: 1, receivedBytes: 1 }, { peerId: '2'.repeat(64), sentBytes: 1, receivedBytes: 1 }] },
  ]) {
    f.inject('wss://one.test/', f.telemetry({ secret, epoch, value })); f.advance(0); assert.equal(memberReport(), null);
  }
  for (const body of [{ source: 'c'.repeat(64) }, { room: 'other' }, { durationMs: 1 },
    { epoch: { ...epoch, id: 'e'.repeat(64) } }, { url: 'https://example.test' }, { padding: 'x'.repeat(5000) }]) {
    f.inject('wss://one.test/', f.telemetry({ secret, epoch, body })); f.advance(0); assert.equal(memberReport(), null);
  }
  const valid = f.telemetry({ secret, epoch });
  f.inject('wss://one.test/', { ...valid, sig: '0'.repeat(128) }); f.advance(0); assert.equal(memberReport(), null);
  f.inject('wss://one.test/', valid); f.inject('wss://two.test/', valid); f.advance(0);
  assert.equal(memberReport().originBytes, 1000000); assert.equal(session.snapshot().listeners, 2);
  const firstSample = memberReport().sampledAt; f.advance(1000);
  const latest = f.telemetry({ secret, epoch, value: { ...f.report(), peerBytes: 700000 } });
  f.inject('wss://one.test/', latest); f.advance(0); f.inject('wss://two.test/', valid); f.advance(0);
  assert.ok(memberReport().sampledAt > firstSample); assert.equal(memberReport().peerBytes, 700000, 'late telemetry replay cannot roll counters back');
  f.inject('wss://one.test/', f.signed({ secret, epoch, status: 'left', created_at: Math.floor(f.now() / 1000) + 1 })); f.advance(0);
  assert.equal(session.snapshot().listeners, 1); assert.equal(memberReport(), undefined);
  session.stop(); assert.equal(f.activeTimers(), 0); assert.equal(LISTENER_TELEMETRY_LIMITS.ttlMs, 12000);
});

test('explicit observation reads live membership and reports without creating a listener or publishing anything', async () => {
  const f = fixture(), changes = []; let telemetryCalls = 0;
  const observer = f.create({ getTelemetry: () => { telemetryCalls++; return f.report(); }, onChange: state => changes.push(state) }, 'observer');
  const started = observer.observe(); assert.equal(started.observed, false); assert.equal(started.id, null);
  f.advance(0); assert.equal(observer.snapshot().observed, true); assert.equal(observer.snapshot().listeners, 0);
  assert.equal(observer.snapshot().ready, false); assert.equal(observer.snapshot().joined, false);
  const a = f.create({ getTelemetry: () => f.report() }, 'a'); await f.join(a); f.advance(0);
  const state = observer.snapshot();
  assert.equal(state.listeners, 1); assert.equal(state.members.length, 1); assert.equal(state.members[0].isSelf, false);
  assert.equal(state.epochId, a.snapshot().epochId); assert.equal(state.members[0].telemetry.peerId, '1'.repeat(64));
  assert.equal(telemetryCalls, 0); assert.ok(f.published.every(row => row.label !== 'observer'));
  assert.ok(changes.some(value => value.observed && value.listeners === 1));
  a.stop(); f.advance(0); assert.equal(observer.snapshot().listeners, 0);
  observer.stop(); assert.equal(f.activeTimers(), 0);
});

test('observe, join, instant leave and rejoin reuse at most three sockets and do not count an inactive observer', async () => {
  const f = fixture(), a = f.create({}, 'a'); await f.join(a);
  const observer = f.create({ relays: ['wss://one.test', 'wss://two.test', 'wss://three.test'] }, 'observer');
  observer.observe(); f.advance(0);
  assert.equal(observer.snapshot().listeners, 1);
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.join(observer); f.advance(0);
    assert.equal(a.snapshot().listeners, 2); assert.equal(observer.snapshot().listeners, 2);
    observer.leave(); f.advance(0);
    const state = observer.snapshot();
    assert.equal(state.status, 'observing'); assert.equal(state.id, null); assert.equal(state.ready, false);
    assert.equal(state.joined, false); assert.equal(state.observed, true); assert.equal(state.listeners, 1);
    assert.equal(a.snapshot().listeners, 1, 'the signed leave updates the other listener immediately');
    assert.equal(f.sockets.filter(socket => socket.label === 'observer').length, 3, 'no playback cycle opens a replacement metadata socket');
  }
  observer.stop(); a.stop(); assert.equal(f.activeTimers(), 0);
});

test('observed requires a current socket matching EOSE and resets on connection loss until a fresh EOSE', () => {
  const f = fixture(); f.eose.set('wss://one.test/', false); f.eose.set('wss://two.test/', false);
  const observer = f.create(); observer.observe(); f.advance(0);
  assert.equal(observer.snapshot().observed, false);
  f.sockets[0].respond(['EOSE', 'unrelated']); f.advance(0); assert.equal(observer.snapshot().observed, false);
  f.sockets[0].respond(['EOSE', f.sockets[0].sub]); f.advance(0); assert.equal(observer.snapshot().observed, true);
  f.sockets[0].close(); assert.equal(observer.snapshot().observed, false);
  f.advance(1000); assert.equal(observer.snapshot().observed, false, 'an open websocket without subscription completion is not observation proof');
  const reconnected = f.sockets.at(-1); reconnected.respond(['EOSE', reconnected.sub]); f.advance(0);
  assert.equal(observer.snapshot().observed, true);
  observer.stop(); assert.equal(observer.snapshot().observed, false); assert.equal(f.activeTimers(), 0);
});

test('an idle observer emits presence expiry even when no viewer heartbeat or media timer is running', () => {
  const f = fixture(), changes = [], observer = f.create({ onChange: state => changes.push(state) });
  observer.observe(); f.advance(0);
  f.inject('wss://one.test/', f.signed()); f.advance(0); assert.equal(observer.snapshot().listeners, 1);
  const afterPresence = changes.length; f.advance(25000);
  assert.equal(observer.snapshot().listeners, 0);
  assert.ok(changes.slice(afterPresence).some(state => state.observed && state.listeners === 0), 'maintenance notifies the idle UI when abrupt departure leases expire');
  assert.equal(f.published.length, 0); observer.stop(); assert.equal(f.activeTimers(), 0);
});

test('observer reconnections renew their failure budget only after matching EOSE or an explicit retry', () => {
  const f = fixture(), observer = f.create({ relays: ['wss://one.test'] }); observer.observe(); f.advance(0);
  for (let outage = 0; outage < 8; outage++) {
    f.sockets.at(-1).close(); f.advance(1000); assert.equal(observer.snapshot().observed, true);
  }
  f.eose.set('wss://one.test/', false);
  for (let outage = 0; outage < 8; outage++) { f.sockets.at(-1).close(); f.advance(17000); }
  const attempts = f.sockets.length; f.advance(60000);
  assert.equal(f.sockets.length, attempts); assert.equal(observer.snapshot().observed, false);
  f.eose.set('wss://one.test/', true); observer.observe(); f.advance(0);
  assert.equal(f.sockets.length, attempts + 1); assert.equal(observer.snapshot().observed, true, 'explicit observation can retry after the network recovers');
  observer.stop(); assert.equal(f.activeTimers(), 0);
});

test('explicit Play re-arms exhausted observer connections without adding a second relay entry', async () => {
  const f = fixture(), observer = f.create({ relays: ['wss://one.test'] }); observer.observe(); f.advance(0);
  f.eose.set('wss://one.test/', false);
  for (let outage = 0; outage < 8; outage++) { f.sockets.at(-1).close(); f.advance(17000); }
  const attempts = f.sockets.length; assert.equal(observer.snapshot().connectedRelays, 0);
  f.eose.set('wss://one.test/', true);
  assert.equal((await f.join(observer)).ready, true); assert.equal(f.sockets.length, attempts + 1);
  assert.equal(f.sockets.filter(socket => socket.readyState === 1).length, 1);
  observer.stop(); assert.equal(f.activeTimers(), 0);
});

test('leaving an opted-in observer during a pending publish rejects join but keeps metadata subscriptions alive', async () => {
  const f = fixture(), observer = f.create(); observer.observe(); f.advance(0);
  f.acks.set('wss://one.test/', null); f.acks.set('wss://two.test/', null);
  const rejected = assert.rejects(observer.join(), { name: 'AbortError' }); f.advance(1250);
  const active = f.published.find(row => JSON.parse(row.event.content).status === 'active').event;
  observer.leave(); await rejected; f.advance(0);
  f.sockets[0].respond(['OK', active.id, true]); f.advance(0);
  assert.equal(observer.snapshot().status, 'observing'); assert.equal(observer.snapshot().id, null);
  assert.equal(observer.snapshot().ready, false); assert.equal(observer.snapshot().observed, true);
  assert.equal(observer.snapshot().listeners, 0); assert.equal(f.sockets.length, 2);
  f.acks.set('wss://one.test/', true); assert.equal((await f.join(observer)).ready, true);
  assert.equal(f.sockets.length, 2); observer.stop(); assert.equal(f.activeTimers(), 0);
});

test('cold preparation reserves no published presence or advancing room until its exact token commits', async () => {
  const f = fixture(), session = f.create();
  const pending = session.prepareJoin(); f.advance(1250); const prepared = await pending;
  assert.equal(prepared.prepared, true); assert.equal(prepared.ready, false); assert.equal(prepared.startedAt, null);
  assert.equal(prepared.listeners, 0); assert.equal(prepared.epochId, prepared.id); assert(Object.isFrozen(prepared.token));
  assert.equal(session.snapshot().prepared, true); assert.equal(Object.hasOwn(session.snapshot(), 'token'), false);
  f.advance(12000);
  assert.equal(session.position(), 0); assert.equal(session.snapshot().startedAt, null); assert.equal(f.published.length, 0);
  const repeated = await session.prepareJoin(); assert.equal(repeated.token, prepared.token);
  await assert.rejects(session.commitPreparedStart(Object.freeze({})), { name: 'AbortError' });
  assert.equal(session.snapshot().prepared, true, 'unrelated tokens do not retire the live reservation');
  const at = f.now(), committed = session.commitPreparedStart(prepared.token); f.advance(0); const live = await committed;
  assert.equal(live.ready, true); assert.equal(live.prepared, false); assert.equal(live.adopted, false);
  assert.equal(live.epochId, prepared.epochId); assert.equal(live.startedAt, at); assert.equal(live.position, 0);
  assert.equal(live.listeners, 1); f.advance(2000); assert.equal(session.position(), 2);
  await assert.rejects(session.commitPreparedStart(prepared.token), { name: 'AbortError' });
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('prepare joins an existing active room immediately and does not freeze or replace its clock', async () => {
  const f = fixture(), starter = f.create(), first = await f.join(starter); f.advance(5000);
  const follower = f.create(), pending = follower.prepareJoin(); f.advance(1250); const joined = await pending;
  assert.equal(joined.ready, true); assert.equal(joined.prepared, false); assert.equal(joined.token, null);
  assert.equal(joined.epochId, first.epochId); assert.equal(joined.startedAt, first.startedAt); assert.equal(joined.position, 6.25);
  f.advance(1000); assert.equal(follower.position(), 7.25); follower.stop(); starter.stop();
});

test('fully observed active-room preparation publishes without another discovery delay but still requires ACK', async () => {
  const f = fixture(), active = f.signed(), epoch = JSON.parse(active.content).epoch;
  const urls = ['wss://one.test/', 'wss://two.test/', 'wss://three.test/'];
  for (const url of urls) { f.inject(url, active); f.acks.set(url, null); }
  const session = f.create({ relays: urls }); session.observe(); f.advance(0);
  const at = f.now(), pending = session.prepareJoin();
  assert.equal(session.snapshot().status, 'publishing', 'completed discovery of an active room must not wait another 1250 ms');
  assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().epochId, epoch.id);
  assert.equal(session.snapshot().startedAt, epoch.startedAt);
  const publication = f.published[0].event;
  assert.equal(f.published.length, 3);
  f.advance(1249); assert.equal(session.snapshot().ready, false, 'time alone cannot replace publication ACK');
  f.sockets[0].respond(['OK', publication.id, true]); f.advance(0);
  const result = await pending;
  assert.equal(result.ready, true); assert.equal(result.prepared, false); assert.equal(result.token, null);
  assert.equal(result.epochId, epoch.id); assert.equal(result.startedAt, epoch.startedAt);
  assert.equal(result.position, (f.now() - epoch.startedAt) / 1000);
  f.advance(1); assert.equal(f.now() - at, 1250);
  assert.equal(f.published.length, 3, 'the cancelled discovery timer cannot publish a second initial claim');
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('fast active-room preparation aborts before ACK and late ACK cannot revive its actor', async () => {
  const f = fixture(), operation = new AbortController();
  f.inject('wss://one.test/', f.signed());
  for (const url of ['wss://one.test/', 'wss://two.test/']) f.acks.set(url, null);
  const session = f.create(); session.observe(); f.advance(0);
  const pending = session.prepareJoin({ signal: operation.signal }), rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.equal(session.snapshot().status, 'publishing');
  const event = f.published[0].event;
  operation.abort(); await rejected;
  assert.equal(JSON.parse(f.published.at(-1).event.content).status, 'left');
  f.sockets[0].respond(['OK', event.id, true]); f.advance(0);
  assert.equal(session.snapshot().status, 'observing'); assert.equal(session.snapshot().ready, false);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('active-room fast preparation requires every configured current matching EOSE and preserves incomplete discovery', async () => {
  for (const condition of ['no-observe', 'one-eose', 'wrong-subscription', 'closed', 'reconnecting', 'cold', 'left', 'invalid', 'expired', 'truncated', 'legacy']) {
    const f = fixture(), session = f.create(condition === 'truncated' ? { maxRecords: 2 } : {});
    if (condition !== 'cold') {
      const active = f.signed(condition === 'left' ? { status: 'left' } : {});
      f.inject('wss://one.test/', condition === 'invalid' ? { ...active, sig: '0'.repeat(128) } : active);
    }
    if (condition === 'truncated') for (let i = 0; i < 3; i++) f.inject('wss://one.test/', f.signed());
    if (['one-eose', 'wrong-subscription', 'reconnecting'].includes(condition)) f.eose.set('wss://two.test/', false);
    if (condition !== 'no-observe') { session.observe(); f.advance(0); }
    if (condition === 'wrong-subscription') { f.sockets[1].respond(['EOSE', 'unrelated']); f.advance(0); }
    if (condition === 'closed' || condition === 'reconnecting') {
      f.sockets[1].close();
      if (condition === 'reconnecting') {
        f.advance(1000);
        assert.equal(f.sockets.at(-1).readyState, 1);
        // An obsolete connection's completion cannot qualify the replacement.
        f.sockets[1].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(['EOSE', f.sockets[1].sub]) }));
      }
    }
    if (condition === 'expired') f.advance(25000);
    if (condition === 'truncated') assert.equal(session.snapshot().truncated, true);
    const pending = condition === 'legacy' ? session.join() : session.prepareJoin();
    f.advance(1249);
    assert.equal(session.snapshot().status, 'discovering', `${condition} retains the complete discovery window`);
    assert.equal(f.published.length, 0);
    f.advance(1); const result = await pending;
    assert.equal(result.ready || result.prepared, true);
    session.stop(); assert.equal(f.activeTimers(), 0);
  }
});

test('EOSE completed after prepare entry retains the original discovery timer', async () => {
  const f = fixture(); f.eose.set('wss://two.test/', false);
  f.inject('wss://one.test/', f.signed());
  const session = f.create(); session.observe(); f.advance(0);
  const pending = session.prepareJoin();
  f.sockets[1].respond(['EOSE', f.sockets[1].sub]); f.advance(0);
  f.advance(1249); assert.equal(session.snapshot().status, 'discovering'); assert.equal(f.published.length, 0);
  f.advance(1); assert.equal((await pending).ready, true);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('truncated observation stays incomplete across acknowledged join, leave and reprepare on the same subscriptions', async () => {
  const f = fixture(), session = f.create({ maxRecords: 2 });
  for (let i = 0; i < 3; i++) f.inject('wss://one.test/', f.signed());
  session.observe(); f.advance(0); assert.equal(session.snapshot().truncated, true);
  const sockets = [...f.sockets];
  const first = session.prepareJoin(); f.advance(1249);
  assert.equal(session.snapshot().status, 'discovering');
  f.advance(1); assert.equal((await first).ready, true);
  session.leave(); f.advance(0);
  const second = session.prepareJoin();
  assert.equal(session.snapshot().status, 'discovering', 'retaining the same incomplete records cannot qualify a later shortcut');
  assert.equal(session.snapshot().truncated, true);
  assert.deepEqual(f.sockets, sockets, 'join/leave did not rebuild the observation subscriptions');
  f.advance(1249); assert.equal(session.snapshot().status, 'discovering');
  f.advance(1); assert.equal((await second).ready, true);
  session.stop(); assert.equal(f.activeTimers(), 0); assert.equal(session.snapshot().truncated, false);
});

test('active observation is freshly revalidated before fast preparation can publish', async () => {
  const f = fixture(), active = f.signed(); f.inject('wss://one.test/', active);
  const runtime = f.runtime(); let armed = false, reads = 0, offset = 0;
  runtime.now = () => {
    // Entry sees a fresh lease; the subsequent actor-creation clock read
    // advances past expiry before the immediate finish revalidates it.
    if (armed && ++reads === 2) offset = 25000;
    return f.now() + offset;
  };
  const session = createListenerSession(defaults, runtime); session.observe(); f.advance(0);
  assert.equal(session.snapshot().listeners, 1);
  armed = true; const pending = session.prepareJoin();
  assert.ok(offset > 0); assert.equal(session.snapshot().status, 'discovering'); assert.equal(f.published.length, 0);
  f.advance(1249); assert.equal(session.snapshot().status, 'discovering');
  f.advance(1); assert.equal((await pending).prepared, true);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('fast preparation keeps epoch convergence and actor ownership while its ACK is pending', async () => {
  const f = fixture(), first = f.signed(); f.inject('wss://one.test/', first);
  for (const url of ['wss://one.test/', 'wss://two.test/']) f.acks.set(url, null);
  const session = f.create(); session.observe(); f.advance(0);
  const pending = session.prepareJoin(), rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.equal(session.snapshot().status, 'publishing'); const oldEvent = f.published[0].event;
  const older = f.signed({ epoch: { id: 'c'.repeat(64), startedAt: f.now() - 20000 } });
  f.inject('wss://one.test/', older); f.advance(0);
  assert.equal(session.snapshot().epochId, JSON.parse(older.content).epoch.id);
  session.leave(); await rejected;
  const current = session.prepareJoin(); assert.equal(session.snapshot().status, 'publishing');
  const actor = session.snapshot().id, event = f.published.at(-1).event;
  f.sockets[0].respond(['OK', oldEvent.id, true]); f.advance(0);
  assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().id, actor);
  f.sockets[0].respond(['OK', event.id, true]); f.advance(0);
  const result = await current;
  assert.equal(result.startedAt, JSON.parse(older.content).epoch.startedAt);
  assert.equal(result.epochId, JSON.parse(older.content).epoch.id);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('prepared listener adopts a newly observed active epoch before its buffer commit', async () => {
  const f = fixture(), a = f.create(), pending = a.prepareJoin(); f.advance(1250); const candidate = await pending;
  const b = f.create(), live = await f.join(b); f.advance(0);
  const joined = a.snapshot();
  assert.equal(joined.ready, true, 'a prepared listener cannot wait on its private buffer while a verified active room exists');
  assert.equal(joined.prepared, false); assert.equal(joined.epochId, live.epochId); assert.equal(joined.startedAt, live.startedAt);
  assert.notEqual(joined.epochId, candidate.epochId); assert.equal(joined.listeners, 2);
  a.stop(); b.stop(); assert.equal(f.activeTimers(), 0);
});

test('automatic prepared adoption waits for ACK under the original operation signal', async () => {
  const f = fixture(), operation = new AbortController(), session = f.create({}, 'prepared');
  const pending = session.prepareJoin({ signal: operation.signal }); f.advance(1250); const reservation = await pending;
  for (const url of ['wss://one.test/', 'wss://two.test/']) f.acks.set(url, null);
  const active = f.signed(); f.inject('wss://one.test/', active); f.advance(0);
  const publishing = session.snapshot();
  assert.equal(publishing.adoptingPrepared, true); assert.equal(publishing.ready, false);
  assert.equal(publishing.prepared, false); assert.equal(publishing.status, 'publishing');
  assert.equal(publishing.epochId, JSON.parse(active.content).epoch.id);
  const sdk = new AbortController(), joined = session.commitPreparedStart(reservation.token, { signal: sdk.signal });
  sdk.abort(); f.advance(1000);
  assert.equal(session.snapshot().adoptingPrepared, true, 'coalescing cannot replace the session-owned cancellation with a retiring SDK signal');
  const publication = f.published.at(-1).event.id;
  for (const socket of f.sockets) socket.respond(['OK', publication, true]);
  f.advance(0); const result = await joined;
  assert.equal(result.ready, true); assert.equal(result.adoptingPrepared, false);
  operation.abort(); assert.equal(session.snapshot().ready, true, 'ACK detached the completed operation before host cleanup');
  session.stop(); assert.equal(f.activeTimers(), 0);
});

for (const action of ['leave', 'stop', 'signal', 'refuse', 'timeout']) test(`automatic prepared adoption handles ${action} without late activation`, async () => {
  const f = fixture(), operation = new AbortController(), session = f.create({}, 'prepared'); session.observe();
  const pending = session.prepareJoin({ signal: operation.signal }); f.advance(1250); const reservation = await pending;
  for (const url of ['wss://one.test/', 'wss://two.test/']) f.acks.set(url, null);
  f.inject('wss://one.test/', f.signed()); f.advance(0);
  const wait = session.commitPreparedStart(reservation.token), rejected = assert.rejects(wait);
  const publication = f.published.at(-1).event.id;
  if (action === 'signal') operation.abort();
  else if (action === 'leave' || action === 'stop') session[action]();
  else if (action === 'timeout') f.advance(LISTENER_SESSION_DEFAULTS.publishTimeoutMs);
  else { for (const socket of f.sockets) socket.respond(['OK', publication, false]); f.advance(LISTENER_SESSION_DEFAULTS.publishTimeoutMs); }
  await rejected;
  for (const socket of f.sockets) if (socket.readyState === 1) socket.respond(['OK', publication, true]);
  f.advance(0);
  assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().adoptingPrepared, false);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('prepared notification reentrancy settles its original caller through automatic adoption or leave', async () => {
  for (const action of ['active', 'leave']) {
    const f = fixture(); let session, fired = false;
    session = f.create({ onChange: state => {
      if (!state.prepared || fired) return; fired = true;
      if (action === 'leave') session.leave();
      else { f.inject('wss://one.test/', f.signed()); f.advance(0); }
    } });
    const pending = session.prepareJoin();
    const result = action === 'leave' ? assert.rejects(pending, { name: 'AbortError' }) : pending;
    f.advance(1250); const joined = await result;
    if (action === 'active') { assert.equal(joined.ready, true); assert.equal(joined.prepared, false); assert.equal(joined.adoptingPrepared, false); }
    session.stop(); assert.equal(f.activeTimers(), 0);
  }
});

test('a cancelled prepared notification cannot bridge its caller into a reentrant new actor', async () => {
  const f = fixture(); let session, replacement, originalActor, fired = false;
  session = f.create({ onChange: state => {
    if (!state.prepared || fired) return; fired = true; originalActor = state.id;
    session.leave(); replacement = session.prepareJoin();
  } });
  session.observe();
  const pending = session.prepareJoin(), rejected = assert.rejects(pending, { name: 'AbortError' });
  f.advance(1250); await rejected;
  f.advance(1250); const next = await replacement;
  assert.equal(next.prepared, true); assert.notEqual(next.id, originalActor);
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('prepared reservation ignores left, invalid, expired and wrong-source rows without publishing', async () => {
  for (const bad of ['left', 'signature', 'expired', 'source']) {
    const f = fixture(), session = f.create({}, 'prepared');
    const pending = session.prepareJoin(); f.advance(1250); const reservation = await pending;
    let event = f.signed(bad === 'left' ? { status: 'left' } : bad === 'expired' ? { created_at: Math.floor(f.now() / 1000) - 25 } : bad === 'source' ? { extra: { source: 'c'.repeat(64) } } : {});
    if (bad === 'signature') event = { ...event, sig: '0'.repeat(128) };
    f.inject('wss://one.test/', event); f.advance(0);
    assert.equal(session.snapshot().prepared, true, bad); assert.equal(session.snapshot().epochId, reservation.epochId, bad);
    assert.equal(f.published.length, 0, bad); session.stop(); assert.equal(f.activeTimers(), 0);
  }
});

test('prepared starts ignore left-only grace rows while legacy join retains its grace compatibility', async () => {
  const f = fixture(), old = f.create(), first = await f.join(old); old.leave(); f.advance(0);
  const next = f.create({}, 'next'), pending = next.prepareJoin(); f.advance(1250); const prepared = await pending;
  assert.equal(prepared.prepared, true); assert.notEqual(prepared.epochId, first.epochId); assert.equal(f.published.filter(r => r.label === 'next').length, 0);
  const committed = next.commitPreparedStart(prepared.token); f.advance(0); const live = await committed;
  assert.equal(live.adopted, false); assert.equal(live.epochId, prepared.epochId);
  next.stop(); old.stop();
});

for (const cancellation of ['leave', 'stop', 'signal']) test(`prepared reservation ${cancellation} cancellation rejects stale token and late ACK cannot revive it`, async () => {
  const f = fixture(), session = f.create(), operation = new AbortController(); session.observe();
  const pending = session.prepareJoin({ signal: operation.signal }); f.advance(1250); const prepared = await pending;
  f.acks.set('wss://one.test/', null); f.acks.set('wss://two.test/', null);
  const commit = session.commitPreparedStart(prepared.token, { signal: operation.signal });
  const rejected = assert.rejects(commit, { name: 'AbortError' });
  const publication = f.published.at(-1).event.id;
  if (cancellation === 'signal') operation.abort(); else session[cancellation]();
  await rejected;
  for (const socket of f.sockets) if (socket.readyState === 1) socket.respond(['OK', publication, true]);
  f.advance(0); assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().prepared, false);
  await assert.rejects(session.commitPreparedStart(prepared.token), { name: 'AbortError' });
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('abort during preparation discovery rejects once and a fresh reservation uses a different token', async () => {
  const f = fixture(), session = f.create(), operation = new AbortController(); session.observe();
  const pending = session.prepareJoin({ signal: operation.signal }); const rejected = assert.rejects(pending, { name: 'AbortError' });
  operation.abort(); await rejected; f.advance(1250); assert.equal(f.published.length, 0);
  const next = session.prepareJoin(); f.advance(1250); const prepared = await next;
  session.leave(); const again = session.prepareJoin(); f.advance(1250); const fresh = await again;
  assert.notEqual(fresh.token, prepared.token); await assert.rejects(session.commitPreparedStart(prepared.token), { name: 'AbortError' });
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('concurrent prepared starters converge through the existing signed epoch rule', async () => {
  const f = fixture(), a = f.create(), b = f.create();
  const pa = a.prepareJoin(), pb = b.prepareJoin(); f.advance(1250); const aa = await pa, bb = await pb;
  assert.equal(f.published.length, 0);
  const ca = a.commitPreparedStart(aa.token), cb = b.commitPreparedStart(bb.token); f.advance(0);
  await Promise.all([ca, cb]); f.advance(1000);
  assert.equal(a.snapshot().epochId, b.snapshot().epochId); assert.equal(a.snapshot().startedAt, b.snapshot().startedAt);
  assert.equal(a.snapshot().listeners, 2); a.stop(); b.stop(); assert.equal(f.activeTimers(), 0);
});

test('legacy join during preparation discovery still commits immediately, and reentrant leave rejects preparation', async () => {
  const f = fixture(), session = f.create(); const preparation = session.prepareJoin(), joining = session.join();
  f.advance(1250); const [a, b] = await Promise.all([preparation, joining]); assert.equal(a.ready, true); assert.equal(b.ready, true);
  session.stop();
  let cancelled;
  const other = f.create({ onChange(state) { if (state.prepared) cancelled.leave(); } }); cancelled = other;
  const pending = other.prepareJoin(), rejected = assert.rejects(pending, { name: 'AbortError' });
  f.advance(1250); await rejected; assert.equal(other.snapshot().prepared, false); other.stop(); assert.equal(f.activeTimers(), 0);
});

test('successful prepared ACK detaches the SDK operation signal before normal barrier release aborts it', async () => {
  const f = fixture(), session = f.create(), operation = new AbortController();
  const pending = session.prepareJoin(); f.advance(1250); const prepared = await pending;
  const committing = session.commitPreparedStart(prepared.token, { signal: operation.signal }); f.advance(0); const live = await committing;
  operation.abort(); f.advance(1000);
  assert.equal(session.snapshot().ready, true); assert.equal(session.snapshot().epochId, live.epochId);
  assert.equal(session.position(), 1); assert(f.published.every(row => JSON.parse(row.event.content).status === 'active'));
  session.stop(); assert.equal(f.activeTimers(), 0);
});

test('standalone prepared publication abort emits a final tombstone before its sockets are closed', async () => {
  const f = fixture(), session = f.create(), operation = new AbortController();
  const pending = session.prepareJoin(); f.advance(1250); const prepared = await pending;
  f.acks.set('wss://one.test/', null); f.acks.set('wss://two.test/', null);
  const committing = session.commitPreparedStart(prepared.token, { signal: operation.signal });
  const rejected = assert.rejects(committing, { name: 'AbortError' }); operation.abort(); await rejected;
  const statuses = f.published.map(row => JSON.parse(row.event.content).status);
  assert.deepEqual(statuses, ['active', 'active', 'left', 'left']);
  assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().listeners, 0);
  assert(f.sockets.every(socket => socket.readyState === 3)); session.stop(); assert.equal(f.activeTimers(), 0);
});

test('ACK notification can retire the old SDK synchronously without aborting the newly acknowledged room', async () => {
  const f = fixture(), operation = new AbortController();
  const session = f.create({ onChange(state) { if (state.ready) operation.abort(); } });
  const pending = session.prepareJoin(); f.advance(1250); const prepared = await pending;
  const committing = session.commitPreparedStart(prepared.token, { signal: operation.signal }); f.advance(0); const joined = await committing;
  assert.equal(operation.signal.aborted, true); assert.equal(joined.ready, true); assert.equal(session.snapshot().ready, true);
  assert(f.published.every(row => JSON.parse(row.event.content).status === 'active'));
  session.stop(); assert.equal(f.activeTimers(), 0);
});
