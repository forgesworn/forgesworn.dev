import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { startMediaLab } from '../scripts/media-lab-server.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3500) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await wait(25); } assert.fail('bounded wait expired'); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
const data = Buffer.alloc(32768, 90);

async function fixture(t, { stalled = false, stubborn = false, publisherStalls = false, publisherEarlyExit = false, srtSenderDrainFailure = false, srtPublisherRecordDelayMs = 0,
  sourceVideoSeconds = 20, sourceAudioSeconds = sourceVideoSeconds, sourceVideoFrames = sourceVideoSeconds * 25,
  publisherProgressSeconds = null, publisherPriorProgressSeconds = null, publisherVideoFrames = null, publisherProgressEnd = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgesworn-lab-test-')), bin = path.join(root, 'bin'), site = path.join(root, 'site');
  await mkdir(bin); await mkdir(site);
  const pidFile = path.join(root, 'pids.jsonl'), requestFile = path.join(root, 'requests.jsonl');
  const input = path.join(root, 'private-licensed-source.mp4'); await writeFile(input, 'generated test fixture, not real media');
  await writeFile(path.join(site, 'media-lab.html'), '<h1>Media lab fixture</h1>');
  await symlink(input, path.join(site, 'source-link.mp4'));
  const code = `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http'),net=require('node:net'),dgram=require('node:dgram'),path=require('node:path'),{spawn}=require('node:child_process');
const kind=path.basename(process.argv[1]),args=process.argv.slice(2);
if(args.includes('--version')){console.log(kind+' 1.2.3');process.exit(0);}
if(kind==='ffprobe'){console.log(JSON.stringify({format:{start_time:'0',duration:${Math.max(sourceVideoSeconds, sourceAudioSeconds)},bit_rate:'24300000',tags:{private:'MUST_NOT_ESCAPE'}},streams:[{codec_type:'video',codec_name:'h264',width:3840,height:2160,avg_frame_rate:'25/1',start_time:'0',duration:${sourceVideoSeconds},nb_frames:${JSON.stringify(sourceVideoFrames)}},{codec_type:'audio',codec_name:'aac',sample_rate:'48000',start_time:'0',duration:${sourceAudioSeconds}}]}));process.exit(0);}
let config,port,rtmp,srt;
if(kind==='sapflow'){port=+process.env.SAPFLOW_HTTP_ADDR.split(':')[1];rtmp=+process.env.SAPFLOW_RTMP_ADDR.split(':')[1];srt=+process.env.SAPFLOW_SRT_ADDR.split(':')[1];config={impl:process.env.SAPFLOW_HTTP_IMPL,threads:process.env.SAPFLOW_HTTP_THREADS,segments:process.env.SAPFLOW_SEGMENT_COUNT,pass:process.env.SAPFLOW_PUBLISH_PASS,callback:process.env.SAPFLOW_CALLBACK_URL};}
if(kind==='mediamtx'){config=JSON.parse(fs.readFileSync(args[0]));port=+config.hlsAddress.split(':')[1];rtmp=+config.rtmpAddress.split(':')[1];srt=+config.srtAddress.split(':')[1];}
const recordStart=()=>fs.appendFileSync(${JSON.stringify(pidFile)},JSON.stringify({kind,pid:process.pid,group:process.pid,args,config,cwd:process.cwd()})+'\\n');
if(kind==='ffmpeg'&&args.at(-1)==='-'&&${srtPublisherRecordDelayMs}>0)setTimeout(recordStart,${srtPublisherRecordDelayMs});else recordStart();
console.error('MUST_NOT_ESCAPE',${JSON.stringify(root)},process.env.SAPFLOW_PUBLISH_PASS||'');
if(kind==='ffmpeg'){if(args.at(-1)!=='-'&&!/^live[/]event-[a-z0-9-]+$/.test(new URL(args.at(-1)).pathname.slice(1))){console.error('invalid public Sapflow stream path');process.exit(64);}const seconds=+args[args.indexOf('-t')+1];let tick;if(args.at(-1)==='-')tick=setInterval(()=>process.stdout.write(Buffer.alloc(1316)),20);if(${publisherStalls}){setInterval(()=>{},1000);return;}const sentSeconds=${publisherEarlyExit}?0.1:seconds;setTimeout(()=>{clearInterval(tick);const prior=${JSON.stringify(publisherPriorProgressSeconds)},clock=${JSON.stringify(publisherProgressSeconds)}??sentSeconds,frames=${JSON.stringify(publisherVideoFrames)}??Math.round(sentSeconds*25);process.stderr.write((prior===null?'':'out_time_us='+Math.round(prior*1e6)+'\\nprogress=continue\\n')+'frame='+frames+'\\nout_time_us='+Math.round(clock*1e6)+'\\nprogress='+(${publisherProgressEnd}?'end':'continue')+'\\n',()=>process.exit(0));},sentSeconds*1000);return;}
if(kind==='srt-live-transmit'){if(!/^live[/]event-[a-z0-9-]+$/.test(new URL(args.at(-1)).searchParams.get('streamid').split(':')[1]))process.exit(64);process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(${srtSenderDrainFailure}?65:0),150));return;}
if(${stubborn}){process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.appendFileSync(${JSON.stringify(pidFile)},JSON.stringify({kind:'descendant',pid:c.pid,group:process.pid})+'\\n');}
if(${stalled}){setInterval(()=>{},1000);return;}
net.createServer(socket=>socket.end()).listen(rtmp,'127.0.0.1');dgram.createSocket('udp4').bind(srt,'127.0.0.1');
http.createServer((req,res)=>{fs.appendFileSync(${JSON.stringify(requestFile)},JSON.stringify({url:req.url,range:req.headers.range,cookie:req.headers.cookie})+'\\n');
 if(req.url.includes('cookie-check.m3u8')&&!req.url.includes('cookieCheck=1')&&!req.headers.cookie?.includes('cookieCheck=1')){res.writeHead(302,{Location:req.url+'?cookieCheck=1','Set-Cookie':['cookieCheck=1; HttpOnly; Secure; SameSite=None','MUST_NOT_ESCAPE=native-private; HttpOnly','outside-domain=must-not-send; Domain=elsewhere.invalid; Path=/','outside-path=must-not-send; Path=/outside','expired=must-not-send; Max-Age=0; Path=/']});res.end();return;}
 if(req.url.includes('cookie-limit.m3u8')){res.writeHead(200,{'Set-Cookie':Array.from({length:17},(_,i)=>'cookie-'+i+'=small; Path=/')});res.end('#EXTM3U\\n');return;}
 if(req.url.includes('cookie-bytes.m3u8')){res.writeHead(200,{'Set-Cookie':Array.from({length:3},(_,i)=>'large-'+i+'='+('x'.repeat(3000))+'; Path=/')});res.end('#EXTM3U\\n');return;}
 if(req.url.includes('redirect-loop.m3u8')){res.writeHead(302,{Location:req.url});res.end();return;}
 if(req.url.includes('redirect-other-path.m3u8')){res.writeHead(302,{Location:'/outside/index.m3u8'});res.end();return;}
 if(req.url.includes('redirect.mp4')){res.writeHead(302,{Location:'https://elsewhere.invalid/private'});res.end();return;}
 if(req.url.includes('.m3u8')){const text=req.url.includes('index.m3u8')?'#EXTM3U\\n#EXT-X-STREAM-INF:BANDWIDTH=25000000\\naudio/main.m3u8\\n':'#EXTM3U\\n#EXT-X-MAP:URI="init.mp4"\\n#EXTINF:1,\\nsegment.mp4\\n';res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':Buffer.byteLength(text),'Set-Cookie':'native-session=fixture-session; HttpOnly; Secure; Path=/'});res.end(req.method==='HEAD'?undefined:text);return;}
 if(req.url.includes('slow.mp4')){res.writeHead(200,{'Content-Type':'video/mp4'});const timer=setInterval(()=>res.write(Buffer.alloc(65536)),10);res.on('close',()=>clearInterval(timer));return;}
 const bytes=Buffer.alloc(32768,90);if(req.headers.range){const m=/bytes=(\\d+)-(\\d+)/.exec(req.headers.range);const a=+m[1],b=+m[2];res.writeHead(206,{'Content-Length':b-a+1,'Content-Range':'bytes '+a+'-'+b+'/'+bytes.length});res.end(req.method==='HEAD'?undefined:bytes.subarray(a,b+1));return;}
 res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
}).listen(port,'127.0.0.1');
`;
  for (const name of ['sapflow', 'mediamtx', 'ffmpeg', 'ffprobe', 'srt-live-transmit']) await writeFile(path.join(bin, name), code, { mode: 0o700 });
  const records = async () => { try { return (await readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const labs = new Set();
  const options = { input, siteRoot: site, sapflow: path.join(bin, 'sapflow'), mediamtx: path.join(bin, 'mediamtx'),
    ffmpeg: path.join(bin, 'ffmpeg'), ffprobe: path.join(bin, 'ffprobe'), srtLiveTransmit: path.join(bin, 'srt-live-transmit'), startupTimeoutMs: 1500, stopGraceMs: 150, sampleIntervalMs: 100, maxRunSeconds: 3 };
  t.after(async () => {
    const stopped = await Promise.allSettled([...labs].map(lab => lab.stop()));
    try {
      // Owners stop and reap first. This is fallback cleanup after a failed
      // assertion or failed owner shutdown, not a competing process owner.
      for (const group of new Set((await records()).map(row => row.group))) { try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    } finally { await rm(root, { recursive: true, force: true }); }
    for (const result of stopped) if (result.status === 'rejected') throw result.reason;
  });
  const startLab = async (overrides = {}) => { const lab = await startMediaLab({ ...options, ...overrides }); labs.add(lab); return lab; };
  return { root, input, site, records, requestFile, options, startLab };
}
function request(base, name, { method = 'GET', value, headers = {}, agent } = {}) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const endpoint = new URL(base);
    const req = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: name, method, ...(agent === undefined ? {} : { agent }), headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.once('end', () => { const bytes = Buffer.concat(chunks), text = bytes.toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, bytes, text, data }); });
    }); req.once('error', reject); req.end(body);
  });
}
const run = (base, engine = 'sapflow', transport = 'rtmp', extra = {}) => request(base, '/lab/run', { method: 'POST', value: { engine, transport, offsetSeconds: 0, durationSeconds: 2, ...extra } });

