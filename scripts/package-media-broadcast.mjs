#!/usr/bin/env node
// Package owner-authorised H.264/AAC into static HLS without re-encoding.
// This is a playback artefact, separate from the live native-server comparison.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { mediaPermission } from './package-media-demo.mjs';

const exec = promisify(execFile);
async function identity(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: (await stat(file)).size };
}
async function probe(file, ffprobe, signal) {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal });
  const value = JSON.parse(stdout), video = value.streams?.find(track => track.codec_type === 'video'),
    audio = value.streams?.find(track => track.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || audio?.codec_name !== 'aac') throw new Error('Packet-copy playback needs H.264 video and AAC audio');
  const [n, d] = String(video.avg_frame_rate).split('/').map(Number);
  return { width: video.width, height: video.height, fps: d > 0 ? n / d : null,
    durationSeconds: Number(value.format.duration), bitrateBps: Number(value.format.bit_rate),
    videoCodec: video.codec_name, audioCodec: audio.codec_name, audioSampleRate: Number(audio.sample_rate) };
}

export async function packageBroadcast({ input, out, provenance, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' }) {
  const permission = mediaPermission({ licensed: true, provenance });
  input = resolve(input); out = resolve(out);
  const source = { ...await identity(input), ...await probe(input, ffprobe) };
  if (!(source.durationSeconds > 0 && source.durationSeconds <= 330) || source.bytes > 1024 ** 3) throw new Error('Public broadcast budget is 330 seconds and 1 GiB');
  await mkdir(out); // Refuse to overwrite any existing path, including symlinks.
  let child, cap, killTimer, completed = false, interrupted = false;
  const postprocessing = new AbortController();
  const stop = () => {
    interrupted = true;
    postprocessing.abort();
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-map_metadata', '-1',
      '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_flags', 'independent_segments', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(out, 'segment-%04d.m4s'), join(out, 'index.m3u8')],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    cap = setTimeout(stop, 180_000).unref();
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    if (result.code !== 0 || interrupted) throw new Error('Packet-copy HLS packaging did not complete');
    const decodedHeader = await probe(join(out, 'index.m3u8'), ffprobe, postprocessing.signal);
    if (decodedHeader.width !== source.width || decodedHeader.height !== source.height || Math.abs(decodedHeader.durationSeconds - source.durationSeconds) > 1)
      throw new Error('Packaged HLS does not match the source dimensions or duration');
    const files = {};
    for (const name of (await readdir(out)).sort()) {
      if (interrupted) throw new Error('Packaging interrupted');
      if (!/^(?:index\.m3u8|init\.mp4|segment-\d{4}\.m4s)$/.test(name)) throw new Error('Unexpected playback artefact');
      files[name] = await identity(join(out, name), postprocessing.signal);
    }
    const manifest = { schema: 1, ...permission, source: { label: permission.licence.title, ...source },
      packaging: { implementation: 'FFmpeg static HLS packet copy', transcode: false, liveOrigin: false,
        videoTracks: 1, audioTracks: 1, targetSegmentSeconds: 2, playlist: 'index.m3u8',
        validation: 'Independent ffprobe parsed the HLS video/audio tracks, dimensions and duration; browser playback is qualified separately.' },
      files, mediaBytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0) };
    if (interrupted) throw new Error('Packaging interrupted');
    await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { signal: postprocessing.signal });
    if (interrupted) throw new Error('Packaging interrupted');
    completed = true;
    return manifest;
  } finally {
    clearTimeout(cap); clearTimeout(killTimer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (child?.exitCode === null && child?.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    if (!completed) await rm(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--input', '--out', '--provenance'].includes(key) || !value || value.startsWith('--')) throw new Error('Use --input FILE --out NEW-DIRECTORY --provenance PERMISSION.json');
    options[key.slice(2)] = value;
  }
  if (!options.input || !options.out || !options.provenance) throw new Error('Input, new output directory and explicit public permission are required');
  options.provenance = JSON.parse(await readFile(options.provenance, 'utf8'));
  try { const manifest = await packageBroadcast(options); console.log(JSON.stringify({ files: Object.keys(manifest.files).length, mediaBytes: manifest.mediaBytes, source: manifest.source, packaging: manifest.packaging })); }
  catch { console.error('Licensed broadcast packaging failed; no complete artefact was published.'); process.exitCode = 1; }
}
