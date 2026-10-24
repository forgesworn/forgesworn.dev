// Manual public-origin acceptance. Local site files are served by route fulfilment;
// the approved licensed 4K media uses its real HTTPS host. No autoplay override.
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
  const key = { '--output': 'output', '--screenshots': 'screenshots', '--bundle': 'bundle', '--origin': 'origin', '--prefix': 'prefix' }[process.argv[index]];
  assert(key && process.argv[index + 1], 'Use --output PRIVATE-RECEIPT.json [--screenshots PRIVATE-DIRECTORY]');
  options[key] = ['origin', 'prefix'].includes(key) ? process.argv[index + 1] : resolve(process.argv[index + 1]);
}
assert(options.output, '--output is required');
const origin = options.origin ?? 'https://forgesworn.dev';
assert.equal(new URL(origin).origin, origin);
const prefix = options.prefix ?? '';
assert(!prefix || /^\/[a-z0-9/_-]+$/.test(prefix));
const siteRoot = options.bundle ?? resolve(root, 'site');
const entry = options.bundle ? `${prefix}/index.html` : '/media-lab.html';
const remote = 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/';
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.woff2': 'font/woff2',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain' };
const receipt = {
  schema: 1, measuredAt: new Date().toISOString(), scope: 'Actual public-origin lab UI and approved licensed media',
  passed: false, autoplayPolicyOverride: false, browserAudioSuppressed: false,
  localSiteRouteFulfilment: true, remote4kMediaRouteFulfilment: false,
  pageOrigin: origin, staticFallbackCopy: Boolean(options.bundle), mountPrefix: prefix,
  fullPlaybackBoundary: 'The 4K path is observed briefly; complete 268.6-second playback is not asserted.',
  audioBoundary: 'Real user clicks start unmuted audio; a connected Web Audio analyser measures nonzero decoded signal. Physical speaker listening is not asserted.',
  audioInstrumentation: 'MediaElementAudioSource -> analyser -> destination; context resumes only on actual Play-button clicks. The video play method is not replaced.',
  dimensionBoundary: 'Original source is coded 3840x2160 with sample aspect 17415:17408. HTML natural display width rounds to3842; decoded-frame pixel metadata is recorded separately.',
  sourceAspectRatio: { numerator: 17415, denominator: 17408, expectedNaturalWidth: Math.round(3840 * 17415 / 17408), evidence: 'Independent ffprobe of the exact licensed source hash' },
  hostLoadAtStart: loadavg(), sources: [], checks: [], pageErrors: 0, localApiRequests: 0,
  unexpectedRequests: 0, mediaHttpErrors: [],
};
let browser, page;
let stage = 'setup';
const privateRequests = [];
const inFlight = new Set();
const cancelled = () => { process.exitCode = 130; void browser?.close().catch(() => {}); };
process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
const isMedia = url => url.startsWith(remote) || url.startsWith(`${origin}${prefix}/media/dejavu-preview/`);

async function state() {
  return page.evaluate(() => {
    const video = document.getElementById('lab-video');
    const audio = window.__publicLabAudio;
    let rms = null;
    if (audio) {
      const samples = new Float32Array(audio.analyser.fftSize);
      audio.analyser.getFloatTimeDomainData(samples);
      rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    }
    return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime,
      decodedFrameWidth: window.__publicLabFrame?.width ?? null, decodedFrameHeight: window.__publicLabFrame?.height ?? null,
      paused: video.paused, muted: video.muted, volume: video.volume,
      decodedFrames: video.webkitDecodedFrameCount ?? null, audioDecodedBytes: video.webkitAudioDecodedByteCount ?? null,
      audioContextState: audio?.context.state ?? null, audioRms: rms,
      quality: document.getElementById('lab-quality').value,
      fpsDisplay: document.getElementById('browser-fps').textContent,
      dimensionsDisplay: document.getElementById('browser-dimensions').textContent,
      firstFrameDisplay: document.getElementById('first-frame').textContent,
      responseBytesDisplay: document.getElementById('browser-bytes').textContent,
      requestsDisplay: document.getElementById('browser-requests').textContent,
      errorsDisplay: document.getElementById('browser-errors').textContent,
      bufferDisplay: document.getElementById('browser-buffer').textContent,
      stallsDisplay: document.getElementById('browser-stalls').textContent,
      stallTimeDisplay: document.getElementById('browser-stall-time').textContent,
      bufferedAheadSeconds: video.buffered.length ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime) : 0,
      hlsConfiguration: window.__publicHlsConfig ?? null,
      currentSourceConfigured: Boolean(video.getAttribute('src')),
    };
  });
}

