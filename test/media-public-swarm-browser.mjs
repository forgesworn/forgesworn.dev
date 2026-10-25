#!/usr/bin/env node
// Manual acceptance: two independent browser contexts, one visible video each.
// Default uses a bounded Nostr wire fixture; --public-relays uses actual WSS.
// Native WebRTC and media decoding are never replaced or simulated.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { verifyEvent, matchFilter } from '../site/vendor/media-peer-demo.js';

const args = process.argv.slice(2);
const publicRelays = args.includes('--public-relays');
const qualityIndex = args.indexOf('--quality');
const quality = qualityIndex >= 0 ? args[qualityIndex + 1] : 'preview';
if (!['full', 'preview'].includes(quality)) throw new Error('Use --quality full|preview.');
const playlist = quality === 'full' ? '/media/dejavu-4k/index.m3u8' : '/media/dejavu-preview/rtmp/index.m3u8';
const outputIndex = args.indexOf('--output');
const output = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : null;
const site = fileURLToPath(new URL('../site', import.meta.url));
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.wasm': 'application/wasm' };
const receipt = { schema: 1, recordedAt: new Date().toISOString(), scenario: 'two-independent-browser-contexts-one-visible-player-each',
  quality, siteAssets: quality === 'full' ? 'candidate local files routed at production site origin for the media host CORS policy' : 'candidate loopback HTTP files',
  signalling: publicRelays ? 'actual public Nostr WSS relays' : 'bounded in-process Nostr wire fixture via Playwright WebSocket routing',
  nativeWebRtc: true, nativeMediaDecoding: true, hiddenHolders: 0, passed: false, errors: [], socketObservations: [] };
