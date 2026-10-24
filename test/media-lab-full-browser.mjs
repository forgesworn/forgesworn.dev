// Manual production-page acceptance and sequential native relay measurements.
// Paths and credentials stay local; JSON output contains scalar observations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus, freemem, totalmem, loadavg } from 'node:os';
import { chromium } from 'playwright';
import { startMediaLab } from '../scripts/media-lab-server.mjs';

const options = { engine: 'sapflow', transport: 'rtmp', relays: 'spry,coturn', turnTransport: 'udp', duration: 'full' };
const flags = { '--input': 'input', '--sapflow': 'sapflow', '--mediamtx': 'mediamtx', '--spry': 'spry', '--coturn': 'coturn',
  '--engine': 'engine', '--transport': 'transport', '--relays': 'relays', '--turn-transport': 'turnTransport', '--duration': 'duration', '--output': 'output' };
for (let index = 2; index < process.argv.length; index += 2) {
  if (!flags[process.argv[index]] || !process.argv[index + 1]) throw new Error('Supply local input/executable paths, engine, transport, relays, turn-transport, duration and output.');
  options[flags[process.argv[index]]] = process.argv[index + 1];
}
assert(['sapflow', 'sapflow-own', 'mediamtx'].includes(options.engine));
assert(['rtmp', 'srt'].includes(options.transport) && ['udp', 'tcp'].includes(options.turnTransport));
assert(['full', '30', '60'].includes(options.duration));
const relays = options.relays.split(',');
assert(relays.length > 0 && relays.length <= 2 && new Set(relays).size === relays.length && relays.every(value => ['spry', 'coturn'].includes(value)));
const receipt = { schema: 1, scope: 'actual production lab page; sequential native same-host relay runs',
  completionBoundary: 'The complete selected source window was ingested. Actual decoded frames and video time are recorded separately; every frame is not asserted.',
  performanceBoundary: 'Functional acceptance on a shared host. Timing and CPU observations do not establish a controlled performance winner.',
  autoplayPolicyOverride: false, audioOutputSuppressed: false, passed: false, pageErrors: 0, externalRequests: 0, checks: [] };
let lab, browser, page, config, lastStats;
const cancellation = new AbortController();
const snapshots = [];
receipt.hostObservations = [];
function observeHost(stage) {
  const value = { stage, at: new Date().toISOString(), loadAverage: loadavg(), logicalCpus: cpus().length,
    freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() };
  if (receipt.hostObservations.length < 128) receipt.hostObservations.push(value);
  return value;
}
const cancelled = () => { process.exitCode = 130; cancellation.abort(); void browser?.close().catch(() => {}); void lab?.stop().catch(() => {}); };
process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);

async function nativeState() {
  return page.evaluate(async () => {
    const video = document.getElementById('lab-video'), pairs = [];
    for (const peer of window.__labAcceptancePeers) {
      if (peer.connectionState === 'closed') continue;
      let reports;
      try { reports = [...(await peer.getStats()).values()]; }
      catch { continue; } // The page may close this connection during a final poll.
      const pair = reports.find(value => value.type === 'candidate-pair' && value.state === 'succeeded' && (value.nominated || value.selected));
      if (!pair) continue;
      const local = reports.find(value => value.id === pair.localCandidateId), remote = reports.find(value => value.id === pair.remoteCandidateId);
      pairs.push({ localType: local?.candidateType, remoteType: remote?.candidateType, relayProtocol: local?.relayProtocol });
    }
    const holders = window.__labAcceptanceVideos.filter(value => value !== video && value.hidden);
    return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime,
      decodedFrameWidth: window.__labAcceptanceFrame?.width ?? null,
      decodedFrameHeight: window.__labAcceptanceFrame?.height ?? null,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, audioDecodedBytes: video.webkitAudioDecodedByteCount ?? null,
      muted: video.muted, volume: video.volume, paused: video.paused, selectedPairs: pairs,
      activePeerConnections: window.__labAcceptancePeers.filter(value => value.connectionState !== 'closed').length,
      hiddenPlayersObserved: holders.length, hiddenPlayersMuted: holders.every(value => value.muted),
      relaySummary: document.getElementById('relay-summary').textContent,
      fpsDisplay: document.getElementById('browser-fps').textContent,
      dimensionsDisplay: document.getElementById('browser-dimensions').textContent,
      relayCpuDisplay: document.getElementById('process-relay-cpu').textContent,
      relayMemoryDisplay: document.getElementById('process-relay-rss').textContent };
  });
}

