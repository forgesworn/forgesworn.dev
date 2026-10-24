import test from 'node:test';
import assert from 'node:assert/strict';
import { createBufferedPlaybackRecovery } from '../site/media-lab.mjs';

function player() {
  let at = 0, ranges = [[20.56, 28.56]];
  const video = { currentTime: 26.581333, readyState: 2, paused: false, ended: false, seeking: false, error: null,
    buffered: { get length() { return ranges.length; }, start: i => ranges[i][0], end: i => ranges[i][1] } };
  const calls = [], recovery = createBufferedPlaybackRecovery(video, { now: () => at, onSeek: when => calls.push(when) });
  return { video, calls, recovery,
    check(time, frames = 411) { at = time; return recovery.check(frames); },
    ranges(value) { ranges = value; } };
}

test('a late fragment can recover the observed contiguous-buffer freeze after data has settled', () => {
  const p = player(); p.ranges([[20.56, 26.56]]);
  p.check(0); p.check(8000); assert.equal(p.calls.length, 0, 'missing data cannot trigger a seek');
  p.ranges([[20.56, 28.56]]); p.check(8400); p.check(9000);
  assert.equal(p.calls.length, 0, 'newly arrived media gets time to decode');
  assert.equal(p.check(9200), true); assert(Math.abs(p.video.currentTime - 26.681333) < 1e-9);
  assert.equal(p.video.paused, false); assert.equal(p.video.readyState, 2);
});

test('normal advancing playback never receives a decoder nudge', () => {
  const p = player(); p.ranges([[0, 100]]);
  for (let at = 0; at < 60_000; at += 400) {
    p.video.currentTime = 20 + at / 1000; p.check(at, Math.floor(at / 40));
  }
  assert.equal(p.calls.length, 0); assert.equal(p.video.playbackRate, undefined);
});

test('pause, seeking, end, media errors and future-data readiness cannot trigger recovery', () => {
  for (const condition of [{ paused: true }, { seeking: true }, { ended: true }, { error: {} }, { readyState: 4 }, { readyState: 1 }]) {
    const p = player(); Object.assign(p.video, condition);
    for (let at = 0; at <= 20_000; at += 400) p.check(at);
    assert.equal(p.calls.length, 0, JSON.stringify(condition));
  }
});

test('only the continuous range containing the playhead with at least a second ahead is eligible', () => {
  for (const ranges of [[], [[20, 27]], [[20, 26.56], [26.6, 30]], [[27, 40]]]) {
    const p = player(); p.ranges(ranges);
    for (let at = 0; at <= 20_000; at += 400) p.check(at);
    assert.equal(p.calls.length, 0, JSON.stringify(ranges));
  }
});

test('self-induced seek movement cannot reset the three-attempt budget or the retry interval', () => {
  const p = player(); p.ranges([[0, 100]]);
  for (let at = 0; at <= 25_000; at += 400) p.check(at, 411 + p.calls.length);
  assert.equal(p.calls.length, 3);
  for (let i = 1; i < p.calls.length; i++) assert(p.calls[i] - p.calls[i - 1] >= 3000);
  assert(Math.abs(p.video.currentTime - 27.181333) < 1e-9, 'the total failed recovery advance is bounded to 0.6 seconds');
  // Merely reporting future data or presenting a seek frame is not recovery.
  p.video.readyState = 4; p.check(26_000, 414); p.check(28_000, 415);
  p.video.readyState = 2; p.check(28_400, 415); p.check(32_000, 415);
  assert.equal(p.calls.length, 3);
});

test('sustained advancing playback and presented frames replenish the budget for a later independent stall', () => {
  const p = player(); p.ranges([[0, 100]]);
  for (let at = 0; at <= 20_000; at += 400) p.check(at, 411 + p.calls.length);
  assert.equal(p.calls.length, 3);
  p.video.readyState = 4; p.check(21_000, 500);
  p.video.currentTime += 1.2; p.check(22_200, 530);
  p.video.readyState = 2; p.check(22_600, 530); p.check(24_000, 530);
  assert.equal(p.calls.length, 4);
});
