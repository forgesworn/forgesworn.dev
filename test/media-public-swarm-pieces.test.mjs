import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPieceArtifacts, commitmentPieceSize, hashSegmentPieces, parseSourceCatalogue,
  rewriteFullPlaylist, validatePieceCatalogue, SOURCE_SHA256, SOURCE_CATALOGUE_SHA256,
  FULL_PLAYLIST_SHA256, FULL_MEDIA_BASE, FULL_PLAYLIST, PREVIEW_MEDIA_BASE,
  MAX_SEGMENT_BYTES, MAX_CATALOGUE_BYTES } from '../scripts/package-public-swarm-pieces.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forgesworn-piece-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fullDir = join(root, 'full'), previewDir = join(root, 'preview');
  await mkdir(fullDir); await mkdir(previewDir);
  const segments = { full: [], preview: [] }, data = {};
  for (const [name, count, directory] of [['full', 134, fullDir], ['preview', 30, previewDir]]) {
    for (let index = 0; index < count; index++) {
      const path = name === 'full' ? `segment-${String(index).padStart(4, '0')}.m4s` : `segment-${String(index).padStart(3, '0')}.mp4`;
      const bytes = name === 'full' && index === 0 ? Buffer.from(Uint8Array.from({ length: 65536 + 19 }, (_, at) => at % 251)) : Buffer.from(`${name} fixture ${index}`);
      await writeFile(join(directory, path), bytes);
      segments[name].push({ path, sn: index, cc: 0, sha256: digest(bytes), size: bytes.length });
      if (index === 0) data[name] = bytes;
    }
  }
  const playlist = Buffer.from('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n' +
    segments.full.map(entry => `#EXTINF:2.000000,\n${entry.path}\n`).join('') + '#EXT-X-ENDLIST\n');
  const init = Buffer.from('Known init fixture.');
  await writeFile(join(fullDir, 'index.m3u8'), playlist); await writeFile(join(fullDir, 'init.mp4'), init);
  const source = { schema: 1, sourceSha256: SOURCE_SHA256, licensed: true, qualities: {
    full: { playlist: FULL_MEDIA_BASE + 'index.m3u8', segments: segments.full },
    preview: { playlist: PREVIEW_MEDIA_BASE + 'index.m3u8', segments: segments.preview },
  } };
  const sourceCatalogueBytes = json(source);
  return { root, source, data, playlist, options: { fullDir, previewDir, sourceCatalogueBytes,
    expectedCatalogueSha256: digest(sourceCatalogueBytes), expectedPlaylistSha256: digest(playlist), expectedInitSha256: digest(init) } };
}

test('schema 3 piece geometry obeys the protocol at size boundaries', () => {
  for (const [size, expected] of [[1, 65536], [65536, 65536], [4194304, 65536], [4194305, 81920], [6471966, 114688], [MAX_SEGMENT_BYTES, 262144]]) {
    assert.equal(commitmentPieceSize(size), expected);
    assert(Math.ceil(size / expected) <= 64);
  }
  for (const size of [0, -1, 1.2, NaN, Infinity, MAX_SEGMENT_BYTES + 1]) assert.throws(() => commitmentPieceSize(size));
});

test('packaging is deterministic and hashes a short final piece without loading the whole recording', async t => {
  const f = await fixture(t), result = await buildPieceArtifacts(f.options), again = await buildPieceArtifacts(f.options);
  assert.deepEqual(result.catalogueBytes, again.catalogueBytes); assert.deepEqual(result.playlistBytes, again.playlistBytes);
  const entry = result.catalogue.qualities.full.segments[0];
  assert.equal(entry.sha256, f.source.qualities.full.segments[0].sha256);
  assert.equal(entry.pieceSize, 65536);
  assert.deepEqual(entry.pieces, [digest(f.data.full.subarray(0, 65536)), digest(f.data.full.subarray(65536))]);
  assert.equal(result.catalogue.qualities.full.mediaBase, FULL_MEDIA_BASE);
  assert.equal(result.catalogue.qualities.full.playlist, FULL_PLAYLIST);
  assert.equal(result.catalogue.qualities.full.mediaPlaylist, FULL_PLAYLIST);
  assert.equal(result.catalogue.qualities.preview.mediaPlaylist, '/media/dejavu-preview/rtmp/stream.m3u8');
  assert.equal(result.catalogue.qualities.preview.playlist, '/media/dejavu-preview/rtmp/index.m3u8');
  assert(result.catalogueBytes.length <= MAX_CATALOGUE_BYTES);
});

test('untrusted catalogue digests, altered source hashes, traversal and oversized segments are rejected', async t => {
  const f = await fixture(t);
  assert.throws(() => parseSourceCatalogue(f.options.sourceCatalogueBytes));
  const changedBytes = Buffer.from(f.options.sourceCatalogueBytes); changedBytes[10] ^= 1;
  assert.throws(() => parseSourceCatalogue(changedBytes, f.options.expectedCatalogueSha256), /digest mismatch/);
  for (const change of [
    value => { value.sourceSha256 = 'a'.repeat(64); },
    value => { value.licensed = false; },
    value => { value.qualities.full.playlist = 'https://evil.example/index.m3u8'; },
    value => { value.qualities.full.segments[0].path = '../private'; },
    value => { value.qualities.preview.segments[0].path = '/tmp/private'; },
    value => { value.qualities.full.segments[1].sn = 0; },
    value => { value.qualities.full.segments[0].size = MAX_SEGMENT_BYTES + 1; },
  ]) {
    const value = structuredClone(f.source); change(value); const bytes = json(value);
    assert.throws(() => parseSourceCatalogue(bytes, digest(bytes)));
  }
});

