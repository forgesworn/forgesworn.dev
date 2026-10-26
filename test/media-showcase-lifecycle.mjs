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
    static Events = { MEDIA_ATTACHED:'attached', MEDIA_DETACHING:'detaching', MANIFEST_PARSED:'manifest', ERROR:'error', FRAG_LOADED:'fragment' };
    static isSupported() { return fixture.engine === 'mse'; }
    constructor(config) { this.config={loader:Loader,...config}; this.handlers=new Map();
      this.mediaSource={readyState:'open',streaming:true};this.loadingEnabled=false;this.bufferingEnabled=true;
      this.inFlightFragments={main:{state:'IDLE',frag:null}};fixture.players.push(this); }
    on(event, handler) { this.handlers.set(event,handler); }
    off(event, handler) { if(this.handlers.get(event)===handler)this.handlers.delete(event); }
    attachMedia(video) { this.video=video; fixture.trace.push({kind:'attach'}); video.src='blob:fixture-pipeline'; video.load();
      queueMicrotask(()=>this.handlers.get('attached')?.(null,{mediaSource:this.mediaSource})); }
    loadSource(url) { fixture.trace.push({kind:'source',url}); queueMicrotask(()=>this.handlers.get('manifest')?.()); }
    startLoad(position) { fixture.trace.push({kind:'startLoad',position,player:fixture.players.indexOf(this)});
      this.loadingEnabled=true;this.inFlightFragments={main:{state:'FRAG_LOADING',frag:{sn:0,cc:0,type:'main'}}};
      fixture.duration=this.config.liveDurationInfinity?Infinity:fixture.sourceDuration; fixture.currentTime=position; }
    stopLoad() { this.loadingEnabled=false;fixture.trace.push({kind:'stopLoad',player:fixture.players.indexOf(this)}); }
    destroy() { this.handlers.get('detaching')?.();this.destroyed=true; this.video?.pause(); }
  }`,
  '/media-listener-session.mjs': `export function createListenerSession({onChange,room,duration}) {
    fixture.roomConfig={room,duration};
    const position=()=>fixture.recorded?((Date.now()-fixture.startedAt)/1000)%fixture.sourceDuration:50;
    let joined=false,prepared=false,publishing=false,foreign=false,token=null,generation=0,cancelCommit=null;
    let adopting=false,committingToken=null,commitPromise=null;
    const snapshot=()=>({ready:joined,prepared,adoptingPrepared:adopting,observed:true,connectedRelays:1,joined:joined||publishing,
      status:prepared?'prepared':publishing?'publishing':joined?'active':'observing',
      listeners:(joined?1:0)+(foreign?1:0),epochId:fixture.coldRoom&&!prepared&&!joined&&!publishing&&!foreign?null:fixture.epochId,
      position:prepared||fixture.coldRoom&&!joined&&!publishing&&!foreign?0:position(),startedAt:prepared?null:fixture.startedAt});
    const notify=()=>onChange(snapshot()); fixture.roomUpdate=notify;
    fixture.listenerSnapshot=snapshot;
    fixture.replaceEpoch=()=>{fixture.epochId='2'.repeat(64);fixture.startedAt=Date.now()-10_000;notify()};
    fixture.adoptPublishingEpoch=()=>{if(!publishing)throw new Error('Expected publishing');
      foreign=true;fixture.epochId='2'.repeat(64);fixture.startedAt=Date.now()-10_000;notify()};
    const roomApi={snapshot,position,observe:notify,join:async()=>{
      const request=++generation; fixture.trace.push({kind:'join'});
      if(fixture.holdJoin) await new Promise(resolve=>fixture.joinWaiters.push(resolve));
      if(request!==generation) throw new DOMException('Join cancelled','AbortError');
      publishing=true;notify();await Promise.resolve();
      if(request!==generation)throw new DOMException('Join cancelled','AbortError');publishing=false;joined=true;notify();
    },leave:()=>{generation++;cancelCommit?.();joined=false;prepared=false;publishing=false;adopting=false;token=null;notify()},
      stop(){generation++;cancelCommit?.();joined=false;prepared=false;publishing=false;adopting=false;token=null}};
    if(fixture.coldRoom){
      roomApi.prepareJoin=async({signal}={})=>{
        const request=++generation;fixture.trace.push({kind:'join'});
        if(fixture.holdJoin)await new Promise(resolve=>fixture.joinWaiters.push(resolve));
        if(request!==generation)throw new DOMException('Prepare cancelled','AbortError');
        if(joined)return {...snapshot(),token:null};
        if(foreign){await roomApi.join();return {...snapshot(),prepared:false,token:null};}
        fixture.preparations=(fixture.preparations||0)+1;
        if(fixture.preparations>1)fixture.epochId='3'.repeat(64);
        prepared=true;token=Object.freeze({});fixture.prepareSignal=signal;fixture.preparedEpoch=fixture.epochId;notify();return {...snapshot(),token};
      };
      roomApi.commitPreparedStart=async(value,{signal}={})=>{
        if(publishing&&value&&value===committingToken)return commitPromise;
        const request=generation;fixture.trace.push({kind:'commit'});
        if(value!==token||!prepared||signal?.aborted)throw new DOMException('Invalid preparation','AbortError');
        const candidate=fixture.preparedEpoch??fixture.epochId;committingToken=value;
        if(fixture.adoptOnCommit){foreign=true;fixture.epochId='2'.repeat(64);}
        fixture.startedAt=Date.now()-(foreign?10_000:0);prepared=false;token=null;publishing=true;
        let acknowledge;const result=new Promise((resolve,reject)=>{
          let settled=false;
          const aborted=()=>roomApi.leave();
          const cleanup=()=>{signal?.removeEventListener('abort',aborted);if(cancelCommit===cancel)cancelCommit=null};
          const cancel=()=>{if(settled)return;settled=true;cleanup();publishing=false;prepared=false;adopting=false;notify();reject(new DOMException('Commit cancelled','AbortError'))};
          acknowledge=()=>{
            if(settled)return;
            if(request!==generation||signal?.aborted){cancel();return;}
            // The real actor removes its operation abort listener BEFORE it
            // notifies active: that callback may retire the losing SDK.
            settled=true;cleanup();publishing=false;adopting=false;joined=true;committingToken=null;notify();
            resolve({...snapshot(),adopted:fixture.epochId!==candidate});
          };
          cancelCommit=cancel;signal?.addEventListener('abort',aborted,{once:true});
          fixture.commitWaiters.push(acknowledge);
        });
        commitPromise=result;notify();
        if(!fixture.holdCommit)queueMicrotask(acknowledge);
        return result;
      };
      fixture.autoAdoptPrepared=()=>{
        if(!prepared)throw new Error('Expected private preparation');
        const value=token;adopting=true;foreign=true;fixture.epochId='2'.repeat(64);
        void roomApi.commitPreparedStart(value,{signal:fixture.prepareSignal})
          .then(()=>fixture.autoAdoptionOutcome='ready',error=>fixture.autoAdoptionOutcome=error.name);
      };
      fixture.rejectCommit=()=>cancelCommit?.();
    }
    return roomApi;
  }`,
  '/media-public-swarm.mjs': `import * as real from '/__actual-public-swarm.mjs';
    export const PUBLIC_SWARM_SOURCE_SHA256=real.PUBLIC_SWARM_SOURCE_SHA256,PUBLIC_SWARM_RELAYS=[];
    export async function prepareRecordedSource(options){
      if(!fixture.recorded)return null;
      fixture.trace.push({kind:'prepareMetadata'});
      const recording=await real.prepareRecordedSource(options);fixture.prepared.push(recording);return recording;
    }
    export function createRecordedLive(options){const view=real.createRecordedLive(options);if(view){
      fixture.trace.push({kind:'recordedView',priorPlaylist:typeof fixture.players.at(-1)?.config.pLoader==='function'});
      fixture.views.push(view);
    }return view;}
    export function createPublicSwarm(options){
      if(options.recordedLive){
        // Validate the real adapter's private prepared-recording brand and
        // epoch/context contract; stop before enabling any network identity.
        const checked=real.createPublicSwarm(options);checked.stop();fixture.brandedAdapters++;
      }
      const peer={options,enabled:false,stopped:false,request:0,setEnabled:async value=>{
        const request=++peer.request;
        if(value&&fixture.holdPeerEnable)await new Promise(resolve=>fixture.peerWaiters.push(resolve));
        if(peer.stopped||request!==peer.request)return;
        if(value&&fixture.rejectPeerEnable)throw new Error('Fixture peer preparation failed');
        peer.enabled=value;if(value)fixture.trace.push({kind:'peerReady',peer:fixture.peers.indexOf(peer)});
      },metrics:()=>fixture.peerMetrics??null,
        stop(){peer.stopped=true;peer.enabled=false}};fixture.peers.push(peer);return peer;}`,
};
const types = { '.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml' };
let browser;
const checks=[];
async function open({held=false,heldVisual=false,heldRoomCode=false,heldMetadata=false,engine='mse',reject=false,
  recorded=false,quality='full',holdPeerEnable=false,frameWitness='rvfc',coldRoom=false,holdCommit=false,observeReport=false}={}) {
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
    if(url.pathname==='/media/dejavu-swarm/catalogue-v3.json')await metadataGate;
    if(observeReport&&url.pathname==='/media-playback-report.mjs')return route.fulfill({contentType:'text/javascript',body:`
      import {createPlaybackReport as real} from '/__actual-playback-report.mjs';
      export function createPlaybackReport(options){const report=real(options);return{
        record(input){const added=report.record(input);if(added)fixture.reportSample=report.snapshot().samples.at(-1);return added},
        snapshot:()=>report.snapshot()
      }};`});
    if(fixtures[url.pathname])return route.fulfill({contentType:'text/javascript',body:fixtures[url.pathname]});
    const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname==='/__actual-public-swarm.mjs'?'/media-public-swarm.mjs':
      url.pathname==='/__actual-playback-report.mjs'?'/media-playback-report.mjs':url.pathname));if(!path.startsWith(root+sep))return route.abort();
    try{return await route.fulfill({contentType:types[extname(path)]??'application/octet-stream',body:await readFile(path)})}
    catch{return route.fulfill({status:404,body:''})}
  });
  await page.addInitScript(({engine,reject,recorded,quality,holdPeerEnable,frameWitness,coldRoom,holdCommit})=>{
    const state=window.fixture={engine,reject,players:[],peers:[],trace:[],readyState:1,currentTime:0,ranges:[],paused:true,seeking:false,source:'',
      recorded,views:[],prepared:[],brandedAdapters:0,nativeCapable:false,epochId:'1'.repeat(64),startedAt:Date.now()-50_000,
      sourceDuration:quality==='preview'?29.96:267.32,duration:quality==='preview'?29.96:267.32,wallOffset:0,
      holdJoin:true,joinWaiters:[],playWaiters:[],inTap:false,trusted:false,holdPeerEnable,peerWaiters:[],metadataHandlers:[],
      coldRoom,holdCommit,commitWaiters:[]};
    const wallNow=Date.now;Date.now=()=>wallNow()+state.wallOffset;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, callback, options) {
      if(type==='loadedmetadata'&&this.id==='lab-video')state.metadataHandlers.push(callback);
      if (type !== 'click' || this.id !== 'public-play') return add.call(this, type, callback, options);
      return add.call(this, type, function (event) {
        state.inTap = true; state.trusted = event.isTrusted;
        try { return callback.call(this, event); }
        finally { state.inTap = false; state.trusted = false; }
      }, options);
    };
    state.releaseRoom=()=>{state.holdJoin=false;for(const resolve of state.joinWaiters.splice(0))resolve()};
    state.releasePeer=()=>{state.holdPeerEnable=false;for(const resolve of state.peerWaiters.splice(0))resolve()};
    state.releaseCommit=()=>{state.holdCommit=false;for(const resolve of state.commitWaiters.splice(0))resolve()};
    state.finishPlay=()=>{state.readyState=4;state.ranges=[[0,100]];for(const {resolve}of state.playWaiters.splice(0))resolve();document.getElementById('lab-video').dispatchEvent(new Event('playing'))};
    state.presentFrame=()=>{state.frameCallback?.(performance.now(),{width:3840,height:2160})};
    state.frameCallbacks=[];state.frameRegistrations=0;
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){state.frameCallback=callback;state.frameCallbacks.push(callback);return ++state.frameRegistrations};
    HTMLVideoElement.prototype.cancelVideoFrameCallback=function(id){if(id===state.frameRegistrations)state.frameCallback=null};
    if(frameWitness==='none')Object.defineProperties(HTMLVideoElement.prototype,{
      requestVideoFrameCallback:{configurable:true,value:undefined},cancelVideoFrameCallback:{configurable:true,value:undefined},
      webkitDecodedFrameCount:{configurable:true,get:()=>undefined},videoWidth:{configurable:true,get:()=>3840},videoHeight:{configurable:true,get:()=>2160},
    });
    Object.defineProperties(HTMLMediaElement.prototype,{
      readyState:{get:()=>state.readyState},duration:{get:()=>state.duration},paused:{get:()=>state.paused},seeking:{get:()=>state.seeking},
      currentTime:{get:()=>state.currentTime,set:value=>{state.currentTime=value;state.trace.push({kind:'seek',position:value})}},
      src:{get:()=>state.source,set(value){state.source=value;if(!value.startsWith('blob:'))state.duration=state.sourceDuration;state.trace.push({kind:'src',value,crossOrigin:this.crossOrigin})}},
      buffered:{get:()=>({length:state.ranges.length,start:i=>state.ranges[i][0],end:i=>state.ranges[i][1]})},
    });
    const canPlay=HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType=function(type){return type==='application/vnd.apple.mpegurl'?state.engine==='native'||state.nativeCapable?'probably':'':canPlay.call(this,type)};
    HTMLMediaElement.prototype.play=function(){state.trace.push({kind:'play',inTap:state.inTap,trusted:state.trusted,source:state.source});
      if(state.reject)return Promise.reject(new DOMException('Gesture required','NotAllowedError'));
      state.paused=false;this.dispatchEvent(new Event('play'));return new Promise((resolve,reject)=>state.playWaiters.push({resolve,reject}));};
    HTMLMediaElement.prototype.pause=function(){state.paused=true;this.dispatchEvent(new Event('pause'));for(const {reject}of state.playWaiters.splice(0))reject(new DOMException('Paused','AbortError'))};
    HTMLMediaElement.prototype.load=function(){state.trace.push({kind:'load'})};
  },{engine,reject,recorded,quality,holdPeerEnable,frameWitness,coldRoom,holdCommit});
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
async function report(page){
  if(await page.locator('#public-stats-details').getAttribute('open')===null)await page.locator('#public-stats-details > summary').click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#public-save-report').click()]);
  const stream=await download.createReadStream();let text='';for await(const chunk of stream)text+=chunk.toString();
  await download.delete();return JSON.parse(text);
}
async function gestureOrder(page,native=false){
  // The join is asynchronous. Wait for its trace before comparing the actual
  // ordering; a slow module import must not turn a missing event into -1.
  await page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='join'));
  const trace=await page.evaluate(()=>fixture.trace);
  const play=trace.findIndex(x=>x.kind==='play'),source=trace.findIndex(x=>x.kind==='src'),join=trace.findIndex(x=>x.kind==='join');
  assert(source>=0&&play>source,'real pipeline/source is attached before play');assert(join>play,'play precedes async room setup');
  assert.equal(trace[play].inTap,true,'play stays in the original click turn');assert.equal(trace[play].trusted,true);
  assert.match(trace[play].source,native?/^https:\/\/forgesworn\.dev\/media\//:/^blob:/);
  if(native)assert.equal(trace[source].crossOrigin,'anonymous','native CORS mode is set before assigning its manifest');
}
try {
  browser=await chromium.launch({headless:true});
  const legacyFrames=await open({recorded:true,frameWitness:'none'});
  await legacyFrames.page.locator('#public-play').click();await legacyFrames.page.evaluate(()=>fixture.releaseRoom());
  await legacyFrames.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  assert.equal(await legacyFrames.page.evaluate(()=>fixture.peers[0].options.startupBufferNeeded()),false,
    'without any real per-pipeline frame witness the new startup gate stays off');
  const legacyMetadata=await legacyFrames.page.evaluate(()=>{
    fixture.finishPlay();fixture.currentTime+=0.2;
    const video=document.getElementById('lab-video');video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('waiting'));fixture.finishPlay();
    const before=fixture.trace.filter(x=>x.kind==='seek').length;
    fixture.wallOffset+=2200;video.dispatchEvent(new Event('loadedmetadata'));
    return {before,after:fixture.trace.filter(x=>x.kind==='seek').length,registrations:fixture.frameRegistrations,
      target:fixture.peers[0].options.startupBufferTarget()};
  });
  assert.equal(legacyMetadata.after,legacyMetadata.before,'legacy known-playback guard still prevents late initial alignment');
  assert.equal(legacyMetadata.registrations,0);assert.equal(legacyMetadata.target,null,'unobservable pipeline never invents a barrier/frame witness');
  await legacyFrames.page.waitForFunction(()=>document.getElementById('browser-stalls').textContent==='1');
  await legacyFrames.page.evaluate(()=>{document.getElementById('lab-video').pause();void document.getElementById('lab-video').play()});
  await legacyFrames.page.waitForFunction(()=>fixture.trace.filter(x=>x.kind==='startLoad').length===2);
  const legacyResume=await legacyFrames.page.evaluate(()=>{fixture.finishPlay();return {needed:fixture.peers[0].options.startupBufferNeeded(),
    registrations:fixture.frameRegistrations,pendingPlays:fixture.playWaiters.length,paused:fixture.paused,players:fixture.players.length,
    first:document.getElementById('first-frame').textContent,stalls:document.getElementById('browser-stalls').textContent};});
  assert.deepEqual(legacyResume,{needed:false,registrations:0,pendingPlays:0,paused:false,players:1,first:'—',stalls:'1'});
  await close(legacyFrames);checks.push('legacy browsers without a real per-pipeline frame witness opt out of the new barrier, retain late-metadata guards and resume without invented frame credit or counter resets');
  const installing=await open({holdPeerEnable:true});
  await installing.page.locator('#public-play').click();await gestureOrder(installing.page);
  await installing.page.evaluate(()=>fixture.releaseRoom());
  await installing.page.waitForFunction(()=>fixture.peerWaiters.length>0);
  assert.equal(await installing.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0,
    'full 4K cannot begin its first fragment before the peer loader is installed');
  assert.equal(await installing.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);
  await installing.page.evaluate(()=>fixture.releasePeer());
  await installing.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
  const installTrace=await installing.page.evaluate(()=>fixture.trace);
  assert(installTrace.findIndex(x=>x.kind==='peerReady')<installTrace.findIndex(x=>x.kind==='source'));
  assert.equal(installTrace.filter(x=>x.kind==='play').length,1,'loader readiness never repeats the trusted playback request');
  await close(installing);checks.push('first full 4K fragment waits for loader installation after same-gesture play');

  const freshMetadata=await open({recorded:true});
  await freshMetadata.page.locator('#public-play').click();await freshMetadata.page.evaluate(()=>fixture.releaseRoom());
  await freshMetadata.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  const initialMetadata=await freshMetadata.page.evaluate(()=>{
    const initial=fixture.currentTime;
    // The manifest chose a valid position, then the first fragment took 2.2s.
    // Metadata is available before any presented frame, just as in the real
    // trace where the next warm fragment was already cached or in flight.
    fixture.wallOffset+=2200;fixture.readyState=1;fixture.ranges=[[0,2]];
    const target=fixture.views[0].mediaTimeAt(Date.now());
    document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'));
    return {initial,target,current:fixture.currentTime,plays:fixture.trace.filter(x=>x.kind==='play').length,
      sources:fixture.trace.filter(x=>x.kind==='source').length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
      players:fixture.players.length,peers:fixture.peers.length,seeks:fixture.trace.filter(x=>x.kind==='seek').length,
      rate:document.getElementById('lab-video').playbackRate};
  });
  assert(initialMetadata.target-initialMetadata.initial>=2.15);
  assert(Math.abs(initialMetadata.current-initialMetadata.target)<0.01,
    'initial full recorded HLS metadata aligns to the fresh room time before the first frame');
  assert.deepEqual([initialMetadata.plays,initialMetadata.sources,initialMetadata.attaches,initialMetadata.players,initialMetadata.peers],
    [1,1,1,1,1],'fresh metadata alignment preserves the original pending play, source, player and peer');
  assert.equal(initialMetadata.rate,1);assert.equal(initialMetadata.seeks,1);
  await freshMetadata.page.evaluate(()=>{fixture.wallOffset+=2000;document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'))});
  assert.equal(await freshMetadata.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='seek').length),1,
    'duplicate metadata never chases the moving room clock');
  await close(freshMetadata);checks.push('initial full recorded metadata refreshes the pre-download position once without another play, source or attachment');

  const seekingMetadata=await open({recorded:true});
  await seekingMetadata.page.locator('#public-play').click();await seekingMetadata.page.evaluate(()=>fixture.releaseRoom());
  await seekingMetadata.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  await seekingMetadata.page.evaluate(()=>{
    fixture.wallOffset+=2200;fixture.readyState=1;fixture.ranges=[[0,4]];fixture.seeking=true;
    const video=document.getElementById('lab-video');video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('loadedmetadata'));
  });
  assert.equal(await seekingMetadata.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='seek').length),0,
    'an existing HLS seek owns the element until it settles');
  await seekingMetadata.page.evaluate(()=>{
    fixture.seeking=false;fixture.readyState=4;document.getElementById('lab-video').dispatchEvent(new Event('seeked'));
  });
  await seekingMetadata.page.waitForFunction(()=>fixture.trace.filter(x=>x.kind==='seek').length===1);
  const coalescedMetadata=await seekingMetadata.page.evaluate(()=>({current:fixture.currentTime,
    target:fixture.views[0].mediaTimeAt(Date.now()),plays:fixture.trace.filter(x=>x.kind==='play').length}));
  assert(Math.abs(coalescedMetadata.current-coalescedMetadata.target)<0.5);
  assert.equal(coalescedMetadata.plays,1);await close(seekingMetadata);
  checks.push('initial metadata coalesces with an existing HLS seek and then uses the fresh clock once');

  const presentedMetadata=await open({recorded:true});
  await presentedMetadata.page.locator('#public-play').click();await presentedMetadata.page.evaluate(()=>fixture.releaseRoom());
  await presentedMetadata.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  await presentedMetadata.page.evaluate(()=>{
    fixture.wallOffset+=2200;fixture.readyState=1;fixture.ranges=[[0,4]];fixture.seeking=true;
    const video=document.getElementById('lab-video');video.dispatchEvent(new Event('seeking'));
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.finishPlay();fixture.seeking=false;fixture.presentFrame();
    video.dispatchEvent(new Event('seeked'));
    delete document.getElementById('main').dataset.sharedDrift;
  });
  // Wait for the real controller's observation tick. An immediate assertion
  // would miss a forced correction leaked into its ordinary sync checks.
  await presentedMetadata.page.waitForFunction(()=>document.getElementById('main').dataset.sharedDrift!==undefined);
  assert.equal(await presentedMetadata.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='seek').length),0,
    'first presentation cancels deferred initial alignment before any later ordinary follow tick');
  assert.equal(await presentedMetadata.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);
  await close(presentedMetadata);checks.push('a frame arriving before deferred seek completion prevents an audible queued initial correction');

  for(const guard of ['paused','pagehide','first-frame','changed-epoch']) {
    const run=await open({recorded:true});
    await run.page.locator('#public-play').click();await run.page.evaluate(()=>fixture.releaseRoom());
    await run.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
    const guarded=await run.page.evaluate(guard=>{
      const video=document.getElementById('lab-video');
      const startup=fixture.peers[0].options.startupBufferTarget;
      const startupBefore=startup();
      if(guard==='paused')video.pause();
      else if(guard==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'));
      else if(guard==='first-frame'){fixture.finishPlay();fixture.presentFrame()}
      else fixture.epochId='2'.repeat(64);
      const before=fixture.trace.filter(x=>x.kind==='seek').length;
      fixture.wallOffset+=2200;fixture.readyState=1;fixture.ranges=[[0,2]];
      video.dispatchEvent(new Event('loadedmetadata'));
      return {before,after:fixture.trace.filter(x=>x.kind==='seek').length,startupBefore,startupAfter:startup()};
    },guard);
    assert.equal(guarded.after,guarded.before,`${guard} fences a late initial metadata seek`);
    assert(Number.isFinite(guarded.startupBefore),'the current player exposes a fresh startup target');
    assert.equal(guarded.startupAfter,null,`${guard} retires the startup buffer target`);
    await close(run);
  }
  checks.push('paused, departed, already-presented and changed-epoch sessions reject late initial metadata alignment');

  const replacedMetadata=await open({recorded:true});
  await replacedMetadata.page.locator('#public-play').click();await replacedMetadata.page.evaluate(()=>fixture.releaseRoom());
  await replacedMetadata.page.waitForFunction(()=>fixture.metadataHandlers.length===1);
  await replacedMetadata.page.evaluate(()=>fixture.replaceEpoch());
  await replacedMetadata.page.waitForFunction(()=>fixture.players.length===2&&fixture.metadataHandlers.length===2);
  const staleMetadata=await replacedMetadata.page.evaluate(()=>{
    fixture.wallOffset+=2200;fixture.readyState=1;fixture.ranges=[[0,2]];
    const video=document.getElementById('lab-video'),before=fixture.trace.filter(x=>x.kind==='seek').length;
    let playingEvents=0;video.addEventListener('playing',()=>playingEvents++);
    const plays=fixture.trace.filter(x=>x.kind==='play').length,pendingPlays=fixture.playWaiters.length;
    // The old callback is still a listener on the same visible element until
    // metadata arrives. It must not reinterpret the replacement's timeline.
    fixture.metadataHandlers[0].call(video,new Event('loadedmetadata'));
    const old=fixture.trace.filter(x=>x.kind==='seek').length;
    video.dispatchEvent(new Event('loadedmetadata'));
    const after=fixture.trace.filter(x=>x.kind==='seek').length,current=fixture.currentTime,target=fixture.views[1].mediaTimeAt(Date.now());
    const beforePlaying=playingEvents===0,playsAfter=fixture.trace.filter(x=>x.kind==='play').length,pendingAfter=fixture.playWaiters.length;
    fixture.finishPlay();fixture.presentFrame();fixture.wallOffset+=2200;
    fixture.metadataHandlers[1].call(video,new Event('loadedmetadata'));
    return {before,old,after:fixture.trace.filter(x=>x.kind==='seek').length,current:fixture.currentTime,
      firstAfter:after,firstCurrent:current,firstTarget:target,players:fixture.players.length,beforePlaying,plays,playsAfter,pendingPlays,pendingAfter};
  });
  assert.equal(staleMetadata.old,staleMetadata.before,'the replaced player cannot seek the current visible element');
  assert.equal(staleMetadata.firstAfter,staleMetadata.before+1,'current new-epoch metadata refreshes the room clock while its transition still awaits playing');
  assert(Math.abs(staleMetadata.firstCurrent-staleMetadata.firstTarget)<0.5);
  assert.equal(staleMetadata.beforePlaying,true);assert(staleMetadata.pendingPlays>0);
  assert.equal(staleMetadata.playsAfter,staleMetadata.plays);assert.equal(staleMetadata.pendingAfter,staleMetadata.pendingPlays,'alignment preserves the original pending play');
  assert.equal(staleMetadata.after,staleMetadata.firstAfter,'a presented current-pipeline frame fences even a saved metadata callback');
  assert.equal(staleMetadata.players,2);
  await close(replacedMetadata);checks.push('current new-epoch metadata aligns once before playing without replacing pending play; old-player and post-frame callbacks stay inert');

  const previewMetadata=await open({recorded:true,quality:'preview'});
  await previewMetadata.page.locator('#public-play').click();await previewMetadata.page.evaluate(()=>fixture.releaseRoom());
  await previewMetadata.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  assert.equal(await previewMetadata.page.evaluate(()=>fixture.metadataHandlers.length),0,
    'preview does not install the full 4K metadata alignment listener');
  await close(previewMetadata);checks.push('preview retains its existing initial metadata behaviour');

  const pausedInstall=await open({recorded:true,holdPeerEnable:true});
  await pausedInstall.page.locator('#public-play').click();await pausedInstall.page.evaluate(()=>fixture.releaseRoom());
  await pausedInstall.page.waitForFunction(()=>fixture.peerWaiters.length===1&&fixture.views.length===1);
  await pausedInstall.page.evaluate(()=>document.getElementById('lab-video').pause());
  assert.equal(await pausedInstall.page.evaluate(()=>fixture.peers[0].enabled),false);
  assert.equal(await pausedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);
  await pausedInstall.page.evaluate(()=>{fixture.paused=false;document.getElementById('lab-video').dispatchEvent(new Event('play'))});
  await pausedInstall.page.waitForFunction(()=>fixture.peers[0].stopped);
  assert.equal(await pausedInstall.page.evaluate(()=>fixture.players.length),1,'resume preserves the source-less HLS instance');
  assert.equal(await pausedInstall.page.evaluate(()=>fixture.players[0].destroyed===true),false);
  assert.equal(await pausedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='attach').length),1);
  assert.equal(await pausedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);
  await pausedInstall.page.evaluate(()=>fixture.releasePeer());
  await pausedInstall.page.waitForFunction(()=>fixture.trace.filter(x=>x.kind==='source').length===1);
  const pausedSetup=await pausedInstall.page.evaluate(()=>({players:fixture.players.length,views:fixture.views.length,
    peers:fixture.peers.length,ready:fixture.trace.filter(x=>x.kind==='peerReady').map(x=>x.peer),
    priorPlaylists:fixture.trace.filter(x=>x.kind==='recordedView').map(x=>x.priorPlaylist),
    plays:fixture.trace.filter(x=>x.kind==='play').length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
    oldViewStopped:(()=>{try{fixture.views[0].windowAt(Date.now());return false}catch{return true}})()}));
  assert.deepEqual(pausedSetup,{players:1,views:2,peers:2,ready:[1],priorPlaylists:[false,false],plays:1,attaches:1,oldViewStopped:true});
  await close(pausedInstall);checks.push('pause and native resume during peer enable retire old setup without replacing empty MSE or repeating script play');

  const departedInstall=await open({recorded:true,holdPeerEnable:true});
  await departedInstall.page.locator('#public-play').click();await departedInstall.page.evaluate(()=>fixture.releaseRoom());
  await departedInstall.page.waitForFunction(()=>fixture.peerWaiters.length===1);
  await departedInstall.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await departedInstall.page.evaluate(()=>fixture.releasePeer());await departedInstall.page.waitForTimeout(100);
  assert.equal(await departedInstall.page.evaluate(()=>fixture.players[0].destroyed&&fixture.peers[0].stopped),true);
  assert.equal(await departedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);
  assert.equal(await departedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='peerReady').length),0,'late enable cannot create a departed peer identity');
  assert.equal(await departedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);
  await close(departedInstall);checks.push('pagehide before peer enable completion leaves no late source or peer readiness');

  const changedInstall=await open({recorded:true,holdPeerEnable:true});
  await changedInstall.page.locator('#public-play').click();await changedInstall.page.evaluate(()=>fixture.releaseRoom());
  await changedInstall.page.waitForFunction(()=>fixture.peerWaiters.length===1&&fixture.views.length===1);
  await changedInstall.page.evaluate(()=>fixture.replaceEpoch());
  await changedInstall.page.waitForFunction(()=>fixture.peers[0].stopped);
  assert.equal(await changedInstall.page.evaluate(()=>fixture.players.length),1);
  assert.equal(await changedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0);
  await changedInstall.page.evaluate(()=>fixture.releasePeer());
  await changedInstall.page.waitForFunction(()=>fixture.peers.length===2&&fixture.trace.filter(x=>x.kind==='source').length===1);
  const changedSetup=await changedInstall.page.evaluate(()=>({players:fixture.players.length,plays:fixture.trace.filter(x=>x.kind==='play').length,
    attaches:fixture.trace.filter(x=>x.kind==='attach').length,originalAlive:!fixture.players[0].destroyed,
    oldStopped:fixture.peers[0].stopped,ready:fixture.trace.filter(x=>x.kind==='peerReady').map(x=>x.peer),
    epoch:fixture.peers[1].options.recordedLive.epochId,
    priorPlaylists:fixture.trace.filter(x=>x.kind==='recordedView').map(x=>x.priorPlaylist),
    oldViewStopped:(()=>{try{fixture.views[0].windowAt(Date.now());return false}catch{return true}})()}));
  assert.deepEqual(changedSetup,{players:1,plays:1,attaches:1,originalAlive:true,oldStopped:true,ready:[1],epoch:'2'.repeat(64),priorPlaylists:[false,false],oldViewStopped:true});
  await changedInstall.page.evaluate(()=>fixture.peers[0].options.onStats({peerBytes:999999}));
  assert.equal(await changedInstall.page.locator('#main').getAttribute('data-playback-mode'),'recorded-live');
  await close(changedInstall);checks.push('epoch change before first source replaces only view and cohort, restores pLoader and retains the trusted pending play');

  const previewInstall=await open({quality:'preview',holdPeerEnable:true});
  await previewInstall.page.locator('#public-play').click();await previewInstall.page.evaluate(()=>fixture.releaseRoom());
  await previewInstall.page.waitForFunction(()=>fixture.peerWaiters.length===1&&fixture.trace.some(x=>x.kind==='source'));
  assert.equal(await previewInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='peerReady').length),0,'preview keeps its existing non-blocking peer setup');
  await close(previewInstall);checks.push('preview source keeps its existing asynchronous peer preparation');

  const failedInstall=await open({holdPeerEnable:true});
  await failedInstall.page.evaluate(()=>{fixture.rejectPeerEnable=true});
  await failedInstall.page.locator('#public-play').click();await failedInstall.page.evaluate(()=>fixture.releaseRoom());
  await failedInstall.page.waitForFunction(()=>fixture.peerWaiters.length===1);
  await failedInstall.page.evaluate(()=>fixture.releasePeer());
  await failedInstall.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
  assert.equal(await failedInstall.page.evaluate(()=>fixture.players.length),1);
  assert.equal(await failedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1);
  assert.equal(await failedInstall.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='peerReady').length),0);
  await close(failedInstall);checks.push('failed full peer preparation preserves HTTP fallback on the same authorised player');

  const first=await open({held:true});
  assert.equal(await first.page.locator('#public-play').isDisabled(),true);
  assert.equal(await first.page.locator('#public-play').innerText(),'Preparing player…');
  assert.deepEqual(await first.page.evaluate(()=>({players:fixture.players.length,peers:fixture.peers.length,trace:fixture.trace})),{players:0,peers:0,trace:[]});
  assert.deepEqual(first.mediaRequests,[]);first.release();await first.page.waitForFunction(()=>!document.getElementById('public-play').disabled);
  await first.page.locator('#public-play').click();await gestureOrder(first.page);
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

  const native=await open({engine:'native'});await native.page.locator('#public-play').click();await gestureOrder(native.page,true);
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

  const cold=await open({recorded:true,coldRoom:true,holdCommit:true});
  await cold.page.locator('#public-play').click();await cold.page.evaluate(()=>fixture.releaseRoom());
  await cold.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  const prepared=await cold.page.evaluate(()=>{
    fixture.wallOffset+=4000;
    return {target:fixture.peers[0].options.startupBufferTarget(),view:fixture.views[0].mediaTimeAt(Date.now()),
      commits:fixture.trace.filter(x=>x.kind==='commit').length,count:document.getElementById('main').dataset.watcherCount,
      loads:fixture.trace.filter(x=>x.kind==='startLoad').map(x=>x.position)};
  });
  assert.equal(prepared.target,0);assert.equal(prepared.view,0);assert.equal(prepared.commits,0);
  assert.deepEqual(prepared.loads,[0],'an unpublished room prepares the genuine first raw fragment');
  assert.equal(prepared.count,'0','preparation does not invent an active watcher');
  await cold.page.evaluate(()=>{
    fixture.commitController=new AbortController();
    fixture.peers[0].options.startupBufferCommit({signal:fixture.commitController.signal})
      .then(()=>fixture.commitOutcome='done',error=>fixture.commitOutcome=error.name);
  });
  await cold.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='commit'));
  assert.deepEqual(await cold.page.evaluate(()=>{const s=fixture.listenerSnapshot();return{
    prepared:s.prepared,joined:s.joined,ready:s.ready,status:s.status,
    sources:fixture.trace.filter(x=>x.kind==='source').length,peers:fixture.peers.length}}),
    {prepared:false,joined:true,ready:false,status:'publishing',sources:1,peers:1},
    'publication is joined but unready while its real ACK is pending');
  assert.equal(await cold.page.evaluate(()=>fixture.views[0].mediaTimeAt(Date.now())),0,'pending ACK cannot start the local clock');
  await cold.page.evaluate(()=>fixture.releaseCommit());
  await cold.page.waitForFunction(()=>fixture.commitOutcome==='done');
  const anchored=await cold.page.evaluate(()=>{
    const target=fixture.peers[0].options.startupBufferTarget();
    fixture.commitController.abort();
    fixture.finishPlay();fixture.presentFrame();
    return {target,players:fixture.players.length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
      plays:fixture.trace.filter(x=>x.kind==='play').length,epoch:document.getElementById('main').dataset.sharedEpoch};
  });
  assert(anchored.target>=0&&anchored.target<0.75,'fresh playback starts against the newly acknowledged anchor');
  assert.deepEqual([anchored.players,anchored.attaches,anchored.plays],[1,1,1]);assert.equal(anchored.epoch,'1'.repeat(64));
  await cold.page.evaluate(()=>fixture.roomUpdate());
  assert.deepEqual(await cold.page.evaluate(()=>[fixture.players.length,fixture.peers.length,fixture.trace.filter(x=>x.kind==='source').length]),[1,1,1],
    'same-epoch publication, ACK and repeated ready observations do not churn the recording scope');
  await close(cold);

  for(const action of ['ack','pending-enable','pause','pagehide','ack-fail','deny-after-ack']){
    const automatic=await open({recorded:true,coldRoom:true,holdCommit:true,holdPeerEnable:action==='pending-enable',observeReport:action==='ack-fail'});
    await automatic.page.locator('#public-play').click();await automatic.page.evaluate(()=>fixture.releaseRoom());
    await automatic.page.waitForFunction(()=>fixture.peers.length===1);
    if(action!=='pending-enable')await automatic.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
    const before=await automatic.page.evaluate(()=>{
      fixture.oldMetadata=fixture.metadataHandlers.at(-1);
      fixture.oldManifest=fixture.players[0].handlers.get('manifest');
      const sources=fixture.trace.filter(x=>x.kind==='source').length;
      fixture.autoAdoptPrepared();
      const loads=fixture.trace.filter(x=>x.kind==='startLoad').length;
      fixture.oldManifest?.();fixture.oldMetadata?.();
      return{state:fixture.listenerSnapshot(),sources,loads,afterLoads:fixture.trace.filter(x=>x.kind==='startLoad').length,
        stopped:fixture.peers[0].stopped,views:fixture.views.length,oldTarget:fixture.peers[0].options.startupBufferTarget(),
        players:fixture.players.length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
        plays:fixture.trace.filter(x=>x.kind==='play').length};
    });
    assert.equal(before.state.adoptingPrepared,true);assert.equal(before.state.ready,false);
    assert.equal(before.stopped,true,'AUTO publication stops the losing SDK before ACK');
    assert.equal(before.oldTarget,null);assert.equal(before.views,1,'old recording binding is retained until ACK');
    assert.equal(before.afterLoads,before.loads,'late old manifest/metadata cannot restart the stopped scope');
    assert.deepEqual([before.players,before.attaches,before.plays],[1,1,1]);
    if(action==='pause'||action==='pagehide'||action==='ack-fail'){
      await automatic.page.evaluate(action=>{
        if(action==='pause')document.getElementById('lab-video').pause();
        else if(action==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'));
        else fixture.rejectCommit();
        fixture.releaseCommit();
      },action);
      await automatic.page.waitForFunction(()=>fixture.autoAdoptionOutcome==='AbortError');
      assert.equal(await automatic.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),before.sources,
        'failed or cancelled AUTO ACK cannot load a late source');
      if(action==='ack-fail'){
        await automatic.page.waitForFunction(()=>fixture.reportSample?.playbackFailed===true&&!document.getElementById('public-play').disabled);
        assert.equal(await automatic.page.evaluate(()=>fixture.reportSample.playbackFailed),true,
          'publication failure has an honest terminal retry owner');
      }
    }else{
      await automatic.page.evaluate(()=>fixture.releaseCommit());
      if(action==='pending-enable'){
        await automatic.page.waitForTimeout(100);
        assert.equal(await automatic.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),0,
          'retired async setup cannot load after the new ACK');
        await automatic.page.evaluate(()=>fixture.releasePeer());
      }
      await automatic.page.waitForFunction(expected=>fixture.peers.length===2&&fixture.trace.filter(x=>x.kind==='source').length===expected,before.sources+1);
      const active=await automatic.page.evaluate(()=>({players:fixture.players.length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
        plays:fixture.trace.filter(x=>x.kind==='play').length,epoch:fixture.peers[1].options.recordedLive.epochId,
        target:fixture.peers[1].options.startupBufferTarget(),sources:fixture.trace.filter(x=>x.kind==='source').length}));
      assert.deepEqual([active.players,active.attaches,active.plays],[1,1,1]);assert.equal(active.epoch,'2'.repeat(64));assert(active.target>0);
      assert.equal(active.sources,before.sources+1);
      if(action==='deny-after-ack'){
        await automatic.page.evaluate(()=>{fixture.paused=true;for(const {reject}of fixture.playWaiters.splice(0))reject(new DOMException('Denied','NotAllowedError'))});
        await automatic.page.waitForFunction(()=>document.getElementById('main').dataset.playbackPlayError==='NotAllowedError'&&!document.getElementById('public-play').disabled);
        assert.equal(await automatic.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),1,
          'setup-generation retirement retains ownership of the original pending Play rejection');
      }
    }
    await close(automatic);checks.push('automatic prepared adoption '+action+' preserves one trusted pipeline and explicit ACK/cancellation ownership');
  }

  for(const action of ['pause','adopt-at-commit','adopt-while-publishing','abort','pagehide']){
    const adopt=action.startsWith('adopt');
    const pending=await open({recorded:true,coldRoom:true,holdCommit:true});
    await pending.page.locator('#public-play').click();await pending.page.evaluate(()=>fixture.releaseRoom());
    await pending.page.waitForFunction(()=>fixture.peers.length===1&&fixture.trace.some(x=>x.kind==='startLoad'));
    await pending.page.evaluate(action=>{
      fixture.adoptOnCommit=action==='adopt-at-commit';fixture.oldMetadata=fixture.metadataHandlers.at(-1);
      fixture.commitController=new AbortController();
      fixture.peers[0].options.startupBufferCommit({signal:fixture.commitController.signal})
        .then(()=>fixture.commitOutcome='done',error=>fixture.commitOutcome=error.name);
    },action);
    await pending.page.waitForFunction(()=>fixture.listenerSnapshot().status==='publishing');
    await pending.page.evaluate(action=>{
      if(action==='adopt-while-publishing')fixture.adoptPublishingEpoch();
      else if(action==='pause')document.getElementById('lab-video').pause();
      else if(action==='abort')fixture.commitController.abort();
      else if(action==='pagehide')window.dispatchEvent(new PageTransitionEvent('pagehide'));
      fixture.releaseCommit();
    },action);
    await pending.page.waitForFunction(()=>fixture.commitOutcome==='AbortError');
    if(adopt){
      assert.equal(await pending.page.evaluate(()=>fixture.peers[0].stopped),true,
        'ACK of a changed ready epoch retires the loaded unpresented candidate after its unready notification');
      await pending.page.waitForFunction(()=>fixture.peers.length===2&&fixture.trace.filter(x=>x.kind==='source').length===2);
      const converged=await pending.page.evaluate(()=>({players:fixture.players.length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
        plays:fixture.trace.filter(x=>x.kind==='play').length,oldStopped:fixture.peers[0].stopped,
        epoch:fixture.peers[1].options.recordedLive.epochId,target:fixture.peers[1].options.startupBufferTarget(),
        metadataHandlers:fixture.metadataHandlers.length}));
      assert.deepEqual([converged.players,converged.attaches,converged.plays],[1,1,1],'a losing unpresented candidate reuses the trusted pipeline');
      assert.equal(converged.oldStopped,true);assert.equal(converged.epoch,'2'.repeat(64));assert(converged.target>0);
      assert.equal(converged.metadataHandlers,2,'new epoch arms its own initial metadata alignment');
      const retired=await pending.page.evaluate(async()=>{
        const old=fixture.peers[0],before=document.getElementById('public-peer-bytes').dataset.bytes;
        const seeks=fixture.trace.filter(x=>x.kind==='seek').length;
        fixture.oldMetadata();old.options.onStats({peerBytes:999999});
        const result=await old.options.startupBufferCommit({signal:new AbortController().signal}).then(()=>false,error=>error.name==='AbortError');
        fixture.roomUpdate();
        return{target:old.options.startupBufferTarget(),rejected:result,bytes:document.getElementById('public-peer-bytes').dataset.bytes,
          unchanged:before,seeks:fixture.trace.filter(x=>x.kind==='seek').length-seeks};
      });
      assert.equal(retired.target,null);assert.equal(retired.rejected,true);assert.equal(retired.bytes,retired.unchanged);
      assert.equal(retired.seeks,0,'old metadata and cohort callbacks cannot reach the fresh scope');
      assert.deepEqual(await pending.page.evaluate(()=>[fixture.players.length,fixture.peers.length,fixture.trace.filter(x=>x.kind==='source').length]),[1,2,2],
        'a repeated same ready epoch does not create another scope');
    }else if(action==='pause'){
      assert.equal(await pending.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='source').length),1,'late cancelled activation cannot reload or resume');
      const pausedMetadata=await pending.page.evaluate(()=>{
        const seeks=fixture.trace.filter(x=>x.kind==='seek').length;fixture.oldMetadata();
        return{seeks:fixture.trace.filter(x=>x.kind==='seek').length-seeks,target:fixture.peers[0].options.startupBufferTarget()};
      });
      assert.deepEqual(pausedMetadata,{seeks:0,target:null},'a paused publication cannot release its old cohort or metadata');
      await pending.page.evaluate(()=>{void document.getElementById('lab-video').play()});
      await pending.page.waitForFunction(()=>fixture.peers.length===2&&fixture.trace.filter(x=>x.kind==='source').length===2);
      await pending.page.evaluate(async()=>{
        await fixture.peers[1].options.startupBufferCommit({signal:new AbortController().signal});
        fixture.finishPlay();fixture.presentFrame();
      });
      const resumed=await pending.page.evaluate(()=>({players:fixture.players.length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,
        plays:fixture.trace.filter(x=>x.kind==='play').length,epoch:fixture.peers[1].options.recordedLive.epochId,
        oldStopped:fixture.peers[0].stopped}));
      assert.deepEqual([resumed.players,resumed.attaches,resumed.plays],[1,1,2],'explicit resume prepares afresh on the same empty player');
      assert.equal(resumed.oldStopped,true);assert.equal(resumed.epoch,'3'.repeat(64));
    }else{
      const late=await pending.page.evaluate(()=>{
        const seeks=fixture.trace.filter(x=>x.kind==='seek').length;fixture.oldMetadata();
        return{sources:fixture.trace.filter(x=>x.kind==='source').length,plays:fixture.trace.filter(x=>x.kind==='play').length,
          seeks:fixture.trace.filter(x=>x.kind==='seek').length-seeks,target:fixture.peers[0].options.startupBufferTarget()};
      });
      assert.deepEqual(late,{sources:1,plays:1,seeks:0,target:null},'aborted/departed publication cannot activate old bytes or metadata');
    }
    await close(pending);
  }
  checks.push('first room buffers at zero; two-phase publishing/ACK retains one trusted pipeline or hands off the bound epoch; pause, abort and departure fence retired authority');

  const preFrameResume=await open({recorded:true});
  await preFrameResume.page.locator('#public-play').click();await preFrameResume.page.evaluate(()=>fixture.releaseRoom());
  await preFrameResume.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='startLoad'));
  const beforeResume=await preFrameResume.page.evaluate(()=>{
    const options=fixture.peers[0].options;
    fixture.oldEmptyFrame=fixture.frameCallbacks[0];
    const registrations=fixture.frameRegistrations;
    fixture.oldEmptyFrame(performance.now(),{width:3840,height:2160});
    const staleLoopUnchanged=fixture.frameRegistrations===registrations;
    const needed=options.startupBufferNeeded();
    document.getElementById('lab-video').pause();fixture.holdPeerEnable=true;
    void document.getElementById('lab-video').play();
    return {loads:fixture.trace.filter(x=>x.kind==='startLoad').length,needed,staleLoopUnchanged};
  });
  assert.equal(beforeResume.needed,true);assert.equal(beforeResume.staleLoopUnchanged,true,'an initial unowned callback cannot start a duplicate observer');
  await preFrameResume.page.waitForFunction(()=>fixture.peerWaiters.length>0);
  assert.equal(await preFrameResume.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='startLoad').length),beforeResume.loads,
    'resuming before the first encoded body waits for the fresh peer loader instead of starting ordinary HTTP');
  const resumedIntent=await preFrameResume.page.evaluate(()=>({needed:fixture.peers[0].options.startupBufferNeeded(),target:fixture.peers[0].options.startupBufferTarget()}));
  assert.equal(resumedIntent.needed,true);assert(Number.isFinite(resumedIntent.target),'the adapter callback accepts the new play intent on the same pipeline');
  await preFrameResume.page.evaluate(()=>fixture.releasePeer());
  await preFrameResume.page.waitForFunction(()=>fixture.trace.filter(x=>x.kind==='startLoad').length===2);
  const resumedMetadata=await preFrameResume.page.evaluate(()=>{
    fixture.wallOffset+=2200;fixture.readyState=1;fixture.ranges=[[0,4]];
    const before=fixture.trace.filter(x=>x.kind==='seek').length;
    document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'));
    const after=fixture.trace.filter(x=>x.kind==='seek').length;
    fixture.finishPlay();
    const playingStillNeedsFrame=fixture.peers[0].options.startupBufferNeeded();
    fixture.presentFrame();
    document.getElementById('lab-video').dispatchEvent(new Event('waiting'));fixture.finishPlay();
    return {before,after,playingStillNeedsFrame,afterFrame:fixture.peers[0].options.startupBufferNeeded(),
      players:fixture.players.length,attaches:fixture.trace.filter(x=>x.kind==='attach').length,plays:fixture.trace.filter(x=>x.kind==='play').length};
  });
  assert.equal(resumedMetadata.after,resumedMetadata.before+1,'pre-frame resume preserves fresh initial metadata alignment across the play-version change');
  assert.equal(resumedMetadata.playingStillNeedsFrame,true,'playing is not a presented frame');assert.equal(resumedMetadata.afterFrame,false);
  assert.deepEqual([resumedMetadata.players,resumedMetadata.attaches,resumedMetadata.plays],[1,1,2],'resume keeps one visible pipeline and adds only its requested play');
  await preFrameResume.page.waitForFunction(()=>document.getElementById('first-frame').textContent!=='—'&&document.getElementById('browser-stalls').textContent==='1');
  const firstMetrics=await preFrameResume.page.evaluate(()=>({first:document.getElementById('first-frame').textContent,stalls:document.getElementById('browser-stalls').textContent}));
  await preFrameResume.page.evaluate(()=>{fixture.holdPeerEnable=true;document.getElementById('lab-video').pause();void document.getElementById('lab-video').play()});
  await preFrameResume.page.waitForFunction(()=>fixture.peerWaiters.length>0);
  assert.equal(await preFrameResume.page.evaluate(()=>fixture.peers[0].options.startupBufferNeeded()),false,'same-pipeline post-frame resume does not request another barrier');
  await preFrameResume.page.evaluate(()=>fixture.releasePeer());
  await preFrameResume.page.waitForFunction(()=>fixture.trace.filter(x=>x.kind==='startLoad').length===3);
  await preFrameResume.page.evaluate(()=>{fixture.finishPlay();fixture.oldPipelineFrame=fixture.frameCallback;fixture.replaceEpoch()});
  await preFrameResume.page.waitForFunction(()=>fixture.players.length===2&&fixture.peers.length===2&&fixture.trace.filter(x=>x.kind==='source').length===2);
  const replacementFrame=await preFrameResume.page.evaluate(()=>{
    const needed=fixture.peers[1].options.startupBufferNeeded(),before=fixture.frameRegistrations,callback=fixture.frameCallback;
    fixture.oldPipelineFrame(performance.now(),{width:3840,height:2160});
    const staleNeeded=fixture.peers[1].options.startupBufferNeeded(),oneLoop=before===fixture.frameRegistrations&&callback===fixture.frameCallback;
    fixture.finishPlay();fixture.presentFrame();
    return {needed,staleNeeded,oneLoop,afterFrame:fixture.peers[1].options.startupBufferNeeded(),
      first:document.getElementById('first-frame').textContent,stalls:document.getElementById('browser-stalls').textContent};
  });
  assert.deepEqual([replacementFrame.needed,replacementFrame.staleNeeded,replacementFrame.oneLoop,replacementFrame.afterFrame],[true,true,true,false],
    'a new epoch owns a new first-frame obligation; queued old callbacks cannot satisfy it or reschedule');
  assert.equal(replacementFrame.first,firstMetrics.first);assert.equal(replacementFrame.stalls,firstMetrics.stalls,'pipeline replacement preserves cumulative measurements');
  await close(preFrameResume);
  checks.push('pre-frame resume installs its peer loader before loading; actual per-pipeline frames control barriers and preserve metadata alignment, counters and one observer across epoch changes');

  for(const quality of ['full','preview']) {
    const run=await open({recorded:true,quality});
    assert.deepEqual(run.mediaRequests,[],'recording preparation fetches no metadata or video before the tap');
    await run.page.locator('#public-play').click();await gestureOrder(run.page);
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
        epoch:fixture.peers[0].options.recordedLive.epochId,oneVideo:document.querySelectorAll('video').length,
        room:fixture.roomConfig,recordingDuration:view.durationSeconds,historySeconds:view.backSeconds,
        retainsPendingFragment:view.windowAt(Date.now()+20_000).startSequence===view.originSequence,
        windowFragments:view.windowAt(Date.now()+20_000).fragments.length,
        mediaBackBuffer:player.config.backBufferLength,mediaByteTarget:player.config.maxBufferSize};
    });
    assert.equal(installed.branded,1,'the real adapter accepts the real prepared-recording WeakSet brand');
    assert.equal(installed.viewCount,1);assert.equal(installed.loader,'function');assert.equal(installed.infinite,true);
    assert.equal(installed.rate,1);assert.equal(installed.maxLatency,true);assert.equal(installed.oneVideo,1);
    assert(Math.abs(installed.position-installed.fresh)<0.25);assert(Math.abs(installed.phase-installed.expectedPhase)<0.25);
    assert.equal(installed.epoch,'1'.repeat(64));
    assert.deepEqual(installed.room,{room:`forgesworn-dejavu-listening-v${quality==='full'?2:1}-${quality}`,duration:quality==='full'?267.32:29.96});
    assert.equal(installed.recordingDuration,installed.room.duration,'the pinned programme and shared room use exactly the same duration');
    assert.equal(installed.historySeconds,24);assert.equal(installed.retainsPendingFragment,true);assert(installed.windowFragments<=64);
    assert.equal(installed.mediaBackBuffer,4);assert.equal(installed.mediaByteTarget,64*1024*1024);
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
  const nativePlayCalls=await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length);
  const phase=await fallback.page.evaluate(()=>{
    fixture.finishPlay();fixture.presentFrame();fixture.currentTime=fixture.sourceDuration+20;
    const position=fixture.views[1].recordingPosition(fixture.currentTime);fixture.nativeCapable=true;
    fixture.players[1].handlers.get('error')(null,{fatal:true});return position;
  });
  await fallback.page.waitForFunction(()=>document.getElementById('main').dataset.playbackFallback==='player-error');
  assert.equal(await fallback.page.evaluate(()=>fixture.source),origin+'/media/dejavu-4k/index.m3u8');
  assert.equal(await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='src').at(-1).crossOrigin),'anonymous','fallback enables CORS before loading cross-origin child media');
  assert.equal(await fallback.page.evaluate(()=>fixture.players.every(p=>p.destroyed)&&fixture.peers.every(p=>p.stopped)),true);
  assert.equal(await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),nativePlayCalls+1,
    'native recovery requests playback before metadata arrives, so fetching does not depend on a future metadata event');
  assert.equal(await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').at(-1).source),origin+'/media/dejavu-4k/index.m3u8');
  await fallback.page.evaluate(()=>{fixture.readyState=4;document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'))});
  assert.equal(await fallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),nativePlayCalls+1,
    'metadata restores programme phase without issuing a second play request');
  assert.equal(await fallback.page.evaluate(()=>fixture.paused),false);
  assert(Math.abs(await fallback.page.evaluate(()=>fixture.currentTime)-phase)<0.01,'native fallback restores phase, never the continuous raw offset');
  assert.equal(await fallback.page.locator('#main').getAttribute('data-playback-mode'),'recorded-vod');
  await fallback.page.evaluate(()=>{fixture.finishPlay();fixture.presentFrame();document.getElementById('lab-video').dispatchEvent(new Event('error'))});
  assert.equal(await fallback.page.locator('#public-play').isVisible(),true,'a native failure restores the visible retry action');
  assert.equal(await fallback.page.locator('#public-play').isDisabled(),false);
  assert.equal(await fallback.page.locator('#public-play').innerText(),'Play again');
  assert.equal(await fallback.page.evaluate(()=>document.getElementById('lab-video').controls),false);
  await close(fallback);checks.push('pause then explicit resume authorises a later native fallback; anonymous CORS, programme phase and approved original VOD are preserved; failure restores retry');

  for (const reject of [false,true]) {
    const recovery=await open({recorded:true});
    await recovery.page.locator('#public-play').click();await recovery.page.evaluate(()=>fixture.releaseRoom());
    await recovery.page.waitForFunction(()=>fixture.brandedAdapters===1);
    await recovery.page.evaluate(reject=>{
      fixture.finishPlay();fixture.presentFrame();fixture.nativeCapable=true;fixture.reject=reject;
      fixture.players[0].handlers.get('error')(null,{fatal:true,type:'mediaError',details:'bufferAppendError'});
    },reject);
    await recovery.page.waitForFunction(()=>document.getElementById('main').dataset.playbackFallback==='player-error');
    if(reject)await recovery.page.waitForFunction(()=>document.getElementById('main').dataset.playbackPlayError==='NotAllowedError');
    else await recovery.page.evaluate(()=>{
      const v=document.getElementById('lab-video');v.dispatchEvent(new Event('pointerdown'));v.pause();
    });
    const requested=await recovery.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length);
    assert.equal(requested,2,'one initial play and one native recovery demand');
    await recovery.page.evaluate(()=>{fixture.readyState=4;document.getElementById('lab-video').dispatchEvent(new Event('loadedmetadata'))});
    assert.equal(await recovery.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),requested,
      'late native metadata cannot undo a viewer pause or retry rejected autoplay');
    assert.equal(await recovery.page.evaluate(()=>fixture.paused),true);
    assert.equal(await recovery.page.locator('#main').getAttribute('data-shared-session'),'paused');
    await close(recovery);
  }
  checks.push('native recovery starts before metadata; later metadata cannot resume a viewer pause or retry rejected autoplay');

  const primedFallback=await open({recorded:false});
  await primedFallback.page.locator('#public-play').click();await primedFallback.page.evaluate(()=>fixture.releaseRoom());
  await primedFallback.page.waitForFunction(()=>fixture.trace.some(x=>x.kind==='source'));
  await primedFallback.page.evaluate(()=>{
    fixture.finishPlay();fixture.presentFrame();document.getElementById('lab-video').dispatchEvent(new Event('ended'));
    fixture.nativeCapable=true;fixture.players[0].handlers.get('error')(null,{fatal:true});
  });
  await primedFallback.page.waitForFunction(()=>document.getElementById('main').dataset.playbackFallback==='player-error');
  assert.equal(await primedFallback.page.evaluate(()=>fixture.trace.filter(x=>x.kind==='play').length),2,
    'an old replay priming barrier cannot suppress the replacement native demand');
  assert.equal(await primedFallback.page.locator('#public-play').getAttribute('disabled'),null);
  await close(primedFallback);checks.push('native handoff retires old replay priming before requesting replacement playback');
  const diagnostics=await open({recorded:true,coldRoom:true,observeReport:true});
  await diagnostics.page.locator('#public-play').click();await diagnostics.page.evaluate(()=>fixture.releaseRoom());
  await diagnostics.page.waitForFunction(()=>fixture.brandedAdapters===1&&fixture.trace.some(x=>x.kind==='source'));
  await diagnostics.page.evaluate(()=>{
    fixture.peerMetrics={enabled:true,peerBytes:0,uploadedBytes:0,originBytes:0,connectedPeers:0,
      topology:{connections:[]},startupBuffer:{enabled:true,state:'cancelled',reason:'caller-abort',released:0,
        failures:0,cancellations:1,commitStarted:false,commitCompleted:false}};
    const player=fixture.players[0];player.bufferingEnabled=false;player.mediaSource.streaming=false;
    player.handlers.get('error')(null,{fatal:false,type:'networkError',details:'aborted',
      frag:{type:'main',sn:'initSegment',cc:0,url:'https://private.invalid/secret'}});
  });
  // The passive fixture wrapper delegates to the real helper and observes an
  // accepted existing-tick sample. It adds no product timer or media action.
  await diagnostics.page.waitForFunction(()=>fixture.reportSample?.startupBuffer?.reason==='caller-abort');
  let observed=(await report(diagnostics.page)).samples.at(-1);
  assert.equal(observed.startupBuffer.state,'cancelled');assert.equal(observed.startupBuffer.reason,'caller-abort');
  assert.equal(observed.startupPending,true);assert.equal(observed.playbackWanted,true);
  assert.equal(observed.roomPrepared,true);assert.equal(observed.roomReady,false);
  assert.equal(observed.hls.loadingEnabled,true);assert.equal(observed.hls.bufferingEnabled,false);
  assert.deepEqual(observed.hls.main,{state:'FRAG_LOADING',sn:0,cc:0,type:'main'});
  assert.deepEqual(observed.mediaSource,{readyState:'open',streaming:false});
  assert.deepEqual(observed.lastPlayerError.fragment,{sn:'initSegment',cc:0,type:'main'});
  assert.equal(await diagnostics.page.locator('#public-play').isDisabled(),true,'diagnostics alone do not introduce a recovery policy');
  assert.doesNotMatch(JSON.stringify(observed),/private[.]invalid|secret/);
  await diagnostics.page.evaluate(async()=>{
    await fixture.peers[0].options.startupBufferCommit({signal:new AbortController().signal});
    fixture.finishPlay();fixture.presentFrame();fixture.replaceEpoch();
  });
  await diagnostics.page.waitForFunction(()=>fixture.players.length===2&&fixture.brandedAdapters===2);
  await diagnostics.page.evaluate(()=>{
    const [old,current]=fixture.players;
    current.inFlightFragments={main:{state:'PARSING',frag:{sn:12,cc:1,type:'main'}}};
    old.handlers.get('attached')(null,{mediaSource:{readyState:'closed',streaming:false}});
    fixture.peerMetrics=null;
  });
  await diagnostics.page.waitForFunction(()=>fixture.reportSample?.hls?.main?.sn===12&&fixture.reportSample.startupBuffer===null);
  observed=(await report(diagnostics.page)).samples.at(-1);
  assert.deepEqual(observed.hls.main,{state:'PARSING',sn:12,cc:1,type:'main'});
  assert.deepEqual(observed.mediaSource,{readyState:'open',streaming:true},'a late old-player attachment cannot replace the current source observation');
  assert.equal(observed.startupBuffer,null,'older or unavailable SDK metrics stay unknown');
  assert.equal(observed.roomPrepared,false);assert.equal(observed.roomReady,true);
  await diagnostics.page.evaluate(()=>{
    fixture.finishPlay();fixture.presentFrame();fixture.nativeCapable=true;
    fixture.players[1].handlers.get('error')(null,{fatal:true,type:'mediaError',details:'bufferAppendError'});
  });
  await diagnostics.page.waitForFunction(()=>fixture.reportSample?.engine==='Native HLS'&&fixture.reportSample.hls===null);
  observed=(await report(diagnostics.page)).samples.at(-1);
  assert.equal(observed.engine,'Native HLS');assert.equal(observed.hls,null);assert.equal(observed.mediaSource,null);
  assert.equal(observed.startupBuffer,null,'retired peer or Hls state is not presented as the native pipeline');
  await close(diagnostics);checks.push('stock report captures owned startup/Hls/MediaSource state, rejects stale attachments and preserves unavailable SDK/native observations');
  console.log(JSON.stringify({suite:'media-showcase-lifecycle',passed:true,checks,
    scope:'Real controller; explicit HLS/room/media fixtures. No decoded playback, physical-device or peer-delivery qualification.'}));
} finally { await browser?.close(); }
