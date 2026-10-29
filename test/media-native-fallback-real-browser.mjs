#!/usr/bin/env node
// Real homepage recovery, with ONE intentional fatal Hls event after real 4K
// frames. This is a native-fallback regression, not spontaneous-failure,
// sustained-continuity, peer-delivery or physical-device qualification.
// node test/media-native-fallback-real-browser.mjs --site site --output PRIVATE.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const options = { site: resolve('site') };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = { '--site': 'site', '--output': 'output', '--chrome': 'chrome' }[process.argv[i]];
  assert(key && process.argv[i + 1], 'Use --site site --output PRIVATE.json [--chrome EXECUTABLE]');
  options[key] = resolve(process.argv[i + 1]);
}
assert(options.output, 'A private output path is required.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRelative = relative(repository, options.output);
assert(outputRelative.startsWith('..') || isAbsolute(outputRelative), 'Keep the playback receipt outside the repository.');
const ORIGIN = 'https://forgesworn.dev', PLAYLIST = ORIGIN + '/media/dejavu-4k/index.m3u8';
const MAX_MS = 40_000, MAX_BODY = 160 * 1024 * 1024, NATIVE_MS = 13_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const receipt = { schema: 1, measuredAt: new Date().toISOString(), passed: false,
  qualification: 'Intentional fatal-error recovery through the real homepage controller only',
  scope: 'One fresh owned Chrome context and visible player. Real Hls, SDK, native RTC, public signalling and remote licensed 4K media. Exactly one intentional Hls.trigger fatal ERROR after decoded frames. No mocked capability, media, peer, native pipeline or audio routing; no physical-device or spontaneous-failure claim.',
  cacheBoundary: 'Candidate static routing disables browser HTTP cache throughout; remote media is not fulfilled or delayed.',
  audioBoundary: 'Native video audio, unmuted at 1x; native AAC decoder/counter evidence, no AudioContext or analyser.',
  byteBoundary: 'CDP HTTP response bodies include partial aborted loads; these are not total wire bytes.',
  limits: { totalMs: MAX_MS, bodyBytes: MAX_BODY, nativeObservationMs: NATIVE_MS },
  sources: {}, staticMediaResponses: [], requests: [], pageErrors: [], nativeMedia: [], nativeMediaErrors: [], samples: [], cleanup: {} };
let browser, context, page, stage = 'setup', httpBytes = 0, deadline, watchdog, closed = false;

// Identical single-range rules to media-showcase-visitors: open, closed,
// suffix and clamped GET ranges; HEAD returns the full resource headers.
function staticResource(body, range, method) {
  const headers = { 'accept-ranges': 'bytes', 'content-length': String(body.length) };
  if (method === 'HEAD') return { status: 200, headers, body: Buffer.alloc(0) };
  if (!range) return { status: 200, headers, body };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const unsatisfied = () => ({ status: 416, headers: { ...headers, 'content-length': '0',
    'content-range': `bytes */${body.length}` }, body: Buffer.alloc(0) });
  if (!match || (!match[1] && !match[2]) || body.length === 0) return unsatisfied();
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) return unsatisfied();
  const start = first === null ? Math.max(0, body.length - last) : first;
  const end = first !== null && last !== null ? Math.min(body.length - 1, last) : body.length - 1;
  if (start > end || start >= body.length || start < 0) return unsatisfied();
  return { status: 206, headers: { ...headers, 'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) };
}
const fixtureBytes = Buffer.from('#EXTM3U\n');
for (const [range, expected] of [['bytes=0-', fixtureBytes], ['bytes=1-', fixtureBytes.subarray(1)],
  ['bytes=-2', fixtureBytes.subarray(-2)], ['bytes=0-999', fixtureBytes]]) {
  const result = staticResource(fixtureBytes, range, 'GET');
  assert.equal(result.status, 206); assert.deepEqual(result.body, expected);
}
assert.equal(staticResource(fixtureBytes, 'bytes=99-', 'GET').status, 416);
assert.equal(staticResource(fixtureBytes, 'bytes=0-', 'HEAD').body.length, 0);
receipt.staticRangeSelfChecks = true;

const mediaUrl = value => {
  const url = new URL(value);
  return url.origin === ORIGIN && url.pathname === '/media/dejavu-4k/index.m3u8' ||
    url.origin === 'https://v4v.com' && url.pathname.startsWith('/forgesworn-media-demo/dejavu-4k-v1/') && /\.(?:mp4|m4s)$/.test(url.pathname);
};
const headers = (values, names) => Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => names.includes(key.toLowerCase()))
  .map(([key, value]) => [key.toLowerCase(), String(value).slice(0, 2048)]));