async function labFixture(t, options) { const f = await fixture(t, options); const lab = await f.startLab(); return { ...f, lab, base: new URL(lab.url).origin }; }

test('sanitised config, strict local origin and immutable executable/source choices', { timeout: 10000 }, async t => {
  const f = await labFixture(t);
  const result = await request(f.base, '/lab/config');
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.data.engines.map(item => item.id), ['sapflow', 'sapflow-own', 'mediamtx']);
  assert.equal(result.data.engines[1].profile.sapflowHttpImpl, 'own'); assert.equal(result.data.source.width, 3840);
  assert.match(result.data.source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(result.data.host.loadAverage.oneMinute));
  for (const forbidden of [f.root, f.input, 'MUST_NOT_ESCAPE', 'tags', 'private-licensed-source']) assert.ok(!result.text.includes(forbidden));
  for (const headers of [{ Host: 'evil.invalid' }, { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request(f.base, '/lab/config', { headers })).status, 403);
  assert.equal((await request(f.base, '/lab/run')).status, 405);
  for (const extra of [{ input: '/some/private/file' }, { executable: '/bin/sh' }, { offsetSeconds: -1 }, { offsetSeconds: 21 }, { durationSeconds: 331 }, { turnEngine: 'unknown' }]) assert.equal((await run(f.base, 'sapflow', 'rtmp', extra)).status, 400);
  assert.equal((await run(f.base, 'unknown')).status, 400);
  assert.equal((await request(f.base, '/source-link.mp4')).status, 403);
  assert.equal((await request(f.base, '/%2e%2e/private.mp4')).status, 403);
  assert.equal((await request(f.base, '/lab/hash?path=https%3A%2F%2Felsewhere.invalid%2Fvideo.mp4')).status, 400);
  assert.equal((await f.records()).length, 0);
});

