// Signed, short-lived observations of a shared listening clock. This is an
// experimental public addressable event (NIP-01), not NIP-78 private app storage.
// Relay partitions and dishonest clients prevent an authoritative audience count.
import { finalizeEvent, generateSecretKey, verifyEvent } from './vendor/media-peer-demo.js';

export const LISTENER_SESSION_KIND = 30378;
export const LISTENER_SESSION_DEFAULTS = Object.freeze({
  discoveryMs: 1250, heartbeatMs: 6000, ttlMs: 24000, openTimeoutMs: 5000, publishTimeoutMs: 5000,
  maxRecords: 256, maxRelays: 3, maxFrameBytes: 8192, maxClockSkewMs: 5000,
});
const HEX = /^[0-9a-f]{64}$/u;
const MAX_EPOCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRIES = 5;
const sameEpoch = (a, b) => a?.id === b?.id && a?.startedAt === b?.startedAt;
const compareEpoch = (a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const abortError = () => Object.assign(new Error('Listening session stopped.'), { name: 'AbortError' });
function integer(value, fallback, min, max, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new TypeError(`Invalid listening ${label}.`);
  return result;
}

/**
 * Networking starts only at join(), after the page's affirmative play gesture.
 * duration is seconds; startedAt is Unix milliseconds; position() is seconds.
 * leave() is reusable; stop() is terminal. onChange receives a fresh snapshot.
 * Runtime injection is for deterministic tests, not a page-global control.
 */
export function createListenerSession(options, runtime = {}) {
  const { room, source, duration, signal, onChange } = options ?? {};
  if (typeof room !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/u.test(room)
    || !HEX.test(source) || !Number.isFinite(duration) || duration < 1 || duration > 86400) {
    throw new TypeError('Invalid listening room or source.');
  }
  const durationMs = Math.round(duration * 1000), d = `forgesworn-listener:${room}`;
  const discoveryMs = integer(options.discoveryMs, 1250, 100, 5000, 'discovery window');
  const heartbeatMs = integer(options.heartbeatMs, 6000, 1000, 10000, 'heartbeat');
  const ttlMs = integer(options.ttlMs, 24000, heartbeatMs * 2, 30000, 'lease');
  if (ttlMs % 1000) throw new TypeError('Listening lease must use whole seconds.');
  const openTimeoutMs = integer(options.openTimeoutMs, 5000, 100, 10000, 'open timeout');
  const publishTimeoutMs = integer(options.publishTimeoutMs, 5000, 100, 10000, 'publish timeout');
  const maxRecords = integer(options.maxRecords, 256, 1, 256, 'record limit');
  const relays = [...new Set((options.relays ?? []).map(value => {
    const url = new URL(value);
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash
      || url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new TypeError('Invalid listening relay.');
    }
    return url.href;
  }))];
  if (!relays.length || relays.length > 3) throw new TypeError('Use one to three listening relays.');
  const now = runtime.now ?? Date.now;
  const later = runtime.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = runtime.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const Socket = runtime.WebSocketImpl ?? globalThis.WebSocket;
  const page = runtime.page ?? globalThis.window;
  let phase = 'idle', key = null, id = null, epoch = null, lastEvent = null;
  let lastCreatedAt = 0, lastPublishedAt = -Infinity, truncated = false;
  let generation = 0, pendingJoin = null, joinPromise = null;
  let openTimer = null, discoveryTimer = null, heartbeatTimer = null, publishTimer = null, ackTimer = null;
  let initialEventId = null;
  const records = new Map(), entries = [];

  function position() {
    return phase === 'active' && epoch ? Math.max(0, now() - epoch.startedAt) % durationMs / 1000 : 0;
  }
  function freshRows() {
    const at = now();
    for (const [author, row] of records) if (row.expiresAt <= at) records.delete(author);
    return [...records.values()];
  }
  function snapshot() {
    const rows = freshRows();
    return { id, joined: ['discovering', 'publishing', 'active'].includes(phase), ready: phase === 'active', status: phase,
      epochId: epoch?.id ?? null, startedAt: epoch?.startedAt ?? null, position: position(),
      listeners: rows.filter(row => row.status === 'active' && (row.author !== id || phase === 'active')).length, truncated,
      role: epoch ? epoch.id === id ? 'starter' : 'joined' : null,
      connectedRelays: entries.filter(entry => entry.ws?.readyState === 1).length };
  }
  function notify() {
    try {
      const result = onChange?.(snapshot());
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch {}
  }
  function bestEpoch() { return freshRows().map(row => row.epoch).sort(compareEpoch)[0] ?? null; }
  function send(entry, frame) {
    if (entry.ws?.readyState !== 1) return false;
    try { entry.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }
  function chooseEpoch() {
    const best = bestEpoch();
    if (['publishing', 'active'].includes(phase) && best && (!epoch || compareEpoch(best, epoch) < 0) && !sameEpoch(best, epoch)) {
      epoch = { ...best };
      queuePublish();
    }
  }
  function validate(event) {
    const at = now();
    if (!event || event.kind !== LISTENER_SESSION_KIND || !HEX.test(event.pubkey) || !HEX.test(event.id)
      || !Number.isSafeInteger(event.created_at) || event.created_at * 1000 > at + 5000
      || event.created_at * 1000 < at - ttlMs || typeof event.content !== 'string' || event.content.length > 1024
      || !Array.isArray(event.tags) || event.tags.length !== 3) return null;
    const tags = new Map();
    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string'
        || tags.has(tag[0])) return null;
      tags.set(tag[0], tag[1]);
    }
    if (!/^[0-9]{1,12}$/u.test(tags.get('expiration'))) return null;
    const expiresAt = Number(tags.get('expiration')) * 1000;
    if (tags.get('d') !== d || tags.get('source') !== source || !Number.isSafeInteger(expiresAt)
      || expiresAt <= at || expiresAt !== event.created_at * 1000 + ttlMs) return null;
    let body;
    try { body = JSON.parse(event.content); } catch { return null; }
    if (!body || Object.keys(body).length !== 6 || body.v !== 1 || body.room !== room || body.source !== source
      || body.durationMs !== durationMs || !['active', 'left'].includes(body.status)
      || !body.epoch || Object.keys(body.epoch).length !== 2 || !HEX.test(body.epoch.id)
      || !Number.isSafeInteger(body.epoch.startedAt) || body.epoch.startedAt > at + 5000
      || body.epoch.startedAt < at - MAX_EPOCH_AGE_MS) return null;
    try { if (!verifyEvent(event)) return null; } catch { return null; }
    return { id: event.id, author: event.pubkey, createdAt: event.created_at, expiresAt,
      status: body.status, epoch: { ...body.epoch } };
  }
  function accept(event) {
    // Already superseded or duplicate IDs cannot replace a verified row. Drop
    // those before another relay can repeat their signature-verification work.
    const known = records.get(event?.pubkey);
    if (known && (event.created_at < known.createdAt
      || event.created_at === known.createdAt && typeof event.id === 'string' && event.id >= known.id)) return;
    const row = validate(event);
    if (!row) return;
    const previous = records.get(row.author);
    // NIP-01 addressable replacement: latest timestamp, then lowest event ID.
    if (previous && (row.createdAt < previous.createdAt
      || row.createdAt === previous.createdAt && row.id >= previous.id)) return;
    freshRows();
    // Reserve the local row even if a relay fills its bounded discovery reply.
    if (!previous && row.author !== id && records.size >= maxRecords - (records.has(id) ? 0 : 1)) {
      truncated = true; return;
    }
    records.set(row.author, row);
    chooseEpoch();
    notify();
  }
  function publish(status = 'active') {
    if (!key || !epoch || status === 'active' && !['publishing', 'active'].includes(phase)) return;
    const created_at = Math.max(Math.floor(now() / 1000), lastCreatedAt + 1);
    // Clock jumps and rapid calls cannot manufacture unbounded future leases.
    if (created_at * 1000 > now() + 5000) return;
    lastCreatedAt = created_at; lastPublishedAt = now();
    const event = finalizeEvent({ kind: LISTENER_SESSION_KIND, created_at,
      tags: [['d', d], ['source', source], ['expiration', String(created_at + ttlMs / 1000)]],
      content: JSON.stringify({ v: 1, room, source, durationMs, status, epoch }) }, key);
    lastEvent = event;
    if (phase === 'publishing' && status === 'active') initialEventId = event.id;
    accept(event);
    for (const entry of entries) send(entry, ['EVENT', event]);
  }
  function queuePublish() {
    if (phase !== 'active' || publishTimer !== null) return;
    publishTimer = later(() => { publishTimer = null; publish(); }, Math.max(0, 1000 - (now() - lastPublishedAt)));
  }
  function heartbeat() {
    if (phase !== 'active') return;
    publish();
    if (phase === 'active') heartbeatTimer = later(heartbeat, heartbeatMs);
  }
  function finishDiscovery() {
    if (phase !== 'discovering') return;
    discoveryTimer = null;
    if (!entries.some(entry => entry.ws?.readyState === 1)) {
      teardown('unavailable', new Error('Listening relays disconnected during discovery.'));
      return;
    }
    const existing = bestEpoch();
    epoch = existing ? { ...existing } : { id, startedAt: now() };
    phase = 'publishing';
    ackTimer = later(() => teardown('unavailable', new Error('Listening relays did not accept this listener.')), publishTimeoutMs);
    publish();
  }
  function acceptedInitialPresence(eventId) {
    if (phase !== 'publishing' || eventId !== initialEventId) return;
    cancel(ackTimer); ackTimer = null;
    phase = 'active';
    // A newly observed older epoch may have converged while the ACK was pending.
    if (!sameEpoch(JSON.parse(lastEvent.content).epoch, epoch)) queuePublish();
    heartbeatTimer = later(heartbeat, heartbeatMs);
    notify();
    if (phase !== 'active') return;
    const pending = pendingJoin; pendingJoin = null;
    pending?.resolve(snapshot());
  }
  function disposeSocket(entry) {
    cancel(entry.openTimer); entry.openTimer = null;
    const ws = entry.ws; entry.ws = null;
    if (!ws) return;
    for (const [type, handler] of Object.entries(entry.handlers ?? {})) ws.removeEventListener(type, handler);
    try { ws.close(); } catch {}
  }
  function connect(entry, token) {
    if (token !== generation || !['discovering', 'publishing', 'active'].includes(phase)) return;
    entry.attempts++;
    let ws;
    const failed = () => {
      if (entry.ws !== ws) return;
      disposeSocket(entry); notify();
      if (token === generation && ['discovering', 'publishing', 'active'].includes(phase) && entry.attempts <= MAX_RETRIES) {
        entry.retry = later(() => { entry.retry = null; connect(entry, token); }, Math.min(1000 * 2 ** (entry.attempts - 1), 16000));
      }
    };
    try { ws = new Socket(entry.url); entry.ws = ws; } catch {
      entry.ws = null;
      if (entry.attempts <= MAX_RETRIES) entry.retry = later(() => { entry.retry = null; connect(entry, token); }, 1000);
      return;
    }
    entry.handlers = {
      open: () => {
        if (entry.ws !== ws || token !== generation) return;
        cancel(entry.openTimer); entry.openTimer = null;
        if (!send(entry, ['REQ', entry.sub, { kinds: [LISTENER_SESSION_KIND], '#d': [d],
          since: Math.floor((now() - ttlMs - 5000) / 1000), limit: maxRecords }])) return failed();
        if (phase === 'discovering' && discoveryTimer === null) {
          cancel(openTimer); openTimer = null;
          discoveryTimer = later(finishDiscovery, discoveryMs);
        }
        // Newly common relays see this clock immediately, without a global replay.
        if (['publishing', 'active'].includes(phase) && lastEvent && lastCreatedAt * 1000 + ttlMs > now()) send(entry, ['EVENT', lastEvent]);
        notify();
      },
      message: message => {
        if (entry.ws !== ws || token !== generation || typeof message.data !== 'string' || message.data.length > 8192) return;
        if (now() - entry.rateAt >= heartbeatMs) { entry.rateAt = now(); entry.frames = 0; }
        if (++entry.frames > 128) return;
        let frame;
        try { frame = JSON.parse(message.data); } catch { return; }
        if (!Array.isArray(frame)) return;
        if (frame.length === 3 && frame[0] === 'EVENT' && frame[1] === entry.sub) accept(frame[2]);
        else if ((frame.length === 3 || frame.length === 4) && frame[0] === 'OK'
          && typeof frame[1] === 'string' && HEX.test(frame[1]) && frame[2] === true) acceptedInitialPresence(frame[1]);
        else if (frame[0] === 'CLOSED' && frame[1] === entry.sub) failed();
      },
      close: failed,
      error: failed,
    };
    for (const [type, handler] of Object.entries(entry.handlers)) ws.addEventListener(type, handler);
    entry.openTimer = later(failed, openTimeoutMs);
  }
  function teardown(nextPhase, error) {
    generation++;
    for (const timer of [openTimer, discoveryTimer, heartbeatTimer, publishTimer, ackTimer]) cancel(timer);
    openTimer = discoveryTimer = heartbeatTimer = publishTimer = ackTimer = null;
    for (const entry of entries) { cancel(entry.retry); entry.retry = null; disposeSocket(entry); }
    entries.length = 0;
    key?.fill(0); key = null; id = null; epoch = null; lastEvent = null; initialEventId = null;
    records.clear(); phase = nextPhase;
    const pending = pendingJoin; pendingJoin = null; joinPromise = null;
    pending?.reject(error ?? abortError());
    notify();
  }
  function join() {
    if (phase === 'stopped' || signal?.aborted) return Promise.reject(abortError());
    if (phase === 'active') return Promise.resolve(snapshot());
    if (joinPromise) return joinPromise;
    if (typeof Socket !== 'function') return Promise.reject(new Error('Listening relays are unavailable.'));
    phase = 'discovering'; generation++; lastCreatedAt = 0; lastPublishedAt = -Infinity; truncated = false;
    key = generateSecretKey();
    id = finalizeEvent({ kind: LISTENER_SESSION_KIND, created_at: Math.floor(now() / 1000), tags: [], content: '' }, key).pubkey;
    joinPromise = new Promise((resolve, reject) => { pendingJoin = { resolve, reject }; });
    const result = joinPromise, token = generation;
    openTimer = later(() => teardown('unavailable', new Error('No listening relay became available.')), openTimeoutMs);
    for (const [index, url] of relays.entries()) {
      const entry = { url, sub: `listen-${id.slice(0, 12)}-${index}`, ws: null, retry: null, openTimer: null,
        attempts: 0, rateAt: now(), frames: 0, handlers: null };
      if (token !== generation || phase !== 'discovering') break;
      entries.push(entry); connect(entry, token);
    }
    notify();
    return result;
  }
  function leave() {
    if (phase === 'stopped') return;
    if (['publishing', 'active'].includes(phase)) publish('left');
    teardown('left');
  }
  function stop() {
    if (phase === 'stopped') return;
    if (['publishing', 'active'].includes(phase)) publish('left');
    teardown('stopped');
    signal?.removeEventListener('abort', stop);
    page?.removeEventListener('pagehide', stop);
  }
  signal?.addEventListener('abort', stop, { once: true });
  page?.addEventListener('pagehide', stop, { once: true });
  return { join, snapshot, position, leave, stop };
}
