// Actual landing-page UI, decoded media and native relay acceptance.
// node test/media-ui-browser.mjs --spry /path/to/spry-turn --output /tmp/ui.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startMediaDemo } from '../scripts/serve-media-demo.mjs';

const options = { transport: 'udp', clip: 'rtmp', mode: 'relay' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--spry', '--transport', '--clip', '--mode', '--output'].includes(key) || !value) throw new Error('Use --spry PATH, --transport udp|tcp, --clip rtmp|srt, --mode relay|host and --output PATH');
  options[key.slice(2)] = value;
}
assert(options.spry, 'A local Spry executable is required');
assert(['udp', 'tcp'].includes(options.transport));
assert(['rtmp', 'srt'].includes(options.clip));
assert(['relay', 'host'].includes(options.mode));
let browser, operator;
const receipt = { schema: 1, scope: 'actual-media-landing-page-with-forced-local-turn', passed: false,
  clip: options.clip, mode: options.mode, clientTransport: options.mode === 'relay' ? options.transport : null,
  autoplayPolicyOverride: false, audioOutputSuppressed: false, pageErrors: 0, externalRequests: 0 };

async function playbackState(page) {
  return page.evaluate(async () => {
    const pairs = [];
    for (const peer of window.__acceptancePeers) {
      if (peer.connectionState === 'closed') continue;
      const reports = [...(await peer.getStats()).values()];
      const pair = reports.find(value => value.type === 'candidate-pair' && value.state === 'succeeded' && (value.nominated || value.selected));
      if (!pair) continue;
      const local = reports.find(value => value.id === pair.localCandidateId);
      const remote = reports.find(value => value.id === pair.remoteCandidateId);
      pairs.push({ localType: local?.candidateType, remoteType: remote?.candidateType, relayProtocol: local?.relayProtocol });
    }
    const video = document.getElementById('media-video');
    const holders = window.__acceptanceVideos.filter(value => value !== video && value.hidden);
    return { verifiedPeerFragments: Number(document.getElementById('demo-fragments').textContent),
      peerBytesDisplay: document.getElementById('demo-bytes').textContent,
      deliveryPath: document.getElementById('demo-transport').textContent,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, currentTime: video.currentTime,
      muted: video.muted, volume: video.volume, paused: video.paused,
      audioDecodedBytes: video.webkitAudioDecodedByteCount ?? null,
      hiddenPlayersObserved: holders.length, hiddenPlayersMuted: holders.every(value => value.muted),
      selectedPairs: pairs, activeConnections: window.__acceptancePeers.filter(peer => peer.connectionState !== 'closed').length };
  });
}