test('real child ownership, exact presets, one active origin, SRT pipe and stale stop protection', { timeout: 15000 }, async t => {
  // The sender may report its start before the separate publisher is scheduled.
  const f = await labFixture(t, { srtPublisherRecordDelayMs: 150 });
  const first = await run(f.base); assert.equal(first.status, 200); assert.equal(first.data.profile.sapflowHttpImpl, 'hyper');
  await until(async () => (await f.records()).some(row => row.kind === 'ffmpeg'));
  let records = await f.records(), origin = records.find(row => row.kind === 'sapflow');
  const firstOwned = records.filter(row => row.cwd === origin.cwd);
  assert.match(new URL(records.find(row => row.kind === 'ffmpeg').args.at(-1)).pathname, /^\/live\/event-lab-[a-f0-9]{24}$/);
  assert.equal(origin.config.impl, 'hyper'); assert.equal(origin.config.segments, '24'); assert.equal(origin.config.callback, undefined);
  assert.ok(!first.text.includes(origin.config.pass));
  const next = await run(f.base, 'sapflow-own', 'srt'); assert.equal(next.status, 200); assert.equal(next.data.profile.httpWorkers, 1);
  for (const row of firstOwned) assert.ok(!alive(row.pid), `${row.kind} from the previous run remains alive`);
  let publisher;
  await until(async () => {
    records = await f.records();
    const ownOrigin = records.find(row => row.kind === 'sapflow' && row.config.impl === 'own');
    if (!ownOrigin) return false;
    publisher = records.find(row => row.kind === 'ffmpeg' && row.cwd === ownOrigin.cwd);
    return Boolean(publisher && records.some(row => row.kind === 'srt-live-transmit' && row.cwd === ownOrigin.cwd));
  });
  assert.ok(publisher.args.includes('copy')); assert.ok(publisher.args.includes('mpegts'));
  assert.equal((await request(f.base, '/lab/stop', { method: 'POST', value: { runId: first.data.runId } })).data.ignored, true);
  assert.equal((await request(f.base, '/lab/stats')).data.run.id, next.data.runId);
  const third = await run(f.base, 'mediamtx'); assert.equal(third.status, 200);
  const mtx = (await f.records()).find(row => row.kind === 'mediamtx');
  assert.match(Object.keys(mtx.config.paths)[0], /^live\/event-lab-[a-f0-9]{24}$/);
  assert.equal(mtx.config.moq, false); assert.equal(mtx.config.api, false); assert.equal(mtx.config.hlsSegmentCount, 24); assert.equal(mtx.config.hlsAlwaysRemux, true);
  assert.equal(third.data.profile.sapflowHttpImpl, null);
  await wait(250); const stats = (await request(f.base, '/lab/stats')).data;
  assert.ok(stats.processes.origin.rssBytes > 0); assert.ok(stats.processes.publisher.rssBytes > 0);
  assert.ok(stats.processes.origin.cpuSeconds >= 0); assert.ok(Number.isFinite(stats.processes.origin.cpuPercent));
  await request(f.base, '/lab/stop', { method: 'POST', value: { runId: third.data.runId } });
  const stopped = (await request(f.base, '/lab/stats')).data;
  assert.equal(stopped.state, 'idle'); assert.equal(stopped.run, null); assert.equal(stopped.lastRun.state, 'stopped'); assert.equal(stopped.lastRun.run.id, third.data.runId);
  for (const row of await f.records()) assert.ok(!alive(row.pid), `${row.kind} remains alive`);
});

