// Optional recorded-media timeline. No player, media fetch or peer is created here.
const LIMITS = Object.freeze({ manifestBytes: 65_536, segments: 512, windowSegments: 64, playlistBytes: 131_072, loaders: 8 });
const recordings = new WeakSet();
const encode = value => new TextEncoder().encode(value);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const mod = (value, divisor) => (value % divisor + divisor) % divisor;

function approvedUrl(value, base) {
  const url = new URL(value, base);
  if (url.username || url.password || url.search || url.hash || url.href.length > 2048 ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Unsupported media URL');
  return url.href;
}

/** Verify canonical bytes before using their durations. Unsupported VODs decline. */
export async function parseRecordedManifest({ text, playlistUrl, expectedSha256, allowedUrls, signal } = {}) {
  try {
    if (signal?.aborted || typeof text !== 'string' || text.length > LIMITS.manifestBytes || !/^[a-f0-9]{64}$/.test(expectedSha256) ||
        !Array.isArray(allowedUrls) || !allowedUrls.length || allowedUrls.length > LIMITS.segments + 1) return null;
    const bytes = encode(text);
    if (bytes.length > LIMITS.manifestBytes || !globalThis.crypto?.subtle ||
        hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== expectedSha256 || signal?.aborted) return null;
    const url = approvedUrl(playlistUrl);
    const allowed = new Set(allowedUrls.map(value => approvedUrl(value)));
    let target = null, init = null, pending = null, offset = 0, ended = false, independent = false;
    const seen = new Set(), segments = [];
    const lines = text.trim().split(/\r?\n/);
    if (lines.shift() !== '#EXTM3U') return null;
    for (const line of lines) {
      if (!line) continue;
      if (ended) throw new Error('Data after ENDLIST');
      if (line.startsWith('#EXTINF:')) {
        if (pending !== null || !/^#EXTINF:\d+(?:\.\d{1,6})?,$/.test(line)) throw new Error('Unsupported duration');
        pending = Math.round(Number(line.slice(8, -1)) * 1_000_000);
        if (!Number.isSafeInteger(pending) || pending < 1000 || pending > 60_000_000) throw new Error('Unsupported duration');
      } else if (!line.startsWith('#')) {
        const media = approvedUrl(line, url);
        if (!init || pending === null || !allowed.has(media) || media === init || segments.some(segment => segment.url === media)) throw new Error('Unapproved segment');
        segments.push(Object.freeze({ index: segments.length, url: media, startUs: offset, durationUs: pending }));
        offset += pending; pending = null;
        if (segments.length > LIMITS.segments || offset > 86_400_000_000) throw new Error('Recording exceeds bounds');
      } else if (line === '#EXT-X-ENDLIST') {
        if (pending !== null) throw new Error('Missing segment');
        ended = true;
      } else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') independent = true;
      else if (line.startsWith('#EXT-X-')) {
        const [tag, value] = line.split(/:(.*)/s);
        if (seen.has(tag)) throw new Error('Duplicate tag');
        seen.add(tag);
        if (tag === '#EXT-X-VERSION' && /^\d+$/.test(value) && Number(value) >= 7 && Number(value) <= 10) continue;
        if (tag === '#EXT-X-TARGETDURATION' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 60) target = Number(value);
        else if (tag === '#EXT-X-MEDIA-SEQUENCE' && value === '0' || tag === '#EXT-X-DISCONTINUITY-SEQUENCE' && value === '0' || tag === '#EXT-X-PLAYLIST-TYPE' && value === 'VOD') continue;
        else if (tag === '#EXT-X-MAP' && /^URI="[^"\r\n]+"$/.test(value)) {
          init = approvedUrl(value.slice(5, -1), url);
          if (segments.length || !allowed.has(init)) throw new Error('Unapproved init');
        } else throw new Error('Unsupported playlist tag');
      } else if (line.startsWith('#EXT')) throw new Error('Unsupported playlist tag');
    }
    if (!ended || pending !== null || !target || !init || !segments.length || !seen.has('#EXT-X-VERSION') ||
        segments.some(segment => Math.ceil(segment.durationUs / 1_000_000) > target)) return null;
    const recording = Object.freeze({ playlistUrl: url, manifestSha256: expectedSha256, initUrl: init, targetDuration: target,
      independent, durationUs: offset, durationSeconds: offset / 1_000_000, segments: Object.freeze(segments) });
    recordings.add(recording);
    return recording;
  } catch { return null; }
}

function stats() {
  return { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
}

/** A fixed session origin: Hls time zero is the first issued fragment, not SN. */
export function createRecordedLive({ recording, epochMs, now = Date.now, signal, aheadSeconds = 24, backSeconds = 4,
  passthroughUrls = [] } = {}) {
  try {
    if (!recordings.has(recording) || !Number.isSafeInteger(epochMs) || epochMs < 0 || typeof now !== 'function' || signal?.aborted ||
        !Number.isFinite(aheadSeconds) || aheadSeconds < recording.targetDuration * 3 || aheadSeconds > 30 ||
        !Number.isFinite(backSeconds) || backSeconds < 0 || backSeconds > 8 || !Array.isArray(passthroughUrls) || passthroughUrls.length > 4) return null;
    const pass = new Set(passthroughUrls.map(value => approvedUrl(value)));
    const count = recording.segments.length, duration = recording.durationUs;
    const elapsedAt = at => {
      const elapsed = Math.round((at - epochMs) * 1000);
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER - 60_000_000) throw new Error('Unsupported timeline');
      return elapsed;
    };
    const locate = elapsed => {
      const cycle = Math.floor(elapsed / duration), phase = elapsed - cycle * duration;
      const index = recording.segments.findIndex(segment => phase < segment.startUs + segment.durationUs);
      const sn = cycle * count + index;
      if (index < 0 || !Number.isSafeInteger(sn)) throw new Error('Unsupported sequence');
      return { sn, cycle, index };
    };
    const createdAt = now(), first = locate(elapsedAt(createdAt));
    const originOffsetUs = first.cycle * duration + recording.segments[first.index].startUs;
    const timelineOriginMs = epochMs + originOffsetUs / 1000;
    if (!Number.isFinite(timelineOriginMs) || !Number.isFinite(new Date(timelineOriginMs).getTime())) return null;
    let stopped = false, issued = false;
    const active = new Set();
    const windowAt = (at, initial = false) => {
      if (stopped) throw new Error('Timeline stopped');
      const elapsed = elapsedAt(at);
      if (elapsed < originOffsetUs) throw new Error('Clock precedes timeline origin');
      const start = initial ? first.sn : Math.max(first.sn, locate(Math.max(0, elapsed - backSeconds * 1_000_000)).sn);
      const end = locate(elapsed + aheadSeconds * 1_000_000).sn;
      if (end < start || end - start + 1 > LIMITS.windowSegments) throw new Error('Timeline window exceeds bounds');
      const fragments = [];
      const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${recording.targetDuration}`,
        `#EXT-X-MEDIA-SEQUENCE:${start}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(start / count)}`];
      if (recording.independent) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
      for (let sn = start; sn <= end; sn++) {
        const index = sn % count, cc = Math.floor(sn / count), segment = recording.segments[index];
        const programmeUs = cc * duration + segment.startUs;
        if (sn !== start && index === 0) lines.push('#EXT-X-DISCONTINUITY');
        if (sn === start || index === 0) lines.push(`#EXT-X-MAP:URI="${recording.initUrl}"`);
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(epochMs + programmeUs / 1000).toISOString()}`,
          `#EXTINF:${(segment.durationUs / 1_000_000).toFixed(6)},`, segment.url);
        fragments.push(Object.freeze({ sn, cc, index, url: segment.url, durationSeconds: segment.durationUs / 1_000_000,
          mediaStart: (programmeUs - originOffsetUs) / 1_000_000, programmeTimeMs: epochMs + programmeUs / 1000 }));
      }
      const text = lines.join('\n') + '\n';
      if (encode(text).length > LIMITS.playlistBytes) throw new Error('Timeline playlist exceeds bounds');
      return Object.freeze({ text, startSequence: start, endSequence: end, fragments: Object.freeze(fragments) });
    };
    // Decline clips whose segment density cannot fit this fixed output bound.
    windowAt(createdAt, true);
    windowAt(createdAt + backSeconds * 1000);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      signal?.removeEventListener('abort', stop);
      for (const loader of [...active]) { try { loader.abort(); } catch {} }
    };
    signal?.addEventListener('abort', stop, { once: true });
    const createPlaylistLoader = ParentLoader => class RecordedPlaylistLoader {
      constructor(config) { this.config = config; this.context = null; this.stats = stats(); this.parent = null; this.token = 0; this.callbacks = null; }
      getCacheAge() { return this.parent?.getCacheAge?.() ?? null; }
      getResponseHeader(name) { return this.parent?.getResponseHeader?.(name) ?? null; }
      load(context, config, callbacks) {
        this.abort(); this.stats = stats(); this.context = context; this.callbacks = callbacks;
        const token = ++this.token;
        this.stats.loading.start = performance.now();
        const fail = () => {
          if (this.token !== token || this.callbacks !== callbacks) return;
          active.delete(this);
          this.callbacks = null;
          callbacks.onError({ code: 0, text: 'Recorded timeline unavailable.' }, context, null, this.stats);
        };
        if (stopped || active.size >= LIMITS.loaders) { queueMicrotask(fail); return; }
        active.add(this);
        if (context.url !== recording.playlistUrl) {
          if (!pass.has(context.url) || typeof ParentLoader !== 'function') { queueMicrotask(fail); return; }
          try {
            this.parent = new ParentLoader(this.config);
            this.stats = this.parent.stats;
            const wrapped = {};
            for (const [name, callback] of Object.entries(callbacks)) wrapped[name] = (...args) => {
              if (this.token !== token || stopped) return;
              if (name !== 'onProgress') { active.delete(this); this.callbacks = null; }
              return callback(...args);
            };
            this.parent.load(context, config, wrapped);
          } catch { fail(); }
          return;
        }
        if (!['manifest', 'level'].includes(context.type) || context.rangeStart !== undefined || context.rangeEnd !== undefined) { queueMicrotask(fail); return; }
        queueMicrotask(() => {
          if (this.token !== token || stopped) return;
          let window;
          try { window = windowAt(now(), !issued); } catch { fail(); return; }
          issued = true;
          this.stats.loaded = this.stats.total = encode(window.text).length;
          this.stats.chunkCount = 1;
          this.stats.loading.first = this.stats.loading.end = performance.now();
          active.delete(this); this.callbacks = null;
          callbacks.onSuccess({ url: recording.playlistUrl, data: window.text, code: 200 }, this.stats, context, null);
        });
      }
      abort() {
        ++this.token; active.delete(this);
        const parent = this.parent; this.parent = null;
        try { parent?.destroy(); } catch { try { parent?.abort(); } catch {} }
        const callbacks = this.callbacks; this.callbacks = null;
        if (callbacks) { this.stats.aborted = true; callbacks.onAbort?.(this.stats, this.context, null); }
      }
      destroy() { this.abort(); }
    };
    return Object.freeze({ recording, timelineOriginMs, originSequence: first.sn, aheadSeconds, backSeconds,
      durationSeconds: recording.durationSeconds, startPosition: (elapsedAt(createdAt) - originOffsetUs) / 1_000_000,
      mediaTimeAt: at => (elapsedAt(at) - originOffsetUs) / 1_000_000,
      recordingPosition: mediaTime => Number.isFinite(mediaTime) ? mod(recording.segments[first.index].startUs / 1_000_000 + mediaTime, duration / 1_000_000) : null,
      windowAt, createPlaylistLoader, stop });
  } catch { return null; }
}
