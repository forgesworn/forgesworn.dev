// node test/media-native-fallback-browser.mjs [--output RECEIPT.json]
// Real generated landing/controller; explicitly simulated HLS, native media,
// listener presence and peer adapter. No decoding, sockets or speed claim.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const site = fileURLToPath(new URL('../site/', import.meta.url));
const output = process.argv[2] === '--output' && process.argv[3] ? resolve(process.argv[3]) : null;
if (process.argv.length > (output ? 4 : 2)) throw new Error('Use --output RECEIPT.json');
const landing = await readFile(resolve(site, 'index.html'));
assert.match(landing.toString(), /id="public-play"/, 'Build the generated landing page before this focused fixture.');
const receipt = { scope: 'generated-landing-controller-native-fallback-with-explicit-media-and-network-mocks', passed: false,
  decodedMediaClaim: false, realRelayOrPeerTraffic: false, landingSha256: createHash('sha256').update(landing).digest('hex'),
  pageErrors: [], forbiddenRequests: [], simulatedCases: [] };

const hlsModule = `
window.__nativeFixture.hlsImports++;
export default class Hls {
  static Events={MANIFEST_PARSED:'manifest',MEDIA_ATTACHED:'attached',FRAG_LOADED:'fragment',ERROR:'hls-error'};
  static isSupported(){return true;}
  constructor(config){this.config=config;this.handlers=new Map();this.mediaSource={constructor:{name:'MediaSource'}};window.__nativeFixture.hls.push(this);}
  on(name,fn){this.handlers.set(name,fn);} off(name){this.handlers.delete(name);}
  loadSource(url){this.url=url;}
  attachMedia(video){this.video=video;const s=window.__nativeFixture;s.readyState=4;s.time=this.config.startPosition>=0?this.config.startPosition:12.5;
    queueMicrotask(()=>{this.handlers.get(Hls.Events.MEDIA_ATTACHED)?.('attached',{media:video,mediaSource:this.mediaSource});this.handlers.get(Hls.Events.MANIFEST_PARSED)?.('manifest',{});});}
  destroy(){const s=window.__nativeFixture;s.hlsDestroy++;if(s.pendingPlay){s.stalePlayRejected++;s.pendingPlay.reject(new DOMException('Fixture old HLS playback interrupted','AbortError'));s.pendingPlay=null;}this.handlers.clear();}
}
`;
const peerModule = `
export const PUBLIC_SWARM_SOURCE_SHA256='76d90719a756c77d1008088c58ca6b28a74eb0ef01e5337906cfb68d3e2b13aa';
export const PUBLIC_SWARM_RELAYS=['wss://fixture.invalid'];
export function createPublicSwarm({onStats}){
 const s=window.__nativeFixture;s.peerCreated++;let enabled=false,stopped=false;
 const metrics=()=>({enabled,phase:stopped?'stopped':enabled?'peer':'origin',reason:stopped?'stopped':'opted-in',serving:enabled,
  viewerId:'a'.repeat(64),peerBytes:4096,uploadedBytes:8192,acceptedUploadBytes:8192,originBytes:16384,loadedMediaBytes:20480,
  connectedPeers:enabled?1:0,verifiedPeerSegments:1,uploadAllowanceRemaining:null,
  library:{version:'0.4.2',sourceCommit:'2c2708c9e11daf8e85bc059682d3eda09a0c4ffb'},core:{state:'ready'},
  topology:{connections:[]},resources:{activePeerConnections:enabled?1:0,signallingConnections:enabled?3:0,heldBytes:0}});
 const peer={metrics,async setEnabled(value){s.peerEnabled.push(value);if(stopped&&value)throw new Error('Stopped fixture peer was reopened');enabled=value===true;onStats(metrics());return metrics();},
 stop(){s.peerStop++;stopped=true;enabled=false;onStats(metrics());}};
 s.peer=peer;return peer;
}
`;
const listenerModule = `
export function createListenerSession({onChange}){
 const s=window.__nativeFixture;s.listenerCreated++;let joined=false;
 const snapshot=()=>({id:joined?'b'.repeat(64):null,joined,ready:joined,observed:true,status:joined?'active':'observing',
  epochId:'e'.repeat(64),startedAt:Date.now()-12500,position:s.roomPosition,listeners:joined?2:1,role:'joined',connectedRelays:3,members:[]});
 const clock={snapshot,position:()=>s.roomPosition,observe(){s.observe++;onChange(snapshot());return snapshot();},
 async join(){s.join++;joined=true;onChange(snapshot());return snapshot();},
 leave(){s.leave++;joined=false;onChange(snapshot());},stop(){s.listenerStop++;joined=false;onChange(snapshot());}};
 s.listener=clock;return clock;
}
`;
const visualModule = `export function createSwarmVisual(){return {update(){},pulse(){},destroy(){}};}`;
const pulseModule = `export function createMusicPulse(){return {refresh(){},destroy(){}};}`;
const modules = new Map([['/vendor/hls.light.min.mjs', hlsModule], ['/media-public-swarm.mjs', peerModule],
  ['/media-listener-session.mjs', listenerModule], ['/media-swarm-visual.mjs', visualModule], ['/media-music-pulse.mjs', pulseModule]]);
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript', '.js': 'application/javascript',
  '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (/\.(?:m3u8|m4s|mp4|wasm)$/u.test(path)) {
      receipt.forbiddenRequests.push(path); response.writeHead(204); response.end(); return;
    }
    const body = modules.get(path);
    if (body !== undefined) { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(body); return; }
    const target = resolve(site, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
    if (!target.startsWith(resolve(site) + sep)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(path === '/' || path === '/index.html' ? landing : await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
let browser;

function mockMedia() {
  const state = window.__nativeFixture = { hls: [], hlsImports: 0, hlsDestroy: 0, peerCreated: 0, peerStop: 0, peerEnabled: [],
    listenerCreated: 0, observe: 0, join: 0, leave: 0, listenerStop: 0, source: '', nativeAssignments: 0,
    nativeMetadata: 0, nativePlay: 0, stalePlayRejected: 0, deferNextPlay: false, pendingPlay: null,
    readyState: 0, paused: true, ended: false, seeking: false, error: null,
    time: 12.5, roomPosition: 12.5, frames: 0, ranges: [[0, 268.6]], callbacks: new Map(), nextFrame: 0, setters: [] };
  const proto = HTMLMediaElement.prototype;
  for (const [key, getter] of Object.entries({ paused: () => state.paused, ended: () => state.ended, seeking: () => state.seeking,
    readyState: () => state.readyState, error: () => state.error, duration: () => 268.6, currentSrc: () => state.source,
    buffered: () => ({ length: state.ranges.length, start: i => state.ranges[i][0], end: i => state.ranges[i][1] }) })) {
    Object.defineProperty(proto, key, { configurable: true, get: getter });
  }
  Object.defineProperty(proto, 'currentTime', { configurable: true, get: () => state.time, set(value) {
    state.setters.push({ value, at: performance.now() }); state.time = Number(value);
  } });
  Object.defineProperty(proto, 'src', { configurable: true, get: () => state.source, set(value) {
    state.source = new URL(value, location.href).href; state.nativeAssignments++; state.readyState = 1; state.time = 0;
    // Native source replacement owns these transient media events. They must
    // not be mistaken for the listener deliberately leaving the room.
    const wasPlaying = !state.paused; state.paused = true;
    if (wasPlaying) this.dispatchEvent(new Event('pause'));
    // A queued event from the detached source has no current MediaError.
    // A genuine non-null error from the new native source must stay actionable.
    if (state.hlsDestroy) this.dispatchEvent(new Event('error'));
    queueMicrotask(() => { state.readyState = 4; state.error = null; state.nativeMetadata++; this.dispatchEvent(new Event('loadedmetadata')); });
  } });
  proto.canPlayType = type => /(?:mpegurl|mp2t)/i.test(type) ? 'probably' : '';
  proto.play = function () {
    if (state.deferNextPlay) {
      state.deferNextPlay = false;
      return new Promise((resolve, reject) => { state.pendingPlay = { resolve, reject }; });
    }
    const wasPaused = state.paused; state.paused = false;
    if (state.nativeAssignments) state.nativePlay++;
    if (wasPaused) queueMicrotask(() => { this.dispatchEvent(new Event('playing')); state.present(this); });
    return Promise.resolve();
  };
  proto.pause = function () {
    if (state.paused) return;
    state.paused = true; this.dispatchEvent(new Event('pause'));
  };
  proto.load = function () {
    state.time = 0; state.readyState = 0; this.dispatchEvent(new Event('emptied'));
    if (state.hlsDestroy && !state.nativeMetadata) {
      state.error = { code: 1 }; this.dispatchEvent(new Event('error')); state.error = null;
    }
  };
  const remove = proto.removeAttribute;
  proto.removeAttribute = function (name) { if (name === 'src') state.source = ''; return remove.call(this, name); };
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) { const id = ++state.nextFrame; state.callbacks.set(id, { video: this, callback }); return id; };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = id => state.callbacks.delete(id);
  HTMLVideoElement.prototype.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frames, droppedVideoFrames: 0 });
  state.present = video => {
    state.frames++;
    for (const [id, item] of [...state.callbacks]) if (item.video === video) {
      state.callbacks.delete(id); item.callback(performance.now(), { width: 3840, height: 2160, mediaTime: state.time, presentedFrames: state.frames });
    }
  };
  window.WebSocket = class { constructor() { throw new Error('No real sockets belong in the fallback fixture'); } };
  window.RTCPeerConnection = class { constructor() { throw new Error('No real peers belong in the fallback fixture'); } };
}

