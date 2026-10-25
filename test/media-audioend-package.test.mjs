import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchRecordingMetadata, packageAudioEnd } from '../scripts/package-public-swarm-audioend.mjs';

const source = new URL('../site/media/', import.meta.url);
const catalogueBytes = await readFile(new URL('dejavu-swarm/catalogue-v2.json', source));
const playlistBytes = await readFile(new URL('dejavu-4k/index-v1.m3u8', source));
const expectedCatalogue = await readFile(new URL('dejavu-swarm/catalogue-v3.json', source));
const expectedPlaylist = await readFile(new URL('dejavu-4k/index.m3u8', source));
const last = JSON.parse(expectedCatalogue).qualities.full.segments[133];
const tailPieces = { ...last, path: 'segment-0133.m4s' };

test('reviewed tail commitments reproduce the shipped manifest and catalogue exactly', () => {
  const actual = patchRecordingMetadata({ catalogueBytes, playlistBytes, tailPieces });
  assert.deepEqual(actual.catalogueBytes, expectedCatalogue);
  assert.deepEqual(actual.playlistBytes, expectedPlaylist);
});

test('the packet-copy metadata patch rejects changed originals and unreviewed tail identity', () => {
  for (const changed of [
    { catalogueBytes: Buffer.concat([catalogueBytes, Buffer.from(' ')]) },
    { playlistBytes: Buffer.concat([playlistBytes, Buffer.from(' ')]) },
    { tailPieces: { ...tailPieces, sha256: '0'.repeat(64) } },
    { tailPieces: { ...tailPieces, size: tailPieces.size - 1 } },
    { tailPieces: { ...tailPieces, pieces: [] } },
    { tailPieces: { ...tailPieces, pieceSize: tailPieces.pieceSize * 2 } },
  ]) assert.throws(() => patchRecordingMetadata({ catalogueBytes, playlistBytes, tailPieces, ...changed }));
});

test('the full package gate refuses an unrelated init change before publishing metadata', async t => {
  const fullDir = await mkdtemp(join(tmpdir(), 'forgesworn-audioend-test-'));
  t.after(() => rm(fullDir, { recursive: true, force: true }));
  await writeFile(join(fullDir, 'init.mp4'), 'unreviewed replacement');
  await assert.rejects(packageAudioEnd({ fullDir, catalogueBytes, playlistBytes }), /Initialisation segment changed/);
});
