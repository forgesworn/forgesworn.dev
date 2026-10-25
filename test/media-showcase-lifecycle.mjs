// Real homepage/controller with explicit HLS, room and media-state fixtures.
// This qualifies startup ordering, not decoding, browser policy or physical playback.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = resolve(fileURLToPath(new URL('../site/', import.meta.url)));
const origin = 'https://forgesworn.dev';
const fixtures = {
  '/vendor/hls.light.min.mjs': `window.fixture.imported = true; export default class Hls {
    static Events = { MEDIA_ATTACHED:'attached', MANIFEST_PARSED:'manifest', ERROR:'error' };
    static isSupported() { return fixture.engine === 'mse'; }
    constructor(config) { this.config=config; this.handlers=new Map(); fixture.players.push(this); }
    on(event, handler) { this.handlers.set(event,handler); }
    attachMedia(video) { this.video=video; fixture.trace.push({kind:'attach'}); video.src='blob:fixture-pipeline'; video.load();
      queueMicrotask(()=>this.handlers.get('attached')?.(null,{mediaSource:{}})); }
    loadSource(url) { fixture.trace.push({kind:'source',url}); queueMicrotask(()=>this.handlers.get('manifest')?.()); }
    startLoad(position) { fixture.trace.push({kind:'startLoad',position}); fixture.currentTime=position; }
    stopLoad() {} destroy() { this.destroyed=true; }
  }`,
  '/media-listener-session.mjs': `export function createListenerSession({onChange}) {
    let joined=false,generation=0; const snapshot=()=>({ready:joined,observed:true,connectedRelays:1,joined,
      listeners:joined?1:0,epochId:'fixture',position:50,startedAt:1});
    const notify=()=>onChange(snapshot()); fixture.roomUpdate=notify;
    return {snapshot,position:()=>50,observe:notify,join:async()=>{
      const request=++generation; fixture.trace.push({kind:'join'});
      if(fixture.holdJoin) await new Promise(resolve=>fixture.joinWaiters.push(resolve));
      if(request!==generation) throw new DOMException('Join cancelled','AbortError'); joined=true; notify();
    },leave:()=>{generation++;joined=false;notify()},stop(){generation++}};
  }`,
  '/media-public-swarm.mjs': `export const PUBLIC_SWARM_SOURCE_SHA256='a'.repeat(64),PUBLIC_SWARM_RELAYS=[];
    export function createPublicSwarm(){const peer={enabled:false,stopped:false,setEnabled:async value=>{peer.enabled=value},metrics:()=>null,
      stop(){peer.stopped=true;peer.enabled=false}};fixture.peers.push(peer);return peer;}`,
};
const types = { '.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml' };
let browser;
const checks=[];
async function open({held=false,heldVisual=false,heldRoomCode=false,engine='mse',reject=false}={}) {
  const context=await browser.newContext(),page=await context.newPage(),errors=[],mediaRequests=[];
  page.setDefaultTimeout(8000);
  let release;const gate=new Promise(resolve=>{release=resolve});if(!held)release();
  let releaseVisual;const visualGate=new Promise(resolve=>{releaseVisual=resolve});if(!heldVisual)releaseVisual();
  let releaseRoomCode;const roomCodeGate=new Promise(resolve=>{releaseRoomCode=resolve});if(!heldRoomCode)releaseRoomCode();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\.(m3u8|m4s)(\?|$)/.test(request.url()))mediaRequests.push(request.url())});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(url.pathname==='/vendor/hls.light.min.mjs'){await page.evaluate(()=>{fixture.requested=true});await gate;}
    if(url.pathname==='/media-swarm-visual.mjs')await visualGate;
    if(url.pathname==='/media-listener-session.mjs')await roomCodeGate;
    if(fixtures[url.pathname])return route.fulfill({contentType:'text/javascript',body:fixtures[url.pathname]});
    const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!path.startsWith(root+sep))return route.abort();
    try{return await route.fulfill({contentType:types[extname(path)]??'application/octet-stream',body:await readFile(path)})}
    catch{return route.fulfill({status:404,body:''})}
  });
  await page.addInitScript(({engine,reject})=>{
    const state=window.fixture={engine,reject,players:[],peers:[],trace:[],readyState:1,currentTime:0,ranges:[],paused:true,seeking:false,source:'',
      holdJoin:true,joinWaiters:[],playWaiters:[],inTap:false,trusted:false};
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, callback, options) {
      if (type !== 'click' || this.id !== 'public-play') return add.call(this, type, callback, options);
      return add.call(this, type, function (event) {
        state.inTap = true; state.trusted = event.isTrusted;
        try { return callback.call(this, event); }
        finally { state.inTap = false; state.trusted = false; }
      }, options);
    };
    state.releaseRoom=()=>{state.holdJoin=false;for(const resolve of state.joinWaiters.splice(0))resolve()};
    state.finishPlay=()=>{state.readyState=4;state.ranges=[[0,100]];for(const {resolve}of state.playWaiters.splice(0))resolve();document.getElementById('lab-video').dispatchEvent(new Event('playing'))};
    state.presentFrame=()=>{state.frameCallback?.(performance.now(),{width:3840,height:2160})};
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){state.frameCallback=callback;return 1};
    HTMLVideoElement.prototype.cancelVideoFrameCallback=function(){state.frameCallback=null};
    Object.defineProperties(HTMLMediaElement.prototype,{
      readyState:{get:()=>state.readyState},duration:{get:()=>268.6},paused:{get:()=>state.paused},seeking:{get:()=>state.seeking},
      currentTime:{get:()=>state.currentTime,set:value=>{state.currentTime=value}},
      src:{get:()=>state.source,set:value=>{state.source=value;state.trace.push({kind:'src',value})}},
      buffered:{get:()=>({length:state.ranges.length,start:i=>state.ranges[i][0],end:i=>state.ranges[i][1]})},
    });
    const canPlay=HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?state.engine==='native'?'probably':'':canPlay.call(this,type)};
    HTMLMediaElement.prototype.play=function(){state.trace.push({kind:'play',inTap:state.inTap,trusted:state.trusted,source:state.source});
      if(state.reject)return Promise.reject(new DOMException('Gesture required','NotAllowedError'));
      state.paused=false;this.dispatchEvent(new Event('play'));return new Promise((resolve,reject)=>state.playWaiters.push({resolve,reject}));};
    HTMLMediaElement.prototype.pause=function(){state.paused=true;this.dispatchEvent(new Event('pause'));for(const {reject}of state.playWaiters.splice(0))reject(new DOMException('Paused','AbortError'))};
    HTMLMediaElement.prototype.load=function(){state.trace.push({kind:'load'})};
  },{engine,reject});
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>fixture.requested);
  if(!held)await page.waitForFunction(()=>!document.getElementById('public-play').disabled);
  return {page,context,errors,mediaRequests,release,releaseVisual,releaseRoomCode};
}
async function close(run){
  await run.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await run.page.evaluate(()=>fixture.players.every(p=>p.destroyed)),true);
  assert.equal(await run.page.evaluate(()=>fixture.peers.every(p=>p.stopped)),true);
  assert.deepEqual(run.errors,[]);await run.context.close();
}
function gestureOrder(trace,native=false){
  const play=trace.findIndex(x=>x.kind==='play'),source=trace.findIndex(x=>x.kind==='src'),join=trace.findIndex(x=>x.kind==='join');
  assert(source>=0&&play>source,'real pipeline/source is attached before play');assert(join>play,'play precedes async room setup');
  assert.equal(trace[play].inTap,true,'play stays in the original click turn');assert.equal(trace[play].trusted,true);
  assert.match(trace[play].source,native?/^https:\/\/forgesworn\.dev\/media\//:/^blob:/);
}
try {
  browser=await chromium.launch({headless:true});
  const first=await open({held:true});
  assert.equal(await first.page.locator('#public-play').isDisabled(),true);
  assert.equal(await first.page.locator('#public-play').innerText(),'Preparing player…');
  assert.deepEqual(await first.page.evaluate(()=>({players:fixture.players.length,peers:fixture.peers.length,trace:fixture.trace})),{players:0,peers:0,trace:[]});
  assert.deepEqual(first.mediaRequests,[]);first.release();await first.page.waitForFunction(()=>!document.getElementById('public-play').disabled);
  await first.page.locator('#public-play').click();gestureOrder(await first.page.evaluate(()=>fixture.trace));
  assert.equal(await first.page.evaluate(()=>fixture.players[0].config.autoStartLoad),false);
  assert.equal(await first.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);
  assert.equal(await first.page.evaluate(()=>fixture.peers.length),0);
  for(let i=0;i<3;i++){await first.page.evaluate(()=>fixture.roomUpdate());assert.equal(await first.page.locator('#public-play').innerText(),'Loading the mix…');assert.equal(await first.page.locator('#public-play').isDisabled(),true)}
  await first.page.evaluate(()=>fixture.releaseRoom());await first.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  assert.equal(await first.page.evaluate(()=>fixture.trace.find(x=>x.kind==='startLoad').position),50);
  assert.equal(await first.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);
  await first.page.evaluate(()=>fixture.finishPlay());
  assert.equal(await first.page.locator('#public-play').innerText(),'Loading the mix…','playing without a presented frame cannot finish initial loading');
  await first.page.evaluate(()=>fixture.presentFrame());
  assert.equal(await first.page.locator('#public-play').isHidden(),true);
  assert.equal(await first.page.evaluate(()=>document.getElementById('lab-video').muted),false);
  for (const readyState of [3, 4]) {
    const seconds = readyState === 3 ? 61 : 62;
    await first.page.evaluate(({readyState,seconds})=>{
      fixture.readyState=readyState;fixture.currentTime=seconds;
      document.getElementById('lab-video').dispatchEvent(new Event('stalled'));
      fixture.presentFrame();
    },{readyState,seconds});
    // The time reading is updated by the real observation tick. Wait for that
    // update before checking the count, rather than inspecting stale DOM.
    await first.page.waitForFunction(seconds=>document.getElementById('browser-time').textContent===`1:${String(seconds-60).padStart(2,'0')}`,seconds);
    assert.equal(await first.page.locator('#browser-stalls').textContent(),'0','network stalled with playable advancing frames is not a playback interruption');
  }
  await first.page.evaluate(()=>{
    fixture.currentTime=63;fixture.readyState=2;
    document.getElementById('lab-video').dispatchEvent(new Event('waiting'));
  });
  await first.page.waitForFunction(()=>document.getElementById('browser-time').textContent==='1:03');
  assert.equal(await first.page.locator('#browser-stalls').textContent(),'1','real waiting during underflow is counted');
  await first.page.evaluate(()=>{
    fixture.readyState=4;document.getElementById('lab-video').dispatchEvent(new Event('playing'));fixture.presentFrame();
    fixture.currentTime=64;fixture.seeking=true;
    const video=document.getElementById('lab-video');video.dispatchEvent(new Event('seeking'));video.dispatchEvent(new Event('waiting'));
  });
  await first.page.waitForFunction(()=>document.getElementById('browser-time').textContent==='1:04');
  assert.equal(await first.page.locator('#browser-stalls').textContent(),'2','real waiting during a buffered seek remains counted');
  checks.push('healthy network stalled is ignored after an observation tick; real underflow and seek waits remain counted');
  await close(first);checks.push('code-only preparation; same-turn attach/play; held join and stable Loading; fresh start position; no async duplicate play');

  const denied=await open({reject:true});await denied.page.locator('#public-play').click();
  await denied.page.waitForFunction(()=>document.getElementById('main').dataset.playbackPlayError==='NotAllowedError');
  assert.equal(await denied.page.locator('#public-play').isDisabled(),false);assert.match(await denied.page.locator('#lab-status').innerText(),/Press play/);
  await denied.page.evaluate(()=>{fixture.reject=false});await denied.page.locator('#public-play').click();
  assert.equal(await denied.page.locator('#public-play').innerText(),'Loading the mix…');
  assert.equal(await denied.page.evaluate(()=>fixture.players.length),1,'retry retains prepared engine');
  assert.equal(await denied.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').every(x=>x.inTap&&x.trusted)),true);
  await denied.page.evaluate(()=>fixture.releaseRoom());await denied.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
  await denied.page.evaluate(()=>fixture.finishPlay());assert.equal(await denied.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),2);
  await close(denied);checks.push('policy denial is recorded; trusted retry retains one prepared, audible player');

  const paused=await open();await paused.page.locator('#public-play').click();await paused.page.evaluate(()=>document.getElementById('lab-video').pause());
  await paused.page.evaluate(()=>fixture.releaseRoom());await paused.page.waitForTimeout(100);
  assert.equal(await paused.page.evaluate(()=>fixture.paused),true);assert.equal(await paused.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);
  assert.equal(await paused.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);assert.equal(await paused.page.evaluate(()=>fixture.peers.length),0);
  assert.equal(await paused.page.locator('#public-play').isDisabled(),false);
  await paused.page.evaluate(()=>{fixture.paused=false;document.getElementById('lab-video').dispatchEvent(new Event('play'))});
  assert.equal(await paused.page.locator('#public-play').innerText(),'Loading the mix…','native-controls play also owns the startup label');
  assert.equal(await paused.page.locator('#public-play').isDisabled(),true);
  await paused.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
  assert.equal(await paused.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1,'native play events never trigger a duplicate script play');
  await close(paused);checks.push('pause during join cancels startup; native-controls resume owns Loading without duplicate play');

  const resumed=await open();
  await resumed.page.locator('#public-play').click();
  await resumed.page.waitForFunction(()=>fixture.joinWaiters.length>0);
  await resumed.page.evaluate(()=>document.getElementById('lab-video').pause());
  await resumed.page.locator('#public-play').click();
  await resumed.page.evaluate(()=>fixture.releaseRoom());
  await resumed.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  assert.equal(await resumed.page.evaluate(()=>fixture.trace.find(x=>x.kind==='startLoad').position),50,'a cancelled old join cannot supply the resumed stream position');
  assert.equal(await resumed.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='join').length),2,'resume receives its own acknowledged room join');
  await close(resumed);checks.push('resume before an old cancelled join settles still obtains a fresh room clock');

  const replaced=await open({heldRoomCode:true});
  await replaced.page.locator('#public-play').click();
  await replaced.page.evaluate(()=>document.getElementById('lab-video').dispatchEvent(new Event('error')));
  await replaced.page.waitForFunction(()=>!document.getElementById('public-play').disabled);
  await replaced.page.locator('#public-play').click();
  assert.equal(await replaced.page.evaluate(()=>fixture.players.length),2,'one Replay creates a new player while the old room module is still pending');
  assert.equal(await replaced.page.evaluate(()=>fixture.players[0].destroyed),true);
  assert.equal(await replaced.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),2);
  assert.equal(await replaced.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').every(x=>x.inTap&&x.trusted)),true);
  replaced.releaseRoomCode();await replaced.page.waitForFunction(()=>fixture.roomUpdate!==undefined);
  await replaced.page.evaluate(()=>fixture.releaseRoom());await replaced.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
  assert.equal(await replaced.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),1,'old uncancellable import cannot load the disposed player');
  assert.equal(await replaced.page.evaluate(()=>fixture.peers.length),1);
  await close(replaced);checks.push('fatal startup during held room-code import permits one fresh trusted Replay');

  const native=await open({engine:'native'});await native.page.locator('#public-play').click();gestureOrder(await native.page.evaluate(()=>fixture.trace),true);
  assert.equal(await native.page.evaluate(()=>fixture.players.length),0);await native.page.evaluate(()=>fixture.releaseRoom());
  await native.page.evaluate(()=>{fixture.readyState=4;document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'));fixture.finishPlay()});
  assert.equal(await native.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);await close(native);checks.push('native HLS assigns real source and plays in same gesture');

  const departing=await open({heldVisual:true});
  await departing.page.locator('#public-play').click();
  await departing.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await departing.page.evaluate(()=>fixture.players[0].destroyed),true,'teardown exists even while decorative import is pending');
  await departing.page.evaluate(()=>fixture.releaseRoom());departing.releaseVisual();
  await departing.page.waitForTimeout(100);
  assert.equal(await departing.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);
  assert.equal(await departing.page.evaluate(()=>fixture.peers.length),0);
  await close(departing);checks.push('pagehide during decorative import aborts pending startup and destroys its engine');

  for(const kind of ['hls','media']){
    const failed=await open();await failed.page.locator('#public-play').click();await failed.page.evaluate(()=>fixture.releaseRoom());
    await failed.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
    await failed.page.evaluate(kind=>{if(kind==='hls')fixture.players[0].handlers.get('error')(null,{fatal:true});else document.getElementById('lab-video').dispatchEvent(new Event('error'))},kind);
    await failed.page.waitForFunction(()=>!document.getElementById('public-play').disabled);
    assert.match(await failed.page.locator('#lab-status').innerText(),/could not be played/);
    assert.doesNotMatch(await failed.page.locator('#lab-status').innerText(),/mix is ready/);
    assert.equal(await failed.page.evaluate(()=>document.getElementById('lab-video').controls),false);
    await failed.page.evaluate(()=>{fixture.paused=false;const v=document.getElementById('lab-video');v.dispatchEvent(new Event('play'));v.dispatchEvent(new Event('playing'))});
    assert.equal(await failed.page.locator('#public-play').isDisabled(),false,'native play cannot revive a failed startup');
    assert.notEqual(await failed.page.locator('#public-play').innerText(),'Loading the mix…');
    assert.equal(await failed.page.evaluate(()=>fixture.peers.every(p=>!p.enabled)),true);await close(failed);
  }
  checks.push('fatal HLS/media errors clear Loading and fence old promise rejection');
  console.log(JSON.stringify({suite:'media-showcase-lifecycle',passed:true,checks,
    scope:'Real controller; explicit HLS/room/media fixtures. No decoded playback, physical-device or peer-delivery qualification.'}));
} finally { await browser?.close(); }
