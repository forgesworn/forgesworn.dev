import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm, stat, lstat, open, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms).unref());
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function mediaPermission({ generated = false, licensed = false, provenance } = {}) {
  if (generated === licensed) throw new Error('Choose exactly one provenance: --generated or --licensed');
  if (licensed && (typeof provenance?.title !== 'string' || !provenance.title.trim() ||
      provenance.permission !== 'owner-authorised-public-demo')) {
    throw new Error('Licensed media needs a title and owner-authorised-public-demo permission in its provenance');
  }
  return generated ? { generated: true } : {
    generated: false, licensed: true,
    licence: { title: provenance.title.trim().slice(0, 160), permission: 'owner-authorised-public-demo' },
  };
}

async function fileIdentity(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size };
}

// Capture only complete media segments. Initial live-window GAP entries are
// absent from the replay; the original media bytes and durations are retained.
export function parseSnapshot(text) {
  if (!text.startsWith('#EXTM3U')) throw new Error('Invalid HLS snapshot');
  let init, duration, gap = false;
  const segments = [];
  for (const line of text.trim().split(/\r?\n/).map(value => value.trim())) {
    if (line.startsWith('#EXT-X-MAP:')) init = line.match(/URI="([^"]+)"/)?.[1];
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line === '#EXT-X-GAP') gap = true;
    else if (line && !line.startsWith('#')) {
      if (!gap) {
        if (!Number.isFinite(duration) || duration <= 0 || duration > 12) throw new Error('Invalid segment duration');
        if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(line)) throw new Error('Unsafe media path');
        segments.push({ name: line, duration });
      }
      duration = undefined;
      gap = false;
    }
  }
  if (!init || !/^[a-zA-Z0-9_-]+\.mp4$/.test(init)) throw new Error('Unsafe initialisation path');
  return { init, segments };
}

export function replayPlaylist(segments) {
  if (!segments.length || segments.length > 64) throw new Error('Replay needs 1–64 complete segments');
  const target = Math.ceil(Math.max(...segments.map(item => item.duration)));
  return [
    '#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-MAP:URI="init.mp4"',
    ...segments.flatMap((item, index) => [`#EXTINF:${item.duration.toFixed(6)},`, `segment-${String(index).padStart(3, '0')}.mp4`]),
    '#EXT-X-ENDLIST', '',
  ].join('\n');
}

