import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startMediaDemo, turnCredential, viewerRuntime } from '../scripts/serve-media-demo.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/serve-media-demo.mjs', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, { stall = false, stubborn = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgesworn-media-server-test-'));
  const owners = new Set();
  t.after(async () => {
    // Let each owner reap its child before the fallback kill and scratch
    // removal. Killing it first races the owner's normal process teardown.
    const stopped = await Promise.allSettled([...owners].map(demo => demo.stop()));
    // A failed assertion must not leak its disposable subprocesses.
    try {
      const entries = (await readFile(path.join(root, 'pids.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      for (const { parent } of entries) {
        try { process.kill(process.platform === 'win32' ? parent : -parent, 'SIGKILL'); }
        catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
    const failure = stopped.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
  const site = path.join(root, 'site');
  await mkdir(site);
  await writeFile(path.join(site, 'live-media.html'), '<h1>Generated demo</h1>');
  const pidFile = path.join(root, 'pids.json');
  const binary = path.join(root, 'spry-fixture');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const {spawn} = require('node:child_process');
if (process.argv[2] !== 'serve' || !process.argv.includes('--allow-loopback-peers')) process.exit(12);
if ((process.env.SPRY_TURN_SECRET || '').length < 32) process.exit(13);
console.log('CHILD_OUTPUT_MUST_STAY_PRIVATE', process.env.SPRY_TURN_SECRET);
console.error('CHILD_OUTPUT_MUST_STAY_PRIVATE', process.env.SPRY_TURN_SECRET);
const descendant = ${stubborn} ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}) : null;
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({parent:process.pid, child:descendant?.pid}));
fs.appendFileSync(${JSON.stringify(path.join(root, 'pids.jsonl'))}, JSON.stringify({parent:process.pid, child:descendant?.pid}) + '\\n');
if (${stubborn}) process.on('SIGTERM', () => {});
if (${stall}) setInterval(() => {}, 1000);
else {
  const address = process.argv[process.argv.indexOf('--listen') + 1];
  const port = Number(address.split(':')[1]);
  if (!address.startsWith('127.0.0.1:')) process.exit(14);
  const udp = dgram.createSocket('udp4');
  udp.on('message', (bytes, peer) => udp.send(bytes, peer.port, peer.address));
  udp.bind(port, '127.0.0.1');
  net.createServer(socket => socket.end()).listen(port, '127.0.0.1');
}
`, { mode: 0o700 });
  return { root, site, binary, pidFile, async startDemo(options = {}) {
    const demo = await startMediaDemo({ spry: binary, siteRoot: site, ...options });
    owners.add(demo); return demo;
  } };
}

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (data) => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function eventually(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(25);
  }
  assert.fail('bounded wait expired');
}

test('TURN REST HMAC and two short-lived opaque viewer principals', () => {
  assert.equal(turnCredential('key', 'The quick brown fox jumps over the lazy dog'), '3nybhbi3iqa8ino29wqQcBydtNk=');
  const runtime = viewerRuntime('a-secret', 3478, 'tcp', 1000);
  assert.equal(runtime.iceTransportPolicy, 'relay');
  assert.equal(runtime.label, 'Spry TURN (local TCP)');
  const [first, second] = runtime.iceServersByViewer.map(([entry]) => entry);
  assert.notEqual(first.username, second.username);
  for (const entry of [first, second]) {
    assert.match(entry.username, /^1600:[a-f0-9]{24}$/);
    assert.deepEqual(entry.urls, ['turn:127.0.0.1:3478?transport=tcp']);
    assert.equal(entry.credential, createHmac('sha1', 'a-secret').update(entry.username).digest('base64'));
  }
  assert.throws(() => viewerRuntime('secret', 3478, 'tls'));
});

test('real local child, per-viewer runtime credentials, origin guard and bounded shutdown', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const demo = await f.startDemo({ transport: 'tcp' });
  assert.match(demo.url, /^http:\/\/127\.0\.0\.1:\d+\/media-peer-fixture\.html\?relay=local$/);
  const runtime = await request(demo.port, '/media/demo/runtime.json');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.headers['cache-control'], 'no-store');
  assert.equal(runtime.headers['access-control-allow-origin'], undefined);
  const data = JSON.parse(runtime.body);
  assert.equal(data.transport, 'tcp');
  assert.equal(data.iceServersByViewer.length, 2);
  assert.notEqual(data.iceServersByViewer[0][0].username, data.iceServersByViewer[1][0].username);
  const expiry = Number(data.iceServersByViewer[0][0].username.split(':')[0]);
  assert.ok(Math.abs(expiry - Math.floor(Date.now() / 1000) - 600) <= 2);
  assert.equal((await request(demo.port, '/media/demo/runtime.json', { headers: { Origin: `http://127.0.0.1:${demo.port}`, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  for (const headers of [
    { Host: `evil.example:${demo.port}` },
    { Host: `localhost:${demo.port}` },
    { Origin: 'https://evil.example' },
    { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const rejected = await request(demo.port, '/media/demo/runtime.json', { headers });
    assert.equal(rejected.status, 403);
    assert.ok(!rejected.body.includes('credential'));
  }
  assert.equal((await request(demo.port, '/media/demo/runtime.json', { method: 'POST' })).status, 405);
  assert.equal((await request(demo.port, '/media/demo/runtime.json', { method: 'HEAD' })).body, '');
  const pids = JSON.parse(await readFile(f.pidFile));
  assert.ok(alive(pids.parent));
  await demo.stop();
  await demo.stop();
  assert.ok(!alive(pids.parent));
  await assert.rejects(request(demo.port, '/media/demo/runtime.json'));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(demo.turnPort, '127.0.0.1', resolve); });
  await new Promise((resolve) => probe.close(resolve));
});

