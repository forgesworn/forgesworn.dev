#!/usr/bin/env node
// Operator-started, loopback-only origin comparison. Importing starts nothing.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, realpath, stat, readFile, writeFile, mkdtemp, rm, open } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { cpus, loadavg, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';

const exec = promisify(execFile);
const HOST = '127.0.0.1';
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const MAX_BODY = 4096, MAX_RESPONSE = 64 * 1024 * 1024, MAX_HASHES = 512, MAX_TIMINGS = 2048;
const MAX_NATIVE_COOKIES = 16, MAX_COOKIE_BYTES = 8192;
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment', '.ts': 'video/mp2t', '.aac': 'audio/aac', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const PROFILE = Object.freeze({ hlsMode: 'low-latency', segmentCount: 24, segmentDurationSeconds: 1,
  partDurationSeconds: 0.2, endDrainSeconds: 12, publisherCompletionToleranceSeconds: 0.25, transcode: false, recording: false, authentication: 'matched static publisher credentials',
  sapflowHttpImpl: 'hyper', cpuPercentBasis: '100% is one CPU core', byteScope: 'HLS response body bytes read by the local proxy, excluding headers and metadata API requests' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hostLoad = () => { const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg(); return { oneMinute, fiveMinutes, fifteenMinutes }; };
const profileFor = engine => ({ ...PROFILE, sapflowHttpImpl: engine === 'mediamtx' ? null : engine === 'sapflow-own' ? 'own' : 'hyper', httpImpl: engine === 'mediamtx' ? 'mediamtx-native' : engine === 'sapflow-own' ? 'own' : 'hyper', httpWorkers: engine === 'sapflow-own' ? 1 : null });
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const freshHttp = () => ({ requests: 0, originRequests: 0, redirectsFollowed: 0, completed: 0, errors: 0, cancelled: 0, active: 0, bytes: 0,
  bytesPerSecond: 0, sampleSeconds: 0, first: [], response: [], firstCount: 0, responseCount: 0 });

function reply(response, status, body, head = false, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  response.end(head ? undefined : text);
}
function sameOrigin(request, origin) {
  const hosts = request.rawHeaders.filter((_, i) => i % 2 === 0).filter(name => name.toLowerCase() === 'host');
  return hosts.length === 1 && request.headers.host === origin.slice(7)
    && (request.headers.origin === undefined || request.headers.origin === origin)
    && (request.headers['sec-fetch-site'] === undefined || ['none', 'same-origin'].includes(request.headers['sec-fetch-site']));
}
function pathnameOf(raw) {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.length > 4096) throw failure('invalid_path');
  let name;
  try { name = decodeURIComponent(raw.split('?')[0]); } catch { throw failure('invalid_path'); }
  if (name.includes('\\') || name.includes('\0') || name.split('/').some(part => part.startsWith('.') || part === 'node_modules')) throw failure('path_not_served', 403);
  return name;
}
async function bodyJson(request) {
  if (Number(request.headers['content-length']) > MAX_BODY) { request.resume(); throw failure('body_limit', 413); }
  if (request.headers['content-length'] !== '0' && request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw failure('json_required', 415);
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { request.resume(); finish(failure('body_timeout', 408)); }, 5000);
    request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { chunks = []; finish(failure('body_limit', 413)); } else if (!settled) chunks.push(chunk); });
    request.once('end', () => { try { const value = size ? JSON.parse(Buffer.concat(chunks)) : {}; if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); finish(null, value); } catch { finish(failure('invalid_json')); } });
    request.once('error', () => finish(failure('request_cancelled', 400)));
  });
}
async function executable(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw failure('invalid_executable');
  const choices = value.includes(path.sep) ? [path.resolve(value)] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const choice of choices) {
    try { await access(choice, constants.X_OK); const resolved = await realpath(choice); if ((await stat(resolved)).isFile()) return resolved; } catch {}
  }
  throw failure('executable_unavailable');
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function safeEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'SYSTEMROOT'].includes(key)));
}
function nativeCookieHeader(run, pathname) {
  const cookies = run.nativeCookies;
  if (!cookies) return '';
  const now = Date.now(), matched = [];
  for (const [key, cookie] of cookies) {
    if (cookie.expires <= now) { cookies.delete(key); continue; }
    if (pathname === cookie.path || pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || pathname[cookie.path.length] === '/')) matched.push(cookie);
  }
  return matched.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}
