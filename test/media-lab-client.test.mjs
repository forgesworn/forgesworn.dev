import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedMediaUrl, publicSource, completedRecord, recordedRuns, reading, sourceRetiredError, confirmedPublisherEnd, videoDimensions, invitedPlaybackStart, sharedPositionDifference } from '../site/media-lab.mjs';

test('shared playback compares the nearest position across recording loops', () => {
  assert(Math.abs(sharedPositionDifference(268.5, 0.1, 268.6) - 0.2) < 1e-9);
  assert(Math.abs(sharedPositionDifference(0.1, 268.5, 268.6) + 0.2) < 1e-9);
  assert(Math.abs(sharedPositionDifference(100, 100.1, 268.6) - 0.1) < 1e-9);
  assert.equal(sharedPositionDifference(8, 8, 30), 0);
  assert.equal(sharedPositionDifference(NaN, 1, 30), null);
  assert.equal(sharedPositionDifference(1, 1, 0), null);
});

test('a listening invitation advances only a matching, recent, bounded media position', () => {
  const now = 1_800_000_000_000;
  assert.equal(invitedPlaybackStart(`?q=full&t=30&at=${now - 5000}`, now, 268.6, 'full'), 35);
  for (const query of ['', '?q=full&t=NaN&at=0', `?q=preview&t=30&at=${now}`, `?q=full&t=-1&at=${now}`,
    `?q=full&t=267&at=${now}`, `?q=full&t=10&at=${now - 1_000_000}`, `?q=full&t=10&at=${now + 6000}`]) {
    assert.equal(invitedPlaybackStart(query, now, 268.6, 'full'), 0);
  }
});

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
    publisherVideoFrames: 750, expectedVideoFrames: 750, expectedProgressSeconds: 30, expectedProgressBasis: 'bounded-window-time',
    publisherCompletedWindow: true, publisherProgressEnded: true,
    hostLoadAtStart: { oneMinute: 24, fiveMinutes: 20, fifteenMinutes: 19, privateToken: 'secret' } },
    host: { loadAverage: { oneMinute: 30, fiveMinutes: 22, fifteenMinutes: 20 } },
    processes: { origin: { cpuSeconds: 2, rssBytes: 50000, peakSampledRssBytes: 60000 } }, http: { requests: 3, originRequests: 5, redirectsFollowed: 2 } },
  session: { id: 'one', engine: 'sapflow', transport: 'rtmp', offsetSeconds: 0, cpuSamples: [10, 20], rssSamples: [50000], processSamples: {} },
  config: { source: { label: 'Licensed recording', sha256: 'a'.repeat(64), bytes: 123, privatePath: '/private/source.mp4' },
    host: { cpu: 'Apple Silicon', platform: 'darwin', architecture: 'arm64', logicalCpus: 8, privateKey: 'secret' },
    engines: [{ id: 'sapflow', label: 'Sapflow', version: '0.1.0', binarySha256: 'b'.repeat(64) }], profile: { publisherCompletionToleranceSeconds: 0.25 } },
  browser: { seenFrame: true, decodedFrames: 600, fpsSamples: [25, 25], firstFrameMs: 1000, width: 3842, height: 2160, mediaWidth: 3840, mediaHeight: 2160 },
});