const wire = { published: 0, delivered: 0, rejected: 0 };
const clients = new Set(), presence = new Map();
const html = `<!doctype html><meta charset="utf-8"><title>Public swarm acceptance fixture</title><button id="play">Play &amp; join</button><video id="video" controls playsinline style="width:960px;max-width:100%"></video><script type="module">
import Hls from '/vendor/hls.light.min.mjs';
import {createPublicSwarm} from '/media-public-swarm.mjs';
const video=document.querySelector('video');
const hls=new Hls({enableWorker:false,maxBufferLength:${quality === 'full' ? 10 : 8},maxMaxBufferLength:${quality === 'full' ? 14 : 10},maxBufferSize:${quality === 'full' ? 32 : 8}*1024*1024,backBufferLength:0});
window.hls=hls;window.video=video;window.metrics=[];window.codedFrame=null;window.audioRmsPeak=0;
const frame=(_time,metadata)=>{window.codedFrame={width:metadata.width,height:metadata.height};video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
let audioContext,analyser,audioTimer;
function sampleAudio(){const pcm=new Float32Array(2048);analyser.getFloatTimeDomainData(pcm);const rms=Math.sqrt(pcm.reduce((sum,x)=>sum+x*x,0)/pcm.length);window.audioRmsPeak=Math.max(window.audioRmsPeak,rms);}
window.publicSwarm=createPublicSwarm({Hls,hls,video,playlistUrl:${JSON.stringify(playlist)},quality:${JSON.stringify(quality)},onStats:m=>{window.latest=m;window.metrics.push(m);if(window.metrics.length>100)window.metrics.shift();}});
window.initial=publicSwarm.metrics();
document.querySelector('button').addEventListener('click',async()=>{try{audioContext=new AudioContext();analyser=audioContext.createAnalyser();analyser.fftSize=2048;audioContext.createMediaElementSource(video).connect(analyser);analyser.connect(audioContext.destination);await audioContext.resume();audioTimer=setInterval(sampleAudio,100);await publicSwarm.setEnabled(true);hls.loadSource(${JSON.stringify(playlist)});hls.attachMedia(video);await video.play();}catch(e){window.fixtureError=String(e);}});
window.cleanupFixture=async()=>{publicSwarm.stop();clearInterval(audioTimer);hls.destroy();video.pause();video.removeAttribute('src');video.load();await audioContext?.close();};
window.ready=true;
</script>`;
let browser;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/public-swarm-acceptance') { response.writeHead(200, { 'content-type': 'text/html' }).end(html); return; }
    const file = resolve(site, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(site + sep) || !(await stat(file)).isFile()) throw new Error('Not found');
    const bytes = await readFile(file);
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range), start = Number(match?.[1]), end = Number(match?.[2]);
      if (!match || start > end || end >= bytes.length) { response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end(); return; }
      response.writeHead(206, { 'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'accept-ranges': 'bytes' }).end(bytes.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});

const deliver = (client, frame) => { try { client.route.send(JSON.stringify(frame)); wire.delivered++; } catch {} };
const matching = (event, filter) => { try { return matchFilter(filter, event); } catch { return false; } };
function fixtureRoute(route) {
  const client = { route, subscriptions: new Map() };
  clients.add(client);
  route.onClose(() => { clients.delete(client); });
  route.onMessage(raw => {
    let frame;
    try { if (typeof raw !== 'string' || raw.length > 128 * 1024) throw new Error(); frame = JSON.parse(raw); } catch { wire.rejected++; return; }
    const [operation, id, filter] = frame;
    if (operation === 'CLOSE') { client.subscriptions.delete(id); return; }
    if (operation === 'REQ') {
      if (typeof id !== 'string' || client.subscriptions.size >= 8 || !filter || Array.isArray(filter)) { wire.rejected++; return; }
      client.subscriptions.set(id, filter);
      for (const event of presence.values()) if (matching(event, filter)) deliver(client, ['EVENT', id, event]);
      deliver(client, ['EOSE', id]);
      return;
    }
    const event = id;
    let valid = false;
    try { valid = operation === 'EVENT' && [24170, 24171].includes(event?.kind) && verifyEvent(event); } catch {}
    if (!valid) { wire.rejected++; return; }
    wire.published++;
    if (event.kind === 24170) { presence.set(event.pubkey, event); if (presence.size > 8) presence.delete(presence.keys().next().value); }
    deliver(client, ['OK', event.id, true, '']);
    for (const target of clients) for (const [subscription, requested] of target.subscriptions) {
      if (matching(event, requested)) deliver(target, ['EVENT', subscription, event]);
    }
  });
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const loopback = `http://127.0.0.1:${server.address().port}`;
  const url = `${quality === 'full' ? 'https://forgesworn.dev' : loopback}/public-swarm-acceptance`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    if (quality === 'full') await context.route('https://forgesworn.dev/**', async route => {
      const incoming = new URL(route.request().url());
      const response = await fetch(loopback + incoming.pathname + incoming.search);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    if (!publicRelays) await context.routeWebSocket(/^wss:\/\/(?:relay\.damus\.io|nos\.lol|relay\.primal\.net)\/?$/, fixtureRoute);
    const page = await context.newPage();
    page.on('pageerror', error => receipt.errors.push(String(error)));
    page.on('websocket', socket => {
      const observation = { browser: i, url: socket.url(), sent: 0, received: 0, errors: 0 };
      receipt.socketObservations.push(observation);
      socket.on('framesent', () => observation.sent++); socket.on('framereceived', () => observation.received++); socket.on('socketerror', () => observation.errors++);
    });
    await page.goto(url);
    await page.waitForFunction(() => window.ready === true);
    const initial = await page.evaluate(() => window.initial);
    assert.equal(initial.enabled, false); assert.equal(initial.resources.signallingConnections, 0); assert.equal(initial.resources.activePeerConnections, 0);
    pages.push(page);
  }
  receipt.beforeGestureNoSockets = receipt.socketObservations.length === 0;
  assert.equal(receipt.beforeGestureNoSockets, true);
  await pages[0].click('#play');
  await pages[0].waitForFunction(() => video.currentTime > 3 && latest.resources.heldBytes > 0, { timeout: 20000 });
  await pages[1].click('#play');
  const deadline = Date.now() + (publicRelays ? 60000 : 35000);
  let snapshots;
  while (Date.now() < deadline) {
    snapshots = await Promise.all(pages.map(page => page.evaluate(() => ({ ...publicSwarm.metrics(), currentTime: video.currentTime,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, naturalWidth: video.videoWidth, naturalHeight: video.videoHeight,
      codedFrame: window.codedFrame, audioRmsPeak: window.audioRmsPeak, muted: video.muted, volume: video.volume,
      videoElements: document.querySelectorAll('video').length,
      visibleVideoElements: [...document.querySelectorAll('video')].filter(v=>!v.hidden).length, fixtureError: window.fixtureError ?? null }))));
    assert(snapshots.every(m => !['failed', 'stopped'].includes(m.core?.transferWorker?.state)), 'The packaged module worker failed during playback.');
    if (snapshots.some(m => m.verifiedPeerSegments > 0) && snapshots.some(m => m.uploadedBytes > 0) && snapshots.every(m => m.decodedFrames > 10) &&
      snapshots.some(m => m.peerBytes > 0 && m.topology.connections.reduce((sum, p) => sum + (p.bytesReceived ?? 0), 0) >= m.peerBytes)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  receipt.players = snapshots;
  assert.ok(snapshots.every(m => m.core?.transferWorker?.state === 'ready'), 'Each player must start its real packaged module worker.');
  assert.ok(snapshots.every(m => m.fixtureError === null && m.decodedFrames > 10 && m.videoElements === 1 && m.visibleVideoElements === 1));
  assert.ok(snapshots.every(m => m.audioRmsPeak > 0.00001 && m.muted === false && m.volume > 0), 'Decoded audible audio was not observed in both visible players.');
  if (quality === 'full') assert.ok(snapshots.every(m => m.codedFrame?.width === 3840 && m.codedFrame?.height === 2160), 'Both visible players must decode actual 3840x2160 media pixels.');
  assert.ok(snapshots.some(m => m.verifiedPeerSegments > 0 && m.peerBytes > 0), 'No independently verified peer media reached a visible player.');
  assert.ok(snapshots.some(m => m.uploadedBytes > 0), 'No real visitor uploaded media.');
  assert.ok(snapshots.some(m => m.topology.connections.some(p => p.bytesSent > 0 || p.bytesReceived > 0)), 'No actual RTC connection traffic observed.');
  assert.ok(snapshots.every(m => m.integrityRejected === 0));
  const before = await pages[1].evaluate(() => { video.volume = 0.37; return { time: video.currentTime, source: video.src }; });
  await pages[1].evaluate(() => publicSwarm.setEnabled(false));
  await pages[1].waitForTimeout(1200);
  receipt.afterOff = await pages[1].evaluate(() => ({ ...publicSwarm.metrics(), currentTime: video.currentTime, source: video.src, volume: video.volume, paused: video.paused }));
  assert.equal(receipt.afterOff.resources.activePeerConnections, 0); assert.equal(receipt.afterOff.resources.signallingConnections, 0); assert.equal(receipt.afterOff.resources.heldBytes, 0);
  assert.equal(receipt.afterOff.source, before.source); assert.equal(receipt.afterOff.volume, 0.37); assert.ok(receipt.afterOff.currentTime > before.time); assert.equal(receipt.afterOff.paused, false);
  receipt.afterRapidResume = await pages[0].evaluate(async () => {
    const before = publicSwarm.metrics();
    const stopped = publicSwarm.setEnabled(false);
    const resume = publicSwarm.setEnabled(true);
    const off = publicSwarm.setEnabled(false);
    const resumed = publicSwarm.setEnabled(true);
    await Promise.allSettled([stopped, resume, off, resumed]);
    return { beforeUploaded: before.acceptedUploadBytes, ...publicSwarm.metrics(), source: video.src, currentTime: video.currentTime };
  });
  assert.equal(receipt.afterRapidResume.enabled, true);
  assert.equal(receipt.afterRapidResume.uploadAllowanceRemaining, null, 'active sharing has no cumulative upload cutoff');
  assert.ok(receipt.afterRapidResume.acceptedUploadBytes >= receipt.afterRapidResume.beforeUploaded, 'Pause/resume lost cumulative upload accounting.');
  await Promise.all(pages.map(page => page.evaluate(() => publicSwarm.stop())));
  receipt.stopped = await Promise.all(pages.map(page => page.evaluate(() => publicSwarm.metrics())));
  assert.ok(receipt.stopped.every(m => m.resources.activePeerConnections === 0 && m.resources.signallingConnections === 0 && m.resources.heldBytes === 0));
  await Promise.all(pages.map(page => page.evaluate(() => window.cleanupFixture())));
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  clients.clear(); presence.clear();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  receipt.fixture = publicRelays ? null : wire;
  receipt.cleanup = { browserClosed: true, serverClosed: !server.listening, fixtureClients: clients.size };
  if (output) await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
