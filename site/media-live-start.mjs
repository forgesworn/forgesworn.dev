// Read the first usable live position before constructing hls.js players.
// Fragment sequence numbers, timestamps and signed media context stay intact.
const MAX_MANIFEST_BYTES = 128 * 1024;

export function initialMediaStart(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('#EXTM3U')) throw new Error('The live playlist is invalid.');
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const live = !lines.includes('#EXT-X-ENDLIST');
  let sequence = 0, duration = null, gap = false, elapsed = 0, index = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const raw = line.slice('#EXT-X-MEDIA-SEQUENCE:'.length);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('The live playlist is invalid.');
      sequence = Number(raw);
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('The live playlist is invalid.');
    } else if (line === '#EXT-X-GAP') gap = true;
    else if (line && !line.startsWith('#')) {
      if (duration === null) throw new Error('The live playlist is invalid.');
      if (!gap) return { live, startPosition: live ? elapsed : -1, mediaSequence: sequence + index, firstMediaDuration: duration };
      elapsed += duration; index++; duration = null; gap = false;
    }
  }
  return { live, startPosition: null, mediaSequence: sequence + index, firstMediaDuration: null };
}

async function manifestText(response) {
  const reader = response.body?.getReader();
  if (!response.ok || !reader) { await response.body?.cancel(); throw new Error('The initial live playlist is unavailable.'); }
  const decoder = new TextDecoder(); let bytes = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) { await reader.cancel(); throw new Error('The live playlist exceeds its limit.'); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

// Fetch only manifests before constructing Hls. No fragment, key or init bytes
// are prefetched, and no playlist text, sequence or context is rewritten.
export async function readInitialLiveStart(playlistUrl, { signal, origin = globalThis.location?.href, fetchImpl = globalThis.fetch } = {}) {
  const playlist = new URL(playlistUrl, origin), page = origin ? new URL(origin) : playlist;
  const match = /^\/media\/lab\/hls\/[a-f0-9]{16,64}\//.exec(playlist.pathname);
  if (page.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(page.hostname) || playlist.origin !== page.origin || !match) {
    throw new Error('Use the active local lab playlist.');
  }
  const prefix = match[0], seen = new Set();
  const checked = value => {
    const url = new URL(value, playlist);
    if (url.origin !== playlist.origin || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith(prefix) || !/^[a-z0-9_./-]+\.m3u8$/i.test(url.pathname) || url.href.length > 2048) {
      throw new Error('The initial live playlist is outside this run.');
    }
    return url;
  };
  const combined = AbortSignal.any([signal, AbortSignal.timeout(10_000)].filter(Boolean));
  let url = checked(playlist);
  for (let depth = 0; depth < 3; depth++) {
    combined.throwIfAborted();
    if (seen.has(url.href)) throw new Error('The initial playlist redirects in a loop.');
    seen.add(url.href);
    let text = await manifestText(await fetchImpl(url, { signal: combined, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    const lines = text.split(/\r?\n/).map(line => line.trim()), variants = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
      const uri = lines[index + 1];
      if (!uri || uri.startsWith('#') || variants.length >= 16) throw new Error('The initial master playlist is invalid.');
      variants.push({ uri, video: /(?:RESOLUTION=|avc1|hvc1|hev1|vp09|av01)/i.test(lines[index]) });
    }
    if (variants.length) { url = checked(new URL((variants.find(value => value.video) ?? variants[0]).uri, url)); continue; }
    while (true) {
      combined.throwIfAborted();
      const start = initialMediaStart(text);
      if (start.startPosition !== null) return { ...start, playlistUrl: playlist.href, mediaPlaylistUrl: url.href };
      if (!start.live) throw new Error('The finite playlist has no media.');
      await new Promise(resolve => setTimeout(resolve, 100));
      combined.throwIfAborted();
      text = await manifestText(await fetchImpl(url, { signal: combined, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    }
  }
  throw new Error('The initial playlist nesting exceeds its limit.');
}

