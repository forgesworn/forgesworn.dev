#!/usr/bin/env node
// Manual acceptance: deterministic renderer fixtures plus one real preview.
// Ten fixture members are layout data, never a claim of ten live browsers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { chromium } from 'playwright';
import { verifyEvent, matchFilter } from '../site/vendor/media-peer-demo.js';

const options = { url: 'https://forgesworn.dev/' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = { '--url': 'url', '--site': 'site', '--output': 'output', '--screenshots': 'screenshots' }[process.argv[i]];
  assert(key && process.argv[i + 1], 'Use --output PRIVATE.json [--site site] [--screenshots PRIVATE-DIR] [--url PAGE]');
  options[key] = ['site', 'output', 'screenshots'].includes(key) ? resolve(process.argv[i + 1]) : process.argv[i + 1];
}
assert(options.output); const origin = new URL(options.url).origin; assert.equal(origin, 'https://forgesworn.dev');
const fixturePath = '/__private-swarm-experience';
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const receipt = { schema: 1, at: new Date().toISOString(), passed: false, page: options.url,
  layoutScope: 'Ten explicit synthetic renderer members at1440/390/320px; not ten live visitors or a performance benchmark',
  mediaScope: 'One actual remote1080p preview and native audio/video path; local signed Nostr wire fixture',
  privateReferenceAndSampleCapture: true, mediaOrTimingOverrides: false, hiddenMediaElements: 0,
  sources: [], layout: [], media: {}, errors: [], cleanup: {} };