async function waitFor(page, predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await page.evaluate(predicate)) return;
    await page.clock.runFor(100);
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Controller fixture did not reach ${label}`);
}
async function state(page) {
  return page.evaluate(() => {
    const s = window.__nativeFixture, video = document.getElementById('lab-video'), root = document.getElementById('main');
    return { engine: root.dataset.playbackEngine, fallback: root.dataset.playbackFallback, room: s.listener?.snapshot(),
      hlsCreated: s.hls.length, hlsImported: s.hlsImports, hlsDestroyed: s.hlsDestroy, peerCreated: s.peerCreated, peerStopped: s.peerStop,
      peerEnabled: [...s.peerEnabled], listenerCreated: s.listenerCreated, joins: s.join, leaves: s.leave, listenerStops: s.listenerStop,
      source: s.source, hlsSource: s.hls[0]?.url, nativeAssignments: s.nativeAssignments, nativeMetadata: s.nativeMetadata, nativePlay: s.nativePlay,
      stalePlayRejected: s.stalePlayRejected,
      time: video.currentTime, volume: video.volume, muted: video.muted, videoCount: document.querySelectorAll('video').length,
      peerBytes: Number(document.getElementById('public-peer-bytes').dataset.bytes),
      uploadBytes: Number(document.getElementById('public-upload-bytes').dataset.bytes),
      originBytesValue: document.getElementById('public-origin-bytes').dataset.bytes,
      originBytesDisplay: document.getElementById('public-origin-bytes').textContent,
      localPeers: document.getElementById('public-local-peers').textContent,
      delivery: document.getElementById('public-share-status').textContent, status: document.getElementById('lab-status').textContent };
  });
}

try {
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath) {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { await access(chrome); executablePath = chrome; } catch { /* Use an already installed Playwright browser. */ }
  }
  browser = await chromium.launch({ headless: true, executablePath, timeout: 15000 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(3000); page.on('pageerror', error => receipt.pageErrors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(mockMedia);
  await page.clock.install();
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await waitFor(page, () => !document.getElementById('public-play').disabled && window.__nativeFixture.listener, 'ready landing');
  await page.evaluate(() => {
    const video = document.getElementById('lab-video'); video.volume = 0.37; video.muted = false;
    window.__nativeFixture.originalVideo = video; document.getElementById('public-play').click();
  });
  await waitFor(page, () => window.__nativeFixture.frames > 0 && window.__nativeFixture.peerEnabled.includes(true), 'first presented fixture frame');
  const before = await state(page); assert.equal(before.peerBytes, 4096); assert.equal(before.uploadBytes, 8192);
  const savedTime = await page.evaluate(() => {
    const s = window.__nativeFixture, video = document.getElementById('lab-video');
    s.deferNextPlay = true; document.getElementById('public-play').click();
    s.time = 22.25; s.roomPosition = 52.25; s.readyState = 2; s.ranges = [];
    video.dispatchEvent(new Event('waiting')); return video.currentTime;
  });
  await page.clock.runFor(9200);
  await waitFor(page, () => document.getElementById('main').dataset.playbackEngine === 'Native HLS', 'native fallback');
  const after = await state(page);
  assert.equal(after.fallback, 'stalls'); assert.equal(after.hlsDestroyed, 1); assert.equal(after.peerStopped, 1);
  assert.equal(after.stalePlayRejected, 1, 'the old HLS play promise rejects during teardown without leaving the room');
  assert.equal(after.hlsCreated, 1); assert.equal(after.peerCreated, 1); assert.equal(after.listenerCreated, 1);
  assert.equal(after.room.id, before.room.id); assert.equal(after.room.epochId, before.room.epochId);
  assert.equal(after.leaves, 0); assert.equal(after.listenerStops, 0); assert.equal(after.joins, before.joins);
  assert.equal(after.volume, 0.37); assert.equal(after.muted, false); assert.equal(after.time, savedTime);
  assert.equal(after.peerBytes, before.peerBytes); assert.equal(after.uploadBytes, before.uploadBytes);
  assert.equal(after.videoCount, 1); assert.match(after.localPeers, /^0\b/); assert.match(after.delivery, /native|media host|origin/i);
  assert.equal(await page.evaluate(() => window.__nativeFixture.originalVideo === document.getElementById('lab-video')), true);
  const enabledCalls = after.peerEnabled.length;
  await page.evaluate(() => document.getElementById('lab-video').pause());
  await page.clock.runFor(1200);
  const paused = await state(page);
  assert.equal(paused.leaves, 1); assert.equal(paused.peerStopped, 1); assert.equal(paused.peerCreated, 1);
  assert.ok(paused.peerEnabled.slice(enabledCalls).every(value => value !== true), 'native Pause cannot reopen peer delivery');
  assert.equal(paused.listenerStops, 0); assert.equal(paused.engine, 'Native HLS');
  assert.deepEqual(receipt.pageErrors, []); assert.deepEqual(receipt.forbiddenRequests, []);
  receipt.simulatedCases.push({ trigger: 'eight-second-frozen-playhead', before, after, paused });
  await page.close();

  const iphoneHlsRequests = [];
  const iphone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  iphone.setDefaultTimeout(3000); iphone.on('pageerror', error => receipt.pageErrors.push(error.message));
  iphone.on('request', request => {
    if (/\/vendor\/hls(?:\.light)?\.min\.mjs$/u.test(new URL(request.url()).pathname)) iphoneHlsRequests.push(request.url());
  });
  await iphone.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await iphone.addInitScript(mockMedia); await iphone.clock.install();
  await iphone.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await waitFor(iphone, () => !document.getElementById('public-play').disabled && window.__nativeFixture.listener, 'iPhone ready landing');
  await iphone.evaluate(() => {
    const video = document.getElementById('lab-video'); video.volume = 0.61; video.muted = false;
    window.__nativeFixture.originalVideo = video; document.getElementById('public-play').click();
  });
  await waitFor(iphone, () => document.getElementById('main').dataset.playbackEngine?.startsWith('hls.js') && window.__nativeFixture.frames > 0,
    'iPhone first-play peer-capable HLS');
  const peerFirst = await state(iphone);
  assert.equal(peerFirst.hlsImported, 1); assert.equal(peerFirst.hlsCreated, 1); assert.equal(peerFirst.hlsDestroyed, 0);
  assert.equal(iphoneHlsRequests.length, 1, 'iPhone loads the same peer-capable player as other browsers');
  assert.equal(peerFirst.peerCreated, 1); assert.ok(peerFirst.peerEnabled.includes(true)); assert.equal(peerFirst.peerStopped, 0);
  assert.equal(new URL(peerFirst.hlsSource).origin, origin); assert.equal(new URL(peerFirst.hlsSource).pathname, '/media/dejavu-4k/index.m3u8');
  assert.equal(peerFirst.nativeAssignments, 0); assert.equal(peerFirst.listenerCreated, 1); assert.equal(peerFirst.joins, 1);
  assert.equal(peerFirst.leaves, 0); assert.equal(peerFirst.listenerStops, 0); assert.equal(peerFirst.room.ready, true);
  assert.equal(peerFirst.peerBytes, 4096); assert.equal(peerFirst.uploadBytes, 8192); assert.equal(peerFirst.originBytesValue, '16384');
  assert.equal(peerFirst.volume, 0.61); assert.equal(peerFirst.muted, false); assert.match(peerFirst.localPeers, /^1\b/);
  assert.equal(peerFirst.videoCount, 1);
  await iphone.evaluate(() => document.getElementById('lab-video').pause()); await iphone.clock.runFor(400);
  const peerPaused = await state(iphone);
  assert.equal(peerPaused.leaves, 1); assert.equal(peerPaused.listenerStops, 0); assert.equal(peerPaused.room.ready, false);
  assert.equal(peerPaused.peerEnabled.at(-1), false);
  await iphone.evaluate(() => document.getElementById('public-play').click());
  await waitFor(iphone, () => window.__nativeFixture.listener.snapshot().ready && !document.getElementById('lab-video').paused, 'iPhone peer-capable resume');
  const peerResumed = await state(iphone);
  assert.ok(peerResumed.engine.startsWith('hls.js')); assert.equal(peerResumed.listenerCreated, 1); assert.equal(peerResumed.joins, 2);
  assert.equal(peerResumed.room.id, peerFirst.room.id); assert.equal(peerResumed.room.epochId, peerFirst.room.epochId);
  assert.equal(peerResumed.nativeAssignments, 0); assert.equal(peerResumed.volume, 0.61);
  assert.equal(peerResumed.hlsImported, 1); assert.equal(peerResumed.peerCreated, 1); assert.equal(peerResumed.peerEnabled.at(-1), true);
  assert.equal(peerResumed.peerBytes, 4096); assert.equal(peerResumed.uploadBytes, 8192);
  assert.equal(await iphone.evaluate(() => window.__nativeFixture.originalVideo === document.getElementById('lab-video')), true);
  assert.deepEqual(receipt.pageErrors, []); assert.deepEqual(receipt.forbiddenRequests, []);
  receipt.simulatedCases.push({ trigger: 'iphone-peer-capable-first-play', userAgentEmulated: true, nativeMediaSimulated: true,
    hlsBundleRequests: iphoneHlsRequests.length, first: peerFirst, paused: peerPaused, resumed: peerResumed });
  await iphone.close();
  receipt.passed = true;
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(done => server.close(done));
  receipt.cleanup = { browserClosed: true, fixtureServerClosed: true };
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); }
}