async function playing(width, height) {
  await page.waitForFunction(({ width, height }) => {
    const video = document.getElementById('lab-video'), audio = window.__publicLabAudio;
    if (!audio || audio.context.state !== 'running') return false;
    const values = new Float32Array(audio.analyser.fftSize); audio.analyser.getFloatTimeDomainData(values);
    const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    const frame = window.__publicLabFrame;
    return frame?.width === width && frame?.height === height && video.videoHeight === height && video.currentTime > 0.3 &&
      !video.paused && !video.muted && video.volume > 0 && video.webkitDecodedFrameCount > 0 &&
      video.webkitAudioDecodedByteCount > 0 && rms > 0.00001;
  }, { width, height }, { timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('browser-fps').textContent.includes('fps'), undefined, { timeout: 5000 });
  const before = await state();
  await page.waitForFunction(time => document.getElementById('lab-video').currentTime > time + 0.5, before.currentTime, { timeout: 15000 });
  const after = await state();
  assert(after.decodedFrames > before.decodedFrames && after.audioDecodedBytes > 0);
  assert.notEqual(after.firstFrameDisplay, '—');
  assert.notEqual(after.dimensionsDisplay, 'Browser video dimensions');
  assert.notEqual(after.requestsDisplay, '—');
  return after;
}

async function fullscreen(quality) {
  const before = await page.evaluate(() => {
    window.__publicLabVideo = document.getElementById('lab-video');
    const video = window.__publicLabVideo; video.volume = 0.47;
    return { currentTime: video.currentTime, volume: video.volume, muted: video.muted,
      quality: document.getElementById('lab-quality').value, engine: document.getElementById('lab-engine').value };
  });
  await page.click('#lab-fullscreen');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'lab-video-wrap', undefined, { timeout: 10000 });
  await page.waitForFunction(time => document.getElementById('lab-video').currentTime > time + 0.2, before.currentTime, { timeout: 10000 });
  assert.equal(await page.locator('#lab-fullscreen').textContent(), 'Back to stats');
  await page.click('#lab-fullscreen');
  await page.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 10000 });
  const after = await page.evaluate(() => {
    const video = document.getElementById('lab-video');
    return { sameElement: video === window.__publicLabVideo, currentTime: video.currentTime, volume: video.volume, muted: video.muted,
      quality: document.getElementById('lab-quality').value, engine: document.getElementById('lab-engine').value, focus: document.activeElement.id };
  });
  assert(after.sameElement && after.currentTime > before.currentTime);
  assert.equal(after.volume, before.volume); assert.equal(after.muted, false);
  assert.equal(after.quality, quality); assert.equal(after.engine, before.engine); assert.equal(after.focus, 'lab-fullscreen');
  return { enteredAndExited: true, sameElement: true, timeAdvanced: true, volumePreserved: true, selectionPreserved: true, focusRestored: true };
}