const clients = new Set(), stored = new Map(), contexts = [];
let browser, guard, stage = 'setup';
const send = (client, frame) => { try { client.route.send(JSON.stringify(frame)); } catch {} };
const matches = (event, filter) => { try { return matchFilter(filter, event); } catch { return false; } };
function localRelay(route) {
  const client = { route, filters: new Map() }; clients.add(client); route.onClose(() => clients.delete(client));
  route.onMessage(raw => {
    let frame; try { if (typeof raw !== 'string' || raw.length > 131072) return; frame = JSON.parse(raw); } catch { return; }
    const [op, id, filter] = frame;
    if (op === 'CLOSE') return client.filters.delete(id);
    if (op === 'REQ') {
      if (!filter || client.filters.size >= 16) return; client.filters.set(id, filter);
      for (const event of stored.values()) if (matches(event, filter)) send(client, ['EVENT', id, event]);
      return send(client, ['EOSE', id]);
    }
    const event = id; try { if (op !== 'EVENT' || !verifyEvent(event)) return; } catch { return; }
    if (event.kind === 30378) {
      const key = event.pubkey + ':' + event.tags.find(tag => tag[0] === 'd')?.[1], old = stored.get(key);
      if (!old || event.created_at > old.created_at || event.created_at === old.created_at && event.id < old.id) stored.set(key, event);
      if (stored.size > 16) stored.delete(stored.keys().next().value);
    }
    send(client, ['OK', event.id, true, '']);
    for (const other of clients) for (const [sub, f] of other.filters) if (matches(event, f)) send(other, ['EVENT', sub, event]);
  });
}
function instrumentation() {
  const qa = window.__swarmExperienceQa = { calls: [], audioContexts: 0, elementSources: 0, streamCaptures: 0, getUserMedia: 0, sampleId: 0 };
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name]; if (typeof Native !== 'function') continue;
    window[name] = class extends Native { constructor(...args) { super(...args); qa.audioContexts++; } };
    const original = Native.prototype.createMediaElementSource;
    if (original && !original.__fixtureObserved) {
      const observed = function(...args) { qa.elementSources++; return original.apply(this, args); };
      observed.__fixtureObserved = true; Native.prototype.createMediaElementSource = observed;
    }
  }
  for (const name of ['captureStream', 'mozCaptureStream']) {
    const original = HTMLMediaElement.prototype[name];
    if (original) HTMLMediaElement.prototype[name] = function(...args) { qa.streamCaptures++; return original.apply(this, args); };
  }
  if (navigator.mediaDevices?.getUserMedia) {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { qa.getUserMedia++; return original(...args); };
  }
}
const fixtureHtml = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/media-showcase.css"><body class="media-page"><main class="media-showcase"><section class="swarm-stage"><div id="public-swarm-map" class="swarm-map" data-statistics="public-swarm-statistics"></div><div id="public-swarm-statistics" class="swarm-statistics" data-swarm-statistics></div></section></main><script type="module">
import {createSwarmVisual} from '/media-swarm-visual.mjs';
const id=n=>n.toString(16).padStart(64,'0');const visual=createSwarmVisual(document.getElementById('public-swarm-map'));
function metrics(kind){if(kind==='unknown')return{active:false,playing:false,room:{observed:false,members:[]}};if(kind==='empty')return{active:false,playing:false,room:{observed:true,members:[],listeners:0}};
const now=Date.now(),members=Array.from({length:10},(_,i)=>({id:id(i+1),isSelf:i===0,epochId:id(500),lastSeenAt:now,expiresAt:now+24000,telemetryExpiresAt:now+12000,
telemetry:{peerId:id(i+101),sampledAt:now,positionMs:5000,following:true,originBytes:2000000+i*100000,peerBytes:300000+i*1000,uploadedBytes:400000+i*1000,connections:i>0?[{peerId:id((i%9)+102),sentBytes:400000,receivedBytes:300000}]:[]}}));
return{active:true,playing:true,enabled:true,serving:true,viewerId:id(101),originBytes:2000000,peerBytes:300000,uploadedBytes:400000,connectedPeers:2,
room:{id:id(1),observed:true,ready:true,joined:true,epochId:id(500),members,listeners:10},topology:{connections:[1,2].map(i=>({id:'peer-'+i,peerId:id(i+101),state:'connected',kind:'direct',mediaBytesSent:10000*i,verifiedMediaBytesReceived:20000*i}))}};}
window.fixture={visual,show(kind){const value=metrics(kind);visual.update(value);return value;}};fixture.show('unknown');window.fixtureReady=true;
</script>`;
const replaceOnce = (source, from, to) => { assert.equal(source.split(from).length, 2, `Private capture anchor missing: ${from}`); return source.replace(from, to); };
async function context(viewport) {
  const value = await browser.newContext({ viewport }); contexts.push(value); await value.addInitScript(instrumentation);
  await value.routeWebSocket(/^wss:\/\/(?:relay\.damus\.io|nos\.lol|relay\.primal\.net)\/?$/u, localRelay);
  await value.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === fixturePath) return route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml });
    if (/\.(?:m3u8|mp4|m4s)$/u.test(path)) return route.continue();
    let body, headers;
    if (options.site) {
      const file = resolve(options.site, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (relative(options.site, file).startsWith('..')) return route.abort();
      try { body = await readFile(file); headers = { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }; }
      catch { return route.fulfill({ status: 404, body: 'Not found' }); }
    } else { const response = await route.fetch(); body = await response.body(); headers = response.headers(); }
    if (path === '/media-swarm-visual.mjs') {
      const source = replaceOnce(body.toString(), 'export function createSwarmVisual(', 'function __fixtureCreateSwarmVisual(');
      body = Buffer.from(source + `\nexport function createSwarmVisual(...args){const visual=__fixtureCreateSwarmVisual(...args),set=visual.setAudioPulse.bind(visual);globalThis.__swarmExperienceQa.visual=visual;visual.setAudioPulse=value=>{const q=globalThis.__swarmExperienceQa,v=document.getElementById('lab-video');q.calls.push({at:performance.now(),time:v?.currentTime,paused:v?.paused,hidden:document.hidden,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,sampleId:q.sampleId,sample:q.sample,energy:value.energy,beat:value.beat});if(q.calls.length>1800)q.calls.shift();return set(value);};return visual;}\n`);
    }
    if (path === '/media-music-pulse.mjs') body = Buffer.from(replaceOnce(body.toString(),
      'onPulse(sampleMusicPulse(timelines[getQuality()], video.currentTime));',
      '{ const sampledTime = video.currentTime, quality = getQuality(); globalThis.__swarmExperienceQa.sampleId++; globalThis.__swarmExperienceQa.sample = { time: sampledTime, quality }; onPulse(sampleMusicPulse(timelines[quality], sampledTime)); }'));
    const cleaned = { ...headers }; delete cleaned['content-length']; delete cleaned['content-encoding'];
    return route.fulfill({ status: 200, headers: cleaned, body });
  });
  return value;
}
async function geometry(page) {
  return page.evaluate(() => {
    const map=document.getElementById('public-swarm-map'),svg=map.querySelector('svg.swarm-canvas'),stats=document.getElementById('public-swarm-statistics');
    const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    return{svg:rect(svg),stats:stats&&rect(stats),labels:[...svg.querySelectorAll('text')].map(node=>({text:node.textContent,...rect(node)})),
      memberCount:svg.querySelectorAll('[data-room-member-id]').length,overflow:document.documentElement.scrollWidth>innerWidth,
      statsText:stats?.textContent, audio:[...svg.querySelectorAll('[data-audio-pulse]')].map(node=>({...node.dataset,owner:node.parentElement.dataset.swarmNode})),
      facts:[...svg.querySelectorAll('[data-edge-kind]')].map(node=>({id:node.dataset.edgeId,kind:node.dataset.edgeKind,
        values:[...node.querySelectorAll('[data-cumulative-bytes]')].map(path=>path.dataset.cumulativeBytes)}))};
  });
}
function checkGeometry(value, ten) {
  assert.equal(value.overflow,false); assert(value.stats && value.stats.y >= value.svg.bottom-1,'statistics sit below the picture');
  if(ten)assert.equal(value.memberCount,10,'every supplied fixture member has a real visible node');
  for(const label of value.labels){assert(/^(?:Broadcast|You|Listener\s*\d{1,2})$/u.test(label.text),`Only short names belong in the graph: ${label.text}`);
    assert(label.height>=11,'labels retain readable screen size');assert(label.x>=value.svg.x-1&&label.right<=value.svg.right+1&&label.y>=value.svg.y-1&&label.bottom<=value.svg.bottom+1,'short labels stay inside the SVG');}
  for(let i=0;i<value.labels.length;i++)for(let j=i+1;j<value.labels.length;j++){const a=value.labels[i],b=value.labels[j];assert(a.right+2<=b.x||b.right+2<=a.x||a.bottom+2<=b.y||b.bottom+2<=a.y,`Labels overlap: ${a.text}/${b.text}`);}
}
async function zeroPulse(page, state) {
  await page.waitForFunction(state=>document.getElementById('public-swarm-map').dataset.musicPulseState===state,state,{polling:100,timeout:5000});
  await page.waitForTimeout(350);
  const value=await page.evaluate(()=>{const map=document.getElementById('public-swarm-map'),node=map.querySelector('[data-audio-pulse]'),last=window.__swarmExperienceQa.calls.at(-1);return{state:map.dataset.musicPulseState,ornament:node&&{...node.dataset},last,video:{time:document.getElementById('lab-video').currentTime,paused:document.getElementById('lab-video').paused}};});
  assert.equal(value.last.energy,0);assert.equal(value.last.beat,0);return value;
}
async function shot(page,name) {
  if(!options.screenshots)return;await mkdir(options.screenshots,{recursive:true,mode:0o700});
  const map=page.locator('#public-swarm-map');await map.scrollIntoViewIfNeeded();
  await page.evaluate(()=>{const header=document.querySelector('.site-header'),map=document.getElementById('public-swarm-map');if(header&&map.getBoundingClientRect().top<header.getBoundingClientRect().bottom)scrollBy(0,-header.getBoundingClientRect().height-12);});
  await page.screenshot({path:resolve(options.screenshots,name+'.png'),fullPage:true});
}

try {
  if(options.site)for(const path of[new URL(options.url).pathname==='/'?'index.html':new URL(options.url).pathname.slice(1),'media-swarm-visual.mjs','media-showcase.css','media-music-pulse.mjs','media/dejavu-rhythm.json'])receipt.sources.push({path,sha256:createHash('sha256').update(await readFile(resolve(options.site,path))).digest('hex')});
  browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--mute-audio']});receipt.browserVersion=browser.version();
  const run=async()=>{
    stage='deterministic-layouts';const fixtureContext=await context({width:1440,height:1000}),fixturePage=await fixtureContext.newPage();
    fixturePage.on('pageerror',e=>receipt.errors.push(String(e)));await fixturePage.goto(origin+fixturePath);await fixturePage.waitForFunction(()=>window.fixtureReady);
    for(const width of[1440,390,320]){await fixturePage.setViewportSize({width,height:1000});for(const kind of['unknown','empty','ten']){
      await fixturePage.evaluate(kind=>window.fixture.show(kind),kind);await fixturePage.waitForTimeout(150);const value=await geometry(fixturePage);receipt.layout.push({width,kind,...value});checkGeometry(value,kind==='ten');if(kind==='ten')await shot(fixturePage,'fixture-ten-'+width);}}
    stage='decorative-pulse-preserves-measured-facts';const before=await geometry(fixturePage);
    await fixturePage.evaluate(()=>window.fixture.visual.setAudioPulse({energy:.8,beat:1}));const high=await geometry(fixturePage);
    assert.deepEqual(high.facts,before.facts);assert.equal(high.audio.length,1);assert.equal(high.audio[0].owner,'origin');
    await fixturePage.evaluate(()=>window.fixture.visual.setAudioPulse({energy:0,beat:0}));receipt.decoration={before,high,zero:await geometry(fixturePage)};
    await fixtureContext.close();
    stage='actual-preview-and-music-time';const mediaContext=await context({width:1440,height:1000}),page=await mediaContext.newPage();
    page.on('pageerror',e=>receipt.errors.push(String(e)));await page.goto(options.url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>{const b=document.getElementById('public-play');return b&&!b.disabled;});await page.selectOption('#lab-quality','preview');await page.click('#public-play');
    await page.waitForFunction(()=>{const v=document.getElementById('lab-video');return!v.paused&&v.getVideoPlaybackQuality().totalVideoFrames>0;},undefined,{timeout:25000});
    await page.locator('#public-swarm-map').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.getElementById('public-swarm-map').dataset.musicPulseState==='live',undefined,{timeout:8000});
    await page.waitForTimeout(4_000);
    receipt.media.timeline=await page.evaluate(async()=>{const{decodeRhythm,sampleMusicPulse}=await import('/media-music-pulse.mjs'),timelines=decodeRhythm(await(await fetch('/media/dejavu-rhythm.json')).json()),q=window.__swarmExperienceQa;
      const calls=q.calls.filter(c=>c.sample&&c.energy+c.beat>0);return{calls:calls.map(c=>({...c,expected:sampleMusicPulse(timelines[c.sample.quality],c.sample.time)})),audioContexts:q.audioContexts,elementSources:q.elementSources,streamCaptures:q.streamCaptures,getUserMedia:q.getUserMedia,
      videos:document.querySelectorAll('video').length,muted:document.getElementById('lab-video').muted,volume:document.getElementById('lab-video').volume};});
    assert(receipt.media.timeline.calls.length>20,'a real advancing soundtrack drives decorative samples');
    for(const call of receipt.media.timeline.calls){assert.equal(call.hidden,false);assert.equal(call.reduced,false);assert.equal(call.paused,false);assert(Math.abs(call.energy-call.expected.energy)<1e-9&&Math.abs(call.beat-call.expected.beat)<1e-9,'pulse samples the actual media timeline');}
    for(const key of['audioContexts','elementSources','streamCaptures','getUserMedia'])assert.equal(receipt.media.timeline[key],0,'music decoration does not create an audio or capture route');
    assert.equal(receipt.media.timeline.videos,1);assert.equal(receipt.media.timeline.muted,false);assert(receipt.media.timeline.volume>0);
    await shot(page,'actual-media-desktop');
    stage='pause-stops-music-pulse';await page.evaluate(()=>document.getElementById('lab-video').pause());receipt.media.paused=await zeroPulse(page,'idle');
    await page.evaluate(()=>document.getElementById('lab-video').play());await page.waitForFunction(()=>document.getElementById('public-swarm-map').dataset.musicPulseState==='live');
    stage='real-hidden-tab-stops-music-pulse';const blank=await mediaContext.newPage();await blank.goto('about:blank');await blank.bringToFront();
    await page.waitForFunction(()=>document.hidden,undefined,{polling:100,timeout:5000});receipt.media.hidden=await zeroPulse(page,'hidden');await blank.close();await page.bringToFront();
    await page.waitForFunction(()=>document.getElementById('public-swarm-map').dataset.musicPulseState==='live');
    stage='reduced-motion-stops-decoration-only';await page.emulateMedia({reducedMotion:'reduce'});receipt.media.reduced=await zeroPulse(page,'reduced');assert.equal(receipt.media.reduced.video.paused,false);
    await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>document.getElementById('public-swarm-map').dataset.musicPulseState==='live');
    stage='actual-mobile-layout';await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);receipt.media.mobile=await geometry(page);checkGeometry(receipt.media.mobile,false);await shot(page,'actual-media-mobile');
    assert.deepEqual(receipt.errors,[]);receipt.passed=true;
  };
  await Promise.race([run(),new Promise((_,reject)=>{guard=setTimeout(()=>reject(new Error('Swarm experience exceeded100s at '+stage)),100_000);})]);
}catch(error){receipt.failure={stage,message:String(error),stack:error.stack};process.exitCode=1;}
finally{clearTimeout(guard);await Promise.allSettled(contexts.map(value=>value.close()));await browser?.close();receipt.cleanup={browserClosed:true,relayClients:clients.size};
  await mkdir(dirname(options.output),{recursive:true,mode:0o700});await writeFile(options.output,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:receipt.passed,stage,layouts:receipt.layout.length,actualMusicSamples:receipt.media.timeline?.calls.length,errors:receipt.errors,cleanup:receipt.cleanup,...(receipt.failure?{failure:receipt.failure.message}:{})},null,2));}