test('streamed HLS preserves renditions/query/ranges; hashes only completed active media', { timeout: 10000 }, async t => {
  const f = await labFixture(t), started = await run(f.base), url = started.data.playlistUrl.replace('index.m3u8', 'audio/segment.mp4');
  assert.equal((await request(f.base, `/lab/hash?path=${encodeURIComponent(url)}`)).status, 404);
  const partial = await request(f.base, url, { headers: { Range: 'bytes=2-5' } }); assert.equal(partial.status, 206); assert.deepEqual(partial.bytes, data.subarray(2, 6));
  assert.equal((await request(f.base, `/lab/hash?path=${encodeURIComponent(url)}`)).status, 404);
  const received = await request(f.base, `${url}?sample=1`); assert.deepEqual(received.bytes, data); assert.equal(received.headers['content-type'], 'video/mp4');
  const hash = await request(f.base, `/lab/hash?path=${encodeURIComponent(url)}`); assert.deepEqual(hash.data, { size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  const before = (await request(f.base, '/lab/stats')).data.http;
  await request(f.base, `/lab/hash?path=${encodeURIComponent(url)}`); await request(f.base, '/lab/config');
  const after = (await request(f.base, '/lab/stats')).data.http; assert.equal(after.bytes, before.bytes); assert.equal(after.requests, before.requests);
  assert.equal(after.completed, 2); assert.equal(after.errors, 0); assert.equal(after.active, 0); assert.ok(after.firstByteMs.last >= 0); assert.ok(after.responseMs.last >= 0);
  const logs = (await readFile(f.requestFile, 'utf8')).trim().split('\n').map(JSON.parse); assert.ok(logs.some(row => row.url.endsWith('/audio/segment.mp4?sample=1')));
  assert.equal((await request(f.base, url.replace('segment.mp4', 'redirect.mp4'))).status, 502);
  await request(f.base, '/lab/stop', { method: 'POST', value: {} });
  assert.equal((await request(f.base, url)).status, 404); assert.equal((await request(f.base, `/lab/hash?path=${encodeURIComponent(url)}`)).status, 404);
});

test('native cookie-check redirects stay within the active origin subtree and a two-hop bound', { timeout: 10000 }, async t => {
  const f = await labFixture(t), started = await run(f.base), prefix = started.data.playlistUrl.replace('index.m3u8', '');
  const result = await request(f.base, `${prefix}cookie-check.m3u8`, { headers: { Cookie: 'MUST_NOT_FORWARD=browser-private' } });
  assert.equal(result.status, 200); assert.ok(result.text.startsWith('#EXTM3U')); assert.equal(result.headers['set-cookie'], undefined);
  let stats = (await request(f.base, '/lab/stats')).data.http;
  assert.equal(stats.requests, 1); assert.equal(stats.originRequests, 2); assert.equal(stats.redirectsFollowed, 1); assert.equal(stats.completed, 1); assert.equal(stats.firstByteMs.samples, 1);
  assert.equal((await request(f.base, `${prefix}cookie-check.m3u8`)).status, 200);
  stats = (await request(f.base, '/lab/stats')).data.http;
  assert.equal(stats.requests, 2); assert.equal(stats.originRequests, 3); assert.equal(stats.redirectsFollowed, 1);
  assert.equal((await request(f.base, `${prefix}redirect-loop.m3u8`)).status, 502);
  stats = (await request(f.base, '/lab/stats')).data.http;
  assert.equal(stats.originRequests, 6); assert.equal(stats.redirectsFollowed, 3); assert.equal(stats.errors, 1);
  assert.equal((await request(f.base, `${prefix}redirect-other-path.m3u8`)).status, 502);
  assert.equal((await request(f.base, `${prefix}redirect.mp4`)).status, 502);
  stats = (await request(f.base, '/lab/stats')).data.http;
  assert.equal(stats.originRequests, 8); assert.equal(stats.redirectsFollowed, 3); assert.equal(stats.errors, 3);
  const originRequests = (await readFile(f.requestFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(originRequests.every(row => !row.cookie?.includes('MUST_NOT_FORWARD')));
  assert.ok(originRequests.every(row => !row.cookie?.includes('must-not-send')));
  assert.ok(originRequests.some(row => row.cookie?.includes('native-session=fixture-session')));
  assert.ok(!JSON.stringify((await request(f.base, '/lab/stats')).data).includes('native-private'));
  assert.ok(!JSON.stringify((await request(f.base, '/lab/stats')).data).includes('fixture-session'));
  assert.ok(!JSON.stringify((await request(f.base, '/lab/config')).data).includes('MUST_NOT_ESCAPE'));
  const next = await run(f.base), nextPrefix = next.data.playlistUrl.replace('index.m3u8', '');
  assert.equal((await request(f.base, `${nextPrefix}cookie-check.m3u8`)).status, 200);
  stats = (await request(f.base, '/lab/stats')).data.http;
  assert.equal(stats.originRequests, 2); assert.equal(stats.redirectsFollowed, 1);
});

test('native session cookies have finite count and byte bounds', { timeout: 10000 }, async t => {
  const f = await labFixture(t), first = await run(f.base), firstPrefix = first.data.playlistUrl.replace('index.m3u8', '');
  assert.equal((await request(f.base, `${firstPrefix}cookie-limit.m3u8`)).status, 502);
  const second = await run(f.base), secondPrefix = second.data.playlistUrl.replace('index.m3u8', '');
  assert.equal((await request(f.base, `${secondPrefix}cookie-bytes.m3u8`)).status, 502);
  const stats = (await request(f.base, '/lab/stats')).data.http;
  assert.equal(stats.requests, 1); assert.equal(stats.originRequests, 1); assert.equal(stats.errors, 1); assert.equal(stats.active, 0);
});

test('a child-cleanup error still closes the runner HTTP listener and remains an error', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  // This owner deliberately fails shutdown; the fixture's final fallback owns
  // the remaining test children. Do not register this expected failed owner.
  const lab = await startMediaLab(f.options), base = new URL(lab.url).origin;
  const kill = process.kill;
  try {
    assert.equal((await run(base)).status, 200);
    const origin = (await f.records()).find(row => row.kind === 'sapflow');
    assert.ok(origin);
    process.kill = function (pid, signal) {
      if (pid === -origin.pid && signal === 'SIGTERM') throw Object.assign(new Error('Fixture refuses an owned child signal'), { code: 'EPERM' });
      return kill.call(this, pid, signal);
    };
    await assert.rejects(lab.stop(), { code: 'child_cleanup_failed' });
    // A new TCP connection proves listener closure. A reused pooled socket can
    // instead race shutdown and report ECONNRESET before observing the close.
    await assert.rejects(request(base, '/lab/stats', { agent: false }), { code: 'ECONNREFUSED' });
  } finally {
    process.kill = kill;
    await lab.stop().catch(() => {});
  }
});

test('client cancellation aborts origin stream without caching incomplete bytes', { timeout: 10000 }, async t => {
  const f = await labFixture(t), started = await run(f.base), url = started.data.playlistUrl.replace('index.m3u8', 'slow.mp4');
  await new Promise((resolve, reject) => { const req = http.get(new URL(url, f.base), res => { res.once('data', () => { res.destroy(); req.destroy(); resolve(); }); }); req.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); }); });
  await until(async () => (await request(f.base, '/lab/stats')).data.http.active === 0);
  const stats = (await request(f.base, '/lab/stats')).data; assert.equal(stats.http.cancelled, 1); assert.equal(stats.http.completed, 0);
  assert.equal((await request(f.base, `/lab/hash?path=${encodeURIComponent(url)}`)).status, 404);
});

