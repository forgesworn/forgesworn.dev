#!/usr/bin/env node
// Local qualification helper. Nothing listens outside the IPv4 loopback interface.
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const RUNTIME_PATH = '/media/demo/runtime.json';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment', '.ts': 'video/mp2t', '.wasm': 'application/wasm',
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function turnCredential(secret, username) {
  return createHmac('sha1', secret).update(username).digest('base64');
}

export function viewerRuntime(secret, turnPort, transport, now = Math.floor(Date.now() / 1000)) {
  if (!['udp', 'tcp'].includes(transport)) throw new Error('transport must be udp or tcp');
  const iceServersByViewer = Array.from({ length: 2 }, () => {
    const username = `${now + 600}:${randomBytes(12).toString('hex')}`;
    return [{
      urls: [`turn:${HOST}:${turnPort}?transport=${transport}`],
      username, credential: turnCredential(secret, username),
    }];
  });
  return {
    iceServersByViewer, iceTransportPolicy: 'relay', transport,
    label: `Spry TURN (local ${transport.toUpperCase()})`,
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.off('error', reject); resolve(); });
  });
}

// Reserve the same port in both protocols, then release immediately before spawn.
async function reserveTurnPortAttempt() {
  const tcp = net.createServer();
  const udp = dgram.createSocket('udp4');
  let udpBound = false;
  try {
    await listen(tcp, 0);
    const port = tcp.address().port;
    await new Promise((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(port, HOST, () => { udp.off('error', reject); udpBound = true; resolve(); });
    });
    return {
      port,
      release: () => Promise.all([
        new Promise((resolve) => tcp.close(resolve)),
        new Promise((resolve) => udp.close(resolve)),
      ]),
    };
  } catch (error) {
    if (tcp.listening) await new Promise((resolve) => tcp.close(resolve));
    if (udpBound) await new Promise((resolve) => udp.close(resolve));
    else { try { udp.close(); } catch {} }
    throw error;
  }
}

async function reserveTurnPort() {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await reserveTurnPortAttempt(); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('could not reserve a shared local UDP/TCP port');
}

function groupAlive(child) {
  if (!child.pid) return false;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // A group can briefly remain visible while exited children are reaped.
    // Permission failure is not evidence that the group has disappeared.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function stopChild(child, graceMs) {
  if (!child.pid) return;
  const signal = (name) => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < deadline) await delay(20);
  if (groupAlive(child)) signal('SIGKILL');
  const killDeadline = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < killDeadline) await delay(20);
  if (groupAlive(child)) throw new Error('local relay process group did not terminate');
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const finish = (ready) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(100, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function startSpry(binary, secret, startupTimeoutMs, graceMs, signal) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new Error('startup cancelled');
    const reservation = await reserveTurnPort();
    await reservation.release();
    const child = spawn(binary, [
      'serve', '--listen', `${HOST}:${reservation.port}`, '--allow-loopback-peers',
    ], {
      env: { ...process.env, SPRY_TURN_SECRET: secret },
      detached: process.platform !== 'win32',
      // Even a failing executable must never echo its environment into our output.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let failed = false;
    child.on('error', () => { failed = true; });
    const deadline = Date.now() + startupTimeoutMs;
    while (!signal?.aborted && !failed && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      if (await probe(reservation.port)) {
        // A short settle catches a child that loses the UDP bind after TCP opens.
        await delay(30);
        if (!signal?.aborted && !failed && child.exitCode === null && child.signalCode === null) {
          return { child, port: reservation.port };
        }
      }
      await delay(25);
    }
    await stopChild(child, graceMs);
    if (signal?.aborted) throw new Error('startup cancelled');
    if (failed) throw new Error('could not start the selected Spry executable');
  }
  throw new Error('Spry did not become ready on a local UDP/TCP port');
}

function sameOrigin(request, origin) {
  const hostHeaders = request.rawHeaders.filter((_, i) => i % 2 === 0)
    .filter((name) => name.toLowerCase() === 'host');
  return hostHeaders.length === 1
    && request.headers.host === origin.slice('http://'.length)
    && (request.headers.origin === undefined || request.headers.origin === origin)
    && (request.headers['sec-fetch-site'] === undefined || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']));
}

function response(response, status, body, type = 'text/plain; charset=utf-8', head = false) {
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  response.end(head ? undefined : body);
}

function byteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end, partial: true };
}

