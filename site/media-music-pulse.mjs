// A visual score derived from this recording's bass onsets. Sampling the media
// timeline leaves the browser's native audio and playback controls intact.
const SOURCE = '76d90719a756c77d1008088c58ca6b28a74eb0ef01e5337906cfb68d3e2b13aa';
const MAX_BYTES = 96 * 1024;
const ZERO = Object.freeze({ energy: 0, beat: 0 });

export function decodeRhythm(value) {
  if (value?.schema !== 1 || value.sourceSha256 !== SOURCE || value.method?.kind !== 'bass-energy-onsets') throw new Error('Unknown soundtrack');
  const result = {};
  for (const quality of ['full', 'preview']) {
    const item = value.qualities?.[quality];
    if (!Number.isInteger(item?.durationMs) || item.durationMs < 1000 || item.durationMs > 300_000 || item.sampleMs !== 40 ||
        typeof item.energy !== 'string' || item.energy.length > 10_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.energy) ||
        !Array.isArray(item.beats) || item.beats.length > 1250) throw new Error('Invalid rhythm timeline');
    const energy = Uint8Array.from(atob(item.energy), value => value.charCodeAt(0));
    if (energy.length !== Math.ceil(item.durationMs / item.sampleMs)) throw new Error('Invalid rhythm samples');
    let previous = -1;
    const beats = item.beats.map(beat => {
      if (!Array.isArray(beat) || beat.length !== 2 || !Number.isInteger(beat[0]) || beat[0] <= previous ||
          beat[0] < 0 || beat[0] >= energy.length || !Number.isInteger(beat[1]) || beat[1] < 1 || beat[1] > 255) throw new Error('Invalid beat');
      previous = beat[0]; return [beat[0] * item.sampleMs / 1000, beat[1] / 255];
    });
    result[quality] = { duration: item.durationMs / 1000, step: item.sampleMs / 1000, energy, beats };
  }
  return result;
}

export function sampleMusicPulse(timeline, time) {
  if (!timeline || !Number.isFinite(time) || time < 0) return ZERO;
  const position = time % timeline.duration, frame = position / timeline.step, index = Math.floor(frame);
  const energy = ((timeline.energy[index] ?? 0) * (1 - (frame - index)) + (timeline.energy[index + 1] ?? 0) * (frame - index)) / 255;
  let low = 0, high = timeline.beats.length - 1, beat = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timeline.beats[middle][0] <= position + 1e-9) { beat = middle + 1; low = middle + 1; } else high = middle - 1;
  }
  const last = timeline.beats[beat - 1] ?? timeline.beats.at(-1);
  if (!last) return { energy, beat: 0 };
  const age = Math.max(0, position - last[0] + (beat ? 0 : timeline.duration));
  return { energy, beat: age < 0.5 ? last[1] * Math.exp(-age / 0.14) : 0 };
}

async function loadRhythm(fetchImpl, signal) {
  const response = await fetchImpl(new URL('./media/dejavu-rhythm.json?v=20261024-swarm-calm', import.meta.url),
    { credentials: 'omit', cache: 'force-cache', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  if (!response.ok || !response.body) throw new Error('Rhythm unavailable');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Rhythm exceeds its limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return decodeRhythm(JSON.parse(new TextDecoder().decode(bytes)));
}

export function createMusicPulse({ video, container, onPulse, getQuality = () => 'full', getTime = () => video.currentTime,
  signal, fetchImpl = globalThis.fetch }) {
  const page = video.ownerDocument, lifetime = new AbortController();
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let inView = typeof IntersectionObserver !== 'function', suspended = false, dead = false, failed = false;
  let timelines, loading, frame, lastPaint = -Infinity, lastTime = null, frozenTime = null, advancedAt = 0;
  const state = value => { container.dataset.musicPulseState = value; };
  function clear(value) {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined; lastTime = null; lastPaint = -Infinity;
    onPulse(ZERO); state(value);
  }
  function eligible() {
    return !dead && !failed && !reduced?.matches && !page.hidden && inView && !suspended &&
      !video.paused && !video.ended && !video.seeking && video.readyState >= 3;
  }
  function tick(now) {
    frame = undefined;
    if (!eligible()) { clear('idle'); return; }
    if (now - lastPaint >= 1000 / 30) {
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; advancedAt = now; }
      // Do not animate a frozen playhead if a browser omits waiting. Its next
      // timeupdate or playing event restarts observation when media advances.
      if (now - advancedAt > 250) { frozenTime = video.currentTime; clear('waiting'); return; }
      // Programme phase can differ from a continuous media timeline. Motion
      // still requires the real video clock to advance above.
      onPulse(sampleMusicPulse(timelines[getQuality()], getTime()));
      state('live'); lastPaint = now;
    }
    frame = requestAnimationFrame(tick);
  }
  function reconcile() {
    if (frozenTime !== null && video.currentTime !== frozenTime) frozenTime = null;
    if (!eligible()) { clear(dead ? 'stopped' : failed ? 'unavailable' : reduced?.matches ? 'reduced' : page.hidden || !inView ? 'hidden' : 'idle'); return; }
    if (frozenTime !== null) { clear('waiting'); return; }
    if (!timelines) {
      if (!loading) {
        state('loading');
        loading = loadRhythm(fetchImpl, lifetime.signal).then(value => { timelines = value; })
          .catch(() => { failed = true; }).finally(() => { loading = null; if (!dead) reconcile(); });
      }
      return;
    }
    if (frame === undefined) frame = requestAnimationFrame(tick);
  }
  for (const name of ['pause', 'waiting', 'seeking', 'ended', 'emptied']) video.addEventListener(name,
    () => { suspended = true; reconcile(); }, { signal: lifetime.signal });
  for (const name of ['playing', 'seeked']) video.addEventListener(name,
    () => { suspended = false; frozenTime = null; reconcile(); }, { signal: lifetime.signal });
  video.addEventListener('timeupdate', reconcile, { signal: lifetime.signal });
  page.addEventListener('visibilitychange', reconcile, { signal: lifetime.signal });
  reduced?.addEventListener('change', reconcile);
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    inView = Boolean(entries[0]?.isIntersecting && entries[0]?.intersectionRatio >= 0.05); reconcile();
  }, { threshold: [0, 0.05] }) : null;
  observer?.observe(container);
  function destroy() {
    if (dead) return;
    dead = true; lifetime.abort(); observer?.disconnect(); reduced?.removeEventListener('change', reconcile);
    signal?.removeEventListener('abort', destroy); clear('stopped');
  }
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy(); else reconcile();
  return { destroy, refresh: reconcile };
}