test('bounded normal completion yields ended with final matching measurements', { timeout: 10000 }, async t => {
  const f = await fixture(t), lab = await f.startLab({ maxRunSeconds: 4 }); const base = new URL(lab.url).origin;
  const started = await run(base, 'sapflow', 'rtmp', { durationSeconds: 1 }); assert.equal(started.status, 200);
  await until(async () => (await request(base, '/lab/stats')).data.lastRun?.state === 'ended', 6500);
  const final = (await request(base, '/lab/stats')).data; assert.equal(final.lastRun.run.id, started.data.runId); assert.ok(final.lastRun.processes.origin.peakSampledRssBytes > 0);
  assert.equal(final.lastRun.run.publisherCompletedWindow, true); assert.equal(final.lastRun.run.publisherMediaSeconds, 1);
  for (const row of await f.records()) assert.ok(!alive(row.pid));
});

test('a clean early publisher exit is incomplete, not a completed source window', { timeout: 8000 }, async t => {
  const f = await fixture(t, { publisherEarlyExit: true }), lab = await f.startLab(); const base = new URL(lab.url).origin;
  const started = await run(base, 'sapflow', 'rtmp', { durationSeconds: 2 });
  await until(async () => (await request(base, '/lab/stats')).data.lastRun?.state === 'error');
  const final = (await request(base, '/lab/stats')).data.lastRun;
  if (started.status === 200) assert.equal(final.run.id, started.data.runId);
  assert.equal(final.error, 'publisher_incomplete'); assert.equal(final.run.publisherEnded, true); assert.equal(final.run.publisherCompletedWindow, false); assert.equal(final.run.publisherMediaSeconds, 0.1);
  for (const row of await f.records()) assert.ok(!alive(row.pid));
});