test('startup timeout and an occupied HTTP port clean up every attempted relay', { timeout: 10000 }, async (t) => {
  const stalled = await fixture(t, { stall: true });
  await assert.rejects(startMediaDemo({ spry: stalled.binary, siteRoot: stalled.site, startupTimeoutMs: 400, stopGraceMs: 100 }), /did not become ready/);
  const attempts = (await readFile(path.join(stalled.root, 'pids.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(attempts.length > 0);
  for (const { parent } of attempts) assert.ok(!alive(parent));
  const f = await fixture(t);
  const busy = net.createServer();
  await new Promise((resolve, reject) => { busy.once('error', reject); busy.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  await assert.rejects(startMediaDemo({ spry: f.binary, siteRoot: f.site, port: busy.address().port, stopGraceMs: 100 }), { code: 'EADDRINUSE' });
  const { parent } = JSON.parse(await readFile(f.pidFile));
  assert.ok(!alive(parent));
});

test('static GET/HEAD, media MIME and ranges; traversal, symlinks and directory listing denied', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.site, 'media'));
  await mkdir(path.join(f.site, 'node_modules'));
  await writeFile(path.join(f.site, 'node_modules', 'private.txt'), 'never served');
  await symlink(path.join(f.site, 'node_modules'), path.join(f.site, 'hidden-dependencies'));
  await writeFile(path.join(f.root, 'outside.txt'), 'outside secret');
  await symlink(path.join(f.root, 'outside.txt'), path.join(f.site, 'escape.txt'));
  for (const extension of ['m3u8', 'mp4', 'm4s', 'webp', 'mjs', 'wasm']) {
    await writeFile(path.join(f.site, `sample.${extension}`), '0123456789');
  }
  await writeFile(path.join(f.site, 'large.mp4'), '');
  await truncate(path.join(f.site, 'large.mp4'), 64 * 1024 * 1024 + 1);
  const demo = await f.startDemo();
  for (const [extension, type] of Object.entries({ m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment', webp: 'image/webp', mjs: 'text/javascript; charset=utf-8', wasm: 'application/wasm' })) {
    const result = await request(demo.port, `/sample.${extension}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], type);
    assert.equal(result.body, '0123456789');
  }
  const head = await request(demo.port, '/sample.mp4', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '10');
  const range = await request(demo.port, '/sample.mp4', { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206); assert.equal(range.body, '234'); assert.equal(range.headers['content-range'], 'bytes 2-4/10');
  assert.equal((await request(demo.port, '/sample.mp4', { headers: { Range: 'bytes=-2' } })).body, '89');
  assert.equal((await request(demo.port, '/sample.mp4', { headers: { Range: 'bytes=100-' } })).status, 416);
  assert.equal((await request(demo.port, '/large.mp4')).status, 413);
  for (const pathname of ['/../outside.txt', '/%2e%2e/outside.txt', '/media/%2e%2e/%2e%2e/outside.txt', '/escape.txt', '/node_modules/private.txt', '/hidden-dependencies/private.txt', '/.git/config', '/media%5c..%5coutside.txt', '/%00']) {
    const result = await request(demo.port, pathname);
    assert.equal(result.status, 403, pathname);
    assert.ok(!result.body.includes('outside secret'));
  }
  assert.equal((await request(demo.port, '/media/')).status, 404);
  assert.equal((await request(demo.port, '/%ZZ')).status, 400);
});

test('failed startup and cancellation remove the child process group', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { stall: true, stubborn: true });
  const controller = new AbortController();
  const starting = startMediaDemo({ spry: f.binary, siteRoot: f.site, signal: controller.signal, startupTimeoutMs: 2000, stopGraceMs: 150 });
  // Attach the rejection before awaiting any fixture activity.
  const rejected = assert.rejects(starting, /cancelled/);
  await eventually(async () => { try { await readFile(f.pidFile); return true; } catch { return false; } });
  const pids = JSON.parse(await readFile(f.pidFile));
  controller.abort();
  await rejected;
  await eventually(() => !alive(pids.parent) && !alive(pids.child));
  await assert.rejects(startMediaDemo({ spry: '/nonexistent/spry', siteRoot: f.site, startupTimeoutMs: 100, stopGraceMs: 100 }), /could not start/);
});

test('import is inert; CLI emits only a local URL and handles SIGTERM', { timeout: 10000 }, async (t) => {
  await exec(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/serve-media-demo.mjs', import.meta.url).href)})`], { timeout: 2000 });
  const f = await fixture(t, { stubborn: true });
  const cli = spawn(process.execPath, [script, '--spry', f.binary, '--transport', 'udp'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  cli.stdout.on('data', (bytes) => { output += bytes; });
  cli.stderr.on('data', (bytes) => { errors += bytes; });
  const closed = new Promise((resolve) => cli.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (cli.exitCode === null && cli.signalCode === null) { cli.kill('SIGTERM'); await closed; } });
  await eventually(() => output.includes('?relay=local'));
  assert.match(output, /^http:\/\/127\.0\.0\.1:\d+\/media-peer-fixture\.html\?relay=local\n$/);
  assert.equal(errors, '');
  const pids = JSON.parse(await readFile(f.pidFile));
  cli.kill('SIGTERM');
  assert.equal((await closed).code, 0);
  await eventually(() => !alive(pids.parent) && !alive(pids.child));
  assert.ok(!output.includes('CHILD_OUTPUT_MUST_STAY_PRIVATE'));
});
