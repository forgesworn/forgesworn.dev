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
  '/vendor/hls.light.min.mjs': `window.fixture.imported = true; class Loader { load(){} abort(){} destroy(){} }
  export default class Hls {
    static Events = { MEDIA_ATTACHED:'attached', MANIFEST_PARSED:'manifest', ERROR:'error', FRAG_LOADED:'fragment' };
    static isSupported() { return fixture.engine === 'mse'; }
    constructor(config) { this.config={loader:Loader,...config}; this.handlers=new Map(); fixture.players.push(this); }
    on(event, handler) { this.handlers.set(event,handler); }
    off(event, handler) { if(this.handlers.get(event)===handler)this.handlers.delete(event); }
    attachMedia(video) { this.video=video; fixture.trace.push({kind:'attach'}); video.src='blob:fixture-pipeline'; video.load();
      queueMicrotask(()=>this.handlers.get('attached')?.(null,{mediaSource:{}})); }
    loadSource(url) { fixture.trace.push({kind:'source',url}); queueMicrotask(()=>this.handlers.get('manifest')?.()); }
    startLoad(position) { fixture.trace.push({kind:'startLoad',position,player:fixture.players.indexOf(this)});
      fixture.duration=this.config.liveDurationInfinity?Infinity:fixture.sourceDuration; fixture.currentTime=position; }
    stopLoad() { fixture.trace.push({kind:'stopLoad',player:fixture.players.indexOf(this)}); }
    destroy() { this.destroyed=true; this.video?.pause(); }
  }`,
  '/media-listener-session.mjs': `export function createListenerSession({onChange}) {
    const position=()=>fixture.recorded?((Date.now()-fixture.startedAt)/1000)%fixture.sourceDuration:50;
    let joined=false,generation=0; const snapshot=()=>({ready:joined,observed:true,connectedRelays:1,joined,
      listeners:joined?1:0,epochId:fixture.epochId,position:position(),startedAt:fixture.startedAt});
    const notify=()=>onChange(snapshot()); fixture.roomUpdate=notify;
    fixture.replaceEpoch=()=>{fixture.epochId='2'.repeat(64);fixture.startedAt=Date.now()-10_000;notify()};
    return {snapshot,position,observe:notify,join:async()=>{
      const request=++generation; fixture.trace.push({kind:'join'});
      if(fixture.holdJoin) await new Promise(resolve=>fixture.joinWaiters.push(resolve));
      if(request!==generation) throw new DOMException('Join cancelled','AbortError'); joined=true; notify();
    },leave:()=>{generation++;joined=false;notify()},stop(){generation++}};
  }`,
  '/media-public-swarm.mjs': `import * as real from '/__actual-public-swarm.mjs';
    export const PUBLIC_SWARM_SOURCE_SHA256=real.PUBLIC_SWARM_SOURCE_SHA256,PUBLIC_SWARM_RELAYS=[];
    export async function prepareRecordedSource(options){
      if(!fixture.recorded)return null;
      fixture.trace.push({kind:'prepareMetadata'});
      const recording=await real.prepareRecordedSource(options);fixture.prepared.push(recording);return recording;
    }
    export function createRecordedLive(options){const view=real.createRecordedLive(options);if(view)fixture.views.push(view);return view;}
    export function createPublicSwarm(options){
      if(options.recordedLive){
        // Validate the real adapter's private prepared-recording brand and
        // epoch/context contract; stop before enabling any network identity.
        const checked=real.createPublicSwarm(options);checked.stop();fixture.brandedAdapters++;
      }
      const peer={options,enabled:false,stopped:false,setEnabled:async value=>{peer.enabled=value},metrics:()=>null,
        stop(){peer.stopped=true;peer.enabled=false}};fixture.peers.push(peer);return peer;}`,
};
const types = { '.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml' };
let browser;
const checks=[];
async function open({held=false,heldVisual=false,heldRoomCode=false,heldMetadata=false,engine='mse',reject=false,
  recorded=false,quality='full'}={}) {
  const context=await browser.newContext(),page=await context.newPage(),errors=[],mediaRequests=[];
  page.setDefaultTimeout(8000);
  let release;const gate=new Promise(resolve=>{release=resolve});if(!held)release();
  let releaseVisual;const visualGate=new Promise(resolve=>{releaseVisual=resolve});if(!heldVisual)releaseVisual();
  let releaseRoomCode;const roomCodeGate=new Promise(resolve=>{releaseRoomCode=resolve});if(!heldRoomCode)releaseRoomCode();
  let releaseMetadata;const metadataGate=new Promise(resolve=>{releaseMetadata=resolve});if(!heldMetadata)releaseMetadata();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\.(m3u8|m4s)(\?|$)/.test(request.url()))mediaRequests.push(request.url())});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(url.pathname==='/vendor/hls.light.min.mjs'){await page.evaluate(()=>{fixture.requested=true});await gate;}
    if(url.pathname==='/media-swarm-visual.mjs')await visualGate;
    if(url.pathname==='/media-listener-session.mjs')await roomCodeGate;
    if(url.pathname==='/media/dejavu-swarm/catalogue-v2.json')await metadataGate;
    if(fixtures[url.pathname])return route.fulfill({contentType:'text/javascript',body:fixtures[url.pathname]});
    const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname==='/__actual-public-swarm.mjs'?'/media-public-swarm.mjs':url.pathname));if(!path.startsWith(root+sep))return route.abort();
    try{return await route.fulfill({contentType:types[extname(path)]??'application/octet-stream',body:await readFile(path)})}
    catch{return route.fulfill({status:404,body:''})}
  });
  await page.addInitScript(({engine,reject,recorded,quality})=>{
    const state=window.fixture={engine,reject,players:[],peers:[],trace:[],readyState:1,currentTime:0,ranges:[],paused:true,seeking:false,source:'',
      recorded,views:[],prepared:[],brandedAdapters:0,nativeCapable:false,epochId:'1'.repeat(64),startedAt:Date.now()-50_000,
      sourceDuration:quality==='preview'?29.96:268.6,duration:quality==='preview'?29.96:268.6,wallOffset:0,
      holdJoin:true,joinWaiters:[],playWaiters:[],inTap:false,trusted:false};
    const wallNow=Date.now;Date.now=()=>wallNow()+state.wallOffset;
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
      readyState:{get:()=>state.readyState},duration:{get:()=>state.duration},paused:{get:()=>state.paused},seeking:{get:()=>state.seeking},
      currentTime:{get:()=>state.currentTime,set:value=>{state.currentTime=value}},
      src:{get:()=>state.source,set:value=>{state.source=value;if(!value.startsWith('blob:'))state.duration=state.sourceDuration;state.trace.push({kind:'src',value})}},
      buffered:{get:()=>({length:state.ranges.length,start:i=>state.ranges[i][0],end:i=>state.ranges[i][1]})},
    });
    const canPlay=HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?state.engine==='native'||state.nativeCapable?'probably':'':canPlay.call(this,type)};
    HTMLMediaElement.prototype.play=function(){state.trace.push({kind:'play',inTap:state.inTap,trusted:state.trusted,source:state.source});
      if(state.reject)return Promise.reject(new DOMException('Gesture required','NotAllowedError'));
      state.paused=false;this.dispatchEvent(new Event('play'));return new Promise((resolve,reject)=>state.playWaiters.push({resolve,reject}));};
    HTMLMediaElement.prototype.pause=function(){state.paused=true;this.dispatchEvent(new Event('pause'));for(const {reject}of state.playWaiters.splice(0))reject(new DOMException('Paused','AbortError'))};
    HTMLMediaElement.prototype.load=function(){state.trace.push({kind:'load'})};
  },{engine,reject,recorded,quality});
  await page.goto(origin+'/?q='+quality,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>fixture.requested);
  if(!held)await page.waitForFunction(()=>!document.getElementById('public-play').disabled);
  return {page,context,errors,mediaRequests,release,releaseVisual,releaseRoomCode,releaseMetadata};
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
  assert.equal(await first.page.locator('#main').getAttribute('data-playback-mode'),'recorded-vod','unavailable metadata keeps the approved VOD path');
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

  for(const quality of ['full','preview']) {
    const run=await open({recorded:true,quality});
    assert.deepEqual(run.mediaRequests,[],'recording preparation fetches no metadata or video before the tap');
    await run.page.locator('#public-play').click();gestureOrder(await run.page.evaluate(()=>fixture.trace));
    assert.equal(await run.page.evaluate(()=>fixture.prepared.length),0,'no metadata before the acknowledged room join');
    await run.page.evaluate(()=>fixture.releaseRoom());
    await run.page.waitForFunction(()=>document.getElementById('main').dataset.playbackMode==='recorded-live'&&fixture.trace.some(x=>x.kind==='startLoad'));
    const installed=await run.page.evaluate(()=>{
      const view=fixture.views[0], player=fixture.players[0], load=fixture.trace.find(x=>x.kind==='startLoad');
      return {branded:fixture.brandedAdapters,viewCount:fixture.views.length,loader:typeof player.config.pLoader,
        position:load.position,fresh:view.mediaTimeAt(Date.now()),phase:view.recordingPosition(load.position),
        expectedPhase:((Date.now()-fixture.startedAt)/1000)%fixture.sourceDuration,
        infinite:fixture.duration===Infinity,rate:player.config.maxLiveSyncPlaybackRate,maxLatency:player.config.liveMaxLatencyDuration===Infinity,
        playlist:view.recording.playlistUrl,outer:fixture.trace.find(x=>x.kind==='source').url,
        epoch:fixture.peers[0].options.recordedLive.epochId,oneVideo:document.querySelectorAll('video').length};
    });
    assert.equal(installed.branded,1,'the real adapter accepts the real prepared-recording WeakSet brand');
    assert.equal(installed.viewCount,1);assert.equal(installed.loader,'function');assert.equal(installed.infinite,true);
    assert.equal(installed.rate,1);assert.equal(installed.maxLatency,true);assert.equal(installed.oneVideo,1);
    assert(Math.abs(installed.position-installed.fresh)<0.25);assert(Math.abs(installed.phase-installed.expectedPhase)<0.25);
    assert.equal(installed.epoch,'1'.repeat(64));
    assert.equal(installed.playlist,origin+(quality==='full'?'/media/dejavu-4k/index.m3u8':'/media/dejavu-preview/rtmp/stream.m3u8'));
    assert.equal(installed.outer,origin+(quality==='full'?'/media/dejavu-4k/index.m3u8':'/media/dejavu-preview/rtmp/index.m3u8'),'preview keeps its original master source');
    await run.page.evaluate(()=>{fixture.finishPlay();fixture.presentFrame()});
    const stopped=await run.page.evaluate(()=>{
      const prior=fixture.trace.filter(x=>x.kind==='stopLoad').length;
      document.getElementById('lab-video').pause();return {prior,now:fixture.trace.filter(x=>x.kind==='stopLoad').length};
    });
    assert.equal(stopped.now,stopped.prior+1,'pause stops the playlist and fragment controllers');
    assert.equal(await run.page.evaluate(()=>fixture.peers[0].enabled),false);
    await run.page.evaluate(()=>{fixture.wallOffset+=(fixture.sourceDuration+10)*1000;void document.getElementById('lab-video').play()});
    await run.page.waitForFunction(()=>fixture.trace.filter(x=>x.kind==='startLoad').length>=2);
    const resumed=await run.page.evaluate(()=>({players:fixture.players.length,peers:fixture.peers.length,views:fixture.views.length,
      target:fixture.trace.filter(x=>x.kind==='startLoad').at(-1).position,raw:fixture.currentTime,duration:fixture.sourceDuration}));
    assert.deepEqual([resumed.players,resumed.peers,resumed.views],[1,1,1],'same-epoch resume keeps the pipeline and adapter identity');
    assert(resumed.target>resumed.duration,'resume uses elapsed raw time rather than programme modulo');
    assert(Math.abs(resumed.raw-resumed.target)<0.25);
    await run.page.evaluate(()=>{fixture.finishPlay();fixture.presentFrame();fixture.replaceEpoch()});
    await run.page.waitForFunction(()=>fixture.players.length===2&&fixture.peers.length===2&&fixture.trace.filter(x=>x.kind==='source').length===2);
    assert.equal(await run.page.evaluate(()=>fixture.players[0].destroyed&&fixture.peers[0].stopped),true);
    assert.equal(await run.page.evaluate(()=>{try{fixture.views[0].windowAt(Date.now());return false}catch{return true}}),true,'the old epoch playlist cannot continue loading');
    assert.equal(await run.page.evaluate(()=>fixture.peers[1].options.recordedLive.epochId),'2'.repeat(64));
    assert.equal(await run.page.evaluate(()=>fixture.brandedAdapters),2);
    assert.equal(await run.page.evaluate(()=>document.querySelectorAll('video').length),1,'epoch replacement retains the visible element');
    await run.page.evaluate(()=>fixture.players[0].handlers.get('error')(null,{fatal:true}));
    assert.equal(await run.page.locator('#main').getAttribute('data-playback-mode'),'recorded-live','late old-engine errors cannot replace the new mode');
    assert.notEqual(await run.page.locator('#lab-status').textContent(),'This source could not be played. Try the preview or open the reproduction guide.');
    await close(run);
  }
  checks.push('real pinned full/preview metadata + shared brand enter recorded-live; pause/resume retains timeline; changed epoch replaces only pipeline on one video');

  const cancelled=await open({recorded:true,heldMetadata:true});
  await cancelled.page.locator('#public-play').click();await cancelled.page.evaluate(()=>fixture.releaseRoom());
  await cancelled.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='prepareMetadata'));
  await cancelled.page.evaluate(()=>document.getElementById('lab-video').pause());cancelled.releaseMetadata();
  await cancelled.page.waitForFunction(()=>fixture.prepared.length===1);
  assert.equal(await cancelled.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0,'pause during metadata cannot start an old load');
  assert.equal(await cancelled.page.evaluate(()=>fixture.peers.length),0);assert.equal(await cancelled.page.evaluate(()=>fixture.views.length),0);
  await close(cancelled);checks.push('pause during recording metadata leaves no view, peer or late source load');

  const fallback=await open({recorded:true});
  await fallback.page.locator('#public-play').click();await fallback.page.evaluate(()=>fixture.releaseRoom());
  await fallback.page.waitForFunction(()=>fixture.brandedAdapters===1);
  await fallback.page.evaluate(()=>{fixture.finishPlay();fixture.presentFrame();fixture.replaceEpoch()});
  await fallback.page.waitForFunction(()=>fixture.brandedAdapters===2&&fixture.trace.filter(x=>x.kind==='source').length===2);
  // A real user pause during a controlled pipeline replacement cancels its
  // pending autoplay. A later explicit resume is the new authoritative intent.
  await fallback.page.evaluate(()=>{
    const video=document.getElementById('lab-video');video.dispatchEvent(new Event('pointerdown'));video.pause();
  });
  assert.equal(await fallback.page.locator('#main').getAttribute('data-shared-session'),'paused');
  const resumeLoads=await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='startLoad').length);
  await fallback.page.evaluate(()=>{void document.getElementById('lab-video').play()});
  await fallback.page.waitForFunction(prior=>fixture.trace.filter(x=>x.kind==='startLoad').length>prior,resumeLoads);
  const phase=await fallback.page.evaluate(()=>{
    fixture.finishPlay();fixture.presentFrame();fixture.currentTime=fixture.sourceDuration+20;
    const position=fixture.views[1].recordingPosition(fixture.currentTime);fixture.nativeCapable=true;
    fixture.players[1].handlers.get('error')(null,{fatal:true});return position;
  });
  await fallback.page.waitForFunction(()=>document.getElementById('main').dataset.playbackFallback==='player-error');
  assert.equal(await fallback.page.evaluate(()=>fixture.source),origin+'/media/dejavu-4k/index.m3u8');
  assert.equal(await fallback.page.evaluate(()=>fixture.players.every(p=>p.destroyed)&&fixture.peers.every(p=>p.stopped)),true);
  const nativePlayCalls=await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length);
  await fallback.page.evaluate(()=>{fixture.readyState=4;document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'))});
  assert.equal(await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),nativePlayCalls+1,
    'an earlier cancelled transition cannot suppress native playback after an explicit resume');
  assert.equal(await fallback.page.evaluate(()=>fixture.paused),false);
  assert(Math.abs(await fallback.page.evaluate(()=>fixture.currentTime)-phase)<0.01,'native fallback restores phase, never the continuous raw offset');
  assert.equal(await fallback.page.locator('#main').getAttribute('data-playback-mode'),'recorded-vod');
  await close(fallback);checks.push('pause then explicit resume authorises a later native fallback; programme phase and approved original VOD are preserved');
  console.log(JSON.stringify({suite:'media-showcase-lifecycle',passed:true,checks,
    scope:'Real controller; explicit HLS/room/media fixtures. No decoded playback, physical-device or peer-delivery qualification.'}));
} finally { await browser?.close(); }