test('full-window completion independently checks video frames, mapped AAC and terminal progress', { timeout: 20000 }, async t => {
  for (const scenario of [
    { name: 'all video frames with a shorter AAC clock', options: { publisherPriorProgressSeconds: 1 }, state: 'ended', expectedClock: 0.5, expectedFrames: 25 },
    { name: 'one missing video frame', options: { publisherVideoFrames: 24 }, state: 'error', expectedClock: 0.5, expectedFrames: 25 },
    { name: 'missing terminal progress', options: { publisherProgressEnd: false }, state: 'error', expectedClock: 0.5, expectedFrames: 25 },
    { name: 'longer AAC remains required', options: { sourceAudioSeconds: 2, publisherProgressSeconds: 1 }, state: 'error', expectedClock: 2, expectedFrames: 25 },
    { name: 'unknown video total retains the original time gate', options: { sourceVideoFrames: null }, state: 'error', expectedClock: 1, expectedFrames: null },
  ]) await t.test(scenario.name, { timeout: 8000 }, async subtest => {
    const options = { sourceVideoSeconds: 1, sourceAudioSeconds: 0.5, publisherProgressSeconds: 0.5, publisherVideoFrames: 25, ...scenario.options };
    const f = await fixture(subtest, options), lab = await f.startLab(); const base = new URL(lab.url).origin;
    const started = await run(base, 'sapflow', 'rtmp', { durationSeconds: Math.max(options.sourceVideoSeconds, options.sourceAudioSeconds) }); assert.equal(started.status, 200);
    await until(async () => (await request(base, '/lab/stats')).data.lastRun?.state === scenario.state, 6000);
    const final = (await request(base, '/lab/stats')).data.lastRun;
    assert.equal(final.run.id, started.data.runId); assert.equal(final.run.expectedVideoFrames, scenario.expectedFrames);
    assert.equal(final.run.publisherVideoFrames, options.publisherVideoFrames); assert.equal(final.run.expectedProgressSeconds, scenario.expectedClock);
    assert.equal(final.run.publisherMediaSeconds, options.publisherProgressSeconds); assert.equal(final.run.publisherEnded, true);
    assert.equal(final.run.publisherProgressEnded, options.publisherProgressEnd !== false);
    assert.equal(final.run.publisherCompletedWindow, scenario.state === 'ended');
    assert.equal(final.error, scenario.state === 'ended' ? null : 'publisher_incomplete');
    for (const row of await f.records()) assert.ok(!alive(row.pid));
  });
});

