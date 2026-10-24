// Manual native TURN/RelaySwarm rolling-cache check using the short shipped
// film. This qualifies the integration, not the separate full-length 4K run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright';
import { startLabTurnOperator } from '../scripts/media-lab-turn.mjs';

const options = { engine: 'spry', transport: 'udp' };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1];
  if (!['--engine', '--transport', '--spry', '--coturn', '--output'].includes(flag) || !value) throw new Error('Use --engine spry|coturn, --transport udp|tcp, --spry PATH, --coturn PATH and --output PATH.');
  options[flag.slice(2)] = value;
}
assert(['spry', 'coturn'].includes(options.engine) && ['udp', 'tcp'].includes(options.transport));
const site = resolve(fileURLToPath(new URL('../site/', import.meta.url))), prefix = '/media/lab/hls/0123456789abcdef/';
const metadata = new Map();
const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4' };
const scaffold = `<!doctype html><video id="video" controls playsinline></video><button id="start">Play with sound</button>
<script type="module">import Hls from '/vendor/hls.light.min.mjs';import {startLabPeer} from '/media-lab-peer.mjs';
document.getElementById('start').onclick=async()=>{try{window.fixture=await startLabPeer({Hls,video:document.getElementById('video'),playlistUrl:location.origin+'${prefix}index.m3u8',runtime:window.runtime,onStats:value=>{window.latest=value;}});}catch(error){window.failureType=error.name;}};</script>`;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('cache-control', 'no-store');
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(scaffold);
    if (url.pathname === '/lab/hash') {
      const value = metadata.get(url.searchParams.get('path'));
      return response.writeHead(value ? 200 : 404, { 'content-type': 'application/json' }).end(value ? JSON.stringify(value) : '{}');
    }
    const relative = url.pathname.startsWith(prefix) ? '/media/demo/rtmp/' + url.pathname.slice(prefix.length) : url.pathname;
    const target = resolve(site, '.' + relative);
    if (!target.startsWith(site + sep) || !/^[a-z0-9_./-]+$/i.test(relative)) return response.writeHead(403).end();
    response.setHeader('content-type', types[extname(target)] || 'application/octet-stream');
    const hash = createHash('sha256'); let size = 0;
    const observer = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
    await pipeline(createReadStream(target), observer, response);
    if (url.pathname.startsWith(prefix) && extname(target) === '.mp4') metadata.set(url.pathname, { sha256: hash.digest('hex'), size });
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
const receipt = { schema: 1, scope: 'short-film rolling-cache integration; not full-length 4K qualification',
  engine: options.engine, transport: options.transport, autoplayPolicyOverride: false, passed: false, pageErrors: 0, externalRequests: 0 };
let operator, browser, page;
const cancellation = new AbortController();
const cancelled = () => { process.exitCode = 130; cancellation.abort(); void browser?.close().catch(() => {}); };
process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled);
try {
  receipt.binarySha256 = createHash('sha256').update(await readFile(resolve(options[options.engine]))).digest('hex');
  receipt.sources = await Promise.all(['site/media-lab-peer.mjs', 'scripts/media-lab-turn.mjs', 'site/vendor/media-peer-demo.js'].map(async path => ({
    path, sha256: createHash('sha256').update(await readFile(new URL('../' + path, import.meta.url))).digest('hex'),
  })));
  operator = await startLabTurnOperator({ ...options, signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  cancellation.signal.throwIfAborted();
  page = await browser.newPage();
  page.on('pageerror', () => { receipt.pageErrors++; });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { receipt.externalRequests++; return route.abort(); }
    return route.continue();
  });
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 10_000 });
  await page.waitForFunction(() => typeof document.getElementById('start').onclick === 'function', undefined, { timeout: 5000 });
  await page.evaluate(runtime => { window.runtime = runtime; }, operator.runtime);
  await page.click('#start');
  await page.waitForFunction(() => window.fixture?.metrics().viewer.verifiedPeerSegments >= 2 &&
    window.fixture.metrics().playback.decodedFrames > 0 && window.fixture.metrics().playback.currentTime > 0 &&
    window.fixture.metrics().transport.selectedPairs.length >= 2, undefined, { timeout: 25_000 });
  const state = await page.evaluate(() => ({ ...window.fixture.metrics(), muted: document.getElementById('video').muted }));
  receipt.peer = { verifiedSegments: state.viewer.verifiedPeerSegments, verifiedBytes: state.viewer.peerBytes,
    originBytes: state.viewer.originBytes, integrityRejected: state.viewer.integrityRejected,
    decodedFrames: state.playback.decodedFrames, currentTime: state.playback.currentTime, muted: state.muted,
    selectedPairs: state.transport.selectedPairs, heldHighWaterBytes: state.resources.heldHighWaterBytes, cacheLimitBytes: state.limits.maxHeldBytes };
  assert.equal(state.muted, false); assert.equal(state.viewer.integrityRejected, 0);
  assert(state.resources.heldHighWaterBytes <= state.limits.maxHeldBytes);
  assert(state.transport.selectedPairs.every(pair => pair.localType === 'relay' && pair.remoteType === 'relay' && pair.relayProtocol === options.transport));
  const before = await page.evaluate(() => { window.fixture.disconnectPeer(); return window.fixture.metrics(); });
  await page.waitForFunction(before => {
    const value = window.fixture.metrics();
    return value.phase === 'origin-fallback' && value.viewer.connectedPeers === 0 && value.viewer.originBytes > before.viewer.originBytes &&
      value.playback.currentTime > before.playback.currentTime + 0.2;
  }, before, { timeout: 12_000 });
  const fallback = await page.evaluate(() => window.fixture.metrics());
  receipt.fallback = { phase: fallback.phase, connectedPeers: fallback.viewer.connectedPeers,
    originBytes: fallback.viewer.originBytes, currentTime: fallback.playback.currentTime };
  await page.evaluate(() => window.fixture.stop());
  const stopped = await page.evaluate(() => window.fixture.metrics());
  receipt.stopped = { phase: stopped.phase, ...stopped.resources };
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.resources.activePeerConnections, 0);
  assert.equal(stopped.resources.signallingConnections, 0); assert.equal(stopped.resources.heldBytes, 0);
  assert.equal(receipt.pageErrors, 0); assert.equal(receipt.externalRequests, 0);
  receipt.passed = true;
} catch (error) {
  receipt.failureType = error.name; process.exitCode = 1;
  try {
    receipt.failureState = await page?.evaluate(() => {
      const value = window.fixture?.metrics() ?? window.latest;
      return { failureType: window.failureType, phase: value?.phase, viewer: value?.viewer, playback: value?.playback,
        transport: value?.transport, resources: value?.resources,
        diagnostics: { peerMisses: value?.diagnostics?.peerMisses, commitmentRejected: value?.diagnostics?.commitmentRejected,
          commitmentUnavailable: value?.diagnostics?.commitmentUnavailable, eligibility: value?.diagnostics?.eligibility } };
    });
  } catch {}
} finally {
  try { await browser?.close(); } finally {
    try { await operator?.stop(); } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
      receipt.ownedProcessesStopped = true;
      if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n'); }
    }
  }
}
console.log(JSON.stringify(receipt, null, 2));
