#!/usr/bin/env node
// Offline packaging for the immutable licensed recording. Every segment must
// match the existing whole-file catalogue before its piece hashes are accepted.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_SHA256 = '76d90719a756c77d1008088c58ca6b28a74eb0ef01e5337906cfb68d3e2b13aa';
export const SOURCE_CATALOGUE_SHA256 = '8b8276556c7aaaaac8fe61716c51648ce00bfdfb8d5a81a2d81490d97b21b7d4';
export const FULL_PLAYLIST_SHA256 = 'd22ce2404aa40427aea82995a070d5f543c3607969d70fdc43d46513ecd972cd';
export const FULL_INIT_SHA256 = 'c074561d71e346f054efa492748cb137ef5d79e8f04317fa3a14eaa69fa7a915';
export const FULL_MEDIA_BASE = 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/';
export const FULL_PLAYLIST = '/media/dejavu-4k/index.m3u8';
export const PREVIEW_MEDIA_BASE = '/media/dejavu-preview/rtmp/';
export const MAX_CATALOGUE_BYTES = 1024 * 1024;
export const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const root = fileURLToPath(new URL('../', import.meta.url));
const HEX = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const qualities = {
  full: { count: 134, pattern: /^segment-[0-9]{4}\.m4s$/, path: index => `segment-${String(index).padStart(4, '0')}.m4s`,
    sourcePlaylist: FULL_MEDIA_BASE + 'index.m3u8', playlist: FULL_PLAYLIST, mediaPlaylist: FULL_PLAYLIST,
    mediaBase: FULL_MEDIA_BASE, swarmId: 'forgesworn-dejavu-4k-pieces-v2-76d90719a756c77d' },
  preview: { count: 30, pattern: /^segment-[0-9]{3}\.mp4$/, path: index => `segment-${String(index).padStart(3, '0')}.mp4`,
    sourcePlaylist: PREVIEW_MEDIA_BASE + 'index.m3u8', playlist: PREVIEW_MEDIA_BASE + 'index.m3u8',
    mediaPlaylist: PREVIEW_MEDIA_BASE + 'stream.m3u8', mediaBase: PREVIEW_MEDIA_BASE,
    swarmId: 'forgesworn-dejavu-1080-pieces-v2-76d90719a756c77d' },
};

// RelaySwarm schema 3: >=64 KiB, <=64 pieces, rounded to a 16 KiB multiple.
export function commitmentPieceSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SEGMENT_BYTES) throw new Error('Invalid segment size.');
  return Math.ceil(Math.max(65536, Math.ceil(size / 64)) / 16384) * 16384;
}

function validateSource(source) {
  if (source?.schema !== 1 || source.sourceSha256 !== SOURCE_SHA256 || source.licensed !== true) throw new Error('Wrong or unlicensed source catalogue.');
  for (const [name, profile] of Object.entries(qualities)) {
    const value = source.qualities?.[name];
    if (value?.playlist !== profile.sourcePlaylist || !Array.isArray(value.segments) || value.segments.length !== profile.count) throw new Error('Incomplete source catalogue.');
    for (const [index, entry] of value.segments.entries()) {
      if (entry?.path !== profile.path(index) || entry.sn !== index || entry.cc !== 0 || !HEX.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_SEGMENT_BYTES) throw new Error('Invalid source segment identity.');
    }
  }
  return source;
}

export function parseSourceCatalogue(bytes, expectedSha256 = SOURCE_CATALOGUE_SHA256) {
  if (!HEX.test(expectedSha256) || bytes.byteLength > 64 * 1024 || hash(bytes) !== expectedSha256) throw new Error('Source catalogue digest mismatch.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid source catalogue JSON.'); }
  return validateSource(value);
}

async function boundedFile(file, limit) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error();
    const buffer = Buffer.allocUnsafe(limit + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    if (filled > limit) throw new Error();
    return buffer.subarray(0, filled);
  } catch { throw new Error('Required packaging metadata is missing or exceeds its bound.'); }
  finally { await handle?.close(); }
}