async function fullscreenCheck(relay) {
  const before = await page.evaluate(() => {
    const video = document.getElementById('lab-video'); window.__labAcceptanceVisible = video;
    return { currentTime: video.currentTime, volume: video.volume, muted: video.muted, relay: document.getElementById('lab-relay').value };
  });
  await page.click('#lab-fullscreen');
  await page.waitForFunction(() => Boolean(document.fullscreenElement), undefined, { timeout: 5000 });
  await page.waitForFunction(time => document.getElementById('lab-video').currentTime > time + 0.2, before.currentTime, { timeout: 5000 });
  await page.click('#lab-fullscreen');
  await page.waitForFunction(() => !document.fullscreenElement, undefined, { timeout: 5000 });
  const after = await page.evaluate(() => {
    const video = document.getElementById('lab-video');
    return { sameElement: video === window.__labAcceptanceVisible, currentTime: video.currentTime, volume: video.volume,
      muted: video.muted, paused: video.paused, relay: document.getElementById('lab-relay').value };
  });
  assert(after.sameElement && after.currentTime >= before.currentTime && !after.paused);
  assert.equal(after.volume, before.volume); assert.equal(after.muted, before.muted); assert.equal(after.relay, relay);
  return { enteredAndExited: true, sameElement: after.sameElement, playbackAdvanced: after.currentTime > before.currentTime,
    volumePreserved: after.volume === before.volume, selectionPreserved: after.relay === before.relay };
}

