// Manual acceptance of the public media experience.  Media and native browser
// playback remain real.  --site serves a candidate at the public site origin;
// omit it to qualify the actual deployed page.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = { '--output': 'output', '--screenshots': 'screenshots', '--site': 'site', '--url': 'url' }[process.argv[index]];
  assert(name && process.argv[index + 1], 'Use --output PRIVATE-RECEIPT.json [--screenshots PRIVATE-DIRECTORY] [--site CANDIDATE-SITE] [--url PAGE-URL]');
  options[name] = name === 'url' ? process.argv[index + 1] : resolve(process.argv[index + 1]);
}
assert(options.output, '--output is required');
const url = new URL(options.url ?? 'https://forgesworn.dev/live-media.html');
assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
assert(!options.site || url.origin === 'https://forgesworn.dev', 'Candidate files use the approved public origin for real media-host CORS');
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.woff2': 'font/woff2', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml' };
const hostedMedia = 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/';
const receipt = {
  schema: 1, measuredAt: new Date().toISOString(), passed: false,
  scope: 'Film-led public showcase, native playback controls and explained visitor participation',
  page: url.href, candidateSiteRouteFulfilment: Boolean(options.site), remoteMediaRouteFulfilment: false,
  autoplayPolicyOverride: false, browserAudioSuppressed: false,
  playbackBoundary: 'A short observation of the full original recording. Complete 268.6-second playback is not asserted.',
  audioBoundary: 'Actual Play starts unmuted audio. Web Audio measures decoded signal after the same trusted click; physical speaker listening is not asserted.',
  sharingBoundary: 'Play and join is the explained participation action. A single visitor may use origin fallback; another browser must actually deliver verified media before a nonzero peer benefit can be claimed.',
  hostLoadAtStart: loadavg(), checks: {}, pageErrors: 0, localApiRequests: 0, mediaHttpErrors: [],
};
let browser, page, stage = 'setup';
const requestLog = [], mediaInFlight = new Set();
const isMedia = value => value.startsWith(hostedMedia) && /\.(?:m3u8|mp4|m4s)(?:\?|$)/.test(value);

async function state() {
  return page.evaluate(() => {
    const video = document.getElementById('lab-video'), qa = window.__showcaseQa;
    let rms = null;
    if (qa?.audio) {
      const values = new Float32Array(qa.audio.analyser.fftSize);
      qa.audio.analyser.getFloatTimeDomainData(values);
      rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    }
    const text = id => document.getElementById(id)?.textContent ?? null;
    const resources = qa ? {
      websocketCreated: qa.sockets.length,
      websocketOpen: qa.sockets.filter(socket => socket.readyState < 2).length,
      peerCreated: qa.peers.length,
      peerOpen: qa.peers.filter(peer => peer.connectionState !== 'closed').length,
    } : null;
    return { width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
      geometry: video.getBoundingClientRect().toJSON(),
      decodedFrameWidth: qa?.frame?.width ?? null, decodedFrameHeight: qa?.frame?.height ?? null,
      frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? null,
      audioDecodedBytes: video.webkitAudioDecodedByteCount ?? null,
      muted: video.muted, volume: video.volume, paused: video.paused, controls: video.controls,
      sourceConfigured: Boolean(video.getAttribute('src')), source: video.currentSrc,
      audioRms: rms, audioState: qa?.audio?.context.state ?? null,
      quality: document.getElementById('lab-quality').value,
      videoElementCount: document.querySelectorAll('video').length,
      delivery: text('public-delivery'), peerBytes: text('public-peer-bytes'), uploadedBytes: text('public-upload-bytes'),
      peers: text('public-peers'), sharingStatus: text('public-share-status'),
      fps: text('browser-fps'), firstFrame: text('first-frame'), dimensions: text('browser-dimensions'),
      statsBytes: text('browser-bytes'), statsRequests: text('browser-requests'),
      map: { exists: Boolean(document.querySelector('#public-swarm-map svg')),
        observedPeers: document.getElementById('public-swarm-map')?.dataset.observedPeers ?? null,
        connectedPeers: document.getElementById('public-swarm-map')?.dataset.connectedPeers ?? null,
        drawnPeerNodes: document.querySelectorAll('#public-swarm-map [data-peer-id]').length,
        description: document.querySelector('#public-swarm-map svg')?.getAttribute('aria-label') ?? null },
      resources,
    };
  });
}

