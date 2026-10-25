import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackPrime } from '../site/media-playback-prime.mjs';

function fixture(ranges = [], options = {}) {
  let at = 0, buffered = ranges;
  const video = { currentTime: 10, readyState: 4, seeking: false, paused: true, volume: 0.7, playbackRate: 1,
    buffered: { get length() { return buffered.length; }, start: index => buffered[index][0], end: index => buffered[index][1] } };
  const prime = createPlaybackPrime(video, { now: () => at, ...options });
  return { video, prime, at(value) { at = value; }, buffers(value) { buffered = value; } };
}
const full = target => ({ target, duration: 268.6 });
const replay = target => ({ ...full(target), allowCurrent: true });

test('startup waits for appended headroom at the latest target and emits one decision', () => {
  const p = fixture([[10, 12]]);
  assert.deepEqual(p.prime.check(full(11)), { ready: false, position: 11, reason: 'buffering' });
  p.at(1_800); p.buffers([[10, 17]]);
  assert.deepEqual(p.prime.check(full(12.8)), { ready: true, position: 12.8, reason: 'buffered' });
  assert.deepEqual(p.prime.check(full(13)), { ready: false, position: null, reason: 'complete' });
  assert.equal(p.video.currentTime, 10);
  assert.equal(p.video.paused, true);
  assert.equal(p.video.volume, 0.7);
  assert.equal(p.video.playbackRate, 1);
});

test('a1.764-second target cannot start in the missing first fragment', () => {
  const p = fixture([[2, 6]]);
  assert.equal(p.prime.check(full(1.764)).ready, false);
  p.at(400);
  assert.deepEqual(p.prime.check(full(2.164)), { ready: true, position: 2.164, reason: 'buffered' });
});

test('a replay plays its safe head buffer before an advancing clock forces the twelve-second escape', () => {
  const p = fixture(); p.video.currentTime = 0;
  assert.equal(p.prime.check(replay(0.1)).ready, false);
  p.at(1_500); p.buffers([[0, 2]]);
  assert.equal(p.prime.check(replay(1.6)).ready, false);
  p.at(3_200); p.buffers([[0, 4]]);
  assert.deepEqual(p.prime.check(replay(3.3)), { ready: true, position: 0, reason: 'buffered-current' });
  assert.equal(p.video.currentTime, 0, 'the decision does not seek');
  assert.equal(p.video.paused, true, 'the controller still owns playback');
  assert.equal(p.video.playbackRate, 1);
  assert.deepEqual(p.prime.check(replay(3.7)), { ready: false, position: null, reason: 'complete' });
});

test('an ordinary cold join waits for fresh room headroom instead of starting behind it', () => {
  const p = fixture(); p.video.currentTime = 0;
  p.prime.check(full(0.1));
  p.at(3_200); p.buffers([[0, 4]]);
  assert.deepEqual(p.prime.check(full(3.3)), { ready: false, position: 3.3, reason: 'buffering' });
  p.at(4_000); p.buffers([[0, 8]]);
  assert.deepEqual(p.prime.check(full(4.1)), { ready: true, position: 4.1, reason: 'buffered' });
});

test('fresh room headroom is preferred when the current position is also playable', () => {
  const p = fixture([[0, 8]]); p.video.currentTime = 0;
  assert.deepEqual(p.prime.check(replay(3.3)), { ready: true, position: 3.3, reason: 'buffered' });
});

test('the current-buffer escape needs one continuous ready range and never uses a later position', () => {
  for (const ranges of [[[0, 2], [2.2, 4]], [[0.1, 4]], [[0, 2.99]]]) {
    const p = fixture(ranges); p.video.currentTime = 0;
    assert.equal(p.prime.check(replay(3.3)).ready, false, JSON.stringify(ranges));
  }
  const p = fixture([[264, 268.6]]); p.video.currentTime = 264;
  assert.equal(p.prime.check(replay(0.5)).ready, false, 'a previous loop tail cannot substitute for its missing head');
});

test('current-buffer readiness cannot bypass seeking, media readiness, or an unknown room clock', () => {
  for (const state of [{ seeking: true }, { readyState: 2 }]) {
    const p = fixture([[0, 4]]); Object.assign(p.video, { currentTime: 0 }, state);
    assert.equal(p.prime.check(replay(3.3)).ready, false);
  }
  const p = fixture([[0, 4]]); p.video.currentTime = 0;
  assert.equal(p.prime.check({ target: NaN, duration: 268.6, allowCurrent: true }).ready, false);
});

test('a ready current head still waits for the room to wrap before a near-end join', () => {
  const p = fixture([[0, 4]]); p.video.currentTime = 0;
  assert.deepEqual(p.prime.check(replay(267.4)), { ready: false, position: 0, reason: 'next-loop' });
  p.at(700); assert.equal(p.prime.check(replay(268.1)).ready, false);
  p.at(1_450);
  assert.deepEqual(p.prime.check(replay(0.25)), { ready: true, position: 0.25, reason: 'buffered' });
});

