import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativePlaybackFallback } from '../site/media-playback-fallback.mjs';

function fixture(readyState = 4) {
  let time = 0;
  const video = { currentTime: 12, readyState, paused: false, seeking: false, ended: false };
  const fallback = createNativePlaybackFallback(video, { now: () => time });
  return { video, fallback,
    check(ms = 0, changes = {}, eligible = true) {
      time += ms; Object.assign(video, changes); return fallback.check(eligible);
    },
  };
}

for (const readyState of [2, 4]) {
  test(`eight-second freeze after the first eligible frame, readyState ${readyState}`, () => {
    const f = fixture(readyState);
    assert.equal(f.check(), false);
    assert.equal(f.check(7_999), false);
    assert.equal(f.check(1), true);
    assert.equal(f.check(8_000), false);
    f.fallback.reset();
    assert.equal(f.check(), false);
    assert.equal(f.check(8_000), false, 'a fired instance stays one-shot after reset');
  });
}

test('normal advancing playback continuously renews the freeze grace period', () => {
  const f = fixture(); f.check();
  for (let i = 0; i < 40; i++) assert.equal(f.check(1_000, { currentTime: f.video.currentTime + 1 }), false);
  assert.equal(f.check(7_999, { readyState: 2 }), false);
  assert.equal(f.check(1), true);
});

function rebuffer(f, duration = 1_100) {
  assert.equal(f.check(400, { readyState: 4, currentTime: f.video.currentTime + 0.4 }), false);
  assert.equal(f.check(100, { readyState: 2 }), false);
  return f.check(duration, { readyState: 4, currentTime: f.video.currentTime + 0.1 });
}

test('three meaningful rebuffer episodes within thirty seconds trigger once', () => {
  const f = fixture(); f.check();
  assert.equal(rebuffer(f), false);
  assert.equal(rebuffer(f), false);
  assert.equal(f.check(400, { currentTime: f.video.currentTime + 0.4 }), false);
  assert.equal(f.check(100, { readyState: 2 }), false);
  assert.equal(f.check(999), false);
  assert.equal(f.check(1), true, 'the third episode need not finish before falling back');
  assert.equal(f.check(1_000), false);
});

test('short waiting pulses do not count as meaningful episodes', () => {
  const f = fixture(); f.check();
  for (let i = 0; i < 20; i++) assert.equal(rebuffer(f, 500), false);
});

test('old rebuffer episodes expire while playback continues', () => {
  const f = fixture(); f.check();
  assert.equal(rebuffer(f), false);
  assert.equal(rebuffer(f), false);
  for (let i = 0; i < 31; i++) assert.equal(f.check(1_000, { currentTime: f.video.currentTime + 1 }), false);
  assert.equal(rebuffer(f), false, 'two old episodes cannot combine with a new one');
});

for (const state of ['paused', 'seeking', 'ended', 'ineligible']) {
  test(`${state} clears previous stalls and starts a fresh grace period`, () => {
    const f = fixture(); f.check();
    assert.equal(rebuffer(f), false);
    assert.equal(rebuffer(f), false);
    assert.equal(f.check(7_900, { readyState: 2 }), false);
    assert.equal(f.check(0, state === 'ineligible' ? {} : { [state]: true }, state !== 'ineligible'), false);
    assert.equal(f.check(0, { paused: false, seeking: false, ended: false }), false);
    assert.equal(f.check(1_100), false, 'old episodes were discarded');
    assert.equal(f.check(6_899), false);
    assert.equal(f.check(1), true);
  });
}

test('initial download and background time cannot trigger before eligibility', () => {
  const f = fixture(2);
  assert.equal(f.check(0, {}, false), false);
  assert.equal(f.check(60_000, {}, false), false);
  assert.equal(f.check(), false);
  assert.equal(f.check(7_999), false);
  assert.equal(f.check(1), true);
});

test('a recording wrap clears old episodes without triggering a fallback', () => {
  const f = fixture(); f.check();
  assert.equal(rebuffer(f), false);
  assert.equal(rebuffer(f), false);
  assert.equal(f.check(400, { currentTime: 0, readyState: 2 }), false);
  assert.equal(f.check(1_100, { currentTime: 0.1, readyState: 4 }), false);
  for (let i = 0; i < 10; i++) assert.equal(f.check(1_000, { currentTime: f.video.currentTime + 1 }), false);
});

test('a large forward seek completed between checks also clears the grace period', () => {
  const f = fixture(2); f.check();
  assert.equal(f.check(7_900), false);
  assert.equal(f.check(100, { currentTime: 100 }), false);
  assert.equal(f.check(7_999), false);
  assert.equal(f.check(1), true);
});

test('small decoder-recovery nudges without playable data do not postpone fallback', () => {
  const f = fixture(2); f.check();
  for (let i = 0; i < 7; i++) assert.equal(f.check(1_000, { currentTime: f.video.currentTime + 0.1 }), false);
  assert.equal(f.check(1_000, { currentTime: f.video.currentTime + 0.1 }), true);
});

test('explicit reset clears observations without counting a new episode', () => {
  const f = fixture(2); f.check();
  assert.equal(f.check(7_900), false);
  f.fallback.reset();
  assert.equal(f.check(10_000), false);
  assert.equal(f.check(7_999), false);
  assert.equal(f.check(1), true);
});