async function playing() {
  await page.waitForFunction(() => {
    const video = document.getElementById('lab-video'), qa = window.__showcaseQa;
    if (!qa?.audio || qa.audio.context.state !== 'running' || !qa.frame) return false;
    const values = new Float32Array(qa.audio.analyser.fftSize); qa.audio.analyser.getFloatTimeDomainData(values);
    const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    return video.videoHeight === 2160 && qa.frame.width === 3840 && qa.frame.height === 2160 &&
      video.currentTime > 0.3 && !video.paused && !video.muted && video.volume > 0 &&
      video.webkitAudioDecodedByteCount > 0 && rms > 0.00001;
  }, undefined, { timeout: 65000 });
  return state();
}

async function nativeFullscreen() {
  const video = page.locator('#lab-video');
  await video.scrollIntoViewIfNeeded();
  await video.hover();
  const before = await page.evaluate(() => {
    const video = document.getElementById('lab-video');
    window.__showcaseQa.sameVideo = video; video.volume = 0.43;
    return { time: video.currentTime, source: video.currentSrc, volume: video.volume, muted: video.muted };
  });
  // Chromium exposes its actual media controls through the accessibility tree.
  // Click the native full-screen button rather than adding a test-only control.
  async function clickFullscreenControl(exit) {
    await video.hover();
    const cdp = await page.context().newCDPSession(page);
    try {
      const tree = await cdp.send('Accessibility.getFullAXTree');
      const nativeButton = tree.nodes.find(node => node.role?.value === 'button' && /full.?screen/i.test(node.name?.value ?? '') && /exit/i.test(node.name?.value ?? '') === exit && node.backendDOMNodeId);
      if (!nativeButton) throw new Error('Native full-screen control is absent from the browser accessibility tree');
      const box = await cdp.send('DOM.getBoxModel', { backendNodeId: nativeButton.backendDOMNodeId });
      const points = box.model.border;
      await page.mouse.click((points[0] + points[2] + points[4] + points[6]) / 4, (points[1] + points[3] + points[5] + points[7]) / 4);
    } finally { await cdp.detach(); }
  }
  await clickFullscreenControl(false);
  await page.waitForFunction(() => Boolean(document.fullscreenElement), undefined, { timeout: 10000 });
  await page.waitForFunction(time => document.getElementById('lab-video').currentTime > time + 0.15, before.time, { timeout: 15000 });
  await clickFullscreenControl(true);
  await page.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 10000 });
  const after = await page.evaluate(() => {
    const video = document.getElementById('lab-video');
    return { sameElement: video === window.__showcaseQa.sameVideo, time: video.currentTime, source: video.currentSrc, volume: video.volume, muted: video.muted, paused: video.paused };
  });
  assert(after.sameElement && after.time >= before.time && !after.paused);
  assert.equal(after.source, before.source); assert.equal(after.volume, before.volume); assert.equal(after.muted, before.muted);
  return { actualNativeEnterAndExitControlsClicked: true, returnedInline: true, sameElement: true, sourcePreserved: true, timeAdvanced: true, volumePreserved: true };
}

