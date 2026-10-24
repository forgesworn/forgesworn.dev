import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validatePublicSwarmCatalogue, catalogueSegment, PUBLIC_SWARM_CATALOGUE_SHA256,
  PUBLIC_SWARM_LIMITS, PUBLIC_SWARM_RELAYS, PUBLIC_SWARM_ICE } from '../site/media-public-swarm.mjs';

const bytes = await readFile(new URL('../site/media/dejavu-swarm/catalogue-v1.json', import.meta.url));
const catalogue = JSON.parse(bytes);
const preview = { quality: 'preview', playlistUrl: '/media/dejavu-preview/rtmp/index.m3u8', origin: 'https://forgesworn.dev/' };
const full = { quality: 'full', playlistUrl: 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/index.m3u8', origin: 'https://forgesworn.dev/' };

test('public VOD digest catalogue is pinned to reviewed source and matches every shipped preview segment', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PUBLIC_SWARM_CATALOGUE_SHA256);
  const plan = validatePublicSwarmCatalogue(catalogue, preview);
  for (const entry of plan.segments.values()) {
    const content = await readFile(new URL(`../site${new URL(entry.url).pathname}`, import.meta.url));
    assert.equal(content.length, entry.size);
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
  }
  const original = JSON.parse(await readFile(new URL('../site/media/dejavu-preview/playback.json', import.meta.url)));
  assert.equal(catalogue.sourceSha256, original.source.sha256);
  assert.equal(validatePublicSwarmCatalogue(catalogue, full).segments.size, 134);
});

test('catalogue refuses altered media identity, traversal, duplicate sequence, oversized media and unlicensed source', () => {
  for (const change of [
    value => { value.sourceSha256 = 'a'.repeat(64); },
    value => { value.licensed = false; },
    value => { value.qualities.preview.swarmId += '-evil'; },
    value => { value.qualities.preview.playlist = 'https://evil.test/index.m3u8'; },
    value => { value.qualities.preview.segments[0].path = '../secret'; },
    value => { value.qualities.preview.segments[1].sn = 0; },
    value => { value.qualities.preview.segments[0].cc = 1; },
    value => { value.qualities.preview.segments[0].size = PUBLIC_SWARM_LIMITS.maxSegmentBytes + 1; },
    value => { value.qualities.preview.segments[0].sha256 = 'not-a-hash'; },
  ]) {
    const altered = structuredClone(catalogue); change(altered);
    assert.throws(() => validatePublicSwarmCatalogue(altered, preview));
  }
  for (const playlistUrl of ['https://evil.test/media/dejavu-preview/rtmp/index.m3u8', `${preview.playlistUrl}?secret=x`, `${preview.playlistUrl}#x`]) {
    assert.throws(() => validatePublicSwarmCatalogue(catalogue, { ...preview, playlistUrl }));
  }
});

test('only the exact unencrypted muxed fragment receives a local commitment', () => {
  const plan = validatePublicSwarmCatalogue(catalogue, full);
  const context = { url: 'https://v4v.com/forgesworn-media-demo/dejavu-4k-v1/segment-0000.m4s',
    frag: { sn: 0, cc: 0, level: 0, type: 'main' } };
  assert.equal(catalogueSegment(plan, context)?.sha256, catalogue.qualities.full.segments[0].sha256);
  for (const patch of [
    value => { value.url += '?different=1'; },
    value => { value.url = 'https://evil.test/segment-0000.m4s'; },
    value => { value.frag.sn = 1; },
    value => { value.frag.cc = 1; },
    value => { value.frag.type = 'audio'; },
    value => { value.frag.level = -1; },
    value => { value.frag.decryptdata = { method: 'AES-128' }; },
    value => { value.part = { index: 0 }; },
    value => { value.rangeEnd = 100; },
    value => { value.rangeStart = 1; },
  ]) {
    const changed = structuredClone(context); patch(changed);
    assert.equal(catalogueSegment(plan, changed), null);
  }
});

test('public configuration has no TURN credentials, embedded secrets, or unlimited upload/cache policy', () => {
  assert.ok(PUBLIC_SWARM_RELAYS.every(value => new URL(value).protocol === 'wss:'));
  assert.deepEqual(PUBLIC_SWARM_ICE, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  assert.equal(PUBLIC_SWARM_LIMITS.maxPeers, 3);
  assert.equal(PUBLIC_SWARM_LIMITS.maxHeldBytes, 64 * 1024 * 1024);
  assert.equal(PUBLIC_SWARM_LIMITS.maxUploadBytesPerSession, 1024 * 1024 * 1024);
});