export async function startMediaDemo({
  spry, transport = 'udp', port = 0, siteRoot = SITE,
  startupTimeoutMs = 2500, stopGraceMs = 800, signal,
} = {}) {
  if (!spry) throw new Error('--spry must name a Spry executable');
  if (!['udp', 'tcp'].includes(transport)) throw new Error('transport must be udp or tcp');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be 0..65535');
  const root = await realpath(siteRoot);
  const secret = randomBytes(32).toString('base64url');
  const relay = await startSpry(spry, secret, startupTimeoutMs, stopGraceMs, signal);
  let origin;
  let active = 0;
  let stopping;
  const server = http.createServer(async (request, reply) => {
    reply.setHeader('Cache-Control', 'no-store');
    reply.setHeader('X-Content-Type-Options', 'nosniff');
    reply.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    reply.setHeader('Referrer-Policy', 'no-referrer');
    const head = request.method === 'HEAD';
    if (!sameOrigin(request, origin)) return response(reply, 403, 'Local origin required\n', undefined, head);
    if (!['GET', 'HEAD'].includes(request.method)) {
      reply.setHeader('Allow', 'GET, HEAD');
      return response(reply, 405, 'GET or HEAD required\n');
    }
    if (active >= 32) return response(reply, 503, 'Request limit\n', undefined, head);
    active++;
    reply.once('close', () => { active--; });
    let file;
    try {
      if (!request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 4096) {
        return response(reply, 400, 'Invalid path\n', undefined, head);
      }
      let pathname;
      try { pathname = decodeURIComponent(request.url.split('?')[0]); }
      catch { return response(reply, 400, 'Invalid path\n', undefined, head); }
      const parts = pathname.split('/');
      if (pathname.includes('\\') || pathname.includes('\0')
        || parts.some((part) => part.startsWith('.') || part === 'node_modules')) {
        return response(reply, 403, 'Path not served\n', undefined, head);
      }
      if (pathname === RUNTIME_PATH) {
        return response(reply, 200, JSON.stringify(viewerRuntime(secret, relay.port, transport)), 'application/json; charset=utf-8', head);
      }
      if (pathname === '/') pathname = '/index.html';
      const target = await realpath(path.join(root, pathname));
      const resolvedParts = path.relative(root, target).split(path.sep);
      if (!target.startsWith(root + path.sep) || resolvedParts.some((part) => part.startsWith('.') || part === 'node_modules')) {
        return response(reply, 403, 'Path not served\n', undefined, head);
      }
      file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = await file.stat();
      if (!stat.isFile()) return response(reply, 404, 'Not found\n', undefined, head);
      if (stat.size > 64 * 1024 * 1024) return response(reply, 413, 'File limit\n', undefined, head);
      const range = byteRange(request.headers.range, stat.size);
      if (!range) {
        reply.setHeader('Content-Range', `bytes */${stat.size}`);
        return response(reply, 416, 'Invalid range\n', undefined, head);
      }
      reply.setHeader('Accept-Ranges', 'bytes');
      reply.setHeader('Content-Type', MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
      reply.setHeader('Content-Length', Math.max(0, range.end - range.start + 1));
      if (range.partial) reply.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.writeHead(range.partial ? 206 : 200);
      if (head || stat.size === 0) return reply.end();
      const stream = file.createReadStream({ start: range.start, end: range.end, autoClose: false });
      reply.once('close', () => stream.destroy());
      await new Promise((resolve) => {
        stream.once('error', () => { reply.destroy(); resolve(); });
        stream.once('close', resolve);
        stream.once('end', resolve);
        stream.pipe(reply);
      });
    } catch (error) {
      if (reply.headersSent) reply.destroy();
      else response(reply, ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 403, 'Not served\n', undefined, head);
    } finally { await file?.close().catch(() => {}); }
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 2000;
  server.on('clientError', (_, socket) => socket.destroy());
  const stop = () => {
    stopping ??= (async () => {
      if (server.listening) {
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await closed;
      }
      await stopChild(relay.child, stopGraceMs);
    })();
    return stopping;
  };
  try {
    await listen(server, port);
    origin = `http://${HOST}:${server.address().port}`;
    if (signal?.aborted) throw new Error('startup cancelled');
    if (relay.child.exitCode !== null || relay.child.signalCode !== null) throw new Error('Spry stopped during startup');
  } catch (error) { await stop(); throw error; }
  const exited = new Promise((resolve) => relay.child.once('exit', (code, signal) => resolve({ code, signal })));
  signal?.addEventListener('abort', () => { stop().catch(() => {}); }, { once: true });
  // A stopped relay cannot leave a misleading credential endpoint running.
  exited.then(() => stop()).catch(() => {});
  return { url: `${origin}/live-media.html?relay=local`, port: server.address().port, turnPort: relay.port, stop, exited };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/serve-media-demo.mjs --spry /path/to/spry-turn [--transport udp|tcp] [--port 0]');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    const name = { '--spry': 'spry', '--transport': 'transport', '--port': 'port' }[args[i]];
    if (!name || !args[i + 1]) throw new Error('expected --spry PATH, --transport udp|tcp or --port NUMBER');
    options[name] = name === 'port' ? Number(args[i + 1]) : args[i + 1];
  }
  const controller = new AbortController();
  options.signal = controller.signal;
  let demo;
  let requested = false;
  const shutdown = () => {
    requested = true;
    controller.abort();
    demo?.stop().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try { demo = await startMediaDemo(options); }
  catch (error) { if (requested) return; throw error; }
  console.log(demo.url);
  demo.exited.then(() => {
    if (!requested) { console.error('Local Spry stopped; demo closed.'); process.exitCode = 1; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Local media demo could not start. Check the executable and available local ports.'); process.exitCode = 1; });
}