try {
  for (const file of [options.bundle ? 'index.html' : 'media-lab.html', 'media-lab.mjs', 'media-live-start.mjs', 'media-fullscreen.mjs', 'vendor/hls.light.min.mjs', 'media/dejavu-preview/manifest.json']) {
    receipt.sources.push({ path: options.bundle ? file : `site/${file}`, sha256: createHash('sha256').update(await readFile(resolve(siteRoot, file))).digest('hex') });
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  receipt.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', () => { receipt.pageErrors++; });
  page.on('request', request => {
    if (isMedia(request.url())) inFlight.add(request);
    if (privateRequests.length < 100) privateRequests.push(request.url());
  });
  page.on('requestfinished', request => inFlight.delete(request));
  page.on('requestfailed', request => inFlight.delete(request));
  page.on('response', response => {
    if (isMedia(response.url()) && response.status() >= 400) receipt.mediaHttpErrors.push({ host: response.url().startsWith(remote) ? 'licensed-media-host' : 'public-site', status: response.status() });
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/lab/')) { receipt.localApiRequests++; return route.abort(); }
    if (url.href.startsWith(remote)) return route.continue();
    if (url.origin !== origin) { receipt.unexpectedRequests++; return route.abort(); }
    if (prefix && !url.pathname.startsWith(prefix + '/')) { receipt.unexpectedRequests++; return route.abort(); }
    const name = prefix ? url.pathname.slice(prefix.length) : url.pathname;
    const file = resolve(siteRoot, `.${decodeURIComponent(name)}`);
    if (relative(siteRoot, file).startsWith('..')) return route.abort();
    try { return route.fulfill({ status: 200, body: await readFile(file), contentType: mime[extname(file)] ?? 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  stage = 'public-page-startup';
  await page.goto(`${origin}${entry}`);
  await page.waitForFunction(() => !document.getElementById('lab-run').disabled);
  const initial = await state();
  assert(initial.paused && initial.currentTime === 0 && !initial.currentSourceConfigured);
  assert.equal(await page.locator('#lab-quality').inputValue(), 'preview');
  await page.evaluate(() => {
    const video = document.getElementById('lab-video');
    const context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 1024;
    context.createMediaElementSource(video).connect(analyser); analyser.connect(context.destination);
    window.__publicLabAudio = { context, analyser };
    const observeFrame = (_now, metadata) => {
      window.__publicLabFrame = { width: metadata.width, height: metadata.height };
      window.__publicLabFrameCallback = video.requestVideoFrameCallback(observeFrame);
    };
    window.__publicLabFrameCallback = video.requestVideoFrameCallback(observeFrame);
    for (const id of ['lab-run', 'lab-play']) document.getElementById(id).addEventListener('click', () => { void context.resume(); }, { capture: true });
  });
  // Observe the actual public HLS configuration without replacing decoding,
  // transport, media bytes or the player's Play method.
  await page.evaluate(async moduleUrl => {
    const { default: Hls } = await import(moduleUrl), attach = Hls.prototype.attachMedia;
    Hls.prototype.attachMedia = function (...args) {
      window.__publicHlsConfig = Object.fromEntries(['maxBufferLength', 'maxMaxBufferLength', 'maxBufferSize', 'backBufferLength', 'lowLatencyMode'].map(key => [key, this.config[key]]));
      return Reflect.apply(attach, this, args);
    };
  }, `${origin}${prefix}/vendor/hls.light.min.mjs`);
  stage = '1080p-preview-playback';
  await page.click('#lab-run');
  const preview = await playing(1920, 1080);
  assert.deepEqual(preview.hlsConfiguration, { maxBufferLength: 4, maxMaxBufferLength: 6, maxBufferSize: 8 * 1024 * 1024, backBufferLength: 0, lowLatencyMode: false });
  stage = '1080p-fullscreen';
  const previewFullscreen = await fullscreen('preview');
  if (options.screenshots) {
    await mkdir(options.screenshots, { recursive: true });
    await page.screenshot({ path: resolve(options.screenshots, 'lab-public-1080p.png'), fullPage: true });
  }
  receipt.checks.push({ quality: '1080p-preview', actualPlayback: preview, fullscreen: previewFullscreen });
  const beforeSwitch = await page.evaluate(() => ({ source: document.getElementById('lab-video').currentSrc, time: document.getElementById('lab-video').currentTime }));
  await page.selectOption('#lab-quality', 'full');
  const pending = await page.evaluate(() => ({ source: document.getElementById('lab-video').currentSrc, time: document.getElementById('lab-video').currentTime }));
  assert.equal(pending.source, beforeSwitch.source); assert(pending.time >= beforeSwitch.time);
  stage = 'hosted-4k-playback';
  await page.click('#lab-play');
  const full = await playing(3840, 2160);
  assert.deepEqual(full.hlsConfiguration, preview.hlsConfiguration);
  assert.equal(full.width, receipt.sourceAspectRatio.expectedNaturalWidth);
  stage = '4k-fullscreen';
  const fullFullscreen = await fullscreen('full');
  if (options.screenshots) await page.screenshot({ path: resolve(options.screenshots, 'lab-public-4k.png'), fullPage: true });
  receipt.checks.push({ quality: '4k-full-source-short-observation', actualPlayback: full, fullscreen: fullFullscreen,
    qualityChangeWaitedForPlay: true, actualRemoteMedia: true });
  stage = 'stop-cleanup';
  await page.click('#lab-stop');
  await page.waitForFunction(() => {
    const video = document.getElementById('lab-video');
    return video.paused && video.getAttribute('src') === null && document.getElementById('lab-play').disabled;
  }, undefined, { timeout: 5000 });
  const stopDeadline = Date.now() + 5000;
  while (inFlight.size && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(inFlight.size, 0);
  assert.equal(await page.locator('#lab-quality').inputValue(), 'full');
  assert.equal(await page.locator('#comparison-runs tr:not(:has(.empty-cell))').count(), 0);
  assert.equal(receipt.localApiRequests, 0); assert.equal(receipt.pageErrors, 0); assert.equal(receipt.unexpectedRequests, 0);
  assert.equal(receipt.mediaHttpErrors.length, 0);
  receipt.stopCleanup = { paused: true, sourceDetached: true, mediaRequestsInFlight: 0, qualityPreserved: true, noComparisonRowInvented: true };
  receipt.passed = true;
} catch (error) {
  // Failure text excludes URLs, input paths and page content. Exact assertion
  // diagnostics stay with the private invocation, outside the scalar receipt.
  receipt.failure = error.name;
  receipt.failureStage = stage;
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output + '.failure.local.json', JSON.stringify({ error: error.stack, stage, requests: privateRequests,
    state: await state().catch(() => null) }, null, 2) + '\n', { mode: 0o600 });
  console.error('Public lab playback qualification did not pass.');
  process.exitCode = 1;
} finally {
  await page?.evaluate(() => {
    const video = document.getElementById('lab-video');
    if (window.__publicLabFrameCallback !== undefined) video.cancelVideoFrameCallback(window.__publicLabFrameCallback);
  }).catch(() => {});
  await page?.evaluate(() => window.__publicLabAudio?.context.close()).catch(() => {});
  await browser?.close();
  receipt.browserClosed = true; receipt.hostLoadAtEnd = loadavg();
  process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, pageErrors: receipt.pageErrors, localApiRequests: receipt.localApiRequests, browserClosed: true }));
}
