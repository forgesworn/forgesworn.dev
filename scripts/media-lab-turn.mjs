// Disposable native TURN operators for the loopback-only comparison lab.
// Credentials are returned to the local caller; child output is never logged.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { viewerRuntime } from './serve-media-demo.mjs';

const HOST = '127.0.0.1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const LAB_TURN_LIMITS = Object.freeze({ allocations: 16, perUser: 8,
  bytesPerSecond: 8 * 1024 * 1024, totalBytesPerSecond: 32 * 1024 * 1024, maxDurationMs: 345_000 });

async function reservePort() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tcp = net.createServer(), udp = dgram.createSocket('udp4');
    let udpBound = false;
    const release = async () => {
      if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
      if (udpBound) await new Promise(resolve => udp.close(resolve));
      else { try { udp.close(); } catch {} }
    };
    try {
      await new Promise((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(0, HOST, () => { tcp.removeListener('error', reject); resolve(); });
      });
      const port = tcp.address().port;
      await new Promise((resolve, reject) => {
        udp.once('error', reject);
        udp.bind(port, HOST, () => { udp.removeListener('error', reject); udpBound = true; resolve(); });
      });
      return { port, release };
    } catch (error) {
      await release();
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('The local TURN port could not be reserved.');
}

function groupAlive(child) {
  if (!child.pid) return false;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function stopGroup(child, graceMs) {
  if (!child?.pid) return;
  const signal = name => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  let deadline = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < deadline) await wait(20);
  if (groupAlive(child)) signal('SIGKILL');
  deadline = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < deadline) await wait(20);
  if (groupAlive(child)) throw new Error('The local TURN process group did not stop.');
}

function tcpReady(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port });
    let done = false;
    const finish = ready => { if (!done) { done = true; socket.destroy(); resolve(ready); } };
    socket.setTimeout(150, () => finish(false));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}

function udpReady(port) {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4'), transaction = randomBytes(12);
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0); request.writeUInt32BE(0x2112a442, 4); transaction.copy(request, 8);
    let done = false;
    const finish = ready => {
      if (done) return;
      done = true; clearTimeout(timer); socket.close(); resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 150);
    socket.once('error', () => finish(false));
    socket.on('message', message => {
      if (message.length >= 20 && message.readUInt16BE(0) === 0x0101 &&
          message.readUInt32BE(4) === 0x2112a442 && message.subarray(8, 20).equals(transaction)) finish(true);
    });
    socket.send(request, port, HOST, error => { if (error) finish(false); });
  });
}

function coturnConfiguration(secret, port, directory) {
  return [
    `listening-ip=${HOST}`, `relay-ip=${HOST}`, `listening-port=${port}`, 'realm=media-lab',
    'use-auth-secret', `static-auth-secret=${secret}`, 'fingerprint', 'allow-loopback-peers',
    'no-multicast-peers', 'no-tcp-relay', 'no-tls', 'no-dtls', 'no-cli',
    'no-stdout-log', 'simple-log', 'log-file=/dev/null', `pidfile=${path.join(directory, 'turn.pid')}`,
    'relay-threads=1', `total-quota=${LAB_TURN_LIMITS.allocations}`, `user-quota=${LAB_TURN_LIMITS.perUser}`,
    `max-bps=${LAB_TURN_LIMITS.bytesPerSecond}`, `bps-capacity=${LAB_TURN_LIMITS.totalBytesPerSecond}`,
  ].join('\n') + '\n';
}

export async function startLabTurnOperator({ engine, spry, coturn, transport = 'udp', signal,
  startupTimeoutMs = 4000, stopGraceMs = 800, maxDurationMs = LAB_TURN_LIMITS.maxDurationMs } = {}) {
  if (!['spry', 'coturn'].includes(engine) || !['udp', 'tcp'].includes(transport)) throw new Error('Choose a local Spry or coturn operator and UDP or TCP.');
  const binary = engine === 'spry' ? spry : coturn;
  if (typeof binary !== 'string' || !binary) throw new Error('The selected native TURN executable is unavailable.');
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 50 || maxDurationMs > LAB_TURN_LIMITS.maxDurationMs ||
      !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 50 || startupTimeoutMs > 10_000 ||
      !Number.isSafeInteger(stopGraceMs) || stopGraceMs < 20 || stopGraceMs > 3000) throw new Error('The TURN lifecycle bounds are invalid.');
  if (signal?.aborted) throw new Error('The TURN startup was cancelled.');
  const secret = randomBytes(32).toString('base64url');
  const directory = engine === 'coturn' ? await mkdtemp(path.join(os.tmpdir(), 'forgesworn-lab-turn-')) : null;
  let child, timer, stopping;
  const stop = () => {
    stopping ??= (async () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await stopGroup(child, stopGraceMs);
      if (directory) await rm(directory, { recursive: true, force: true });
    })();
    return stopping;
  };
  const abort = () => { void stop().catch(() => {}); };
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal?.aborted) throw new Error('The TURN startup was cancelled.');
      const reservation = await reservePort();
      const port = reservation.port;
      let args;
      try {
        if (engine === 'coturn') {
          const configuration = path.join(directory, 'turn.conf');
          await writeFile(configuration, coturnConfiguration(secret, port, directory), { mode: 0o600 });
          args = ['-c', configuration];
        } else args = ['serve', '--listen', `${HOST}:${port}`, '--allow-loopback-peers', '--realm', 'media-lab',
          '--max-allocations', String(LAB_TURN_LIMITS.allocations), '--max-per-user', String(LAB_TURN_LIMITS.perUser),
          '--max-connections', '16', '--bytes-per-second', String(LAB_TURN_LIMITS.bytesPerSecond)];
      } finally { await reservation.release(); }
      child = spawn(binary, args, { env: engine === 'spry' ? { ...process.env, SPRY_TURN_SECRET: secret } : process.env,
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore'] });
      let spawnFailed = false;
      child.on('error', () => { spawnFailed = true; });
      const deadline = Date.now() + startupTimeoutMs;
      while (!signal?.aborted && !spawnFailed && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        const [tcp, udp] = await Promise.all([tcpReady(port), udpReady(port)]);
        if (tcp && udp) {
          await wait(30);
          if (!signal?.aborted && child.exitCode === null && child.signalCode === null) {
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(abort, maxDurationMs); timer.unref();
            const runtime = { ...viewerRuntime(secret, port, transport), engine,
              label: `${engine === 'spry' ? 'Spry TURN' : 'coturn'} (local ${transport.toUpperCase()})` };
            return { runtime, process: child, stop };
          }
        }
        await wait(25);
      }
      await stopGroup(child, stopGraceMs);
      child = undefined;
      if (signal?.aborted) throw new Error('The TURN startup was cancelled.');
      if (spawnFailed) throw new Error('The selected native TURN executable could not start.');
    }
    throw new Error('The native TURN operator did not become ready.');
  } catch (error) {
    await stop();
    throw error;
  }
}