export async function hashSegmentPieces(directory, entry) {
  if (!entry || typeof entry.path !== 'string' || !Object.values(qualities).some(profile => profile.pattern.test(entry.path)) || !HEX.test(entry.sha256)) throw new Error('Invalid segment path or digest.');
  const pieceSize = commitmentPieceSize(entry.size), pieces = [], whole = createHash('sha256');
  let handle;
  try {
    try { handle = await open(resolve(directory, entry.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch { throw new Error(`Required segment is missing or not a regular file: ${entry.path}.`); }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(entry.size)) throw new Error(`Segment size mismatch: ${entry.path}.`);
    const buffer = Buffer.allocUnsafe(pieceSize);
    for (let position = 0; position < entry.size;) {
      const length = Math.min(pieceSize, entry.size - position);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (!bytesRead) throw new Error(`Segment ended early: ${entry.path}.`);
        filled += bytesRead;
      }
      const view = buffer.subarray(0, length);
      whole.update(view); pieces.push(hash(view)); position += length;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`Segment changed while being read: ${entry.path}.`);
    if (whole.digest('hex') !== entry.sha256) throw new Error(`Segment digest mismatch: ${entry.path}.`);
    return { path: entry.path, sn: entry.sn, cc: entry.cc, sha256: entry.sha256, size: entry.size, pieceSize, pieces };
  } finally { await handle?.close(); }
}

export function rewriteFullPlaylist(bytes, entries, expectedSha256 = FULL_PLAYLIST_SHA256) {
  if (!HEX.test(expectedSha256) || bytes.byteLength > 64 * 1024 || hash(bytes) !== expectedSha256) throw new Error('Original full playlist digest mismatch.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Invalid original playlist encoding.'); }
  let init = 0, index = 0;
  const lines = text.split('\n').map(line => {
    if (line === '#EXT-X-MAP:URI="init.mp4"') { init++; return `#EXT-X-MAP:URI="${FULL_MEDIA_BASE}init.mp4"`; }
    if (!line || line.startsWith('#')) {
      if (/URI\s*=/i.test(line)) throw new Error('Unrecognised URI in the original playlist.');
      return line;
    }
    if (line !== entries[index]?.path || line !== qualities.full.path(index)) throw new Error('Unexpected media URI or sequence in the original playlist.');
    index++; return FULL_MEDIA_BASE + line;
  });
  if (init !== 1 || index !== entries.length || index !== qualities.full.count || !text.startsWith('#EXTM3U\n') || !lines.includes('#EXT-X-ENDLIST')) throw new Error('Incomplete original media playlist.');
  return Buffer.from(lines.join('\n'));
}

export function validatePieceCatalogue(value, source, expectedSourceCatalogueSha256 = SOURCE_CATALOGUE_SHA256) {
  validateSource(source);
  if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > MAX_CATALOGUE_BYTES) throw new Error('Piece catalogue exceeds 1 MiB.');
  if (value?.schema !== 2 || value.sourceSha256 !== SOURCE_SHA256 || value.licensed !== true ||
    !HEX.test(expectedSourceCatalogueSha256) || value.sourceCatalogueSha256 !== expectedSourceCatalogueSha256) throw new Error('Invalid piece catalogue identity.');
  for (const [name, profile] of Object.entries(qualities)) {
    const descriptor = value.qualities?.[name];
    if (descriptor?.playlist !== profile.playlist || descriptor.mediaPlaylist !== profile.mediaPlaylist || descriptor.mediaBase !== profile.mediaBase ||
      descriptor.swarmId !== profile.swarmId || !Array.isArray(descriptor.segments) || descriptor.segments.length !== profile.count) throw new Error('Invalid piece catalogue descriptor.');
    for (const [index, entry] of descriptor.segments.entries()) {
      const original = source.qualities[name].segments[index];
      if (!entry || ['path', 'sn', 'cc', 'sha256', 'size'].some(key => entry[key] !== original[key]) || entry.path !== profile.path(index) ||
        entry.pieceSize !== commitmentPieceSize(entry.size) || !Array.isArray(entry.pieces) || entry.pieces.length !== Math.ceil(entry.size / entry.pieceSize) ||
        entry.pieces.length > 64 || entry.pieces.some(piece => typeof piece !== 'string' || !HEX.test(piece))) throw new Error('Invalid segment piece commitments.');
    }
  }
  return value;
}