const cancelled = () => { process.exitCode = 130; void browser?.close().catch(() => {}); };
process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
try {
  receipt.sources = [];
  const entryPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  for (const file of [...new Set([entryPath, 'media-lab.html', 'media-lab.mjs', 'media-showcase.css',
    'media-public-swarm.mjs', 'media-swarm-visual.mjs', 'media/dejavu-swarm/catalogue-v1.json',
    'vendor/media-peer-demo.js', 'vendor/hls.light.min.mjs'])]) {
    try { receipt.sources.push({ path: `site/${file}`, sha256: createHash('sha256').update(await readFile(resolve(options.site ?? resolve(root, 'site'), file))).digest('hex') }); } catch { /* Deployed-only invocation can omit candidate source hashes. */ }
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  receipt.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    const qa = window.__showcaseQa = { sockets: [], peers: [] };
    const NativeSocket = window.WebSocket, NativePeer = window.RTCPeerConnection;
    window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); qa.sockets.push(this); } };
    window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); qa.peers.push(this); } };
  });
  page.on('pageerror', () => { receipt.pageErrors++; });
  page.on('request', request => {
    if (isMedia(request.url())) mediaInFlight.add(request);
    if (requestLog.length < 1500) requestLog.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/lab/')) receipt.localApiRequests++;
  });
  page.on('requestfinished', request => mediaInFlight.delete(request));
  page.on('requestfailed', request => mediaInFlight.delete(request));
  page.on('response', response => {
    if (isMedia(response.url()) && response.status() >= 400) receipt.mediaHttpErrors.push({ status: response.status(), type: extname(new URL(response.url()).pathname) });
  });
  if (options.site) await page.route(`${url.origin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.startsWith('/lab/')) return route.abort();
    const path = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const file = resolve(options.site, `.${decodeURIComponent(path)}`);
    if (relative(options.site, file).startsWith('..')) return route.abort();
    try { return route.fulfill({ status: 200, body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  stage = 'initial-experience';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const play = document.getElementById('public-play');
    return play && !play.disabled;
  });
  await page.evaluate(() => document.fonts.ready);
  // Keep the first-viewport evidence legible after the site's short entrance
  // animation, and observe an idle period before the first playback gesture.
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#lab-quality').inputValue(), 'full');
  assert.equal(await page.locator('video').count(), 1);
  const visiblePlay = [];
  for (const button of await page.locator('button').all()) if (await button.isVisible() && /play|run/i.test(await button.innerText())) visiblePlay.push(await button.getAttribute('id'));
  assert.deepEqual(visiblePlay, ['public-play']);
  const initial = await state();
  assert(initial.paused && !initial.sourceConfigured && initial.time === 0);
  assert.equal(initial.resources.websocketCreated, 0); assert.equal(initial.resources.peerCreated, 0);
  assert(initial.map.exists); assert.equal(initial.map.drawnPeerNodes, 0); assert.equal(initial.map.observedPeers, '0');
  assert.equal(requestLog.filter(isMedia).length, 0);
  const geometry = await page.locator('#lab-video').boundingBox();
  assert(geometry.y < 500 && geometry.width >= 1100, 'The full mix must lead the first desktop viewport');
  receipt.checks.initial = { defaultQuality: 'full-4k', visiblePlayActions: 1, noMediaBeforePlay: true, noPeerNetworkBeforePlayAndJoin: true, videoElements: 1, videoGeometry: geometry };
  if (options.screenshots) {
    await mkdir(options.screenshots, { recursive: true });
    await page.screenshot({ path: resolve(options.screenshots, 'showcase-desktop-ready.png') });
  }
  await page.evaluate(() => {
    const qa = window.__showcaseQa, video = document.getElementById('lab-video');
    const context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 1024;
    context.createMediaElementSource(video).connect(analyser); analyser.connect(context.destination);
    qa.audio = { context, analyser };
    document.getElementById('public-play').addEventListener('click', () => { void context.resume(); }, { capture: true });
    const frame = (_now, data) => { qa.frame = { width: data.width, height: data.height }; qa.frameCallback = video.requestVideoFrameCallback(frame); };
    qa.frameCallback = video.requestVideoFrameCallback(frame);
  });
  stage = 'single-click-4k-with-audio';
  await page.click('#public-play');
  const actual = await playing();
  assert.equal(actual.width, Math.round(3840 * 17415 / 17408));
  assert(actual.controls && actual.frames > 0 && actual.audioDecodedBytes > 0 && actual.audioRms > 0);
  await page.waitForFunction(() => window.__showcaseQa.sockets.length > 0, undefined, { timeout: 15000 });
  assert.equal(actual.videoElementCount, 1);
  receipt.checks.playback = { ...actual, source: actual.source ? 'actual-media-source-attached' : null };
  stage = 'invite-the-current-moment';
  await page.evaluate(() => {
    if (!navigator.clipboard?.writeText) return;
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    // Observe only the URL this click supplies, then call the real browser API.
    // The test never reads the user's existing clipboard.
    navigator.clipboard.writeText = value => { window.__showcaseQa.invitation = value; return nativeWrite(value); };
  });
  const inviteTime = (await state()).time;
  await page.locator('#public-invite').click();
  await page.waitForFunction(() => /Link copied|Share this listening link/.test(document.getElementById('public-invite-status')?.textContent ?? ''));
  const invitation = await page.evaluate(() => window.__showcaseQa.invitation ?? document.getElementById('public-invite-status').textContent.split('Share this listening link: ')[1]);
  const inviteUrl = new URL(invitation);
  assert.equal(inviteUrl.origin, 'https://forgesworn.dev'); assert.equal(inviteUrl.pathname, '/live-media.html');
  assert.equal(inviteUrl.searchParams.get('q'), 'full');
  assert(Number(inviteUrl.searchParams.get('t')) >= inviteTime - 0.1);
  assert(Math.abs(Date.now() - Number(inviteUrl.searchParams.get('at'))) < 10000);
  receipt.checks.invitation = { actualButtonClicked: true, nativeClipboardWriteOrVisibleFallback: true, qualityAndCurrentMomentIncluded: true,
    clipboardExistingContentsRead: false, status: await page.locator('#public-invite-status').innerText() };
  stage = 'native-pause-resume-seek';
  const video = page.locator('#lab-video');
  await video.press('Space');
  await page.waitForFunction(() => document.getElementById('lab-video').paused);
  await page.waitForFunction(() => window.__showcaseQa.sockets.every(socket => socket.readyState === 3) && window.__showcaseQa.peers.every(peer => peer.connectionState === 'closed'), undefined, { timeout: 15000 });
  assert.equal((await state()).map.drawnPeerNodes, 0);
  const pausedAt = (await state()).time;
  const socketCountBeforeResume = (await state()).resources.websocketCreated;
  await video.press('Space');
  await page.waitForFunction(() => !document.getElementById('lab-video').paused);
  await page.waitForFunction(count => window.__showcaseQa.sockets.length > count, socketCountBeforeResume, { timeout: 15000 });
  await video.press('ArrowRight');
  await page.waitForFunction(time => document.getElementById('lab-video').currentTime > time + 3, pausedAt, { timeout: 15000 });
  receipt.checks.nativeControls = { pauseResumeViaKeyboard: true, pauseClosedSharingSocketsAndPeers: true, resumeRejoined: true, seekViaKeyboard: true, browserControlsPresent: true };
  stage = 'native-fullscreen';
  receipt.checks.fullscreen = await nativeFullscreen();
  stage = 'stats-preserve-playback';
  const beforeStats = await state();
  await page.locator('#public-stats-details > summary').click();
  await page.waitForFunction(time => document.getElementById('lab-video').currentTime > time + 0.2, beforeStats.time);
  const afterStats = await state();
  assert.equal(afterStats.source, beforeStats.source); assert.equal(afterStats.volume, beforeStats.volume);
  assert(afterStats.time > beforeStats.time && !afterStats.paused);
  assert(afterStats.fps?.includes('fps') && afterStats.firstFrame !== '—');
  await page.locator('#public-stats-details > summary').click();
  receipt.checks.stats = { openedWithoutRestart: true, sourcePreserved: true, volumePreserved: true, timeAdvanced: true, measuredFrameRateVisible: true };
  if (options.screenshots) await page.screenshot({ path: resolve(options.screenshots, 'showcase-desktop-playing.png') });
  stage = 'real-visitor-participation';
  const joined = await state();
  assert.equal(joined.videoElementCount, 1, 'There must be no hidden second viewer');
  assert.equal(joined.map.drawnPeerNodes, Number(joined.map.observedPeers));
  receipt.checks.sharing = { explainedPlayAndJoinOpenedSignalling: true, hiddenViewers: 0, pauseClosedSocketsAndPeers: true, resumeRejoined: true,
    signallingSocketsCreated: joined.resources.websocketCreated, signallingSocketsOpen: joined.resources.websocketOpen,
    observedDelivery: joined.delivery, observedPeerBytes: joined.peerBytes, observedUploadedBytes: joined.uploadedBytes, observedPeers: joined.peers, status: joined.sharingStatus,
    observedMap: joined.map };
  stage = 'mobile-layout';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  const mobile = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth,
    video: document.getElementById('lab-video').getBoundingClientRect().toJSON() }));
  assert(mobile.body <= 390 && mobile.document <= 390 && mobile.video.width <= 390);
  assert.equal((await state()).videoElementCount, 1);
  if (options.screenshots) await page.screenshot({ path: resolve(options.screenshots, 'showcase-mobile.png') });
  await page.locator('#public-swarm-map').scrollIntoViewIfNeeded();
  const mobileMap = await page.locator('#public-swarm-map svg').getAttribute('viewBox');
  if (options.screenshots) await page.screenshot({ path: resolve(options.screenshots, 'showcase-mobile-swarm.png') });
  receipt.checks.mobile = { viewportWidth: 390, horizontalOverflow: false, sameVideo: true, swarmViewBox: mobileMap };
  assert.equal(receipt.localApiRequests, 0); assert.equal(receipt.pageErrors, 0); assert.equal(receipt.mediaHttpErrors.length, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failure = error.name; receipt.failureStage = stage; process.exitCode = 1;
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output + '.failure.local.json', JSON.stringify({ stage, error: error.stack, state: await state().catch(() => null), requests: requestLog }, null, 2) + '\n', { mode: 0o600 });
  if (options.screenshots && page) {
    await mkdir(options.screenshots, { recursive: true });
    await page.screenshot({ path: resolve(options.screenshots, 'showcase-failure.local.png') }).catch(() => {});
  }
  console.error(`Public showcase acceptance failed at ${stage}.`);
} finally {
  await page?.evaluate(() => {
    const qa = window.__showcaseQa, video = document.getElementById('lab-video');
    if (qa?.frameCallback !== undefined) video.cancelVideoFrameCallback(qa.frameCallback);
    void qa?.audio?.context.close();
    window.dispatchEvent(new Event('pagehide'));
  }).catch(() => {});
  await browser?.close(); receipt.browserClosed = true; receipt.hostLoadAtEnd = loadavg();
  process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, stage, checks: Object.keys(receipt.checks), browserClosed: true, pageErrors: receipt.pageErrors }));
}