test('every segment must match the existing whole digest and size before accepting its pieces', async t => {
  const f = await fixture(t), entry = f.source.qualities.full.segments[0];
  const altered = Buffer.from(f.data.full); altered[1] ^= 1;
  await writeFile(join(f.options.fullDir, entry.path), altered);
  await assert.rejects(hashSegmentPieces(f.options.fullDir, entry), /digest mismatch/);
  await writeFile(join(f.options.fullDir, entry.path), altered.subarray(1));
  await assert.rejects(hashSegmentPieces(f.options.fullDir, entry), /size mismatch/);
  await assert.rejects(hashSegmentPieces(f.options.fullDir, { ...entry, path: '../segment-0000.m4s' }), /Invalid segment path/);
  await assert.rejects(hashSegmentPieces(f.options.fullDir, { ...entry, size: MAX_SEGMENT_BYTES + 1 }), /Invalid segment size/);
});

test('a symlink cannot substitute an external media file', async t => {
  const f = await fixture(t), entry = f.source.qualities.full.segments[0];
  const outside = join(f.root, 'outside.m4s'); await writeFile(outside, f.data.full);
  await unlink(join(f.options.fullDir, entry.path));
  try { await symlink(outside, join(f.options.fullDir, entry.path)); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Creating symlinks is unavailable for this test account.'); return; } throw error; }
  await assert.rejects(hashSegmentPieces(f.options.fullDir, entry), /missing or not a regular file/);
});

test('piece validation rejects malformed hashes, counts, noncanonical sizes, traversal and oversized metadata', async t => {
  const f = await fixture(t), { catalogue } = await buildPieceArtifacts(f.options);
  validatePieceCatalogue(catalogue, f.source, f.options.expectedCatalogueSha256);
  for (const change of [
    value => { value.qualities.full.segments[0].pieces[0] = 'not-a-hash'; },
    value => { value.qualities.full.segments[0].pieces[0] = 'A'.repeat(64); },
    value => { value.qualities.full.segments[0].pieces.pop(); },
    value => { value.qualities.full.segments[0].pieces = Array(65).fill('a'.repeat(64)); },
    value => { value.qualities.full.segments[0].pieceSize += 16384; },
    value => { value.qualities.full.segments[0].sha256 = 'b'.repeat(64); },
    value => { value.sourceCatalogueSha256 = 'b'.repeat(64); },
    value => { value.qualities.full.segments[0].path = '../private'; },
    value => { value.qualities.full.mediaBase = 'https://evil.example/'; },
    value => { value.qualities.preview.mediaPlaylist += '?different=1'; },
    value => { value.padding = 'x'.repeat(MAX_CATALOGUE_BYTES); },
  ]) {
    const altered = structuredClone(catalogue); change(altered);
    assert.throws(() => validatePieceCatalogue(altered, f.source, f.options.expectedCatalogueSha256));
  }
});

test('the wrapper changes only known init and segment URIs, refusing unknown resources and source bytes', async t => {
  const f = await fixture(t), entries = f.source.qualities.full.segments;
  const wrapper = rewriteFullPlaylist(f.playlist, entries, digest(f.playlist));
  assert(wrapper.includes(Buffer.from(`#EXT-X-MAP:URI="${FULL_MEDIA_BASE}init.mp4"`)));
  assert.equal(wrapper.toString().replaceAll(FULL_MEDIA_BASE, ''), f.playlist.toString());
  assert.throws(() => rewriteFullPlaylist(f.playlist, entries), /digest mismatch/);
  for (const input of [
    f.playlist.toString().replace('segment-0000.m4s', '../private'),
    f.playlist.toString().replace('segment-0000.m4s', 'https://evil.example/segment.m4s'),
    f.playlist.toString().replace('init.mp4', '../init.mp4'),
    f.playlist.toString().replace('#EXT-X-ENDLIST', '#EXT-X-KEY:URI="key.bin"\n#EXT-X-ENDLIST'),
  ]) {
    const bytes = Buffer.from(input);
    assert.throws(() => rewriteFullPlaylist(bytes, entries, digest(bytes)));
  }
});

test('the generated public catalogue preserves the licensed identity, exact whole hashes and all shipped preview pieces', async () => {
  const source = parseSourceCatalogue(await readFile(new URL('../site/media/dejavu-swarm/catalogue-v1.json', import.meta.url)));
  const bytes = await readFile(new URL('../site/media/dejavu-swarm/catalogue-v2.json', import.meta.url));
  const catalogue = validatePieceCatalogue(JSON.parse(bytes), source);
  assert.equal(catalogue.sourceCatalogueSha256, SOURCE_CATALOGUE_SHA256);
  assert.equal(catalogue.qualities.full.segments.reduce((n, entry) => n + entry.pieces.length, 0), 8051);
  assert.equal(catalogue.qualities.preview.segments.reduce((n, entry) => n + entry.pieces.length, 0), 195);
  assert(bytes.length < MAX_CATALOGUE_BYTES);
  assert.doesNotMatch(bytes.toString(), /\/Users\/|\/var\/folders\/|file:\/\//);
  for (const entry of catalogue.qualities.preview.segments) {
    const directory = new URL('../site/media/dejavu-preview/rtmp/', import.meta.url);
    assert.deepEqual(await hashSegmentPieces(fileURLToPath(directory), entry), entry);
  }
  const playlist = await readFile(new URL('../site/media/dejavu-4k/index.m3u8', import.meta.url), 'utf8');
  assert.equal(digest(playlist.replaceAll(FULL_MEDIA_BASE, '')), FULL_PLAYLIST_SHA256);
});