test('a completed measurement needs actual publisher completion and rendered frames', () => {
  const f = fixture(), build = () => completedRecord(f.snapshot, f.session, f.config, f.browser);
  assert(build());
  for (const state of ['stopped', 'error', 'running']) { f.snapshot.state = state; assert.equal(build(), null); }
  f.snapshot.state = 'ended'; f.snapshot.run.publisherCompletedWindow = false; assert.equal(build(), null);
  f.snapshot.run.publisherCompletedWindow = true; f.snapshot.run.publisherProgressEnded = false; assert.equal(build(), null);
  f.snapshot.run.publisherProgressEnded = true; f.browser.decodedFrames = 0; assert.equal(build(), null);
  f.browser.decodedFrames = '600'; assert.equal(build(), null);
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
  assert.equal(row.publisherVideoFrames, 750); assert.equal(row.expectedVideoFrames, 750);
  assert.equal(row.expectedProgressSeconds, 30); assert.equal(row.expectedProgressBasis, 'bounded-window-time');
  assert.equal(row.browser.width, 3842); assert.equal(row.browser.mediaWidth, 3840);
  assert.equal(row.http.requests, 3); assert.equal(row.http.originRequests, 5); assert.equal(row.http.redirectsFollowed, 2);
  assert.equal(row.profile.publisherCompletionToleranceSeconds, 0.25);
  assert.doesNotMatch(JSON.stringify(row), /secret|privatePath|privateKey|privateToken|\/private\//);
  const receipt = { schema: 1, runs: [row, { ...row, publisherCompletedWindow: false }, { ...row, browser: { decodedFrames: 0 } }, { ...row, browser: { decodedFrames: '600' } }] };
  assert.equal(recordedRuns(receipt).length, 1);
  assert.equal(recordedRuns(receipt)[0].hostLoadAtEnd.oneMinute, 30);
  assert.equal(recordedRuns(receipt)[0].publisherVideoFrames, 750);
  assert.deepEqual(publicSource({ label: '/private/source.mp4' }).label, 'Licensed source');
});

test('unobserved metrics remain unavailable rather than becoming zero', () => {
  assert.equal(reading(null), '—'); assert.equal(reading(undefined), '—'); assert.equal(reading('0'), '—');
  assert.equal(reading(0), '0.0');
});

test('normal source EOF requires independently completed matching publisher state', () => {
  const f = fixture(); f.snapshot.run.publisherEnded = true;
  assert(confirmedPublisherEnd({ ...f.snapshot, state: 'running' }, 'one'));
  assert(confirmedPublisherEnd(f.snapshot, 'one'));
  assert(confirmedPublisherEnd({ state: 'idle', run: null, lastRun: f.snapshot }, 'one'));
  assert(!confirmedPublisherEnd(f.snapshot, 'other'));
  for (const state of ['stopped', 'error', 'stopping']) assert(!confirmedPublisherEnd({ ...f.snapshot, state }, 'one'));
  assert(!confirmedPublisherEnd({ state: 'error', lastRun: f.snapshot }, 'one'));
  assert(!confirmedPublisherEnd({ state: 'running', run: { id: 'other' }, lastRun: f.snapshot }, 'one'));
  for (const key of ['publisherEnded', 'publisherCompletedWindow', 'publisherProgressEnded']) {
    assert(!confirmedPublisherEnd({ ...f.snapshot, state: 'running', run: { ...f.snapshot.run, [key]: false } }, 'one'));
  }
  assert(!confirmedPublisherEnd({ ...f.snapshot, error: 'publisher_incomplete' }, 'one'));
  f.session.sourceEof = true;
  for (const state of ['running', 'stopped', 'error']) assert.equal(completedRecord({ ...f.snapshot, state }, f.session, f.config, f.browser), null);
});

test('only retired network resources qualify for EOF confirmation and error counts remain visible', () => {
  assert(sourceRetiredError({ type: 'networkError', response: { code: 404 } }));
  assert(sourceRetiredError({ type: 'networkError', networkDetails: { status: 410 } }));
  for (const code of [0, 401, 403, 500]) assert(!sourceRetiredError({ type: 'networkError', response: { code } }));
  assert(!sourceRetiredError({ type: 'mediaError', response: { code: 404 } }));
  const f = fixture(); f.browser.playerErrors = 4; f.browser.httpErrors = 3;
  const row = completedRecord(f.snapshot, f.session, f.config, f.browser);
  assert.equal(row.browser.playerErrors, 4); assert.equal(row.browser.httpErrors, 3);
});

test('reset display dimensions preserve real media geometry without undefined values', () => {
  assert.equal(videoDimensions({ mediaWidth: 3840, mediaHeight: 2160, width: null, height: undefined }), '3,840 × 2,160 video');
  assert.equal(videoDimensions({ mediaWidth: 3840, mediaHeight: 2160, width: 3842, height: 2160 }), '3,840 × 2,160 video · 3,842 × 2,160 display');
  assert.equal(videoDimensions({}), 'Browser video dimensions');
});