test('separate ranges cannot be added together to invent continuous headroom', () => {
  const p = fixture([[0, 3], [3.2, 9]]);
  assert.equal(p.prime.check(full(1)).ready, false);
  p.buffers([[0, 9]]);
  assert.equal(p.prime.check(full(1)).ready, true);
});

test('a near-end join defers to the next recording loop', () => {
  const p = fixture([[0, 6], [264, 268.6]]);
  p.video.currentTime = 268.6;
  assert.deepEqual(p.prime.check(full(267.4)), { ready: false, position: 0, reason: 'next-loop' });
  p.at(700); assert.equal(p.prime.check(full(268.1)).reason, 'next-loop');
  p.at(1_450);
  assert.deepEqual(p.prime.check(full(0.25)), { ready: true, position: 0.25, reason: 'buffered' });
  assert.equal(p.video.currentTime, 268.6, 'the controller still owns the one actual seek');
});

test('replay cannot start from the previous loop buffer', () => {
  const p = fixture([[264, 268.6]]);
  assert.equal(p.prime.check(full(0.5)).ready, false);
  p.buffers([[0, 6], [264, 268.6]]);
  assert.equal(p.prime.check(full(0.5)).ready, true);
});

test('a short or subsecond clip can use its buffered tail', () => {
  for (const [duration, target] of [[2, 1.8], [0.2, 0.15], [4, 3.9]]) {
    const p = fixture([[0, duration]]);
    assert.deepEqual(p.prime.check({ target, duration }), { ready: true, position: target, reason: 'buffered' });
  }
});

test('seeking and low media readiness cannot release the play barrier', () => {
  const p = fixture([[0, 20]]);
  p.video.seeking = true;
  assert.equal(p.prime.check(full(10)).ready, false);
  p.video.seeking = false; p.video.readyState = 2;
  assert.equal(p.prime.check(full(10)).ready, false);
  p.video.readyState = 3;
  assert.equal(p.prime.check(full(10)).ready, true);
});

test('an unavailable clock relaxes only after twelve seconds to safe current data', () => {
  const p = fixture([[10, 12]]);
  assert.equal(p.prime.check({ target: NaN, duration: NaN }).reason, 'clock-unavailable');
  p.at(11_999); assert.equal(p.prime.check({}).ready, false);
  p.at(12_000);
  assert.deepEqual(p.prime.check({}), { ready: true, position: 10, reason: 'timeout-current' });
});

test('a stale unbuffered target cannot block a safe current position indefinitely', () => {
  const p = fixture([[10, 11.5]]);
  assert.equal(p.prime.check(full(1)).ready, false);
  p.at(12_000);
  assert.deepEqual(p.prime.check(full(1)), { ready: true, position: 10, reason: 'timeout-current' });
});

test('timeout never starts an unbuffered player and may recover when data arrives', () => {
  const p = fixture([[9, 10.4]]);
  p.prime.check(full(20)); p.at(12_000);
  assert.deepEqual(p.prime.check(full(20)), { ready: false, position: null, reason: 'timeout-unbuffered' });
  p.buffers([[9, 12]]);
  assert.deepEqual(p.prime.check(full(20)), { ready: true, position: 10, reason: 'timeout-current' });
});

test('fresh buffered room data takes precedence over timeout fallback', () => {
  const p = fixture(); p.prime.check(full(20)); p.at(12_000); p.buffers([[9, 12], [20, 30]]);
  assert.deepEqual(p.prime.check(full(22)), { ready: true, position: 22, reason: 'buffered' });
});

test('a stale near-end clock has the same bounded safe-current escape', () => {
  const p = fixture([[10, 12]]);
  assert.equal(p.prime.check(full(267)).reason, 'next-loop'); p.at(12_000);
  assert.deepEqual(p.prime.check(full(267)), { ready: true, position: 10, reason: 'timeout-current' });
});

test('cancel suppresses release and reset/start independently rearm priming', () => {
  const p = fixture([[0, 20]]);
  p.prime.cancel();
  assert.equal(p.prime.check(full(10)).reason, 'cancelled');
  p.prime.start(); assert.equal(p.prime.check(full(10)).ready, true);
  p.prime.reset(); assert.equal(p.prime.check(full(10)).ready, true);
});

test('a new recording duration clears old wrap deferral', () => {
  const p = fixture([[0, 20]]);
  p.prime.check(full(267));
  assert.deepEqual(p.prime.check({ target: 10, duration: 29.96 }), { ready: true, position: 10, reason: 'buffered' });
});

test('a detached or changing TimeRanges never becomes a false ready signal', () => {
  const p = fixture();
  Object.defineProperty(p.video, 'buffered', { get() { throw new Error('detached'); } });
  assert.equal(p.prime.check(full(10)).ready, false);
  p.at(12_000); assert.equal(p.prime.check(full(10)).reason, 'timeout-unbuffered');
});