const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'access-control-allow-origin',
  'access-control-allow-credentials', 'access-control-expose-headers', 'timing-allow-origin'];
const remaining = () => Math.max(1, deadline - Date.now());
const waitFor = (fn, arg, maximum = 15_000) => page.waitForFunction(fn, arg, { timeout: Math.min(maximum, remaining()) });
const checkLimits = () => {
  assert(Date.now() < deadline, 'Native fallback exceeded its 40-second deadline.');
  assert(httpBytes <= MAX_BODY, 'Approved media response bodies exceeded 160 MiB.');
};

async function snapshot() {
  return page.evaluate(() => {
    const q = window.__nativeFallbackQa, v = document.getElementById('lab-video'), r = document.getElementById('main');
    const quality = v.getVideoPlaybackQuality();
    const peer = (q.oldPeer ?? q.players.at(-1)?.session.publicPeer)?.metrics();
    return { at: Date.now(), time: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null,
      ready: v.readyState, paused: v.paused, seeking: v.seeking, ended: v.ended, currentSrc: v.currentSrc,
      crossOrigin: v.crossOrigin, muted: v.muted, volume: v.volume, rate: v.playbackRate,
      width: v.videoWidth, height: v.videoHeight, frames: q.frames, nativeFrames: q.nativeFrames,
      nativeFirstFrame: q.nativeFirstFrame, lastFrame: q.lastFrame,
      totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames,
      audioDecodedBytes: Number.isFinite(v.webkitAudioDecodedByteCount) ? v.webkitAudioDecodedByteCount : null,
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
      mode: r.dataset.playbackMode, engine: r.dataset.playbackEngine, fallback: r.dataset.playbackFallback,
      stallCount: document.getElementById('browser-stalls')?.textContent,
      stalledSeconds: document.getElementById('browser-stall-time')?.textContent,
      videoElements: document.querySelectorAll('video').length,
      visibleVideos: [...document.querySelectorAll('video')].filter(node => { const b = node.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).length,
      hlsInstances: q.players.length, oldHlsDestroyedAt: q.destroyedAt ?? null,
      oldHlsDetached: q.players[0]?.player.media == null,
      oldPeer: peer ? { enabled: peer.enabled, phase: peer.phase, coreState: peer.core?.state ?? null,
        transferWorkerState: peer.core?.transferWorker?.state ?? null, resources: peer.resources } : null,
    };
  });
}

try {
  deadline = Date.now() + MAX_MS;
  watchdog = setTimeout(() => { receipt.watchdogExpired = true; void browser?.close(); }, MAX_MS);
  browser = await chromium.launch({ ...(options.chrome ? { executablePath: options.chrome } : { channel: 'chrome' }),
    headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  receipt.browserVersion = browser.version();
  const system = await browser.newBrowserCDPSession();
  receipt.ownedBrowserPid = (await system.send('SystemInfo.getProcessInfo')).processInfo.find(row => row.type === 'browser')?.id;
  try { receipt.browserArguments = (await system.send('Browser.getBrowserCommandLine')).arguments; }
  catch { receipt.browserArguments = [execFileSync('/bin/ps', ['-p', String(receipt.ownedBrowserPid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim()]; }
  assert(!receipt.browserArguments.some(value => /--autoplay|no-user-gesture|required-policy|--mute-audio/.test(value)));
  await system.detach();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
  page.setDefaultTimeout(6000); page.on('pageerror', error => { if (receipt.pageErrors.length < 20) receipt.pageErrors.push(error.message); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.continue();
    let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { return route.abort(); }
    const path = resolve(options.site, '.' + (decoded === '/' ? '/index.html' : decoded));
    const inside = relative(options.site, path);
    if (inside.startsWith('..') || isAbsolute(inside)) return route.abort();
    let body; try { body = await readFile(path); } catch { return route.fulfill({ status: 404, body: 'Not found' }); }
    const source = { sha256: sha256(body), bytes: body.length };
    if (url.pathname === '/media-lab.mjs') {
      const anchor = "s.playbackEngine = 'hls.js';";
      const code = body.toString(); assert.equal(code.split(anchor).length, 2, 'The sole controller observation anchor must match once.');
      const observe = "const qa = window.__nativeFallbackQa; qa.players.push({ Hls, player, session: s }); player.on(Hls.Events.DESTROYING, () => { qa.destroyedAt = Date.now(); });";
      body = Buffer.from(code.replace(anchor, anchor + ' ' + observe));
      source.observedSha256 = sha256(body); source.observationAnchors = 1;
    }
    receipt.sources[url.pathname] = source;
    const result = staticResource(body, request.headers().range, request.method());
    if (mediaUrl(url.href) && receipt.staticMediaResponses.length < 24) receipt.staticMediaResponses.push({
      path: url.pathname, method: request.method(), range: request.headers().range ?? null,
      status: result.status, bytes: result.body.length, contentRange: result.headers['content-range'] ?? null });
    return route.fulfill({ ...result, contentType: mime[extname(path)] ?? 'application/octet-stream' });
  });
  await page.addInitScript(() => {
    const q = window.__nativeFallbackQa = { players: [], events: [],
      sources: [], positions: [], trustedClicks: [], frames: 0, nativeFrames: 0, faultCount: 0, cleanup: false };
    const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    const position = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...source, set(value) {
      if (this.id === 'lab-video' && q.sources.length < 24) q.sources.push({ at: Date.now(), value: String(value), crossOrigin: this.crossOrigin });
      return source.set.call(this, value);
    } });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...position, set(value) {
      if (this.id === 'lab-video' && q.positions.length < 64) {
        const owner = q.players.at(-1)?.session, room = owner?.listener?.snapshot();
        q.positions.push({ at: Date.now(), value, source: this.src, native: owner?.nativeHls === true,
          roomPhase: owner?.listener?.position() ?? null, roomReady: room?.ready === true,
          following: owner?.listenerWanted === true && owner?.followLive !== false });
      }
      return position.set.call(this, value);
    } });
    document.addEventListener('click', event => { if (event.target.closest?.('#public-play') && q.trustedClicks.length < 8)
      q.trustedClicks.push({ at: Date.now(), trusted: event.isTrusted, active: navigator.userActivation.isActive }); }, true);
    const event = e => { const v = e.target; if (v.id !== 'lab-video' || q.events.length >= 200) return;
      q.events.push({ type: e.type, at: Date.now(), time: v.currentTime, ready: v.readyState, paused: v.paused,
        seeking: v.seeking, native: q.players.at(-1)?.session.nativeHls === true, nativeFrames: q.nativeFrames,
        error: v.error?.code ?? null, cleanup: q.cleanup }); };
    const names = ['play', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'pause', 'error', 'loadedmetadata', 'emptied'];
    for (const name of names) window.addEventListener(name, event, true);
    let frameId;
    document.addEventListener('DOMContentLoaded', () => {
      const v = document.getElementById('lab-video');
      const frame = (_at, metadata) => {
        if (q.cleanup) return;
        q.frames++;
        const s = q.players.at(-1)?.session;
        if (s?.nativeHls && !v.paused && !v.seeking && v.readyState >= 3 && !v.currentSrc.startsWith('blob:')) {
          q.nativeFrames++; q.nativeFirstFrame ??= { at: Date.now(), mediaTime: metadata.mediaTime, width: metadata.width, height: metadata.height };
        }
        q.lastFrame = { width: metadata.width, height: metadata.height, mediaTime: metadata.mediaTime };
        frameId = v.requestVideoFrameCallback(frame);
      };
      frameId = v.requestVideoFrameCallback(frame);
    }, { once: true });
    q.restore = () => { q.cleanup = true; if (frameId !== undefined) document.getElementById('lab-video')?.cancelVideoFrameCallback(frameId);
      for (const name of names) window.removeEventListener(name, event, true);
      Object.defineProperty(HTMLMediaElement.prototype, 'src', source); Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', position);
    };
  });
  const cdp = await context.newCDPSession(page), network = new Map(), extra = new Map();
  cdp.on('Network.requestWillBeSent', event => {
    if (!mediaUrl(event.request.url) || receipt.requests.length >= 256) return;
    const row = { id: event.requestId, url: event.request.url, at: event.wallTime * 1000, headers: headers(event.request.headers, ['range', 'origin', 'referer']),
      actualHeaders: extra.get(event.requestId) ?? null, bodyBytes: 0 };
    extra.delete(event.requestId); network.set(event.requestId, row); receipt.requests.push(row);
  });
  cdp.on('Network.requestWillBeSentExtraInfo', event => {
    const selected = headers(event.headers, ['range', 'origin', 'referer']);
    const row = network.get(event.requestId); if (row) row.actualHeaders = selected;
    else if (extra.size < 256) extra.set(event.requestId, selected);
  });
  cdp.on('Network.responseReceived', event => { const row = network.get(event.requestId); if (row) Object.assign(row, {
    status: event.response.status, protocol: event.response.protocol, responseHeaders: headers(event.response.headers, responseHeaders) }); });
  cdp.on('Network.dataReceived', event => { const row = network.get(event.requestId); if (row) {
    row.bodyBytes += event.dataLength; httpBytes += event.dataLength;
    if (httpBytes > MAX_BODY && !receipt.bodyLimitExceeded) { receipt.bodyLimitExceeded = true; void browser?.close().catch(() => {}); }
  } });
  cdp.on('Network.loadingFinished', event => { const row = network.get(event.requestId); if (row) Object.assign(row, { completed: true, encodedTransferBytes: event.encodedDataLength }); });
  cdp.on('Network.loadingFailed', event => { const row = network.get(event.requestId); if (row) Object.assign(row, {
    completed: false, error: event.errorText, corsError: event.corsErrorStatus ?? null, blockedReason: event.blockedReason ?? null }); });
  cdp.on('Media.playerPropertiesChanged', event => { for (const property of event.properties) if (receipt.nativeMedia.length < 160 && /audio|decoder/i.test(property.name))
    receipt.nativeMedia.push({ at: Date.now(), playerId: event.playerId, ...property }); });
  cdp.on('Media.playerErrorsRaised', event => { for (const error of event.errors) if (receipt.nativeMediaErrors.length < 40)
    receipt.nativeMediaErrors.push({ at: Date.now(), playerId: event.playerId, errorType: error.errorType, code: error.code, data: error.data ?? null }); });
  await cdp.send('Network.enable'); await cdp.send('Media.enable');
  stage = 'real-initial-playback';
  await page.goto(ORIGIN + '/?q=full', { waitUntil: 'domcontentloaded', timeout: Math.min(12_000, remaining()) });
  await waitFor(() => !document.getElementById('public-play').disabled);
  await page.locator('#public-play').click();
  await waitFor(() => { const q = window.__nativeFallbackQa, s = q.players[0]?.session;
    return q.frames >= 10 && s?.browser.seenFrame && !s.nativeHls && !document.getElementById('lab-video').paused; });
  checkLimits(); receipt.beforeFault = await snapshot();
  assert.equal(receipt.beforeFault.mode, 'recorded-live'); assert.equal(receipt.beforeFault.hlsInstances, 1);
  assert.equal(receipt.beforeFault.lastFrame.width, 3840); assert.equal(receipt.beforeFault.lastFrame.height, 2160);
  assert.equal(receipt.beforeFault.videoElements, 1); assert.equal(receipt.beforeFault.muted, false);
  assert(receipt.beforeFault.volume > 0); assert.equal(receipt.beforeFault.rate, 1);
  stage = 'intentional-fatal-Hls-event';
  receipt.injection = await page.evaluate(() => {
    const q = window.__nativeFallbackQa, { Hls, player, session } = q.players[0], v = document.getElementById('lab-video');
    if (!v.canPlayType('application/vnd.apple.mpegurl')) throw new Error('The actual browser does not advertise native HLS.');
    if (session.nativeHls || q.faultCount) throw new Error('Expected one active Hls engine and no previous fault injection.');
    if (!session.listenerWanted || session.followLive === false || !session.listener?.snapshot().ready)
      throw new Error('The real recorded room must still be followed before the handover.');
    q.oldPeer = session.publicPeer;
    if (!q.oldPeer) throw new Error('A real public peer adapter is required before native recovery.');
    const phase = session.recordedView.recordingPosition(v.currentTime), at = Date.now(); q.faultCount++;
    player.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.FRAG_PARSING_ERROR,
      fatal: true, reason: 'Intentional native-fallback browser regression injection' });
    return { at, phase, count: q.faultCount, basis: 'Exactly one public Hls.trigger fatal ERROR after real decoded/presented frames; not a spontaneous failure.' };
  });
  await waitFor(() => { const q = window.__nativeFallbackQa, v = document.getElementById('lab-video');
    return q.nativeFrames >= 5 && document.getElementById('main').dataset.playbackEngine === 'Native HLS' && !v.paused && v.readyState >= 3; });
  checkLimits(); receipt.nativeStarted = await snapshot(); stage = 'observe-real-native-playback';
  const until = Date.now() + NATIVE_MS;
  while (Date.now() < until) {
    checkLimits(); const sample = await snapshot(); receipt.samples.push(sample);
    assert.equal(sample.error, null, 'Actual native playback raised a media error.');
    await page.waitForTimeout(400);
  }
  receipt.afterNative = await snapshot();
  receipt.observations = await page.evaluate(() => { const q = window.__nativeFallbackQa;
    return { sourceSelections: q.sources, timeAssignments: q.positions, events: q.events, clicks: q.trustedClicks,
      injectedFaults: q.faultCount, lastFrame: q.lastFrame, sessionNative: q.players[0].session.nativeHls,
      sessionHlsCleared: q.players[0].session.hls === null }; });
  const end = receipt.afterNative, observed = receipt.observations;
  assert.equal(observed.injectedFaults, 1); assert.equal(observed.clicks.length, 1); assert.equal(observed.clicks[0].trusted, true); assert.equal(observed.clicks[0].active, true);
  const selected = observed.sourceSelections.find(row => row.at >= receipt.injection.at && row.value === PLAYLIST);
  assert(selected, 'Native selection must use the original approved VOD playlist.'); assert.equal(selected.crossOrigin, 'anonymous', 'anonymous must precede native manifest selection.');
  const position = observed.timeAssignments.find(row => row.at >= receipt.injection.at && row.native && row.source === PLAYLIST);
  assert(position && position.roomReady && position.following && Number.isFinite(position.roomPhase),
    'The owned native handover must observe the actual still-following room.');
  const expected = Math.max(0, Math.min(position.roomPhase, 267.27));
  assert(Math.abs(position.value - expected) < 0.11, 'Native metadata must use the fresh room phase rather than the lagged pre-load capture.');
  receipt.phaseRestoration = { basis: 'fresh-room-phase-at-owned-native-handover', previousPhase: receipt.injection.phase,
    expected, actual: position.value, firstNativeFrame: end.nativeFirstFrame,
    transitionMs: end.nativeFirstFrame.at - receipt.injection.at };
  assert.equal(end.crossOrigin, 'anonymous'); assert.equal(end.currentSrc, PLAYLIST); assert.equal(end.engine, 'Native HLS');
  assert.equal(end.mode, 'recorded-vod'); assert(Math.abs(end.duration - 267.32) < 0.05);
  assert.equal(end.videoElements, 1); assert.equal(end.visibleVideos, 1); assert.equal(end.paused, false); assert.equal(end.muted, false); assert(end.volume > 0); assert.equal(end.rate, 1);
  assert.equal(end.nativeFirstFrame.width, 3840); assert.equal(end.nativeFirstFrame.height, 2160);
  assert(end.nativeFrames - receipt.nativeStarted.nativeFrames >= 200, 'Native 4K must genuinely advance for the observation window.');
  assert(end.audioDecodedBytes > receipt.nativeStarted.audioDecodedBytes, 'Native audio decoding must advance during observation.');
  assert(receipt.nativeMedia.some(row => row.at >= receipt.injection.at && /AudioDecoder/i.test(row.name) && row.value), 'The actual native audio decoder must be observed.');
  assert.deepEqual(receipt.nativeMediaErrors.filter(row => row.at >= receipt.injection.at), [], 'The intentional Hls event is separate from actual native pipeline errors.');
  assert(end.oldHlsDestroyedAt !== null && end.oldHlsDetached && observed.sessionHlsCleared);
  assert.equal(end.oldPeer.enabled, false); assert.equal(end.oldPeer.resources.activePeerConnections, 0); assert.equal(end.oldPeer.resources.signallingConnections, 0); assert.equal(end.oldPeer.resources.heldBytes, 0);
  assert.equal(end.oldPeer.phase, 'stopped'); assert.equal(end.oldPeer.coreState, null); assert.equal(end.oldPeer.transferWorkerState, null);
  const nativeRequests = receipt.requests.filter(row => row.at >= receipt.injection.at && row.url.startsWith('https://v4v.com/'));
  assert(nativeRequests.some(row => row.status === 206 || row.status === 200), 'Native recovery must fetch real approved source media.');
  assert(nativeRequests.every(row => !row.corsError && !row.blockedReason));
  assert(nativeRequests.filter(row => row.status).every(row => ['*', ORIGIN].includes(row.responseHeaders?.['access-control-allow-origin'])), 'Real cross-origin source responses must permit the page.');
  receipt.nativeRequestCors = nativeRequests.map(row => ({ url: row.url, actualOrigin: row.actualHeaders?.origin ?? null,
    provisionalOrigin: row.headers.origin ?? null, allowedOrigin: row.responseHeaders?.['access-control-allow-origin'] ?? null, status: row.status ?? null }));
  assert.deepEqual(receipt.pageErrors, []); checkLimits();
  receipt.continuity = { claimed: false, postFirstNativeWaitingEvents: observed.events.filter(row => row.native && row.nativeFrames > 0 && row.type === 'waiting'),
    nativeDroppedFrames: end.droppedFrames, note: 'All real waits, seeks, drops and drift remain observations. This test qualifies intentional native recovery, not uninterrupted playback.' };
  receipt.passed = true;
} catch (error) {
  receipt.failureStage = stage; receipt.failure = { name: error.name, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { receipt.failureSnapshot = await snapshot().catch(() => null);
    receipt.failureObservations = await page.evaluate(() => { const q = window.__nativeFallbackQa;
      return q ? { sources: q.sources, positions: q.positions, events: q.events, clicks: q.trustedClicks, faultCount: q.faultCount } : null; }).catch(() => null); }
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (page && !page.isClosed()) try {
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); window.__nativeFallbackQa?.restore(); });
    receipt.cleanup.pagehideDispatched = true;
  } catch (error) { receipt.cleanup.pagehideError = error.message; }
  try { await context?.close(); receipt.cleanup.contextClosed = true; } catch (error) { receipt.cleanup.contextError = error.message; }
  try { await browser?.close(); closed = true; receipt.cleanup.browserClosed = true; } catch (error) { receipt.cleanup.browserError = error.message; }
  receipt.cleanup.ownedServers = 0; receipt.cleanup.fixtureBrowserClosed = closed; receipt.mediaBodyBytes = httpBytes; receipt.finishedAt = new Date().toISOString();
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, output: options.output, failureStage: receipt.failureStage ?? null,
    failure: receipt.failure?.message ?? null, mediaBodyBytes: httpBytes, nativeFrames: receipt.afterNative?.nativeFrames ?? null, cleanup: receipt.cleanup }));
}
