import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedMediaUrl, publicSource, completedRecord, recordedRuns, reading } from '../site/media-lab.mjs';

test('public playback accepts only this site and the explicitly configured HTTPS media origin', () => {
  const page = 'https://demo.example/media-lab.html', media = 'https://media.example';
  assert.equal(approvedMediaUrl('/preview/index.m3u8', page, media).origin, 'https://demo.example');
  assert.equal(approvedMediaUrl('https://media.example/full/index.m3u8', page, media).origin, media);
  for (const value of ['https://untrusted.example/video.mp4', 'https://media.example.evil.example/video.mp4', 'http://media.example/video.mp4', 'https://user:secret@media.example/video.mp4', 'file:///private/source.mp4', 'data:video/mp4,test'])
    assert.throws(() => approvedMediaUrl(value, page, media));
  assert.throws(() => approvedMediaUrl('https://media.example/video.mp4', page, 'https://media.example/private'));
});

const fixture = () => ({
  snapshot: { state: 'ended', run: { id: 'one', durationSeconds: 30, publisherMediaSeconds: 30.01,
    publisherCompletedWindow: true, publisherProgressEnded: true,
    hostLoadAtStart: { oneMinute: 24, fiveMinutes: 20, fifteenMinutes: 19, privateToken: 'secret' } },
    host: { loadAverage: { oneMinute: 30, fiveMinutes: 22, fifteenMinutes: 20 } },
    processes: { origin: { cpuSeconds: 2, rssBytes: 50000, peakSampledRssBytes: 60000 } }, http: {} },
  session: { id: 'one', engine: 'sapflow', transport: 'rtmp', offsetSeconds: 0, cpuSamples: [10, 20], rssSamples: [50000], processSamples: {} },
  config: { source: { label: 'Licensed recording', sha256: 'a'.repeat(64), bytes: 123, privatePath: '/private/source.mp4' },
    host: { cpu: 'Apple Silicon', platform: 'darwin', architecture: 'arm64', logicalCpus: 8, privateKey: 'secret' },
    engines: [{ id: 'sapflow', label: 'Sapflow', version: '0.1.0', binarySha256: 'b'.repeat(64) }], profile: {} },
  browser: { seenFrame: true, decodedFrames: 600, fpsSamples: [25, 25], firstFrameMs: 1000, width: 3840, height: 2160 },
});

test('a completed measurement needs actual publisher completion and rendered frames', () => {
  const f = fixture(), build = () => completedRecord(f.snapshot, f.session, f.config, f.browser);
  assert(build());
  for (const state of ['stopped', 'error', 'running']) { f.snapshot.state = state; assert.equal(build(), null); }
  f.snapshot.state = 'ended'; f.snapshot.run.publisherCompletedWindow = false; assert.equal(build(), null);
  f.snapshot.run.publisherCompletedWindow = true; f.snapshot.run.publisherProgressEnded = false; assert.equal(build(), null);
  f.snapshot.run.publisherProgressEnded = true; f.browser.decodedFrames = 0; assert.equal(build(), null);
  f.browser.decodedFrames = 600; f.session.interrupted = true; assert.equal(build(), null);
  f.session.interrupted = false; f.session.id = 'different-run'; assert.equal(build(), null);
});

test('exports preserve host pressure while excluding paths and arbitrary private fields', () => {
  const f = fixture(), row = completedRecord(f.snapshot, f.session, f.config, f.browser);
  assert.equal(row.originCpuMeanPercent, 15);
  assert.equal(row.browser.decodedFpsMean, 25);
  assert.equal(row.hostLoadAtStart.oneMinute, 24);
  assert.equal(row.hostLoadAtEnd.oneMinute, 30);
  assert.equal(row.measurementScope, 'shared-host-observation');
  assert.equal(row.publisherMediaSeconds, 30.01);
  assert.doesNotMatch(JSON.stringify(row), /secret|privatePath|privateKey|privateToken|\/private\//);
  const receipt = { schema: 1, runs: [row, { ...row, publisherCompletedWindow: false }, { ...row, browser: { decodedFrames: 0 } }] };
  assert.equal(recordedRuns(receipt).length, 1);
  assert.equal(recordedRuns(receipt)[0].hostLoadAtEnd.oneMinute, 30);
  assert.deepEqual(publicSource({ label: '/private/source.mp4' }).label, 'Licensed source');
});

test('unobserved metrics remain unavailable rather than becoming zero', () => {
  assert.equal(reading(null), '—'); assert.equal(reading(undefined), '—'); assert.equal(reading('0'), '—');
  assert.equal(reading(0), '0.0');
});