test('hard deadline without publisher EOF is an error, never a completed observation', { timeout: 8000 }, async t => {
  const f = await fixture(t, { publisherStalls: true }), lab = await f.startLab({ maxRunSeconds: 1.5 }); const base = new URL(lab.url).origin;
  const started = await run(base, 'sapflow', 'rtmp', { durationSeconds: 1 }); assert.equal(started.status, 200);
  await until(async () => (await request(base, '/lab/stats')).data.lastRun?.state === 'error', 4500);
  const final = (await request(base, '/lab/stats')).data.lastRun;
  assert.equal(final.run.id, started.data.runId); assert.equal(final.run.publisherEnded, false); assert.equal(final.error, 'run_timeout'); assert.equal(final.run.endedReason, 'run_timeout');
  for (const row of await f.records()) assert.ok(!alive(row.pid));
});

test('SRT sender failure after publisher EOF invalidates the drain and completed observation', { timeout: 8000 }, async t => {
  const f = await fixture(t, { srtSenderDrainFailure: true }), lab = await f.startLab({ maxRunSeconds: 5 }); const base = new URL(lab.url).origin;
  const started = await run(base, 'sapflow', 'srt', { durationSeconds: 1 }); assert.equal(started.status, 200);
  await until(async () => (await request(base, '/lab/stats')).data.lastRun?.state === 'error', 4500);
  const final = (await request(base, '/lab/stats')).data.lastRun;
  assert.equal(final.run.id, started.data.runId); assert.equal(final.error, 'srt_sender_exited'); assert.equal(final.run.endedReason, 'srt_sender_exited');
  assert.equal(final.run.publisherEnded, true); assert.equal(final.run.publisherCompletedWindow, true); assert.equal(final.run.publisherMediaSeconds, 1);
  for (const row of await f.records()) assert.ok(!alive(row.pid));
});

