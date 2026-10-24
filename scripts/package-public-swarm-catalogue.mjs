#!/usr/bin/env node
// A public digest catalogue for immutable, owner-licensed VOD. No signing key
// is needed or written: HTTPS and the shipped catalogue digest are its anchor.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const HEX = /^[a-f0-9]{64}$/;
const sourceSha256 = '76d90719a756c77d1008088c58ca6b28a74eb0ef01e5337906cfb68d3e2b13aa';
const MAX_SEGMENT = 16 * 1024 * 1024;
const valid = (entry) => HEX.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= MAX_SEGMENT;

export function publicSwarmCatalogue(full, preview) {
  if (full?.schema !== 1 || full.licensed !== true || full.source?.sha256 !== sourceSha256 ||
      full.packaging?.transcode !== false || full.packaging?.playlist !== 'index.m3u8' || !full.files ||
      preview?.schema !== 1 || !Array.isArray(preview.segments) || preview.segments.length !== 30) {
    throw new Error('Use the licensed immutable Deja Vu packaging manifests.');
  }
  const segments = Object.entries(full.files).filter(([path]) => /^segment-[0-9]{4}\.m4s$/.test(path))
    .sort(([a], [b]) => a.localeCompare(b)).map(([path, file], index) => ({ path, sn: index, cc: 0, sha256: file.sha256, size: file.bytes }));
  if (segments.length !== 134 || segments.some((entry, index) => entry.path !== `segment-${String(index).padStart(4, '0')}.m4s` || !valid(entry))) {
    throw new Error('The full recording segment catalogue is incomplete.');
  }
  const previewSegments = preview.segments.map(({ path, sha256, size, sn, cc }, index) => {
    const entry = { path, sn, cc, sha256, size };
    if (path !== `segment-${String(index).padStart(3, '0')}.mp4` || sn !== index || cc !== 0 || !valid(entry)) throw new Error('Invalid preview segment.');
    return entry;
  });
  return {
    schema: 1, sourceSha256, licensed: true,
    integrityTrust: 'Reviewed HTTPS digest catalogue pinned by SHA-256 in the public player. Each receiver wraps only these exact hashes in fresh local RelaySwarm commitments. No live broadcaster signature is claimed.',
    qualities: {
      full: { playlist: 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/index.m3u8',
        swarmId: 'forgesworn-dejavu-4k-v1-76d90719a756c77d', segments },
      preview: { playlist: '/media/dejavu-preview/rtmp/index.m3u8',
        swarmId: 'forgesworn-dejavu-1080-v1-76d90719a756c77d', segments: previewSegments },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/package-public-swarm-catalogue.mjs /path/to/dejavu-4k-manifest.json');
  const full = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const preview = JSON.parse(await readFile(resolve(root, 'site/media/dejavu-preview/rtmp/segments.json'), 'utf8'));
  const output = resolve(root, 'site/media/dejavu-swarm/catalogue-v1.json');
  const bytes = Buffer.from(JSON.stringify(publicSwarmCatalogue(full, preview), null, 2) + '\n');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  console.log(JSON.stringify({ file: 'site/media/dejavu-swarm/catalogue-v1.json', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }));
}
