// The independent operator returns short-lived TURN passwords. The site's
// published assets never contain a relay password or the operator's root key.
// The issuer stays unconfigured until the operator supplies a validated
// standard-public instance. No legacy endpoint is queried while it is absent.
export const PUBLIC_TURN_ENDPOINT = null;
export const PUBLIC_TURN_URL = 'turns:demo.forgesworn.dev:5349?transport=tcp';
const LIFETIME_MS = 3600 * 1000 - 1000;
const unavailable = () => new Error('Peer relay temporarily unavailable.');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function validatePublicTurnLease(value) {
  if (!exact(value, ['urls', 'username', 'credential', 'expiresAt']) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || value.expiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
      !Array.isArray(value.urls) || value.urls.length < 1 || value.urls.length > 8 ||
      !value.urls.every(url => typeof url === 'string' && url.length > 0 && url.length <= 512) ||
      !value.urls.includes(PUBLIC_TURN_URL) ||
      typeof value.username !== 'string' || !/^[1-9]\d{0,12}:pub-[a-f0-9]{24}$/.test(value.username) ||
      !value.username.startsWith(`${value.expiresAt}:pub-`) ||
      typeof value.credential !== 'string' || !/^[A-Za-z0-9+/]{26}[AEIMQUYcgkosw048]=$/.test(value.credential)) throw unavailable();
  return { server: { urls: [PUBLIC_TURN_URL], username: value.username, credential: value.credential },
    lifetimeMs: LIFETIME_MS, refreshAfterMs: Math.floor(LIFETIME_MS * 2 / 3) };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(unavailable()); };
    const done = (finish, value) => { signal.removeEventListener('abort', abort); finish(value); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
  });
}

function configuredEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

export function createPublicTurnCredentials({ endpoint = PUBLIC_TURN_ENDPOINT, fetchImpl = globalThis.fetch, now = () => performance.now(), wallNow = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  const issuer = configuredEndpoint(endpoint);
  let active = false, generation = 0, pending = null, lease = null, timer, expiryTimer, failures = 0, retryAt = 0, phase = 'off';
  function remaining(value = lease) {
    if (!value) return 0;
    const elapsed = Math.max(0, now() - value.at);
    let wall;
    try { wall = wallNow?.(); } catch {}
    // A wall-clock correction can only move the monotonic deadline earlier.
    // Moving it back afterwards cannot restore time already discarded.
    if (Number.isFinite(wall)) value.lifetimeMs = Math.min(value.lifetimeMs, elapsed + Math.max(0, value.expiresAt - wall));
    return Math.max(0, value.lifetimeMs - elapsed);
  }
  const snapshot = () => {
    const left = active ? remaining() : 0;
    return { phase: left > 0 ? 'ready' : phase === 'ready' ? 'unavailable' : phase,
      available: left > 0, remainingMs: Math.round(left), failures };
  };
  const emit = () => { try { onChange(snapshot()); } catch {} };
  function schedule(ms) {
    clearTimer(timer);
    const ownGeneration = generation;
    if (active) timer = setTimer(() => { if (active && ownGeneration === generation) void refresh(); }, Math.max(1000, ms));
  }
  async function refresh() {
    if (!active || !issuer) return null;
    if (pending) return pending.promise;
    if (now() < retryAt) return null;
    const ownGeneration = generation, controller = new AbortController();
    const attempt = { controller, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      const requestedAt = now();
      const timeout = setTimer(() => controller.abort(), 4000);
      let response, reader;
      try {
        response = await abortable(fetchImpl(issuer, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
          redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"v":1}' }), controller.signal);
        if (controller.signal.aborted || !active || ownGeneration !== generation || response.status !== 200 || response.redirected ||
            response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' ||
            Number(response.headers.get('content-length')) > 4096 || !response.body) throw unavailable();
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const part = await abortable(reader.read(), controller.signal);
          if (controller.signal.aborted || !active || ownGeneration !== generation) throw unavailable();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) throw unavailable();
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const value = validatePublicTurnLease(body);
        if (controller.signal.aborted || !active || ownGeneration !== generation) throw unavailable();
        const elapsed = Math.max(0, now() - requestedAt);
        const nextLease = { ...value, at: requestedAt, expiresAt: body.expiresAt * 1000 };
        const left = remaining(nextLease);
        if (elapsed >= 4000 || left <= 0) throw unavailable();
        // The public API always mints a fresh 3600-second lease. Charge a
        // full second of timestamp rounding and all request/body time.
        lease = nextLease; phase = 'ready'; retryAt = 0;
        clearTimer(expiryTimer);
        expiryTimer = setTimer(() => {
          if (!active || ownGeneration !== generation || lease !== nextLease) return;
          lease = null; phase = 'unavailable'; emit();
          if (active && !pending) void refresh();
        }, left);
        schedule(Math.min(value.refreshAfterMs - elapsed, Math.floor(left * 2 / 3))); emit();
        return lease;
      } catch {
        if (active && ownGeneration === generation) {
          failures++; phase = remaining() > 0 ? 'ready' : 'unavailable'; retryAt = now() + 15000; schedule(15000); emit();
        }
        return null;
      } finally {
        clearTimer(timeout);
        try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
        try { reader?.releaseLock(); } catch {}
        if (pending === attempt) pending = null;
      }
    })();
    return attempt.promise;
  }
  return {
    start() {
      if (!active) { active = true; generation++; phase = issuer ? 'connecting' : 'unavailable'; emit(); }
      return !issuer ? Promise.resolve(null) : remaining() > 0 ? Promise.resolve(lease) : refresh();
    },
    snapshot,
    servers() { return active && remaining() > 0 ? [{ ...lease.server, urls: [...lease.server.urls] }] : []; },
    leaseIdentity() { return active && remaining() > 0 ? lease.server.username : null; },
    stop() { active = false; generation++; pending?.controller.abort(); pending = null; clearTimer(timer); clearTimer(expiryTimer); lease = null; retryAt = 0; phase = 'off'; emit(); },
  };
}