try {
  observeHost('before-source-preflight');
  receipt.sources = await Promise.all(['scripts/media-lab-server.mjs', 'scripts/media-lab-turn.mjs', 'site/media-live-start.mjs', 'site/media-lab-peer.mjs', 'site/media-lab.mjs', 'site/media-lab.html',
    'site/vendor/media-peer-demo.js', 'site/vendor/hls.min.mjs'].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(new URL('../' + path, import.meta.url))).digest('hex') })));
  lab = await startMediaLab({ ...options, signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  const origin = new URL(lab.url).origin;
  config = await fetch(new URL('/lab/config', origin)).then(value => value.json());
  observeHost('after-source-preflight');
  receipt.source = config.source; receipt.host = config.host; receipt.profile = config.profile;
  receipt.identities = { origins: config.engines, relays: config.relays.filter(value => relays.includes(value.id)) };
  assert(config.source.width >= 3840 && config.source.height >= 2160);
  assert(config.source.bytes > 800_000_000);
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  cancellation.signal.throwIfAborted();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  page.on('pageerror', () => { receipt.pageErrors++; });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { receipt.externalRequests++; return route.abort(); }
    return route.continue();
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/lab/stats') void response.json().then(value => {
      lastStats = value;
      if (value.lastRun && !snapshots.some(item => item.run.id === value.lastRun.run.id)) snapshots.push(value.lastRun);
    }).catch(() => {});
  });
  await page.addInitScript(() => {
    window.__labAcceptancePeers = []; window.__labAcceptanceVideos = [];
    window.__labAcceptanceFrame = null;
    document.addEventListener('DOMContentLoaded', () => {
      const video = document.getElementById('lab-video');
      const frame = (_now, metadata) => {
        // Callback dimensions are media pixels; videoWidth also applies SAR.
        window.__labAcceptanceFrame = { width: metadata.width, height: metadata.height };
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
    }, { once: true });
    const NativePeer = RTCPeerConnection, nativePlay = HTMLMediaElement.prototype.play;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) { super(config); window.__labAcceptancePeers.push(this); }
    };
    HTMLMediaElement.prototype.play = function (...args) {
      if (this instanceof HTMLVideoElement && !window.__labAcceptanceVideos.includes(this)) window.__labAcceptanceVideos.push(this);
      return nativePlay.apply(this, args);
    };
  });
  await page.goto(lab.url, { waitUntil: 'networkidle', timeout: 20_000 });
  await page.waitForFunction(() => !document.getElementById('lab-run').disabled, undefined, { timeout: 10_000 });
  for (const relay of relays) {
    cancellation.signal.throwIfAborted();
    await page.selectOption('#lab-engine', options.engine);
    await page.selectOption('#lab-transport', options.transport);
    await page.selectOption('#lab-duration', options.duration);
    await page.selectOption('#lab-relay', relay);
    await page.selectOption('#lab-turn-transport', options.turnTransport);
    const check = { engine: options.engine, ingest: options.transport, relay, clientTransport: options.turnTransport,
      duration: options.duration, completed: false };
    receipt.checks.push(check);
    observeHost(`start-${relay}`);
    await page.evaluate(() => { window.__labAcceptanceFrame = null; });
    await page.click('#lab-run');
    await page.waitForFunction(({ width, height, protocol }) => {
      const video = document.getElementById('lab-video'), summary = document.getElementById('relay-summary').textContent;
      const count = /Verified peer segments: ([\d,]+)/.exec(summary);
      return window.__labAcceptanceFrame?.width === width && window.__labAcceptanceFrame?.height === height && video.currentTime > 0 && !video.paused &&
        video.getVideoPlaybackQuality().totalVideoFrames > 0 && count && Number(count[1].replaceAll(',', '')) > 0 &&
        summary.includes(`relay → relay (${protocol})`) && document.getElementById('browser-fps').textContent !== '—';
    }, { width: config.source.width, height: config.source.height, protocol: options.turnTransport }, { timeout: 45_000 });
    check.firstPlayback = await nativeState();
    assert(!check.firstPlayback.muted && check.firstPlayback.volume > 0 && !check.firstPlayback.paused);
    if (check.firstPlayback.audioDecodedBytes !== null) assert(check.firstPlayback.audioDecodedBytes > 0);
    assert(check.firstPlayback.hiddenPlayersObserved > 0 && check.firstPlayback.hiddenPlayersMuted);
    assert(check.firstPlayback.selectedPairs.length >= 2 && check.firstPlayback.selectedPairs.every(pair =>
      pair.localType === 'relay' && pair.remoteType === 'relay' && pair.relayProtocol === options.turnTransport));
    assert.notEqual(check.firstPlayback.relayMemoryDisplay, '—');
    check.fullscreen = await fullscreenCheck(relay);
    const timeout = (options.duration === 'full' ? Math.min(config.source.durationSeconds, 330) : Number(options.duration)) * 1000 + 45_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const rows = await page.locator('#comparison-runs tr').count();
      const empty = await page.locator('#comparison-runs .empty-cell').count();
      if (!empty && rows >= receipt.checks.length) break;
      await page.waitForTimeout(20_000);
      const state = await nativeState();
      const host = observeHost(`progress-${relay}`);
      console.log(JSON.stringify({ progress: true, relay, currentTime: Math.round(state.currentTime), decodedFrames: state.decodedFrames,
        phase: /Phase: ([a-z-]+)/.exec(state.relaySummary)?.[1] ?? null, relayCpu: state.relayCpuDisplay, relayMemory: state.relayMemoryDisplay,
        loadAverage: host.loadAverage }));
      if (lastStats?.lastRun?.run.turnEngine === relay && lastStats.lastRun.state === 'error') throw new Error('The local source run failed.');
    }
    const rows = await page.locator('#comparison-runs tr').count();
    assert.equal(await page.locator('#comparison-runs .empty-cell').count(), 0);
    assert.equal(rows, receipt.checks.length);
    check.lastPlayback = await nativeState();
    await page.waitForFunction(() => window.__labAcceptancePeers.every(peer => peer.connectionState === 'closed'), undefined, { timeout: 5000 });
    assert.equal((await nativeState()).activePeerConnections, 0);
    const snapshot = snapshots.find(value => value.run.turnEngine === relay);
    assert(snapshot && snapshot.state === 'ended' && snapshot.run.publisherEnded);
    assert.equal(snapshot.run.publisherProgressEnded, true);
    assert.equal(snapshot.run.publisherCompletedWindow, true);
    if (options.duration === 'full') {
      assert(snapshot.run.expectedVideoFrames > 0);
      assert.equal(snapshot.run.publisherVideoFrames, snapshot.run.expectedVideoFrames);
    }
    check.sourceWindow = { durationSeconds: snapshot.run.durationSeconds, publisherEnded: snapshot.run.publisherEnded,
      publisherMediaSeconds: snapshot.run.publisherMediaSeconds, publisherProgressEnded: snapshot.run.publisherProgressEnded,
      publisherVideoFrames: snapshot.run.publisherVideoFrames, expectedVideoFrames: snapshot.run.expectedVideoFrames,
      expectedProgressSeconds: snapshot.run.expectedProgressSeconds, expectedProgressBasis: snapshot.run.expectedProgressBasis,
      publisherCompletedWindow: snapshot.run.publisherCompletedWindow,
      endedReason: snapshot.run.endedReason, origin: snapshot.processes.origin, publisher: snapshot.processes.publisher,
      turn: snapshot.processes.turn, http: snapshot.http };
    check.completed = true;
    observeHost(`ended-${relay}`);
    console.log(JSON.stringify({ completed: true, relay, sourceSeconds: snapshot.run.durationSeconds,
      relayCpuSeconds: snapshot.processes.turn?.cpuSeconds, relayPeakRssBytes: snapshot.processes.turn?.peakSampledRssBytes }));
  }
  const downloading = page.waitForEvent('download'); await page.click('#lab-export');
  const download = await downloading, stream = await download.createReadStream(), chunks = [];
  let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; assert(bytes <= 1024 * 1024); chunks.push(chunk); }
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(exported.runs.length, relays.length);
  for (const run of exported.runs) {
    assert.equal(run.completion, 'source-window-ended');
    assert.equal(run.offsetSeconds, 0); assert.equal(run.source.sha256, config.source.sha256);
    const checked = receipt.checks.find(value => value.relay === run.turnEngine);
    assert.equal(checked.firstPlayback.decodedFrameWidth, config.source.width);
    assert.equal(checked.firstPlayback.decodedFrameHeight, config.source.height);
    assert.equal(run.browser.width, checked.firstPlayback.width); assert.equal(run.browser.height, checked.firstPlayback.height);
    assert(run.peer.verifiedPeerSegments > 0 && run.peer.peerBytes > 0 && run.peer.cachePeakBytes <= 64 * 1024 * 1024);
    assert.equal(run.peer.integrityRejected, 0);
    assert(run.processes.turn.cpuSeconds > 0 && run.processes.turn.peakSampledRssBytes > 0);
  }
  receipt.runs = exported.runs;
  assert.equal(receipt.pageErrors, 0); assert.equal(receipt.externalRequests, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failureType = error.name; process.exitCode = 1;
  try { receipt.failurePlayback = await nativeState(); } catch {}
  receipt.backendFailureCode = lastStats?.error ?? lastStats?.lastRun?.error ?? null;
  const failed = lastStats?.lastRun?.run ?? lastStats?.run;
  if (failed) receipt.failedSourceWindow = { durationSeconds: failed.durationSeconds, publisherEnded: failed.publisherEnded,
    publisherMediaSeconds: failed.publisherMediaSeconds, publisherProgressEnded: failed.publisherProgressEnded,
    publisherVideoFrames: failed.publisherVideoFrames, expectedVideoFrames: failed.expectedVideoFrames,
    expectedProgressSeconds: failed.expectedProgressSeconds, expectedProgressBasis: failed.expectedProgressBasis,
    publisherCompletedWindow: failed.publisherCompletedWindow, endedReason: failed.endedReason };
  observeHost('failure');
} finally {
  try { await browser?.close(); } finally {
    await lab?.stop();
    process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
    receipt.ownedProcessesStopped = true;
    observeHost('after-cleanup');
    const json = JSON.stringify(receipt, null, 2) + '\n';
    assert(!/\/Users\/|turn:127\.|"(?:credential|username|static-auth-secret)"\s*:/.test(json));
    if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, json); }
  }
}
console.log(JSON.stringify(receipt, null, 2));
