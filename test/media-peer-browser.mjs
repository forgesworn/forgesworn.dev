#!/usr/bin/env node
// Manual acceptance: actual RelaySwarm playback through an optional local Spry.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startMediaDemo } from '../scripts/serve-media-demo.mjs';
import { checkPeerDemo } from '../scripts/media-peer-demo-check.mjs';

const args = process.argv.slice(2), options = { clip: 'rtmp', transport: 'udp' };
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!value || !['--spry', '--transport', '--clip', '--output'].includes(name)) {
    throw new Error('Use --spry PATH, --transport udp|tcp, --clip rtmp|srt or --output PATH.');
  }
  options[name.slice(2)] = value;
}
if (!['udp', 'tcp'].includes(options.transport)) throw new Error('Choose UDP or TCP.');
let operator, receipt;
const identity = {};
const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  if (options.spry) {
    const binary = resolve(options.spry);
    identity.spryBinarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
    identity.spryVersion = /^spry-turn [0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i.test(version) ? version : 'unrecognised';
    operator = await startMediaDemo({ spry: binary, transport: options.transport, signal: cancellation.signal });
  }
  receipt = await checkPeerDemo({ clip: options.clip, output: options.output, signal: cancellation.signal,
    runtimeUrl: operator ? new URL('/media/demo/runtime.json', operator.url).href : undefined });
} finally {
  await operator?.stop();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (!receipt && options.output) {
    try { receipt = JSON.parse(await readFile(options.output, 'utf8')); } catch {}
  }
  if (receipt) {
    Object.assign(receipt, identity, { localOperatorProcessesStopped: true });
    if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(options.output, JSON.stringify(receipt, null, 2) + '\n'); }
  }
}
console.log(JSON.stringify(receipt, null, 2));
