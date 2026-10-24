// Decimal transfer units, retaining small nonzero readings instead of 0.0 MB.
export function transferBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const unit = value >= 1e9 ? ['GB', 1e9] : value >= 1e6 ? ['MB', 1e6] : value >= 1000 ? ['KB', 1000] : ['B', 1];
  return `${(value / unit[1]).toLocaleString('en-GB', { maximumFractionDigits: unit[1] === 1 ? 0 : 1 })} ${unit[0]}`;
}

// Resource Timing normalises header overhead to 300 B: local cache=0,
// validated cache=300, network=encodedBodySize+300. These are reported body
// bytes, not TCP wire totals or proof that the player accepted a whole segment.
// Concealed0/0 readings and contradictory sizes remain unknown.
export function sourceResponseTransfer(entry) {
  try {
    if (!entry || typeof entry !== 'object') return null;
    const bodyBytes = entry.encodedBodySize, transferred = entry.transferSize;
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || !Number.isSafeInteger(transferred) || transferred < 0 ||
        entry.deliveryType !== undefined && typeof entry.deliveryType !== 'string' ||
        entry.responseStatus !== undefined && (!Number.isInteger(entry.responseStatus) || entry.responseStatus < 0 || entry.responseStatus > 599)) return null;
    if (bodyBytes === 0 && transferred === 0) return null;
    const cache = entry.deliveryType === 'cache' || entry.responseStatus === 304;
    if (bodyBytes > 0 && (transferred === 0 || transferred === 300 || cache && transferred - bodyBytes < 300)) {
      return { bodyBytes, networkBodyBytes: 0, cacheBodyBytes: bodyBytes, known: true };
    }
    if (cache) return bodyBytes === 0 && transferred <= 300
      ? { bodyBytes: 0, networkBodyBytes: 0, cacheBodyBytes: 0, known: true } : null;
    if (transferred - bodyBytes < 300) return null;
    return { bodyBytes, networkBodyBytes: bodyBytes, cacheBodyBytes: 0, known: true };
  } catch { return null; }
}

// The immutable public packs contain only these numbered objects and init.
// Playlists, posters, scripts and catalogue requests are separate resources.
export function publicSourceResource(value, { quality, baseUrl } = {}) {
  try {
    const url = new URL(value), base = new URL(baseUrl);
    if (!['full', 'preview'].includes(quality) || !['http:', 'https:'].includes(base.protocol) ||
        base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') ||
        url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(base.pathname)) return false;
    const name = url.pathname.slice(base.pathname.length);
    if (name === 'init.mp4') return true;
    const match = quality === 'full' ? /^segment-(\d{4})\.m4s$/.exec(name) : /^segment-(\d{3})\.mp4$/.exec(name);
    return Boolean(match && Number(match[1]) < (quality === 'full' ? 134 : 30));
  } catch { return false; }
}

// Return whole observed timing totals only when every included response is
// classified. A known subset must never look like the complete source total.
export function createSourceResponseStats() {
  let responses = 0, knownResponses = 0, unknownResponses = 0, missing = false;
  let body = 0, network = 0, cached = 0;
  return {
    add(entry) {
      responses++;
      const reading = sourceResponseTransfer(entry);
      if (!reading || ![body + reading.bodyBytes, network + reading.networkBodyBytes, cached + reading.cacheBodyBytes].every(Number.isSafeInteger)) {
        unknownResponses++; return;
      }
      knownResponses++; body += reading.bodyBytes; network += reading.networkBodyBytes; cached += reading.cacheBodyBytes;
    },
    invalidate() { missing = true; },
    snapshot(expectedBodyBytes = null) {
      const expectedKnown = Number.isSafeInteger(expectedBodyBytes) && expectedBodyBytes >= 0;
      const covered = responses > 0 && unknownResponses === 0 && !missing && (!expectedKnown || body >= expectedBodyBytes);
      return { responses, knownResponses, unknownResponses, missing, covered,
        coverage: covered ? 'complete' : knownResponses > 0 ? 'partial' : 'unavailable',
        bodyBytes: covered ? body : null, networkBodyBytes: covered ? network : null, cacheBodyBytes: covered ? cached : null };
    },
  };
}

// Observe the real HTTP loader before hls.js can transfer its ArrayBuffer to a
// worker. Peer loads never call this loader; playlists use a separate loader.
export function observeOriginLoader(BaseLoader, onResponse) {
  return class ObservedOriginLoader extends BaseLoader {
    load(context, config, callbacks) {
      return super.load(context, config, {
        ...callbacks,
        onSuccess(response, stats, ctx, details) {
          const bytes = response?.data?.byteLength;
          if (Number.isSafeInteger(bytes) && bytes >= 0) onResponse(bytes);
          return callbacks.onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}
