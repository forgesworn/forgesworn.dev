// The independent operator returns short-lived TURN passwords. The site's
// published assets never contain a relay password or the operator's root key.
export const PUBLIC_TURN_ENDPOINT = 'https://demo.forgesworn.dev:7443/turn-credentials';
export const PUBLIC_TURN_URL = 'turns:demo.forgesworn.dev:5349?transport=tcp';
const unavailable = () => new Error('Peer relay temporarily unavailable.');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function validatePublicTurnLease(value) {
  if (!exact(value, ['v', 'iceServers', 'ttlSeconds', 'issuedAt', 'expiresAt', 'refreshAt', 'serverTime']) || value.v !== 1 ||
      !Number.isSafeInteger(value.ttlSeconds) || value.ttlSeconds < 5 || value.ttlSeconds > 1250 ||
      !['issuedAt', 'expiresAt', 'refreshAt', 'serverTime'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0) ||
      value.issuedAt % 1000 !== 0 || value.expiresAt !== value.issuedAt + value.ttlSeconds * 1000 ||
      value.refreshAt !== value.issuedAt + Math.floor(value.ttlSeconds * 1000 * 2 / 3) ||
      value.serverTime < value.issuedAt || value.serverTime >= value.expiresAt ||
      !Array.isArray(value.iceServers) || value.iceServers.length !== 1) throw unavailable();
  const server = value.iceServers[0];
  if (!exact(server, ['urls', 'username', 'credential']) || !Array.isArray(server.urls) ||
      server.urls.length !== 1 || server.urls[0] !== PUBLIC_TURN_URL ||
      typeof server.username !== 'string' || !/^\d{10,12}:[a-f0-9]{32}$/.test(server.username) ||
      Number(server.username.split(':')[0]) * 1000 !== value.expiresAt ||
      typeof server.credential !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(server.credential)) throw unavailable();
  return { server: { urls: [...server.urls], username: server.username, credential: server.credential },
    lifetimeMs: value.expiresAt - value.serverTime, refreshAfterMs: Math.max(0, value.refreshAt - value.serverTime) };
}

export function createPublicTurnCredentials({ fetchImpl = globalThis.fetch, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  let active = false, generation = 0, pending = null, lease = null, timer, expiryTimer, failures = 0, phase = 'off';
  const remaining = () => lease ? Math.max(0, lease.lifetimeMs - Math.max(0, now() - lease.at)) : 0;
  const snapshot = () => ({ phase: active && remaining() > 0 ? 'ready' : phase,
    available: active && remaining() > 0, remainingMs: active ? Math.round(remaining()) : 0, failures });
  const emit = () => { try { onChange(snapshot()); } catch {} };
  function schedule(ms) {
    clearTimer(timer);
    if (active) timer = setTimer(() => { void refresh(); }, Math.max(1000, ms));
  }
  async function refresh() {
    if (!active) return null;
    if (pending) return pending.promise;
    const ownGeneration = generation, controller = new AbortController();
    const attempt = { controller, promise: null };
    pending = attempt;
    attempt.promise = (async () => {
      const requestedAt = now();
      const timeout = setTimer(() => controller.abort(), 4000);
      let response, reader;
      try {
        response = await fetchImpl(PUBLIC_TURN_ENDPOINT, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
          redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"v":1}' });
        if (controller.signal.aborted || !active || ownGeneration !== generation || response.status !== 200 || response.redirected ||
            response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' ||
            Number(response.headers.get('content-length')) > 4096 || !response.body) throw unavailable();
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const part = await reader.read();
          if (controller.signal.aborted || !active || ownGeneration !== generation) throw unavailable();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) throw unavailable();
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const value = validatePublicTurnLease(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (controller.signal.aborted || !active || ownGeneration !== generation) throw unavailable();
        const elapsed = Math.max(0, now() - requestedAt);
        if (elapsed >= value.lifetimeMs) throw unavailable();
        // Charge all request/body time conservatively. A slow issuer response
        // cannot make an already-expired password appear fresh to a new dial.
        lease = { ...value, at: requestedAt }; phase = 'ready';
        clearTimer(expiryTimer);
        expiryTimer = setTimer(() => {
          lease = null; phase = 'unavailable'; emit();
          if (active && !pending) void refresh();
        }, value.lifetimeMs - elapsed);
        schedule(value.refreshAfterMs - elapsed); emit();
        return lease;
      } catch {
        if (active && ownGeneration === generation) {
          failures++; phase = remaining() > 0 ? 'ready' : 'unavailable'; schedule(15000); emit();
        }
        return null;
      } finally {
        clearTimer(timeout);
        try { await reader?.cancel(); } catch {}
        try { reader?.releaseLock(); } catch {}
        if (pending === attempt) pending = null;
      }
    })();
    return attempt.promise;
  }
  return {
    start() { if (!active) { active = true; generation++; phase = 'connecting'; emit(); } return remaining() > 0 ? Promise.resolve(lease) : refresh(); },
    snapshot,
    servers() { return active && remaining() > 0 ? [{ ...lease.server, urls: [...lease.server.urls] }] : []; },
    leaseIdentity() { return active && remaining() > 0 ? lease.server.username : null; },
    stop() { active = false; generation++; pending?.controller.abort(); pending = null; clearTimer(timer); clearTimer(expiryTimer); lease = null; phase = 'off'; emit(); },
  };
}
