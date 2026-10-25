#!/usr/bin/env node
// Reviewed packet-copy derivative: retain every AAC packet and remove only the
// 32 video frames after the soundtrack ends. Never replace an immutable object.
import { createHash } from 'node:crypto';
import { readFile, open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashSegmentPieces, commitmentPieceSize, FULL_INIT_SHA256 } from './package-public-swarm-pieces.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const ORIGINAL_CATALOGUE_SHA256 = 'fe69bf7b88279f796956a021db96b3fc99f12705c1d5f18a2f6fbe9f488b3073';
export const ORIGINAL_MANIFEST_SHA256 = 'd680b83954d81749737ce0ae9174b579c48ae6265a188768cfda9bb1511f400b';
export const AUDIO_END_TAIL = Object.freeze({ path: 'segment-0133-audioend-v2.m4s', size: 2238344,
  sha256: '335270e1369142eaba9faf9964588db74f0219a8b703ac7b2ce643b5c994422d' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function patchRecordingMetadata({ catalogueBytes, playlistBytes, tailPieces }) {
  if (hash(catalogueBytes) !== ORIGINAL_CATALOGUE_SHA256 || hash(playlistBytes) !== ORIGINAL_MANIFEST_SHA256) throw new Error('Original recording metadata digest mismatch.');
  if (tailPieces.path !== 'segment-0133.m4s' || tailPieces.size !== AUDIO_END_TAIL.size || tailPieces.sha256 !== AUDIO_END_TAIL.sha256) throw new Error('Unrecognised packet-copy tail.');
  if (tailPieces.pieceSize !== commitmentPieceSize(tailPieces.size) || !Array.isArray(tailPieces.pieces) ||
      tailPieces.pieces.length !== Math.ceil(tailPieces.size / tailPieces.pieceSize) ||
      tailPieces.pieces.some(piece => !/^[a-f0-9]{64}$/.test(piece))) throw new Error('Invalid tail piece commitments.');
  const catalogue = JSON.parse(catalogueBytes);
  catalogue.schema = 3;
  catalogue.derivedFromCatalogueSha256 = ORIGINAL_CATALOGUE_SHA256;
  catalogue.derivation = { kind: 'trim-silent-video-tail', sourceDurationSeconds: 268.6, durationSeconds: 267.32,
    removedVideoFrames: 32, preservedAudioPackets: 34 };
  const full = catalogue.qualities.full;
  full.swarmId = 'forgesworn-dejavu-4k-pieces-v3-76d90719a756c77d';
  full.segments[133] = { ...tailPieces, path: AUDIO_END_TAIL.path, sn: 133, cc: 0 };
  const before = '#EXTINF:2.000000,\nhttps://v4v.com/forgesworn-media-demo/dejavu-4k-v1/segment-0133.m4s\n#EXT-X-ENDLIST';
  const after = '#EXTINF:0.720000,\nhttps://v4v.com/forgesworn-media-demo/dejavu-4k-v1/' + AUDIO_END_TAIL.path + '\n#EXT-X-ENDLIST';
  const playlist = playlistBytes.toString('utf8');
  if (playlist.split(before).length !== 2) throw new Error('Original final fragment does not match.');
  return { catalogueBytes: Buffer.from(JSON.stringify(catalogue, null, 2) + '\n'), playlistBytes: Buffer.from(playlist.replace(before, after)) };
}

export async function packageAudioEnd({ fullDir, catalogueBytes, playlistBytes }) {
  // Verify the whole unchanged package too: an unrelated segment or init change
  // must not silently enter this one-fragment derivative.
  if (hash(catalogueBytes) !== ORIGINAL_CATALOGUE_SHA256) throw new Error('Original catalogue digest mismatch.');
  const original = JSON.parse(catalogueBytes);
  if (hash(await readFile(resolve(fullDir, 'init.mp4'))) !== FULL_INIT_SHA256) throw new Error('Initialisation segment changed.');
  for (const entry of original.qualities.full.segments.slice(0, 133)) await hashSegmentPieces(fullDir, entry);
  const tailPieces = await hashSegmentPieces(fullDir, { ...AUDIO_END_TAIL, path: 'segment-0133.m4s' });
  return patchRecordingMetadata({ catalogueBytes, playlistBytes, tailPieces });
}

async function atomicWrite(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  let created = false, handle;
  try {
    handle = await open(temporary, 'wx', 0o644); created = true;
    await handle.writeFile(bytes); await handle.close(); handle = undefined;
    await rename(temporary, file);
  } finally { await handle?.close(); if (created) await rm(temporary, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, directory, ...extra] = process.argv.slice(2);
  if (flag !== '--full-dir' || !directory || extra.length) throw new Error('Use --full-dir NEW-PACKET-COPY-DIRECTORY');
  const result = await packageAudioEnd({ fullDir: resolve(directory),
    catalogueBytes: await readFile(resolve(root, 'site/media/dejavu-swarm/catalogue-v2.json')),
    playlistBytes: await readFile(resolve(root, 'site/media/dejavu-4k/index-v1.m3u8')) });
  await atomicWrite(resolve(root, 'site/media/dejavu-swarm/catalogue-v3.json'), result.catalogueBytes);
  await atomicWrite(resolve(root, 'site/media/dejavu-4k/index.m3u8'), result.playlistBytes);
  console.log(JSON.stringify({ catalogueSha256: hash(result.catalogueBytes), manifestSha256: hash(result.playlistBytes), tail: AUDIO_END_TAIL }));
}