function rememberNativeCookies(run, headers, pathname) {
  const cookies = run.nativeCookies ??= new Map();
  nativeCookieHeader(run, pathname);
  for (const raw of headers['set-cookie'] || []) {
    if (raw.length > 4096) return false;
    const [pair, ...attributes] = raw.split(';').map(part => part.trim()), equals = pair.indexOf('=');
    const name = pair.slice(0, equals), value = pair.slice(equals + 1);
    if (equals < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) continue;
    const attrs = new Map(attributes.map(attribute => { const at = attribute.indexOf('='); return at < 0 ? [attribute.toLowerCase(), ''] : [attribute.slice(0, at).trim().toLowerCase(), attribute.slice(at + 1).trim()]; }));
    if (attrs.has('domain') && attrs.get('domain').replace(/^\./, '').toLowerCase() !== HOST) continue;
    const scope = attrs.get('path')?.startsWith('/') ? attrs.get('path') : pathname.slice(0, pathname.lastIndexOf('/') + 1);
    if (scope.length > 1024 || /[\x00-\x20\x7f;]/.test(scope)) continue;
    let expires = Infinity;
    if (/^-?\d+$/.test(attrs.get('max-age') || '')) expires = Date.now() + Math.max(0, Number(attrs.get('max-age'))) * 1000;
    else if (attrs.has('expires') && Number.isFinite(Date.parse(attrs.get('expires')))) expires = Date.parse(attrs.get('expires'));
    const key = `${name}\0${scope}`, previous = cookies.get(key);
    if (expires <= Date.now()) { cookies.delete(key); continue; }
    cookies.set(key, { name, value, path: scope, expires });
    if (cookies.size > MAX_NATIVE_COOKIES || [...cookies.values()].reduce((bytes, cookie) => bytes + cookie.name.length + cookie.value.length + cookie.path.length + 3, 0) > MAX_COOKIE_BYTES) {
      previous ? cookies.set(key, previous) : cookies.delete(key);
      return false;
    }
  }
  return true;
}
async function identity(binary) {
  let version = 'unknown';
  try { const { stdout, stderr } = await exec(binary, ['--version'], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536, env: safeEnv() }); version = `${stdout}\n${stderr}`.match(/\bv?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)/)?.[1] || version; } catch {}
  return { version, binarySha256: await sha256(binary) };
}
async function sourceInfo(input, ffprobe) {
  const info = await stat(input);
  if (!info.isFile() || info.size < 1 || info.size > 16 * 1024 ** 3) throw failure('source_file_limit');
  let probe;
  try { const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input], { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: safeEnv() }); probe = JSON.parse(stdout); } catch { throw failure('source_probe_failed'); }
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration ?? video?.duration);
  if (video?.codec_name !== 'h264' || audio?.codec_name !== 'aac' || !Number.isFinite(duration) || duration < 1 || duration > 86400) throw failure('h264_aac_source_required');
  const [n, d] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
  const formatStart = Number(probe.format?.start_time), videoStart = Number(video.start_time), audioStart = Number(audio.start_time);
  const videoDuration = Number(video.duration), audioDuration = Number(audio.duration), frames = Number(video.nb_frames);
  const endpoint = (start, length) => [formatStart, start, length].every(Number.isFinite) && length > 0 ? Math.max(0, start + length - formatStart) : null;
  return { label: 'Licensed local media', bytes: info.size, sha256: await sha256(input), durationSeconds: duration,
    width: Number(video.width) || 0, height: Number(video.height) || 0, fps: d > 0 ? n / d : 0,
    videoFrames: Number.isSafeInteger(frames) && frames > 0 ? frames : null,
    videoEndSeconds: endpoint(videoStart, videoDuration), audioEndSeconds: endpoint(audioStart, audioDuration),
    videoCodec: 'h264', audioCodec: 'aac', audioSampleRate: Number(audio.sample_rate) || 0, bitrateBps: Number(probe.format?.bit_rate) || 0 };
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, HOST, () => { server.off('error', reject); resolve(); }); });
}
async function reservePorts() {
  const first = net.createServer(), second = net.createServer(), udp = dgram.createSocket('udp4');
  let udpReady = false;
  try {
    await listen(first); await listen(second);
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, HOST, () => { udpReady = true; resolve(); }); });
    return { ports: { http: first.address().port, rtmp: second.address().port, srt: udp.address().port },
      release: () => Promise.all([new Promise(resolve => first.close(resolve)), new Promise(resolve => second.close(resolve)), new Promise(resolve => udp.close(resolve))]) };
  } catch (error) {
    if (first.listening) first.close(); if (second.listening) second.close();
    try { if (udpReady) await new Promise(resolve => udp.close(resolve)); else udp.close(); } catch {}
    throw error;
  }
}
function spawnOwned(command, args, options, kind) {
  const record = { kind, created: performance.now(), failed: false, log: '', firstSample: null, lastSample: null,
    sample: { cpuPercent: null, averageCpuPercent: null, cpuSeconds: null, rssBytes: null, peakSampledRssBytes: null, sampledSeconds: 0, sampleCount: 0 } };
  record.child = spawn(command, args, { ...options, detached: true, stdio: kind === 'srtSender' ? ['pipe', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  const collect = chunk => { record.log = (record.log + chunk.toString()).slice(-8192); };
  if (kind !== 'publisher-srt') record.child.stdout?.on('data', collect);
  let progressPending = '';
  record.child.stderr.on('data', chunk => {
    collect(chunk);
    if (kind !== 'publisher' && kind !== 'publisher-srt') return;
    progressPending = (progressPending + chunk.toString()).slice(-8192);
    const lines = progressPending.split('\n'); progressPending = lines.pop();
    for (const line of lines) {
      const match = /^out_time_us=(\d+)\r?$/.exec(line);
      if (match && Number.isSafeInteger(Number(match[1]))) record.mediaSeconds = Number(match[1]) / 1e6;
      const frames = /^frame=(\d+)\r?$/.exec(line);
      if (frames && Number.isSafeInteger(Number(frames[1]))) record.videoFrames = Number(frames[1]);
      if (line.trim() === 'progress=end') record.progressEnded = true;
    }
  });
  // close follows drained stderr, so the final FFmpeg progress record is parsed.
  record.completion = new Promise(resolve => { record.child.once('error', () => { record.failed = true; resolve({ code: -1 }); }); record.child.once('close', (code, signal) => resolve({ code, signal })); });
  return record;
}
function groupAlive(record) {
  if (!record.child.pid) return false;
  try { process.kill(-record.child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}
async function stopOwned(record, grace) {
  if (!record?.child.pid) return;
  const kill = signal => { try { process.kill(-record.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  kill('SIGTERM');
  let until = Date.now() + grace;
  while (groupAlive(record) && Date.now() < until) await delay(20);
  if (groupAlive(record)) kill('SIGKILL');
  until = Date.now() + grace;
  while (groupAlive(record) && Date.now() < until) await delay(20);
  if (groupAlive(record)) throw failure('child_cleanup_failed', 500);
}
function cpuTime(value) {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  return clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86400;
}
async function sampleProcess(record) {
  if (!record?.child.pid || record.child.exitCode !== null || record.child.signalCode !== null) return;
  try {
    const before = performance.now();
    const { stdout } = await exec('ps', ['-o', 'time=,rss=', '-p', String(record.child.pid)], { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 4096, env: { ...safeEnv(), LC_ALL: 'C' } });
    const [time, rss] = stdout.trim().split(/\s+/), point = { at: (before + performance.now()) / 2, cpu: cpuTime(time), rss: Number(rss) * 1024 };
    if (![point.cpu, point.rss].every(Number.isFinite)) return;
    record.firstSample ??= point;
    const last = record.lastSample;
    const elapsed = (point.at - record.firstSample.at) / 1000;
    record.sample = { cpuPercent: last && point.at > last.at ? Math.max(0, 100000 * (point.cpu - last.cpu) / (point.at - last.at)) : null,
      averageCpuPercent: elapsed > 0 ? Math.max(0, 100 * (point.cpu - record.firstSample.cpu) / elapsed) : null,
      cpuSeconds: point.cpu, rssBytes: point.rss, peakSampledRssBytes: Math.max(point.rss, record.sample.peakSampledRssBytes || 0),
      sampledSeconds: elapsed, sampleCount: record.sample.sampleCount + 1 };
    record.lastSample = point;
  } catch { record.sample.cpuPercent = null; }
}
function timing(values, total) {
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  return { last: values.at(-1) ?? null, p50: at(.5), p95: at(.95), p99: at(.99), samples: total, retained: sorted.length };
}
function addTiming(metrics, key, value) { const list = metrics[key]; list.push(value); if (list.length > MAX_TIMINGS) list.shift(); metrics[`${key}Count`]++; }
function processSnapshot(record) {
  if (!record) return null;
  return { ...record.sample, uptimeSeconds: Math.max(0, (performance.now() - record.created) / 1000), running: record.child.exitCode === null && record.child.signalCode === null && !record.failed };
}
function runSnapshot(run, state) {
  const now = run.finishedAt ?? performance.now(), http = run.http;
  return { schema: 1, state, host: { loadAverage: run.finishedHostLoad ?? hostLoad() }, run: { id: run.id, engine: run.engine, transport: run.transport, turnEngine: run.turnEngine, turnTransport: run.turnTransport,
    playlistUrl: run.playlistUrl, offsetSeconds: run.offsetSeconds, durationSeconds: run.durationSeconds,
    uptimeSeconds: (now - run.created) / 1000, remainingSeconds: Math.max(0, (run.deadline - now) / 1000), publisherEnded: run.publisherEnded,
    publisherMediaSeconds: run.records.publisher?.mediaSeconds ?? null, publisherProgressEnded: run.records.publisher?.progressEnded ?? false, publisherCompletedWindow: run.publisherCompletedWindow,
    publisherVideoFrames: run.records.publisher?.videoFrames ?? null, expectedVideoFrames: run.expectedVideoFrames,
    expectedProgressSeconds: run.expectedProgressSeconds, expectedProgressBasis: run.expectedProgressBasis,
    readyAfterSeconds: run.readyAfterSeconds ?? null, endedReason: run.endedReason ?? null, hostLoadAtStart: run.hostLoadAtStart, profile: profileFor(run.engine) },
    processes: { origin: processSnapshot(run.records.origin), publisher: processSnapshot(run.records.publisher), srtSender: processSnapshot(run.records.srtSender), turn: processSnapshot(run.records.turn) },
    http: { requests: http.requests, originRequests: http.originRequests, redirectsFollowed: http.redirectsFollowed, completed: http.completed, errors: http.errors, cancelled: http.cancelled, active: http.active,
      bytes: http.bytes, bytesPerSecond: http.bytesPerSecond, sampleSeconds: http.sampleSeconds,
      firstByteMs: timing(http.first, http.firstCount), responseMs: timing(http.response, http.responseCount) }, error: run.error || null };
}

export async function startMediaLab({ input, sapflow, mediamtx, spry, coturn, port = 0, siteRoot = SITE,
  ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', srtLiveTransmit = 'srt-live-transmit', startupTimeoutMs = 15000,
  stopGraceMs = 800, maxRunSeconds = 330, sampleIntervalMs = 1000, signal, onDiagnostic } = {}) {
  if (!input || !sapflow || !mediamtx || !Number.isInteger(port) || port < 0 || port > 65535) throw failure('invalid_lab_options');
  if (![startupTimeoutMs, stopGraceMs, sampleIntervalMs, maxRunSeconds].every(Number.isFinite)
      || startupTimeoutMs < 100 || startupTimeoutMs > 30000 || stopGraceMs < 50 || stopGraceMs > 5000
      || sampleIntervalMs < 100 || sampleIntervalMs > 5000 || maxRunSeconds < 1 || maxRunSeconds > 330) throw failure('invalid_lab_limits');
  input = await realpath(input); const root = await realpath(siteRoot);
  const tools = { ffmpeg: await executable(ffmpeg), ffprobe: await executable(ffprobe) };
  try { tools.srt = await executable(srtLiveTransmit); } catch {}
  const binaries = { sapflow: await executable(sapflow), mediamtx: await executable(mediamtx) };
  if (spry) binaries.spry = await executable(spry); if (coturn) binaries.coturn = await executable(coturn);
  const identities = Object.fromEntries(await Promise.all(Object.entries(binaries).map(async ([name, file]) => [name, await identity(file)])));
  const source = await sourceInfo(input, tools.ffprobe);
  const blockedFiles = new Set([input, ...Object.values(binaries), ...Object.values(tools)]);
  const engines = ['sapflow', 'sapflow-own', 'mediamtx'].map(id => ({ id, label: id === 'sapflow' ? 'Sapflow (default Hyper)' : id === 'sapflow-own' ? 'Sapflow (own HTTP, one worker)' : 'MediaMTX',
    ...identities[id === 'sapflow-own' ? 'sapflow' : id], profile: profileFor(id), available: true }));
  const config = { schema: 1, host: { cpu: cpus()[0]?.model || 'unknown', architecture: process.arch, platform: process.platform, release: release(), logicalCpus: cpus().length, loadAverage: hostLoad() },
    source, engines, transports: tools.srt ? ['rtmp', 'srt'] : ['rtmp'],
    relays: [{ id: 'off', label: 'Direct HLS origin', available: true }, { id: 'spry', label: 'Spry TURN', available: Boolean(binaries.spry), ...identities.spry }, { id: 'coturn', label: 'coturn', available: Boolean(binaries.coturn), ...identities.coturn }],
    profile: PROFILE, limits: { maxRunSeconds, maxConcurrentHlsRequests: 32, maxHashEntries: MAX_HASHES, maxResponseBytes: MAX_RESPONSE },
    provenance: { source: 'Operator-supplied licensed recording', execution: 'Live packet-copy ingest and origin delivery on this host', comparison: 'Sequential runs; prior M4 results are not current-host measurements' } };
  let current = null, state = 'idle', lastRun = null, lastError = null, origin, closing = false, controlBusy = false, generation = 0, shutdown;
  const idle = () => ({ schema: 1, state, host: { loadAverage: hostLoad() }, run: null, processes: { origin: null, publisher: null, srtSender: null, turn: null },
    http: { requests: 0, originRequests: 0, redirectsFollowed: 0, completed: 0, errors: 0, cancelled: 0, active: 0, bytes: 0, bytesPerSecond: 0, sampleSeconds: 0, firstByteMs: timing([], 0), responseMs: timing([], 0) }, error: lastError });
  const getStats = () => ({ ...(current ? runSnapshot(current, state) : idle()), lastRun });
  async function sample(run) {
    if (run.sampling) return;
    run.sampling = true;
    try {
      await Promise.all(Object.values(run.records).filter(Boolean).map(sampleProcess));
      const now = performance.now(), elapsed = (now - run.byteSample.at) / 1000;
      if (elapsed > 0) { run.http.bytesPerSecond = (run.http.bytes - run.byteSample.bytes) / elapsed; run.http.sampleSeconds = elapsed; run.byteSample = { at: now, bytes: run.http.bytes }; }
    } finally { run.sampling = false; }
  }
  async function stopRun(run, reason = 'stopped') {
    if (!run) return;
    if (run.stopping) return run.stopping;
    run.abort.abort();
    if (current === run) state = 'stopping';
    clearTimeout(run.cap); clearTimeout(run.endDrain); clearInterval(run.sampler);
    run.stopping = (async () => {
      for (const abort of run.requests) abort();
      await sample(run);
      if (typeof onDiagnostic === 'function') {
        const cookieRedactions = [...(run.nativeCookies?.values() || [])].flatMap(cookie => [`${cookie.name}=${cookie.value}`, ...(cookie.value.length >= 8 ? [cookie.value] : [])]);
        const redact = text => [...(run.redactions || []), ...cookieRedactions].reduce((value, needle) => needle ? value.replaceAll(needle, '[redacted]') : value, String(text || '')).slice(-8192);
        try { void Promise.resolve(onDiagnostic({ code: run.error || reason, engine: run.engine, transport: run.transport,
          readiness: run.readiness,
          logs: Object.fromEntries(Object.entries(run.records).filter(([, record]) => record && record.kind !== 'turn').map(([key, record]) => [key, redact(record.log)])) })).catch(() => {}); } catch {}
      }
      const results = await Promise.allSettled([
        ...Object.values(run.records).filter(record => record && record.kind !== 'turn').map(record => stopOwned(record, stopGraceMs)),
        run.turn?.stop(),
      ]);
      if (results.some(result => result.status === 'rejected')) { run.error = 'child_cleanup_failed'; state = 'error'; throw failure('child_cleanup_failed', 500); }
      run.finishedAt = performance.now(); run.finishedHostLoad = hostLoad(); run.endedReason = reason;
      lastRun = runSnapshot(run, reason === 'ended' ? 'ended' : reason === 'stopped' || reason === 'switched' ? 'stopped' : 'error');
      if (current === run) { current = null; state = 'idle'; lastError = run.error; }
      await rm(run.cwd, { recursive: true, force: true });
    })();
    return run.stopping;
  }
  const checkRun = run => { if (closing || run.abort.signal.aborted || current !== run) throw failure('run_cancelled', 409); };
  async function waitFor(run, condition) {
    const deadline = performance.now() + startupTimeoutMs;
    while (performance.now() < deadline) {
      checkRun(run);
      if (run.records.origin?.failed || run.records.origin?.child.exitCode !== null || run.records.origin?.child.signalCode !== null) throw failure('origin_start_failed', 502);
      if (await condition()) return;
      await delay(100);
    }
    throw failure('origin_readiness_timeout', 504);
  }
  async function beginRun(body) {
    const ticket = ++generation;
    await stopRun(current, 'switched');
    if (ticket !== generation || closing) throw failure('run_cancelled', 409);
    const id = randomBytes(12).toString('hex'), now = performance.now();
    const duration = Math.min(body.durationSeconds ?? source.durationSeconds - body.offsetSeconds, source.durationSeconds - body.offsetSeconds, maxRunSeconds);
    const expectedVideoFrames = body.offsetSeconds === 0 && source.videoEndSeconds !== null && duration + 1e-6 >= source.videoEndSeconds ? source.videoFrames : null;
    // A full copied video has an independent exact frame total. FFmpeg's mux
    // progress can finish at the shorter AAC endpoint, rather than video PTS.
    // Keep the audio endpoint (clipped only by -t), never the shorter of tracks.
    const audioClock = expectedVideoFrames !== null && source.audioEndSeconds !== null && source.audioEndSeconds > 0;
    const run = { id, engine: body.engine, transport: body.transport, turnEngine: body.turnEngine, turnTransport: body.turnTransport,
      offsetSeconds: body.offsetSeconds, durationSeconds: duration, playlistUrl: `/media/lab/hls/${id}/index.m3u8`,
      expectedVideoFrames, expectedProgressSeconds: audioClock ? Math.min(duration, source.audioEndSeconds) : duration,
      expectedProgressBasis: audioClock ? 'mapped-aac-end-and-full-video-frame-count' : 'requested-media-window',
      redactions: [input, path.basename(input), ...Object.values(binaries), ...Object.values(tools)],
      created: now, hostLoadAtStart: hostLoad(), deadline: now + Math.min(maxRunSeconds, duration + 20) * 1000, publisherEnded: false, publisherCompletedWindow: false,
      records: {}, requests: new Set(), hashes: new Map(), abort: new AbortController(), http: freshHttp(), byteSample: { at: now, bytes: 0 },
      cwd: await mkdtemp(path.join(tmpdir(), 'forgesworn-media-lab-')) };
    current = run; state = 'starting'; lastError = null;
    try {
      checkRun(run);
      const reserved = await reservePorts(); run.ports = reserved.ports; await reserved.release(); checkRun(run);
      // Public Sapflow admits only live/event-*; use the same path on both origins.
      const user = 'media-lab', password = randomBytes(24).toString('hex'), stream = `live/event-lab-${id}`;
      run.redactions.push(password, run.cwd);
      run.upstreamPrefix = `/${stream}/`;
      const env = safeEnv();
      let originArgs = [];
      if (body.engine.startsWith('sapflow')) {
        Object.assign(env, { SAPFLOW_HTTP_ADDR: `${HOST}:${run.ports.http}`, SAPFLOW_RTMP_ADDR: `${HOST}:${run.ports.rtmp}`, SAPFLOW_SRT_ADDR: `${HOST}:${run.ports.srt}`,
          SAPFLOW_PUBLISH_USER: user, SAPFLOW_PUBLISH_PASS: password, SAPFLOW_SRT_IMPL: 'own', SAPFLOW_HLS_MODE: 'low-latency', SAPFLOW_SEGMENT_COUNT: String(PROFILE.segmentCount),
          SAPFLOW_HTTP_IMPL: body.engine === 'sapflow-own' ? 'own' : 'hyper', SAPFLOW_HTTP_THREADS: '1', SAPFLOW_RECONNECT_GRACE: '20', SAPFLOW_HEALTH_INTERVAL: '0', RUST_LOG: 'warn' });
      } else {
        const settings = { logLevel: 'warn', rtmp: true, rtmpAddress: `${HOST}:${run.ports.rtmp}`, srt: true, srtAddress: `${HOST}:${run.ports.srt}`,
          hls: true, hlsAddress: `${HOST}:${run.ports.http}`, hlsAlwaysRemux: true, hlsVariant: 'lowLatency', hlsSegmentDuration: '1s', hlsPartDuration: '200ms', hlsSegmentCount: PROFILE.segmentCount,
          hlsAllowOrigins: ['*'], rtsp: false, webrtc: false, moq: false, api: false, metrics: false, pprof: false, playback: false,
          authInternalUsers: [{ user, pass: password, permissions: [{ action: 'publish', path: stream }] }, { user: 'any', permissions: [{ action: 'read', path: stream }] }], paths: { [stream]: {} } };
        const file = path.join(run.cwd, 'mediamtx.yml'); await writeFile(file, JSON.stringify(settings), { mode: 0o600 }); originArgs = [file];
      }
      checkRun(run);
      const binary = binaries[body.engine === 'mediamtx' ? 'mediamtx' : 'sapflow'];
      run.records.origin = spawnOwned(binary, originArgs, { cwd: run.cwd, env }, 'origin');
      run.records.origin.completion.then(() => { if (!run.abort.signal.aborted) { run.error = 'origin_exited'; void stopRun(run, 'origin_exited').catch(() => {}); } });
      await waitFor(run, async () => { try { const response = await fetch(`http://${HOST}:${run.ports.http}/`, { signal: AbortSignal.timeout(200) }); await response.body?.cancel(); return true; } catch { return false; } });
      if (body.turnEngine !== 'off') {
        const { startLabTurnOperator } = await import('./media-lab-turn.mjs'); checkRun(run);
        run.turn = await startLabTurnOperator({ engine: body.turnEngine, spry: binaries.spry, coturn: binaries.coturn, transport: body.turnTransport, signal: run.abort.signal });
        run.records.turn = { kind: 'turn', child: run.turn.process, created: performance.now(), sample: { cpuPercent: null, cpuSeconds: null, rssBytes: null, peakSampledRssBytes: null, sampledSeconds: 0, sampleCount: 0 } };
        if (run.abort.signal.aborted) { await run.turn.stop(); throw failure('run_cancelled', 409); }
      }
      checkRun(run);
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:2', '-stats_period', '0.5', '-re', ...(body.offsetSeconds ? ['-ss', String(body.offsetSeconds)] : []), '-i', input,
        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-t', String(duration)];
      if (body.transport === 'rtmp') {
        run.records.publisher = spawnOwned(tools.ffmpeg, [...args, '-f', 'flv', `rtmp://${HOST}:${run.ports.rtmp}/${stream}?user=${user}&pass=${password}`], { cwd: run.cwd, env: safeEnv() }, 'publisher');
      } else {
        run.records.srtSender = spawnOwned(tools.srt, ['-q', '-a:no', '-chunk:1316', 'file://con', `srt://${HOST}:${run.ports.srt}?streamid=publish:${stream}:${user}:${password}&latency=200`], { cwd: run.cwd, env: safeEnv() }, 'srtSender');
        run.records.publisher = spawnOwned(tools.ffmpeg, [...args, '-f', 'mpegts', '-'], { cwd: run.cwd, env: safeEnv() }, 'publisher-srt');
        run.records.publisher.child.stdout.pipe(run.records.srtSender.child.stdin);
        run.records.srtSender.child.stdin.on('error', () => {});
        run.records.srtSender.completion.then(result => { if (!run.abort.signal.aborted && result.code !== 0) { run.error = 'srt_sender_exited'; void stopRun(run, 'srt_sender_exited').catch(() => {}); } });
      }
      run.records.publisher.completion.then(result => {
        if (run.abort.signal.aborted) return;
        run.publisherEnded = result.code === 0;
        run.publisherCompletedWindow = run.publisherEnded && run.records.publisher.progressEnded === true
          && (run.expectedVideoFrames === null || run.records.publisher.videoFrames === run.expectedVideoFrames)
          && (run.records.publisher.mediaSeconds ?? -1) >= run.expectedProgressSeconds - PROFILE.publisherCompletionToleranceSeconds;
        if (result.code !== 0) { run.error = 'publisher_exited'; void stopRun(run, 'publisher_exited').catch(() => {}); }
        else if (!run.publisherCompletedWindow) { run.error = 'publisher_incomplete'; void stopRun(run, 'publisher_incomplete').catch(() => {}); }
        else run.endDrain = setTimeout(() => void stopRun(run, 'ended').catch(() => {}), Math.min(PROFILE.endDrainSeconds * 1000, Math.max(1, run.deadline - performance.now())));
      });
      run.cap = setTimeout(() => {
        if (!run.publisherCompletedWindow) run.error = 'run_timeout';
        void stopRun(run, run.error || 'ended').catch(() => {});
      }, Math.max(1, run.deadline - performance.now()));
      run.sampler = setInterval(() => void sample(run), sampleIntervalMs); await sample(run);
      await waitFor(run, async () => { try { const response = await fetch(`http://${HOST}:${run.ports.http}${run.upstreamPrefix}index.m3u8`, { signal: AbortSignal.timeout(1000) }); const text = await response.text(); run.readiness = { status: response.status, bytes: Buffer.byteLength(text) }; return response.ok && text.startsWith('#EXTM3U'); } catch { return false; } });
      checkRun(run); run.readyAfterSeconds = (performance.now() - now) / 1000; state = 'running';
      return { runId: id, engine: run.engine, transport: run.transport, turnEngine: run.turnEngine, turnTransport: run.turnTransport, playlistUrl: run.playlistUrl, state, profile: profileFor(run.engine),
        ...(run.turn ? { runtime: run.turn.runtime } : {}) };
    } catch (error) { run.error ??= run.abort.signal.aborted ? null : error.code || 'run_start_failed'; await stopRun(run, run.error || 'stopped'); throw failure(run.error || error.code || 'run_start_failed', error.status || 502); }
  }
  async function proxyHls(request, response, pathname) {
    const match = /^\/(?:media\/lab|lab)\/hls\/([a-f0-9]{24})\/(.+)$/.exec(pathname);
    const run = current;
    if (!match || !run || run.id !== match[1] || run.abort.signal.aborted || !run.ports) return reply(response, 404, { error: 'inactive_run' }, request.method === 'HEAD');
    const relative = match[2];
    if (!relative.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part)) || !['.m3u8', '.mp4', '.m4s', '.ts', '.aac'].includes(path.extname(relative).toLowerCase())) return reply(response, 403, { error: 'hls_path_not_served' });
    if (run.http.active >= 32) return reply(response, 503, { error: 'hls_request_limit' });
    const metrics = run.http, started = performance.now();
    metrics.requests++; metrics.active++;
    let settled = false, upstream, incoming, hash, size = 0, ended = false, good = false;
    const head = request.method === 'HEAD';
    const media = !head && ['.mp4', '.m4s', '.ts', '.aac'].includes(path.extname(relative).toLowerCase()) && !request.headers.range;
    const finish = kind => {
      if (settled) return; settled = true; clearTimeout(deadline); metrics.active--; run.requests.delete(cancel);
      if (kind === 'complete') { metrics.completed++; addTiming(metrics, 'response', performance.now() - started); }
      else if (kind === 'cancelled') metrics.cancelled++;
      else metrics.errors++;
      if (kind === 'complete' && good && ended && hash) {
        const record = { sha256: hash.digest('hex'), size };
        const canonical = `/media/lab/hls/${run.id}/${relative}`, alias = `/lab/hls/${run.id}/${relative}`;
        run.hashes.delete(canonical); run.hashes.set(canonical, record);
        // An alias maps to the same digest without retaining any media bytes.
        run.aliases ??= new Map(); run.aliases.set(alias, canonical);
        while (run.hashes.size > MAX_HASHES) { const oldest = run.hashes.keys().next().value; run.hashes.delete(oldest); run.aliases.delete(oldest.replace('/media/lab/', '/lab/')); }
      }
    };
    const cancel = () => { if (settled) return; finish('cancelled'); upstream?.destroy(); incoming?.destroy(); response.destroy(); };
    const broken = () => { if (settled) return; finish('error'); upstream?.destroy(); incoming?.destroy(); if (!response.headersSent) reply(response, 502, { error: 'origin_response_failed' }, head); else response.destroy(); };
    const deadline = setTimeout(broken, 30000);
    run.requests.add(cancel);
    response.once('close', () => { if (!response.writableFinished) cancel(); });
    response.once('error', broken);
    response.once('finish', () => finish(good && ended ? 'complete' : 'error'));
    const search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    const headers = { 'Accept-Encoding': 'identity' };
    if (request.headers.range) {
      if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(request.headers.range)) { clearTimeout(deadline); finish('error'); return reply(response, 416, { error: 'invalid_range' }, head); }
      headers.Range = request.headers.range;
    }
    const upstreamOrigin = `http://${HOST}:${run.ports.http}`;
    const send = (upstreamPath, hops = 0) => {
      if (settled || run.abort.signal.aborted) return;
      metrics.originRequests++;
      const cookies = nativeCookieHeader(run, new URL(upstreamPath, upstreamOrigin).pathname);
      const attempt = http.request({ host: HOST, port: run.ports.http, method: request.method, path: upstreamPath,
        headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) } }, source => {
        if (settled || run.abort.signal.aborted) { source.destroy(); return; }
        incoming = source;
        const length = Number(source.headers['content-length']);
        if (Number.isFinite(length) && length > MAX_RESPONSE) return broken();
        if (source.statusCode >= 300 && source.statusCode < 400) {
          let target;
          try {
            if (hops >= 2 || ![301, 302, 303, 307, 308].includes(source.statusCode) || typeof source.headers.location !== 'string') throw Error();
            target = new URL(source.headers.location, upstreamOrigin + upstreamPath);
            if (target.origin !== upstreamOrigin || target.username || target.password || target.hash || target.href.length > 4096) throw Error();
            const checked = pathnameOf(target.pathname);
            if (!checked.startsWith(run.upstreamPrefix)) throw Error();
            const tail = checked.slice(run.upstreamPrefix.length);
            if (!tail.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part)) || !['.m3u8', '.mp4', '.m4s', '.ts', '.aac'].includes(path.extname(tail).toLowerCase())) throw Error();
          } catch { return broken(); }
          if (!rememberNativeCookies(run, source.headers, new URL(upstreamPath, upstreamOrigin).pathname)) return broken();
          metrics.redirectsFollowed++;
          source.destroy();
          send(target.pathname + target.search, hops + 1);
          return;
        }
        if (!rememberNativeCookies(run, source.headers, new URL(upstreamPath, upstreamOrigin).pathname)) return broken();
        addTiming(metrics, 'first', performance.now() - started);
        good = source.statusCode >= 200 && source.statusCode < 300;
        hash = media && source.statusCode === 200 ? createHash('sha256') : undefined;
        response.statusCode = source.statusCode;
        response.setHeader('Content-Type', MIME[path.extname(relative).toLowerCase()]);
        for (const name of ['content-length', 'content-range', 'accept-ranges']) if (source.headers[name]) response.setHeader(name, source.headers[name]);
        source.once('aborted', broken); source.once('error', broken); source.once('end', () => { ended = true; });
        const counter = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_RESPONSE) return callback(failure('response_limit', 502));
          metrics.bytes += chunk.length;
          hash?.update(chunk);
          callback(null, chunk);
        } });
        counter.once('error', broken);
        source.pipe(counter).pipe(response);
      });
      upstream = attempt;
      attempt.setTimeout(15000, () => { if (upstream === attempt) broken(); });
      attempt.once('error', () => { if (upstream === attempt) broken(); });
      attempt.end();
    };
    send(run.upstreamPrefix + relative + search);
  }
  async function staticFile(request, response, pathname) {
    let file;
    try {
      const name = pathname === '/' ? '/media-lab.html' : pathname;
      const target = await realpath(path.join(root, name));
      const parts = path.relative(root, target).split(path.sep);
      if (!target.startsWith(root + path.sep) || blockedFiles.has(target) || parts.some(part => part.startsWith('.') || part === 'node_modules')) return reply(response, 403, { error: 'file_not_served' }, request.method === 'HEAD');
      file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const info = await file.stat();
      if (!info.isFile()) return reply(response, 404, { error: 'not_found' }, request.method === 'HEAD');
      if (info.size > MAX_RESPONSE) return reply(response, 413, { error: 'file_limit' }, request.method === 'HEAD');
      let start = 0, end = info.size - 1, partial = false;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || !info.size || !match[1] && !match[2]) return reply(response, 416, { error: 'invalid_range' });
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(info.size - 1, Number(match[2])) : info.size - 1;
        if (![start, end].every(Number.isSafeInteger) || start > end || start >= info.size) return reply(response, 416, { error: 'invalid_range' });
        partial = true;
      }
      response.writeHead(partial ? 206 : 200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Content-Length': Math.max(0, end - start + 1), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
      if (request.method === 'HEAD' || !info.size) return response.end();
      const stream = file.createReadStream({ start, end, autoClose: false });
      response.once('close', () => stream.destroy());
      await new Promise(resolve => { stream.once('end', resolve); stream.once('close', resolve); stream.once('error', () => { response.destroy(); resolve(); }); stream.pipe(response); });
    } catch { if (!response.headersSent) reply(response, 404, { error: 'not_found' }, request.method === 'HEAD'); else response.destroy(); }
    finally { await file?.close().catch(() => {}); }
  }
  function validateRun(body) {
    if (Object.keys(body).some(key => !['engine', 'transport', 'offsetSeconds', 'durationSeconds', 'turnEngine', 'turnTransport'].includes(key))) throw failure('unknown_run_option');
    const value = { engine: body.engine, transport: body.transport, offsetSeconds: body.offsetSeconds ?? 0, durationSeconds: body.durationSeconds,
      turnEngine: body.turnEngine ?? 'off', turnTransport: body.turnTransport ?? 'udp' };
    if (!engines.some(engine => engine.id === value.engine) || !config.transports.includes(value.transport)
      || !Number.isFinite(value.offsetSeconds) || value.offsetSeconds < 0 || value.offsetSeconds >= source.durationSeconds
      || value.durationSeconds !== undefined && (!Number.isFinite(value.durationSeconds) || value.durationSeconds < 1 || value.durationSeconds > maxRunSeconds)
      || !['off', 'spry', 'coturn'].includes(value.turnEngine) || !['udp', 'tcp'].includes(value.turnTransport)
      || value.turnEngine !== 'off' && !binaries[value.turnEngine]) throw failure('invalid_run_options');
    return value;
  }
  let startPromise;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('Referrer-Policy', 'no-referrer');
    const head = request.method === 'HEAD';
    if (!sameOrigin(request, origin)) return reply(response, 403, { error: 'local_origin_required' }, head);
    try {
      const pathname = pathnameOf(request.url);
      if (pathname === '/lab/run' || pathname === '/lab/stop') {
        if (request.method !== 'POST') return reply(response, 405, { error: 'post_required' }, head);
        const body = await bodyJson(request);
        if (closing) throw failure('lab_stopping', 503);
        if (pathname === '/lab/stop') {
          if (Object.keys(body).some(key => key !== 'runId') || body.runId !== undefined && !/^[a-f0-9]{24}$/.test(body.runId)) throw failure('invalid_stop_options');
          if (body.runId && (current?.id !== body.runId || current.abort.signal.aborted)) return reply(response, 200, { state, ignored: true });
          generation++;
          await stopRun(current, 'stopped');
          return reply(response, 200, { state: 'idle' });
        }
        if (controlBusy) throw failure('run_transition_busy', 409);
        const value = validateRun(body); controlBusy = true;
        let owner;
        const cancelled = () => {
          if (!response.writableFinished && owner === generation) { generation++; current?.abort.abort(); void stopRun(current, 'stopped').catch(() => {}); }
        };
        try { startPromise = beginRun(value); owner = generation; response.once('close', cancelled); return reply(response, 200, await startPromise); }
        finally { response.off('close', cancelled); startPromise = null; controlBusy = false; }
      }
      if (!['GET', 'HEAD'].includes(request.method)) return reply(response, 405, { error: 'get_required' }, head);
      if (pathname === '/lab/config') return reply(response, 200, config, head);
      if (pathname === '/lab/stats') return reply(response, 200, getStats(), head);
      if (pathname === '/lab/runtime') {
        if (!current?.turn || current.abort.signal.aborted) return reply(response, 404, { error: 'no_turn_run' }, head);
        return reply(response, 200, current.turn.runtime, head);
      }
      if (pathname === '/lab/hash') {
        const query = new URL(request.url, origin).searchParams;
        const name = query.get('path');
        if (query.size !== 1 || !name?.startsWith('/') || name.includes('?') || name.includes('#')) throw failure('invalid_hash_path');
        const checked = pathnameOf(name), run = current;
        const match = /^\/(?:media\/lab|lab)\/hls\/([a-f0-9]{24})\/(.+)$/.exec(checked);
        if (!run || run.abort.signal.aborted || !match || match[1] !== run.id) return reply(response, 404, { error: 'hash_not_ready' }, head);
        const key = run.aliases?.get(checked) || checked;
        const value = run.hashes.get(key);
        return reply(response, value ? 200 : 404, value || { error: 'hash_not_ready' }, head);
      }
      if (pathname.startsWith('/lab/') && !pathname.startsWith('/lab/hls/')) return reply(response, 404, { error: 'not_found' }, head);
      if (pathname.startsWith('/media/lab/hls/') || pathname.startsWith('/lab/hls/')) return await proxyHls(request, response, pathname);
      return await staticFile(request, response, pathname);
    } catch (error) {
      const code = typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'lab_request_failed';
      if (!response.headersSent && !response.destroyed) reply(response, error.status || 500, { error: code }, head);
      else response.destroy();
    }
  });
  server.maxConnections = 64; server.maxHeadersCount = 32; server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 2000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const abort = () => { void stop().catch(() => {}); };
  const stop = () => {
    shutdown ??= (async () => {
      closing = true; generation++; current?.abort.abort();
      const pending = startPromise;
      await stopRun(current, 'stopped');
      await pending?.catch(() => {});
      if (server.listening) { const done = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await done; }
      signal?.removeEventListener('abort', abort);
    })();
    return shutdown;
  };
  try {
    if (signal?.aborted) throw failure('startup_cancelled');
    await listen(server, port); origin = `http://${HOST}:${server.address().port}`;
    if (signal?.aborted) throw failure('startup_cancelled');
    signal?.addEventListener('abort', abort, { once: true });
  } catch (error) { await stop(); throw error; }
  return { url: `${origin}/media-lab.html`, stop };
}

async function main() {
  const options = {}, args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('node scripts/media-lab-server.mjs --input PATH --sapflow PATH --mediamtx PATH [--spry PATH --coturn PATH] [--port N]'); return; }
  const keys = { '--input': 'input', '--sapflow': 'sapflow', '--mediamtx': 'mediamtx', '--spry': 'spry', '--coturn': 'coturn', '--port': 'port' };
  for (let i = 0; i < args.length; i += 2) {
    if (!keys[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw failure('invalid_cli_options');
    options[keys[args[i]]] = args[i] === '--port' ? Number(args[i + 1]) : args[i + 1];
  }
  const controller = new AbortController(); options.signal = controller.signal;
  let lab;
  const shutdown = () => { controller.abort(); void lab?.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  lab = await startMediaLab(options); console.log(lab.url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Media lab could not start. Check the local source, executable paths and available ports.'); process.exitCode = 1; });
}