test('startup timeout and disconnect clean children; shutdown escalates stubborn groups', { timeout: 12000 }, async t => {
  const f = await fixture(t, { stalled: true }), lab = await f.startLab({ startupTimeoutMs: 200 });
  const base = new URL(lab.url).origin; const result = await run(base); assert.equal(result.status, 504);
  assert.ok(!result.text.includes(f.root)); for (const row of await f.records()) assert.ok(!alive(row.pid));
  const g = await fixture(t, { stubborn: true }), active = await g.startLab();
  assert.equal((await run(new URL(active.url).origin)).status, 200); await active.stop(); await active.stop();
  for (const row of await g.records()) assert.ok(!alive(row.pid));
});

test('aborted run POST cancels startup without leaving an unknown owned run', { timeout: 8000 }, async t => {
  const f = await fixture(t, { stalled: true }), lab = await f.startLab();
  const base = new URL(lab.url), body = JSON.stringify({ engine: 'sapflow', transport: 'rtmp', offsetSeconds: 0, durationSeconds: 2 });
  const outgoing = http.request({ hostname: base.hostname, port: base.port, path: '/lab/run', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  outgoing.on('error', () => {}); outgoing.end(body);
  await until(async () => (await f.records()).some(row => row.kind === 'sapflow'));
  const interruptedId = (await request(base.origin, '/lab/stats')).data.run.id;
  outgoing.destroy();
  let result;
  await until(async () => {
    result = (await request(base.origin, '/lab/stats')).data;
    return result.state === 'idle' && result.run === null && result.lastRun?.run.id === interruptedId;
  });
  assert.equal(result.state, 'idle'); assert.equal(result.run, null); assert.equal(result.lastRun.state, 'stopped');
  for (const row of await f.records()) assert.ok(!alive(row.pid), `${row.kind} from the aborted run remains alive`);
});

test('hash catalogue is bounded and does not refetch missing metadata', { timeout: 10000 }, async t => {
  const f = await fixture(t), lab = await f.startLab({ maxRunSeconds: 15 }); const base = new URL(lab.url).origin;
  const started = await run(base, 'sapflow', 'rtmp', { durationSeconds: 12 }); assert.equal(started.status, 200);
  const prefix = started.data.playlistUrl.replace('index.m3u8', '');
  for (let index = 0; index < 513; index++) assert.equal((await request(base, `${prefix}segment-${index}.mp4`)).status, 200);
  const oldest = `${prefix}segment-0.mp4`, latest = `${prefix}segment-512.mp4`;
  assert.equal((await request(base, `/lab/hash?path=${encodeURIComponent(oldest)}`)).status, 404);
  assert.equal((await request(base, `/lab/hash?path=${encodeURIComponent(latest)}`)).status, 200);
  const before = (await request(base, '/lab/stats')).data.http.requests;
  await request(base, `/lab/hash?path=${encodeURIComponent(oldest)}`);
  assert.equal((await request(base, '/lab/stats')).data.http.requests, before);
});
