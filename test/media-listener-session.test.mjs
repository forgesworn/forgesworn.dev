import test from 'node:test';
import assert from 'node:assert/strict';
import { createListenerSession, LISTENER_SESSION_KIND, LISTENER_SESSION_DEFAULTS } from '../site/media-listener-session.mjs';
import { finalizeEvent, generateSecretKey } from '../site/vendor/media-peer-demo.js';

const source = 'a'.repeat(64), room = 'dejavu-full-v1';
const defaults = { room, source, duration: 268.5, relays: ['wss://one.test', 'wss://two.test'] };

function fixture() {
  let at = 1800000000000, next = 0;
  const timers = new Map(), sockets = [], published = [], stored = new Map(), policies = new Map(), acks = new Map();
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
    if (!old || old.created_at < event.created_at || old.created_at === event.created_at && old.id > event.id) rows.set(address, event);
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
  async function join(session) { const pending = session.join(); advance(1250); return pending; }
  return { now: () => at, advance, runtime, create, join, signed, inject, sockets, published, policies, acks,
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
