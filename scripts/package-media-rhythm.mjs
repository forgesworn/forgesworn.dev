// Extract a small visual rhythm timeline from the licensed demo soundtrack.
// Only audio is decoded. PCM stays in memory; no media file is rewritten.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const SAMPLE_RATE = 8000, SAMPLE_MS = 40;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)] ?? 0;

export function analyseRhythm(pcm, durationMs) {
  const roundedDuration = Math.round(durationMs);
  if (!Buffer.isBuffer(pcm) || pcm.length > 16 * 1024 * 1024 || pcm.length % 4 ||
      !Number.isFinite(durationMs) || roundedDuration <= 0 || durationMs > 300_000) throw new Error('Invalid bounded soundtrack');
  const samplesPerFrame = SAMPLE_RATE * SAMPLE_MS / 1000, length = Math.ceil(roundedDuration / SAMPLE_MS), rms = [];
  for (let frame = 0; frame < length; frame++) {
    let sum = 0;
    for (let i = 0; i < samplesPerFrame; i++) {
      const offset = (frame * samplesPerFrame + i) * 4;
      const sample = offset < pcm.length ? pcm.readFloatLE(offset) : 0;
      if (!Number.isFinite(sample)) throw new Error('Invalid PCM sample');
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / samplesPerFrame));
  }
  const scale = Math.max(1e-8, percentile(rms, 0.98));
  const energy = Buffer.from(rms.map(value => Math.round(Math.min(1, Math.sqrt(value / scale)) * 255)));
  const flux = rms.map((value, i) => Math.max(0, value - (rms[i - 1] ?? value)));
  const fluxScale = Math.max(1e-8, percentile(flux, 0.98)), beats = [];
  for (let i = 1; i < rms.length - 1; i++) {
    const history = rms.slice(Math.max(0, i - 30), i), previousFlux = flux.slice(Math.max(0, i - 30), i);
    const floor = Math.max(1e-8, percentile(history, 0.5));
    const meanFlux = previousFlux.reduce((sum, value) => sum + value, 0) / Math.max(1, previousFlux.length);
    if (flux[i] <= flux[i - 1] || flux[i] < flux[i + 1] || flux[i] < Math.max(1e-7, meanFlux * 1.8) ||
        rms[i] < scale * 0.08 || rms[i] < floor * 1.12 || i - (beats.at(-1)?.[0] ?? -100) < 6) continue;
    beats.push([i, Math.round(Math.min(1, Math.sqrt(flux[i] / fluxScale)) * 255)]);
  }
  return { durationMs: roundedDuration, sampleMs: SAMPLE_MS, energy: energy.toString('base64'), beats };
}

async function timeline(file) {
  const { stdout: json } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
    { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const duration = Number(JSON.parse(json).format?.duration) * 1000;
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
    '-protocol_whitelist', 'file,crypto,data', '-i', file, '-map', '0:a:0', '-vn',
    '-af', 'aresample=8000:async=1:first_pts=0,highpass=f=35,lowpass=f=180', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return analyseRhythm(stdout, duration);
}

export async function packageRhythm({ input, preview, out }) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(input)) hash.update(chunk);
  const sourceSha256 = hash.digest('hex');
  const full = await timeline(input), excerpt = await timeline(preview);
  const result = { schema: 1, sourceSha256,
    method: { kind: 'bass-energy-onsets', bandHz: [35, 180], sampleHz: 25, minimumBeatSpacingMs: 240 },
    qualities: { full, preview: excerpt } };
  const json = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(json) > 96 * 1024) throw new Error('Rhythm asset exceeds its limit');
  await writeFile(out, json);
  return { bytes: Buffer.byteLength(json), sourceSha256,
    full: { durationMs: full.durationMs, beats: full.beats.length }, preview: { durationMs: excerpt.durationMs, beats: excerpt.beats.length } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].slice(2);
    if (!['input', 'preview', 'out'].includes(key) || !process.argv[i + 1]) throw new Error('Use --input LICENSED.mp4 --preview LOCAL.m3u8 --out RHYTHM.json');
    options[key] = resolve(process.argv[i + 1]);
  }
  if (!options.input || !options.preview || !options.out) throw new Error('The input, preview and output paths are required');
  console.log(JSON.stringify(await packageRhythm(options)));
}