const cancelled = () => { process.exitCode = 130; void browser?.close(); void operator?.stop(); };
process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
try {
  const manifest = await readFile(new URL('../site/media/dejavu-preview/manifest.json', import.meta.url));
  receipt.mediaManifestSha256 = createHash('sha256').update(manifest).digest('hex');
  receipt.spryBinarySha256 = createHash('sha256').update(await readFile(resolve(options.spry))).digest('hex');
  operator = await startMediaDemo({ spry: resolve(options.spry), transport: options.transport });
  const origin = new URL(operator.url).origin;
  // Keep Chromium's normal user-gesture policy and permit audio output. The
  // observer below never changes play(), mute or volume behaviour.
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', () => { receipt.pageErrors++; });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { receipt.externalRequests++; return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.__acceptancePeers = [];
    window.__acceptanceVideos = [];
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this instanceof HTMLVideoElement && !window.__acceptanceVideos.includes(this)) window.__acceptanceVideos.push(this);
      return nativePlay.apply(this, args);
    };
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) { super(config); window.__acceptancePeers.push(this); }
    };
  });
  await page.goto(options.mode === 'relay' ? operator.url : new URL('/media-peer-fixture.html', origin).href, { waitUntil: 'networkidle', timeout: 20_000 });
  receipt.versionedPlayerScript = await page.locator('script[src^="/media-demo.mjs"]').getAttribute('src') === '/media-demo.mjs?v=20261024-dejavu';
  assert(receipt.versionedPlayerScript);
  await page.selectOption('#demo-ingest', options.clip);
  await page.click('#demo-start');
  await page.waitForFunction(mode => {
    const video = document.getElementById('media-video');
    return (mode !== 'relay' || Number(document.getElementById('demo-fragments').textContent) > 0 &&
      document.getElementById('demo-transport').textContent === 'Spry TURN') &&
      video.readyState >= 2 && video.currentTime > 0 && !video.paused &&
      (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0;
  }, options.mode, { timeout: 30_000 });
  receipt.playback = await playbackState(page);
  assert.equal(receipt.playback.muted, false);
  assert(receipt.playback.volume > 0 && !receipt.playback.paused);
  if (receipt.playback.audioDecodedBytes !== null) assert(receipt.playback.audioDecodedBytes > 0);
  assert(receipt.playback.hiddenPlayersObserved > 0 && receipt.playback.hiddenPlayersMuted);
  if (options.mode === 'relay') {
    assert(receipt.playback.selectedPairs.length >= 2);
    assert(receipt.playback.selectedPairs.every(pair => pair.localType === 'relay' && pair.remoteType === 'relay' && pair.relayProtocol === options.transport));
  } else {
    receipt.scope = 'actual-public-mode-playback-and-cleanup; peer-transfer-not-required';
    assert(receipt.playback.selectedPairs.every(pair => pair.localType !== 'relay' && pair.remoteType !== 'relay'));
  }

  const beforeFullscreen = await page.evaluate(() => ({ time: document.getElementById('media-video').currentTime,
    src: document.getElementById('media-video').getAttribute('src'), peers: window.__acceptancePeers.length,
    volume: document.getElementById('media-video').volume }));
  await page.click('#demo-fullscreen');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'media-video-wrap', undefined, { timeout: 5000 });
  assert.equal(await page.locator('#demo-fullscreen').innerText(), 'Back to stats');
  await page.waitForFunction(before => document.getElementById('media-video').currentTime > before + 0.15,
    beforeFullscreen.time, { timeout: 5000 });
  await page.click('#demo-fullscreen');
  await page.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 5000 });
  receipt.fullscreenReturn = await page.evaluate(() => ({ time: document.getElementById('media-video').currentTime,
    src: document.getElementById('media-video').getAttribute('src'), peers: window.__acceptancePeers.length,
    paused: document.getElementById('media-video').paused, muted: document.getElementById('media-video').muted,
    volume: document.getElementById('media-video').volume, focus: document.activeElement.id }));
  assert.equal(receipt.fullscreenReturn.src, beforeFullscreen.src);
  assert.equal(receipt.fullscreenReturn.peers, beforeFullscreen.peers);
  assert.equal(receipt.fullscreenReturn.volume, beforeFullscreen.volume);
  assert(receipt.fullscreenReturn.time >= beforeFullscreen.time && !receipt.fullscreenReturn.paused && !receipt.fullscreenReturn.muted);
  assert.equal(receipt.fullscreenReturn.focus, 'demo-fullscreen');

  const previousConnections = await page.evaluate(() => window.__acceptancePeers.length);
  await page.evaluate(() => {
    const video = document.getElementById('media-video');
    video.muted = true;
    video.volume = 0.37;
  });
  await page.click('#demo-start');
  await page.waitForFunction(({ mode, previousConnections }) => {
    const video = document.getElementById('media-video');
    return window.__acceptancePeers.length > previousConnections &&
      window.__acceptancePeers.slice(0, previousConnections).every(peer => peer.connectionState === 'closed') &&
      (mode !== 'relay' || Number(document.getElementById('demo-fragments').textContent) > 0 &&
        document.getElementById('demo-transport').textContent === 'Spry TURN') &&
      video.readyState >= 2 && video.currentTime > 0 && !video.paused &&
      (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0;
  }, { mode: options.mode, previousConnections }, { timeout: 30_000 });
  receipt.replay = await playbackState(page);
  assert.equal(receipt.replay.muted, true);
  assert.equal(receipt.replay.volume, 0.37);
  assert(receipt.replay.hiddenPlayersObserved >= 2 && receipt.replay.hiddenPlayersMuted);
  if (options.mode === 'relay') {
    assert(receipt.replay.selectedPairs.length >= 2);
    assert(receipt.replay.selectedPairs.every(pair => pair.localType === 'relay' && pair.remoteType === 'relay' && pair.relayProtocol === options.transport));
  }
  await page.click('#demo-stop');
  await page.waitForFunction(() => window.__acceptancePeers.every(peer => peer.connectionState === 'closed'), undefined, { timeout: 5000 });
  receipt.stopped = await page.evaluate(() => ({ peers: Number(document.getElementById('demo-peers').textContent),
    path: document.getElementById('demo-transport').textContent,
    activeConnections: window.__acceptancePeers.filter(peer => peer.connectionState !== 'closed').length,
    videoPaused: document.getElementById('media-video').paused,
    videoSourceRemoved: !document.getElementById('media-video').getAttribute('src') }));
  assert.equal(receipt.stopped.peers, 0);
  assert.equal(receipt.stopped.activeConnections, 0);
  assert.equal(receipt.stopped.path, 'Stopped');
  assert(receipt.stopped.videoPaused && receipt.stopped.videoSourceRemoved);
  assert.equal(receipt.pageErrors, 0);
  assert.equal(receipt.externalRequests, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failureType = error.name;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await operator?.stop();
  process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
  receipt.localProcessesStopped = true;
  if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n'); }
}
console.log(JSON.stringify(receipt, null, 2));