async function tcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function udpPort() {
  const socket = createSocket('udp4');
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  const collect = chunk => { child.log = (child.log + chunk.toString()).slice(-12_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.completion = new Promise(resolve => {
    child.once('error', () => resolve({ code: -1 }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return child;
}

async function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await Promise.race([child.completion, pause(2000)]);
  // A wrapper may have exited while a descendant still owns its pipes/sockets.
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await child.completion;
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Media request failed (${response.status})`);
  return response;
}

async function sourceReceipt(source, binary) {
  const files = ['Cargo.lock', 'Cargo.toml'];
  async function visit(path) {
    for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  for (const crate of ['sapflow-core', 'sapflow-srt', 'sapflow-rtmp', 'sapflow-hls', 'sapflow-server']) await visit(`crates/${crate}`);
  const checksums = {};
  for (const file of files.sort()) checksums[file] = digest(await readFile(join(source, file)));
  let archive;
  try { archive = JSON.parse(await readFile(join(source, 'media-demo-source.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const revision = archive ? archive.revision : execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Source receipt needs an exact Git revision');
  return { revision, ...(archive ? { buildAdjustment: String(archive.buildAdjustment).slice(0, 256) } : {}),
    binarySha256: digest(await readFile(binary)), runtimeSourceSha256: digest(JSON.stringify(checksums)), files: checksums };
}

export async function packageDemo({ input, sapflow, source, out, seconds = 18, generated = false, licensed = false, quality = '720p', provenance }) {
  const permission = mediaPermission({ generated, licensed, provenance });
  if (!['720p', '1080p'].includes(quality)) throw new Error('Demo quality must be 720p or 1080p');
  const profile = quality === '1080p'
    ? { width: 1920, height: 1080, fps: 25, videoBps: 3_000_000, maxBps: 4_000_000, bufferBps: 6_000_000, audioBps: 128_000 }
    : { width: 1280, height: 720, fps: 24, videoBps: 1_200_000, maxBps: 1_600_000, bufferBps: 2_400_000, audioBps: 96_000 };
  if (!Number.isInteger(seconds) || seconds < 12 || seconds > 45) throw new Error('Capture duration must be 12–45 whole seconds');
  input = resolve(input); sapflow = resolve(sapflow); source = resolve(source); out = resolve(out);
  for (const name of ['rtmp', 'srt', 'source.mp4', 'manifest.json']) {
    try { await lstat(join(out, name)); throw new Error(`Output already exists: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const scratch = await mkdtemp(join(tmpdir(), 'forgesworn-media-package-'));
  const children = new Set();
  const createdOutputs = [];
  let published = false;
  async function writeNewFile(file, bytes) {
    const handle = await open(file, 'wx', 0o644);
    createdOutputs.push(file);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  }
  let interrupted = false;
  const interrupt = () => { interrupted = true; for (const child of children) void stop(child); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const prepared = join(scratch, 'prepared.mp4');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', input], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }));
    if (!probe.streams.some(stream => stream.codec_type === 'video')) throw new Error('Demo source needs a video track');
    const hasAudio = probe.streams.some(stream => stream.codec_type === 'audio');
    const args = ['-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-i', input];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000');
    args.push('-t', String(seconds), '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
      '-vf', `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,fps=${profile.fps}`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-tune', 'zerolatency',
      '-g', String(profile.fps), '-keyint_min', String(profile.fps), '-sc_threshold', '0', '-b:v', String(profile.videoBps), '-maxrate', String(profile.maxBps), '-bufsize', String(profile.bufferBps),
      '-c:a', 'aac', '-b:a', String(profile.audioBps), '-ar', '48000', '-ac', '2',
      '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', '-movflags', '+faststart', prepared);
    const encoder = start('ffmpeg', args); children.add(encoder);
    const encoded = await Promise.race([encoder.completion, pause(90_000).then(() => ({ code: -1 }))]);
    if (encoded.code !== 0 || interrupted) throw new Error('Demo source normalisation failed');
    await stop(encoder); children.delete(encoder);
    const receipt = await sourceReceipt(source, sapflow);
    const build = {
      schema: 1, ...permission,
      source: { ...await fileIdentity(input),
        provider: provenance?.provider ?? (generated ? 'original generated fixture' : 'owner-licensed media'),
        model: provenance?.model ?? null,
        audio: hasAudio ? 'source audio' : 'generated test tone' },
      sapflow: receipt, captureSeconds: seconds, preparedProfile: profile,
      preparedSource: { file: 'source.mp4', sha256: digest(await readFile(prepared)) }, clips: {},
      playback: 'Finite HLS replay captured from real loopback Sapflow SRT and RTMP ingest. The public static page does not run a live media origin.',
    };
    for (const transport of ['rtmp', 'srt']) {
      if (interrupted) throw new Error('Capture interrupted');
      const output = join(out, transport);
      // Never remove an existing dataset implicitly. Caller chooses a fresh
      // directory or explicitly replaces their own previous generated files.
      try { await mkdir(output); } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Output already exists: ${transport}`);
        throw error;
      }
      createdOutputs.push(output);
      const ports = { http: await tcpPort(), rtmp: await tcpPort(), srt: await udpPort() };
      const pass = randomBytes(24).toString('hex');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SAPFLOW_')));
      Object.assign(env, {
        SAPFLOW_HTTP_ADDR: `127.0.0.1:${ports.http}`, SAPFLOW_RTMP_ADDR: `127.0.0.1:${ports.rtmp}`,
        SAPFLOW_SRT_ADDR: `127.0.0.1:${ports.srt}`, SAPFLOW_SRT_IMPL: 'own',
        SAPFLOW_PUBLISH_USER: 'generated-demo', SAPFLOW_PUBLISH_PASS: pass,
        SAPFLOW_HLS_MODE: 'whole', SAPFLOW_SEGMENT_COUNT: '32', SAPFLOW_RECONNECT_GRACE: '20',
        SAPFLOW_HEALTH_INTERVAL: '0', SAPFLOW_MAX_PUBLISHERS: '2', RUST_LOG: 'info',
      });
      const server = start(sapflow, [], { env }); children.add(server);
      const base = `http://127.0.0.1:${ports.http}/live/event-demo-${transport}`;
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (server.exitCode !== null || interrupted) break;
        try { await fetch(`http://127.0.0.1:${ports.http}/`, { signal: AbortSignal.timeout(200) }); ready = true; break; } catch { await pause(100); }
      }
      if (!ready || !server.log.includes('implementation="own"')) throw new Error('Sapflow own-protocol server did not become ready');
      let publisher, sender;
      if (transport === 'rtmp') {
        publisher = start('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-i', prepared, '-c', 'copy', '-f', 'flv',
          `rtmp://127.0.0.1:${ports.rtmp}/live/event-demo-rtmp?user=generated-demo&pass=${pass}`]);
      } else {
        publisher = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-i', prepared, '-c', 'copy', '-f', 'mpegts', '-'],
          { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        publisher.completion = new Promise(resolve => { publisher.once('error', () => resolve({code:-1})); publisher.once('exit', code => resolve({code})); });
        publisher.log = ''; publisher.stderr.on('data', chunk => { publisher.log = (publisher.log + chunk).slice(-4000); });
        sender = spawn('srt-live-transmit', ['-q', '-a:no', '-chunk:1316', 'file://con',
          `srt://127.0.0.1:${ports.srt}?streamid=publish:live/event-demo-srt:generated-demo:${pass}&latency=200`],
          { detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
        sender.completion = new Promise(resolve => { sender.once('error', () => resolve({code:-1})); sender.once('exit', code => resolve({code})); });
        sender.log = ''; sender.stderr.on('data', chunk => { sender.log = (sender.log + chunk).slice(-4000); });
        publisher.stdout.pipe(sender.stdin); sender.stdin.on('error', () => {});
        children.add(sender);
      }
      children.add(publisher);
      const captured = new Map();
      let snapshot, master, init;
      const deadline = Date.now() + (seconds + 8) * 1000;
      while (Date.now() < deadline && !interrupted) {
        try {
          const text = await (await request(`${base}/stream.m3u8`)).text();
          const parsed = parseSnapshot(text);
          if (!init) {
            init = Buffer.from(await (await request(`${base}/${parsed.init}`)).arrayBuffer());
            master = await (await request(`${base}/index.m3u8`)).text();
          }
          for (const segment of parsed.segments) {
            if (captured.has(segment.name)) continue;
            const bytes = Buffer.from(await (await request(`${base}/${segment.name}`)).arrayBuffer());
            if (bytes.length > 4 * 1024 * 1024 || bytes.length < 1) throw new Error('Segment exceeds demo budget');
            captured.set(segment.name, { ...segment, bytes });
          }
          snapshot = text;
        } catch (error) {
          if (!/Media request failed|fetch failed|timeout/i.test(error.message)) throw error;
        }
        if (publisher.exitCode !== null && (publisher.exitCode !== 0 || captured.size >= 4)) break;
        await pause(250);
      }
      const result = publisher.exitCode === null ? await Promise.race([publisher.completion, pause(2000).then(() => ({code:-1}))]) : await publisher.completion;
      if (result.code !== 0 || captured.size < 4 || !init || !master || interrupted) {
        const redact = text => String(text ?? '').replaceAll(pass, '[redacted]').slice(-1800);
        throw new Error(`${transport.toUpperCase()} capture did not produce complete media (publisher ${result.code}, segments ${captured.size}, init ${Boolean(init)}, master ${Boolean(master)}).\n${redact(publisher.log)}\n${redact(server.log)}`);
      }
      const segments = [...captured.values()];
      if (segments.reduce((sum, item) => sum + item.bytes.length, 0) > 32 * 1024 * 1024) throw new Error('Demo exceeds media byte budget');
      await writeFile(join(output, 'init.mp4'), init);
      const catalogue = { schema: 1, segments: [] };
      for (let i = 0; i < segments.length; i++) {
        const path = `segment-${String(i).padStart(3, '0')}.mp4`;
        await writeFile(join(output, path), segments[i].bytes);
        catalogue.segments.push({ path, sha256: digest(segments[i].bytes), size: segments[i].bytes.length, sn: i, cc: 0 });
      }
      await writeFile(join(output, 'segments.json'), JSON.stringify(catalogue, null, 2) + '\n');
      await writeFile(join(output, 'stream.m3u8'), replayPlaylist(segments));
      // This single-variant master is the server's own codec declaration.
      await writeFile(join(output, 'index.m3u8'), master);
      await writeFile(join(output, 'captured-live-snapshot.txt'), snapshot);
      const validation = start('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', join(output, 'index.m3u8'), '-f', 'null', '-']);
      children.add(validation);
      const decoded = await Promise.race([validation.completion, pause(20_000).then(() => ({code:-1}))]);
      if (decoded.code !== 0) throw new Error('Captured media failed independent decoding');
      await stop(validation); children.delete(validation);
      build.clips[transport] = {
        playlist: `${transport}/index.m3u8`, manifest: `${transport}/segments.json`,
        completeSegments: segments.length, durationSeconds: segments.reduce((sum, item) => sum + item.duration, 0),
        mediaBytes: segments.reduce((sum, item) => sum + item.bytes.length, init.length),
        decoded: true, sourceImplementation: transport === 'srt' ? 'sapflow-srt own listener' : 'sapflow-rtmp server',
      };
      await stop(publisher); children.delete(publisher);
      if (sender) { await stop(sender); children.delete(sender); }
      await stop(server); children.delete(server);
      console.log(`${transport.toUpperCase()}: ${segments.length} Sapflow segments captured and independently decoded`);
    }
    if (interrupted) throw new Error('Capture interrupted');
    await writeNewFile(join(out, 'source.mp4'), await readFile(prepared));
    if (interrupted) throw new Error('Capture interrupted');
    await writeNewFile(join(out, 'manifest.json'), JSON.stringify(build, null, 2) + '\n');
    if (interrupted) throw new Error('Capture interrupted');
    published = true;
    return build;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await Promise.allSettled([...children].map(stop));
    if (!published) await Promise.allSettled(createdOutputs.reverse().map(path => rm(path, { recursive: true, force: true })));
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--generated') options.generated = true;
    else if (key === '--licensed') options.licensed = true;
    else if (['--input', '--sapflow', '--source', '--out', '--seconds', '--quality', '--provenance'].includes(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = key === '--seconds' ? Number(args[++i]) : args[++i];
    } else throw new Error(`Unknown option ${key}`);
  }
  options.out ??= 'site/media/demo';
  if (!options.input || !options.sapflow || !options.source) {
    console.error('Usage: node scripts/package-media-demo.mjs (--generated | --licensed --provenance permission.json) --input clip.mp4 --sapflow /path/to/sapflow --source /path/to/source [--quality 720p|1080p] [--out site/media/demo]');
    process.exitCode = 2;
  } else {
    if (options.provenance) options.provenance = JSON.parse(await readFile(options.provenance, 'utf8'));
    let createdRoot = false;
    try {
      try { await mkdir(resolve(options.out)); createdRoot = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await packageDemo(options);
    } catch (error) {
      if (createdRoot) { try { await rmdir(resolve(options.out)); } catch {} }
      console.error(error.message); process.exitCode = 1;
    }
  }
}
