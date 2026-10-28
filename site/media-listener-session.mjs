// Signed, short-lived observations of a shared listening clock. This is an
// experimental public addressable event (NIP-01), not NIP-78 private app storage.
// Relay partitions and dishonest clients prevent an authoritative audience count.
import { finalizeEvent, generateSecretKey, verifyEvent } from './vendor/media-peer-demo.js?v=20261028-relay-first-candidate';

export const LISTENER_SESSION_KIND = 30378;
export const LISTENER_TELEMETRY_KIND = 20378;
export const LISTENER_TELEMETRY_LIMITS = Object.freeze({ ttlMs: 12000, maxContentBytes: 4096, maxConnections: 3, maxBytes: 2 ** 48 });
export const LISTENER_SESSION_DEFAULTS = Object.freeze({
  discoveryMs: 1250, heartbeatMs: 6000, ttlMs: 24000, openTimeoutMs: 5000, publishTimeoutMs: 5000,
  maxRecords: 256, maxRelays: 3, maxFrameBytes: 8192, maxClockSkewMs: 5000,
});
const HEX = /^[0-9a-f]{64}$/u;
const MAX_EPOCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRIES = 5;
let subscriptionSerial = 0;
const REPORT_FIELDS = ['peerId', 'sampledAt', 'positionMs', 'following', 'originBytes', 'peerBytes', 'uploadedBytes', 'connections'];
const BODY_FIELDS = ['v', 'room', 'source', 'durationMs', 'epoch', ...REPORT_FIELDS];
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeBytes = value => Number.isSafeInteger(value) && value >= 0 && value <= LISTENER_TELEMETRY_LIMITS.maxBytes;
const sameEpoch = (a, b) => a?.id === b?.id && a?.startedAt === b?.startedAt;
const compareEpoch = (a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const abortError = () => Object.assign(new Error('Listening session stopped.'), { name: 'AbortError' });
function integer(value, fallback, min, max, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new TypeError(`Invalid listening ${label}.`);
  return result;
}

/**
 * prepareJoin() reserves a local actor without publishing a cold room; its
 * opaque token is valid only until commit, leave, stop or operation cancellation.
 * commitPreparedStart() publishes and waits for ACK, adopting any active epoch
 * observed in the meantime. join() preserves immediate-start compatibility.
 * Explicit observe() opts into read-only metadata networking before playback.
 * duration is seconds; startedAt is Unix milliseconds; position() is seconds.
 * leave() is reusable; stop() is terminal. onChange receives a fresh snapshot.
 * Runtime injection is for deterministic tests, not a page-global control.
 */
export function createListenerSession(options, runtime = {}) {
  const { room, source, duration, signal, onChange, getTelemetry } = options ?? {};
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
  let phase = 'idle', key = null, id = null, epoch = null, lastEvent = null, observeOpted = false;
  let lastCreatedAt = 0, lastPublishedAt = -Infinity, truncated = false;
  let generation = 0, pendingJoin = null, joinPromise = null;
  let openTimer = null, discoveryTimer = null, heartbeatTimer = null, publishTimer = null, ackTimer = null, observationTimer = null;
  let initialEventId = null, prepareMode = false, preparedToken = null, committingToken = null, candidateId = null, adoptingPrepared = false;
  let operationSignal = null, operationAbort = null;
  const records = new Map(), reports = new Map(), entries = [];

  function position() {
    return phase === 'active' && epoch ? Math.max(0, now() - epoch.startedAt) % durationMs / 1000 : 0;
  }
  function freshRows() {
    const at = now();
    for (const [author, row] of records) if (row.expiresAt <= at) records.delete(author);
    for (const [author, report] of reports) if (report.expiresAt <= at || records.get(author)?.status !== 'active') reports.delete(author);
    return [...records.values()];
  }
  function reportCopy(report) {
    return { ...report, connections: report.connections.map(connection => ({ ...connection })) };
  }
  function snapshot() {
    const rows = freshRows();
    const active = rows.filter(row => row.status === 'active' && (row.author !== id || phase === 'active'));
    const viewedEpoch = phase === 'observing' ? rows.map(row => row.epoch).sort(compareEpoch)[0] : epoch;
    return { id, prepared: phase === 'prepared', adoptingPrepared, joined: ['discovering', 'publishing', 'active'].includes(phase), ready: phase === 'active', status: phase,
      observed: entries.some(entry => entry.ws?.readyState === 1 && entry.observed),
      epochId: viewedEpoch?.id ?? null, startedAt: viewedEpoch?.startedAt ?? null, position: position(),
      listeners: active.length, truncated,
      // Membership is signed presence; remote telemetry remains self-reported.
      members: active.map(row => {
        const report = reports.get(row.author);
        const current = report && sameEpoch(report.epoch, viewedEpoch) && sameEpoch(report.epoch, row.epoch);
        return { id: row.author, isSelf: row.author === id, epochId: row.epoch.id,
          lastSeenAt: row.createdAt * 1000, expiresAt: row.expiresAt,
          telemetry: current ? reportCopy(report.value) : null,
          telemetryExpiresAt: current ? report.expiresAt : null };
      }),
      role: epoch ? epoch.id === id ? 'starter' : 'joined' : null,
      connectedRelays: entries.filter(entry => entry.ws?.readyState === 1).length };
  }
  function notify() {
    try {
      const result = onChange?.(snapshot());
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch {}
  }
  function bestEpoch(activeOnly = false) { return freshRows().filter(row => !activeOnly || row.status === 'active').map(row => row.epoch).sort(compareEpoch)[0] ?? null; }
  function observedActiveEpoch() {
    if (truncated || entries.length !== relays.length ||
        !entries.every(entry => entry.ws?.readyState === 1 && entry.observed)) return null;
    return bestEpoch(true);
  }
  function clearOperationSignal() {
    operationSignal?.removeEventListener('abort', operationAbort);
    operationSignal = operationAbort = null;
  }
  function bindOperationSignal(value) {
    clearOperationSignal();
    if (!value) return;
    operationSignal = value; operationAbort = () => failJoin(abortError());
    value.addEventListener('abort', operationAbort, { once: true });
  }
  function observationTick() {
    observationTimer = null;
    if (!observeOpted || phase === 'stopped') return;
    notify();
    if (observeOpted && phase !== 'stopped') observationTimer = later(observationTick, 1000);
  }
  function send(entry, frame) {
    if (entry.ws?.readyState !== 1) return false;
    const previous = entry.publication;
    if (frame[0] === 'EVENT' && frame[1].kind === LISTENER_SESSION_KIND) entry.publication = frame[1].id;
    try { entry.ws.send(JSON.stringify(frame)); return true; } catch { entry.publication = previous; return false; }
  }
  function chooseEpoch() {
    if (phase === 'prepared') {
      if (preparedToken && bestEpoch(true)) {
        // Existing-room joining need not wait for a private cold reservoir.
        // Keep the original session operation, not an SDK-owned ACK signal.
        adoptingPrepared = true;
        void commitPreparedStart(preparedToken, { signal: operationSignal }).catch(() => {});
      }
      return;
    }
    const best = bestEpoch(prepareMode);
    if (['publishing', 'active'].includes(phase) && best && (!epoch || compareEpoch(best, epoch) < 0) && !sameEpoch(best, epoch)) {
      epoch = { ...best };
      queuePublish();
    }
  }
  function header(event, kind, leaseMs, maxContent) {
    const at = now();
    if (!event || event.kind !== kind || !HEX.test(event.pubkey) || !HEX.test(event.id)
      || !Number.isSafeInteger(event.created_at) || event.created_at * 1000 > at + 5000
      || event.created_at * 1000 < at - leaseMs || typeof event.content !== 'string' || event.content.length > maxContent
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
      || expiresAt <= at || expiresAt !== event.created_at * 1000 + leaseMs) return null;
    return { expiresAt };
  }
  function validate(event) {
    const parsed = header(event, LISTENER_SESSION_KIND, ttlMs, 1024), at = now();
    if (!parsed) return null;
    let body;
    try { body = JSON.parse(event.content); } catch { return null; }
    if (!body || Object.keys(body).length !== 6 || body.v !== 1 || body.room !== room || body.source !== source
      || body.durationMs !== durationMs || !['active', 'left'].includes(body.status)
      || !body.epoch || Object.keys(body.epoch).length !== 2 || !HEX.test(body.epoch.id)
      || !Number.isSafeInteger(body.epoch.startedAt) || body.epoch.startedAt > at + 5000
      || body.epoch.startedAt < at - MAX_EPOCH_AGE_MS) return null;
    try { if (!verifyEvent(event)) return null; } catch { return null; }
    return { id: event.id, author: event.pubkey, createdAt: event.created_at, expiresAt: parsed.expiresAt,
      status: body.status, epoch: { ...body.epoch } };
  }
  function sanitiseReport(value) {
    if (!ownKeys(value, REPORT_FIELDS) || !HEX.test(value.peerId) || !Number.isSafeInteger(value.sampledAt)
      || value.sampledAt > now() + 5000 || value.sampledAt < now() - 12000
      || !Number.isSafeInteger(value.positionMs) || value.positionMs < 0 || value.positionMs > durationMs
      || typeof value.following !== 'boolean' || !safeBytes(value.originBytes) || !safeBytes(value.peerBytes)
      || !safeBytes(value.uploadedBytes) || !Array.isArray(value.connections) || value.connections.length > 3) return null;
    const seen = new Set(), connections = [];
    for (const connection of value.connections) {
      if (!ownKeys(connection, ['peerId', 'sentBytes', 'receivedBytes']) || !HEX.test(connection.peerId)
        || connection.peerId === value.peerId || seen.has(connection.peerId)
        || !safeBytes(connection.sentBytes) || !safeBytes(connection.receivedBytes)) return null;
      seen.add(connection.peerId);
      connections.push({ peerId: connection.peerId, sentBytes: connection.sentBytes, receivedBytes: connection.receivedBytes });
    }
    return { peerId: value.peerId, sampledAt: value.sampledAt, positionMs: value.positionMs, following: value.following,
      originBytes: value.originBytes, peerBytes: value.peerBytes, uploadedBytes: value.uploadedBytes, connections };
  }
  function acceptTelemetry(event) {
    const row = records.get(event?.pubkey), known = reports.get(event?.pubkey);
    const viewedEpoch = phase === 'observing' ? bestEpoch() : epoch;
    if (!viewedEpoch || !row || row.status !== 'active' || row.expiresAt <= now()
      || known && (event.created_at < known.createdAt || event.created_at === known.createdAt && event.id === known.id)) return;
    const parsed = header(event, LISTENER_TELEMETRY_KIND, 12000, 4096);
    if (!parsed) return;
    let body;
    try { body = JSON.parse(event.content); } catch { return; }
    if (!ownKeys(body, BODY_FIELDS) || body.v !== 1 || body.room !== room || body.source !== source || body.durationMs !== durationMs
      || !ownKeys(body.epoch, ['id', 'startedAt']) || !sameEpoch(body.epoch, viewedEpoch) || !sameEpoch(body.epoch, row.epoch)) return;
    const value = sanitiseReport(Object.fromEntries(REPORT_FIELDS.map(field => [field, body[field]])));
    if (!value || Math.abs(value.sampledAt - event.created_at * 1000) >= 1000
      || known && value.sampledAt <= known.value.sampledAt) return;
    try { if (!verifyEvent(event)) return; } catch { return; }
    reports.set(row.author, { id: event.id, createdAt: event.created_at, expiresAt: parsed.expiresAt, epoch: { ...body.epoch }, value });
    notify();
  }
  function publishTelemetry() {
    if (phase !== 'active' || typeof getTelemetry !== 'function' || !epoch || !key) return;
    let value;
    try { value = sanitiseReport(getTelemetry()); } catch { return; }
    if (!value || phase !== 'active' || !epoch || !key) return;
    const created_at = Math.floor(value.sampledAt / 1000);
    const event = finalizeEvent({ kind: LISTENER_TELEMETRY_KIND, created_at,
      tags: [['d', d], ['source', source], ['expiration', String(created_at + 12)]],
      content: JSON.stringify({ v: 1, room, source, durationMs, epoch, ...value }) }, key);
    if (event.content.length > 4096) return;
    acceptTelemetry(event);
    for (const entry of entries) send(entry, ['EVENT', event]);
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
    if (row.status !== 'active') reports.delete(row.author);
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
    publishTimer = later(() => { publishTimer = null; publish(); publishTelemetry(); }, Math.max(0, 1000 - (now() - lastPublishedAt)));
  }
  function heartbeat() {
    if (phase !== 'active') return;
    publish();
    publishTelemetry();
    if (phase === 'active') heartbeatTimer = later(heartbeat, heartbeatMs);
  }
  function finishDiscovery(observedOnly = false) {
    if (phase !== 'discovering') return;
    // Entry-qualified preparation can reuse completed observation, but a
    // disconnected or expired view must still take the full discovery path.
    const observed = observedOnly ? observedActiveEpoch() : null;
    if (observedOnly && (!prepareMode || !observed)) return;
    cancel(discoveryTimer);
    discoveryTimer = null;
    if (!entries.some(entry => entry.ws?.readyState === 1)) {
      failJoin(new Error('Listening relays disconnected during discovery.'));
      return;
    }
    const existing = observed ?? bestEpoch(prepareMode);
    if (prepareMode && !existing) {
      epoch = { id, startedAt: null }; candidateId = id; preparedToken = Object.freeze({});
      phase = 'prepared';
      // A notification can synchronously discover an active room or cancel.
      // Preserve this prepare caller before either path replaces pendingJoin.
      const actor = id;
      const pending = pendingJoin; pendingJoin = null; joinPromise = null;
      notify();
      if (id !== actor) pending?.reject(abortError());
      else if (phase === 'prepared' && preparedToken) pending?.resolve({ ...snapshot(), prepared: true, token: preparedToken });
      else if (joinPromise) joinPromise.then(value => pending?.resolve(value), error => pending?.reject(error));
      else pending?.reject(abortError());
      return;
    }
    epoch = existing ? { ...existing } : { id, startedAt: now() };
    phase = 'publishing';
    ackTimer = later(() => failJoin(new Error('Listening relays did not accept this listener.')), publishTimeoutMs);
    publish();
  }
  function acceptedInitialPresence(eventId) {
    if (phase !== 'publishing' || eventId !== initialEventId) return;
    cancel(ackTimer); ackTimer = null;
    phase = 'active';
    adoptingPrepared = false;
    // ACK owns the active room before notifying the host, which may retire
    // the old SDK synchronously and abort its completed commit operation.
    clearOperationSignal();
    // A newly observed older epoch may have converged while the ACK was pending.
    if (!sameEpoch(JSON.parse(lastEvent.content).epoch, epoch)) queuePublish();
    heartbeatTimer = later(heartbeat, heartbeatMs);
    publishTelemetry();
    notify();
    if (phase !== 'active') return;
    const pending = pendingJoin; pendingJoin = null;
    const result = { ...snapshot(), ...(prepareMode ? { prepared: false, token: null, adopted: Boolean(candidateId && epoch.id !== candidateId) } : {}) };
    preparedToken = committingToken = null;
    pending?.resolve(result);
  }
  function disposeSocket(entry) {
    cancel(entry.openTimer); entry.openTimer = null;
    entry.observed = false;
    const ws = entry.ws; entry.ws = null;
    if (!ws) return;
    for (const [type, handler] of Object.entries(entry.handlers ?? {})) ws.removeEventListener(type, handler);
    try { ws.close(); } catch {}
  }
  function connect(entry, token) {
    if (token !== generation || !['observing', 'discovering', 'prepared', 'publishing', 'active'].includes(phase)) return;
    entry.attempts++;
    let ws;
    const failed = () => {
      if (entry.ws !== ws) return;
      disposeSocket(entry); notify();
      if (token === generation && ['observing', 'discovering', 'prepared', 'publishing', 'active'].includes(phase) && entry.attempts <= MAX_RETRIES) {
        entry.retry = later(() => { entry.retry = null; connect(entry, token); }, Math.min(1000 * 2 ** Math.max(0, entry.attempts - 1), 16000));
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
        if (!send(entry, ['REQ', entry.sub, { kinds: [LISTENER_SESSION_KIND, LISTENER_TELEMETRY_KIND], '#d': [d],
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
        if (frame.length === 3 && frame[0] === 'EVENT' && frame[1] === entry.sub) {
          if (frame[2]?.kind === LISTENER_TELEMETRY_KIND) acceptTelemetry(frame[2]);
          else accept(frame[2]);
        }
        else if (frame.length === 2 && frame[0] === 'EOSE' && frame[1] === entry.sub) {
          entry.observed = true;
          if (phase === 'observing') entry.attempts = 0;
          notify();
        }
        else if ((frame.length === 3 || frame.length === 4) && frame[0] === 'OK'
          && typeof frame[1] === 'string' && HEX.test(frame[1]) && frame[2] === true) {
          // Bound consecutive failures, not the lifetime of a healthy session.
          if (frame[1] === entry.publication) entry.attempts = 0;
          acceptedInitialPresence(frame[1]);
        }
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
    cancel(observationTimer); observationTimer = null;
    for (const entry of entries) { cancel(entry.retry); entry.retry = null; disposeSocket(entry); }
    entries.length = 0;
    clearActor(nextPhase, error);
    records.clear(); reports.clear(); truncated = false;
    notify();
  }
  function clearActor(nextPhase, error) {
    for (const timer of [openTimer, discoveryTimer, heartbeatTimer, publishTimer, ackTimer]) cancel(timer);
    openTimer = discoveryTimer = heartbeatTimer = publishTimer = ackTimer = null;
    clearOperationSignal(); preparedToken = committingToken = candidateId = null; prepareMode = false; adoptingPrepared = false;
    key?.fill(0); key = null; id = null; epoch = null; lastEvent = null; initialEventId = null;
    phase = nextPhase;
    const pending = pendingJoin; pendingJoin = null; joinPromise = null;
    pending?.reject(error ?? abortError());
  }
  function failJoin(error) {
    if (phase === 'publishing' && (prepareMode || observeOpted)) publish('left');
    if (!observeOpted) return teardown('unavailable', error);
    clearActor('observing', error);
    notify();
  }
  function ensureConnections() {
    if (entries.length) {
      // Only an explicit observe()/join() call renews an exhausted burst.
      // Idle maintenance never creates another background retry cycle.
      for (const entry of entries) if (!entry.ws && entry.retry === null) {
        entry.attempts = 0;
        connect(entry, generation);
      }
      return;
    }
    const token = ++generation;
    for (const [index, url] of relays.entries()) {
      const entry = { url, sub: `listen-${++subscriptionSerial}-${index}`, ws: null, retry: null, openTimer: null,
        attempts: 0, rateAt: now(), frames: 0, handlers: null, publication: null, observed: false };
      if (token !== generation || !['observing', 'discovering', 'prepared', 'publishing', 'active'].includes(phase)) break;
      entries.push(entry); connect(entry, token);
    }
  }
  function observe() {
    if (phase === 'stopped' || signal?.aborted) return snapshot();
    observeOpted = true;
    if (phase === 'idle' || phase === 'left' || phase === 'unavailable') phase = 'observing';
    if (typeof Socket === 'function') ensureConnections();
    if (observationTimer === null) observationTimer = later(observationTick, 1000);
    notify();
    return snapshot();
  }
  function beginJoin(prepared, operation = {}) {
    if (phase === 'stopped' || signal?.aborted || operation.signal?.aborted) return Promise.reject(abortError());
    if (phase === 'active') return Promise.resolve({ ...snapshot(), ...(prepared ? { prepared: false, token: null } : {}) });
    if (phase === 'prepared') return prepared ? Promise.resolve({ ...snapshot(), prepared: true, token: preparedToken }) : commitPreparedStart(preparedToken, operation);
    if (joinPromise) {
      if (!prepared && phase === 'discovering') prepareMode = false;
      return prepared && !prepareMode ? joinPromise.then(value => ({ ...value, prepared: false, token: null })) : joinPromise;
    }
    if (typeof Socket !== 'function') return Promise.reject(new Error('Listening relays are unavailable.'));
    // Retained records keep their truncation history across join/leave cycles.
    // Only already-observing prepare callers may skip the discovery window.
    const observedPreparation = prepared && phase === 'observing' && observedActiveEpoch() !== null ? generation : null;
    prepareMode = prepared; candidateId = null; adoptingPrepared = false;
    bindOperationSignal(operation.signal);
    phase = 'discovering'; lastCreatedAt = 0; lastPublishedAt = -Infinity;
    key = generateSecretKey();
    id = finalizeEvent({ kind: LISTENER_SESSION_KIND, created_at: Math.floor(now() / 1000), tags: [], content: '' }, key).pubkey;
    const actor = id;
    joinPromise = new Promise((resolve, reject) => { pendingJoin = { resolve, reject }; });
    const result = joinPromise;
    openTimer = later(() => failJoin(new Error('No listening relay became available.')), openTimeoutMs);
    ensureConnections();
    if (entries.some(entry => entry.ws?.readyState === 1)) {
      cancel(openTimer); openTimer = null;
      discoveryTimer = later(finishDiscovery, discoveryMs);
    }
    if (observedPreparation !== null && observedPreparation === generation && id === actor && prepareMode) finishDiscovery(true);
    notify();
    return result;
  }
  function prepareJoin(operation = {}) { return beginJoin(true, operation); }
  function join() { return beginJoin(false); }
  function commitPreparedStart(token, operation = {}) {
    if (phase === 'publishing' && token && token === committingToken) return joinPromise;
    if (phase !== 'prepared' || !token || token !== preparedToken || signal?.aborted || operation.signal?.aborted) {
      if (phase === 'prepared' && token === preparedToken && operation.signal?.aborted) failJoin(abortError());
      return Promise.reject(abortError());
    }
    const existing = bestEpoch(true);
    if (adoptingPrepared && !existing) {
      adoptingPrepared = false;
      return Promise.resolve({ ...snapshot(), prepared: true, token: preparedToken });
    }
    bindOperationSignal(operation.signal);
    committingToken = token; preparedToken = null;
    epoch = existing ? { ...existing } : { id: candidateId, startedAt: now() };
    phase = 'publishing';
    joinPromise = new Promise((resolve, reject) => { pendingJoin = { resolve, reject }; });
    const result = joinPromise;
    ackTimer = later(() => failJoin(new Error('Listening relays did not accept this listener.')), publishTimeoutMs);
    publish(); notify();
    return result;
  }
  function leave() {
    if (phase === 'stopped') return;
    if (['publishing', 'active'].includes(phase)) publish('left');
    if (observeOpted) { clearActor('observing'); notify(); }
    else teardown('left');
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
  return { observe, prepareJoin, commitPreparedStart, join, snapshot, position, leave, stop };
}