// Explicit expected hashes make small offline fixtures possible. The CLI always
// uses the pinned public catalogue, playlist and init defaults above.
export async function buildPieceArtifacts({ fullDir, previewDir, sourceCatalogueBytes,
  expectedCatalogueSha256 = SOURCE_CATALOGUE_SHA256, expectedPlaylistSha256 = FULL_PLAYLIST_SHA256,
  expectedInitSha256 = FULL_INIT_SHA256 }) {
  const source = parseSourceCatalogue(sourceCatalogueBytes, expectedCatalogueSha256);
  const playlist = rewriteFullPlaylist(await boundedFile(resolve(fullDir, 'index.m3u8'), 64 * 1024), source.qualities.full.segments, expectedPlaylistSha256);
  const init = await boundedFile(resolve(fullDir, 'init.mp4'), 64 * 1024);
  if (!HEX.test(expectedInitSha256) || hash(init) !== expectedInitSha256) throw new Error('Original full init digest mismatch.');
  const descriptors = {};
  for (const [name, profile] of Object.entries(qualities)) {
    const segments = [];
    for (const entry of source.qualities[name].segments) segments.push(await hashSegmentPieces(name === 'full' ? fullDir : previewDir, entry));
    descriptors[name] = { playlist: profile.playlist, mediaPlaylist: profile.mediaPlaylist, mediaBase: profile.mediaBase, swarmId: profile.swarmId, segments };
  }
  const catalogue = validatePieceCatalogue({ schema: 2, sourceSha256: SOURCE_SHA256, licensed: true,
    sourceCatalogueSha256: expectedCatalogueSha256,
    integrityTrust: 'Reviewed HTTPS whole-file and piece digests pinned by SHA-256 in the public player. Each receiver wraps only these exact hashes in fresh local RelaySwarm commitments. No live broadcaster signature is claimed.',
    qualities: descriptors }, source, expectedCatalogueSha256);
  const catalogueBytes = Buffer.from(JSON.stringify(catalogue, null, 2) + '\n');
  return { catalogue, catalogueBytes, playlistBytes: playlist };
}

async function atomicWrite(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  let created = false, handle;
  try {
    handle = await open(temporary, 'wx', 0o644); created = true;
    await handle.writeFile(bytes); await handle.close(); handle = undefined;
    await rename(temporary, file);
  } finally { await handle?.close(); if (created) await rm(temporary, { force: true }); }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/package-public-swarm-pieces.mjs --full-dir DIR [--preview-dir DIR] [--catalogue-output FILE] [--playlist-output FILE]'); return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--full-dir': 'fullDir', '--preview-dir': 'previewDir', '--catalogue-output': 'catalogueOutput', '--playlist-output': 'playlistOutput' }[args[index]];
    if (!key || !args[index + 1] || options[key]) throw new Error('Use --full-dir DIR with optional explicit output paths.');
    options[key] = resolve(args[index + 1]);
  }
  if (!options.fullDir) throw new Error('Use --full-dir DIR for the byte-identical full recording package.');
  const result = await buildPieceArtifacts({ fullDir: options.fullDir,
    previewDir: options.previewDir ?? resolve(root, 'site/media/dejavu-preview/rtmp'),
    sourceCatalogueBytes: await boundedFile(resolve(root, 'site/media/dejavu-swarm/catalogue-v1.json'), 64 * 1024) });
  await atomicWrite(options.catalogueOutput ?? resolve(root, 'site/media/dejavu-swarm/catalogue-v2.json'), result.catalogueBytes);
  // Preserve the original package separately; the public index now uses the
  // reviewed audio-end derivative built by package-public-swarm-audioend.mjs.
  await atomicWrite(options.playlistOutput ?? resolve(root, 'site/media/dejavu-4k/index-v1.m3u8'), result.playlistBytes);
  console.log(JSON.stringify({ schema: 2, catalogueBytes: result.catalogueBytes.length, catalogueSha256: hash(result.catalogueBytes),
    playlistBytes: result.playlistBytes.length, playlistSha256: hash(result.playlistBytes),
    fullSegments: result.catalogue.qualities.full.segments.length, previewSegments: result.catalogue.qualities.preview.segments.length,
    fullPieces: result.catalogue.qualities.full.segments.reduce((total, entry) => total + entry.pieces.length, 0),
    previewPieces: result.catalogue.qualities.preview.segments.reduce((total, entry) => total + entry.pieces.length, 0), sourceSha256: SOURCE_SHA256 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
