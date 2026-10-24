#!/usr/bin/env node
// Actual hls.js/RelaySwarm/native WebRTC playback, fallback and resource cleanup.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = resolve(root, 'site');
const sha = value => createHash('sha256').update(value).digest('hex');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.ts': 'video/mp2t' };

export async function checkPeerDemo({ clip = 'rtmp', runtimeUrl, output, signal } = {}) {
  if (!['rtmp', 'srt'].includes(clip)) throw new Error('Choose the RTMP or SRT generated clip.');
  let runtime;
  if (runtimeUrl) {
    const url = new URL(runtimeUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.hash || url.search || url.pathname !== '/media/demo/runtime.json') {
      throw new Error('Use the loopback demo operator runtime endpoint.');
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error('The local operator runtime is unavailable.');
    runtime = await response.json();
  }
  const manifestBytes = await readFile(resolve(site, `media/demo/${clip}/segments.json`));
  const catalogueBytes = await readFile(resolve(site, 'media/demo/manifest.json'));
  const library = JSON.parse(await readFile(resolve(site, 'vendor/media-peer-demo.build.json'), 'utf8'));
  const scaffold = `<!doctype html><meta charset="utf-8"><video muted controls playsinline></video>
<script type="module">import Hls from '/vendor/hls.light.min.mjs';
import {startPeerDemo} from '/media-peer-demo.mjs';
window.startFixture=async(config)=>{const manifest=await fetch('/media/demo/'+config.clip+'/segments.json').then(r=>r.json());
window.fixtureHistory=[];
window.fixture=await startPeerDemo({Hls,video:document.querySelector('video'),playlistUrl:location.origin+'/media/demo/'+config.clip+'/index.m3u8',manifest,runtime:config.runtime,
onStats:value=>{window.fixtureHistory.push(value);if(window.fixtureHistory.length>120)window.fixtureHistory.shift();}});};</script>`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(scaffold);
      const path = resolve(site, '.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(site + sep)) return res.writeHead(403).end();
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  let browser, page;
  const localCancellation = signal ? null : new AbortController();
  const cancellation = signal ?? localCancellation.signal;
  const interrupt = () => localCancellation?.abort();
  const closeBrowser = () => { void browser?.close().catch(() => {}); };
  if (localCancellation) { process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); }
  cancellation.addEventListener('abort', closeBrowser, { once: true });
  const receipt = { schema: 1, scope: 'same-page-relayswarm-with-sapflow-packaged-replay', passed: false, clip,
    fixture: JSON.parse(catalogueBytes).source?.provider ?? 'generated fixture',
    mediaManifestSha256: sha(manifestBytes), catalogueSha256: sha(catalogueBytes),
    relayswarmSourceCommit: library.sourceCommit, relayswarmBundleSha256: library.bundleSha256,
    requestedPeerTransport: runtime?.transport ?? 'host-direct',
    limits: 'Finite Sapflow-packaged replay, two logical viewers in one browser page and in-page Nostr signalling. Not live capture, an internet Nostr service, WAN/NAT acceptance or native phone qualification.' };
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    cancellation.throwIfAborted();
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
    cancellation.throwIfAborted();
    const context = await browser.newContext();
    let externalHttpRequests = 0, pageErrors = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { externalHttpRequests++; return route.abort(); }
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', () => { pageErrors++; });
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.startFixture === 'function', null, { timeout: 10_000 });
    await page.evaluate(config => window.startFixture(config), { clip, runtime });
    await page.waitForFunction(protocol => {
      const value = window.fixture.metrics();
      return value.viewer.verifiedPeerSegments > 0 && value.viewer.peerBytes > 0 &&
        value.playback.currentTime > 0 && value.playback.decodedFrames > 0 && value.viewer.connectedPeers === 1 &&
        value.transport.selectedPairs.length >= 2 && (!protocol || value.transport.selectedPairs.every(pair =>
          pair.localType === 'relay' && pair.remoteType === 'relay' && pair.relayProtocol === protocol));
    }, runtime?.transport ?? null, { timeout: 25_000 });
    receipt.peer = await page.evaluate(() => window.fixture.metrics());
    assert(receipt.peer.transport.selectedPairs.length > 0, 'Native candidate-pair evidence is missing.');
    if (runtime) assert(receipt.peer.transport.selectedPairs.every(pair => pair.localType === 'relay' && pair.remoteType === 'relay' && pair.relayProtocol === runtime.transport),
      'Native candidate pair did not use the requested operator relay transport.');
    const before = receipt.peer.viewer.originFallbacks;
    const time = receipt.peer.playback.currentTime;
    receipt.disconnectStarted = await page.evaluate(() => { window.fixture.disconnectPeer(); return window.fixture.metrics(); });
    const originBytes = receipt.disconnectStarted.viewer.originBytes;
    await page.waitForFunction(({ before, time, originBytes }) => {
      const value = window.fixture.metrics();
      return value.phase === 'origin-fallback' && value.viewer.originFallbacks > before && value.viewer.originBytes > originBytes &&
        value.viewer.connectedPeers === 0 && value.playback.currentTime > time + 0.2;
    }, { before, time, originBytes }, { timeout: 10_000 });
    receipt.afterDisconnect = await page.evaluate(() => window.fixture.metrics());
    // A complete payload already in flight can finish signature/hash validation
    // after the holder closes. Retain that real accounting rather than zeroing it.
    receipt.completedInflightPeerBytes = receipt.afterDisconnect.viewer.peerBytes - receipt.disconnectStarted.viewer.peerBytes;
    assert(receipt.completedInflightPeerBytes >= 0, 'Cumulative verified peer-byte accounting moved backwards.');
    await page.evaluate(() => window.fixture.stop());
    receipt.stopped = await page.evaluate(() => window.fixture.metrics());
    assert(receipt.stopped.phase === 'stopped' && receipt.stopped.resources.activePeerConnections === 0 &&
      receipt.stopped.resources.signallingConnections === 0 && receipt.stopped.resources.heldBytes === 0, 'Peer resources remained after stop.');
    assert(externalHttpRequests === 0 && pageErrors === 0, 'The browser attempted an external HTTP request or raised an uncaught error.');
    receipt.externalHttpRequests = externalHttpRequests;
    receipt.pageErrors = pageErrors;
    receipt.passed = true;
  } catch (failure) {
    receipt.failure = { type: failure.name ?? 'Error' };
    try { receipt.failure.history = await page?.evaluate(() => window.fixtureHistory ?? []); } catch {}
    throw failure;
  } finally {
    try { await browser?.close(); } finally {
      cancellation.removeEventListener('abort', closeBrowser);
      if (localCancellation) { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
      receipt.ownedProcessesStopped = true;
      if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); }
    }
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!value || !['--clip', '--runtime-url', '--output'].includes(name)) throw new Error('Use --clip, --runtime-url or --output.');
    options[name === '--runtime-url' ? 'runtimeUrl' : name.slice(2)] = value;
  }
  const receipt = await checkPeerDemo(options);
  console.log(JSON.stringify(receipt, null, 2));
}
