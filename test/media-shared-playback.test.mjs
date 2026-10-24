import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedPlaybackSync } from '../site/media-lab.mjs';

function player() {
  const video = Object.assign(new EventTarget(), { currentTime: 20, duration: 268.6,
    readyState: 4, paused: false, ended: false, seeking: false });
  let at = 0, ranges = [[0, 268.6]];
  video.buffered = { get length() { return ranges.length; }, start: i => ranges[i][0], end: i => ranges[i][1] };
  const seeks = [], abort = new AbortController();
  const sync = createSharedPlaybackSync(video, { now: () => at, signal: abort.signal,
    onSeek: when => seeks.push({ when, from: video.currentTime }) });
  return { video, sync, seeks, abort,
    at(value) { at = value; }, ranges(value) { ranges = value; },
    event(type) { video.dispatchEvent(new Event(type)); },
    follow(until, difference = 2) {
      for (; at <= until; at += 400) sync.align(video.currentTime + difference, video.duration);
    } };
}

test('subsecond decoder delay does not start a recurring seek and rebuffer cycle', () => {
  const p = player();
  for (let ms = 0; ms <= 60_000; ms += 400) {
    p.at(ms); p.video.currentTime = 20 + ms / 1000;
    p.sync.align(p.video.currentTime + 0.6, p.video.duration);
  }
  assert.equal(p.seeks.length, 0);
  assert.equal(p.video.playbackRate, undefined, 'the synchroniser never alters the music tempo');
});

test('a real stall cannot be prolonged by clock corrections even with a large offset', () => {
  const p = player();
  p.follow(2400);
  p.video.readyState = 2; p.event('waiting');
  p.follow(24_000, 20);
  assert.equal(p.seeks.length, 0);
  p.video.readyState = 4; p.event('playing');
  p.follow(28_800, 20);
  assert.equal(p.seeks.length, 0, 'recovered playback gets time to settle');
  p.follow(31_200, 20);
  assert.equal(p.seeks.length, 1, 'one correction follows stable buffered recovery');
});

test('automatic corrections need a sustained offset in the same direction', () => {
  const p = player();
  p.follow(6000, 0.1);
  for (let i = 0; i < 16; i++) {
    p.at(6400 + i * 800); p.sync.align(p.video.currentTime + (i % 2 ? -2 : 2), p.video.duration);
  }
  assert.equal(p.seeks.length, 0, 'clock jitter does not cause alternating seeks');
  p.follow(23_200, 2);
  assert.equal(p.seeks.length, 1);
});

test('the current position and correction target need one continuous buffer with headroom', () => {
  for (const ranges of [[[0, 21]], [[0, 21], [22, 100]], [[21, 100]]]) {
    const p = player(); p.ranges(ranges); p.follow(30_000);
    assert.equal(p.seeks.length, 0, `refuses an unbuffered jump or buffer edge: ${JSON.stringify(ranges)}`);
  }
  const p = player(); p.ranges([[0, 40]]); p.follow(6000);
  assert.equal(p.seeks.length, 1);
});

test('seek recovery and a minimum correction interval break repeated slow-seek loops', () => {
  const p = player(); p.follow(6000);
  assert.equal(p.seeks.length, 1);
  const first = p.seeks[0].when;
  p.video.seeking = true; p.event('seeking'); p.follow(12_000, 5);
  assert.equal(p.seeks.length, 1);
  p.video.seeking = false; p.event('seeked'); p.event('playing'); p.follow(first + 14_800, 8);
  assert.equal(p.seeks.length, 1);
  p.follow(first + 16_000, 8);
  assert.equal(p.seeks.length, 2);
  assert(p.seeks[1].when - first >= 15_000);
});

test('pause, seek and waiting events each restart the stable playback requirement', () => {
  for (const event of ['pause', 'seeking', 'waiting', 'stalled', 'emptied']) {
    const p = player(); p.follow(4800); p.event(event); p.follow(9600);
    assert.equal(p.seeks.length, 0, event);
    p.follow(11_200); assert.equal(p.seeks.length, 1, event);
  }
  for (const state of [{ paused: true }, { seeking: true }, { readyState: 2 }, { ended: true }]) {
    const p = player(); Object.assign(p.video, state); p.follow(30_000);
    assert.equal(p.seeks.length, 0, JSON.stringify(state));
  }
});

test('join, Back to live and the recording boundary can align immediately without buffer gates', () => {
  const p = player(); p.ranges([]); p.video.paused = true;
  assert.equal(p.sync.align(50, p.video.duration, true).corrected, true);
  assert.equal(p.video.currentTime, 50);
  assert.equal(p.sync.align(50.02, p.video.duration, true).corrected, false, 'an aligned join is not sought twice');
  p.video.currentTime = p.video.duration; p.video.ended = true;
  assert.equal(p.sync.align(0.01, p.video.duration, true).corrected, true);
  assert.equal(p.video.currentTime, 0.01, 'the next recording loop still starts immediately');
});

test('an explicit live alignment during an existing seek uses the fresh room clock when it settles', () => {
  const p = player(); p.ranges([]); p.video.seeking = true;
  assert.equal(p.sync.align(100, p.video.duration, true).corrected, false);
  p.at(400); p.sync.align(101, p.video.duration, true);
  assert.equal(p.seeks.length, 0, 'an in-flight seek is not interrupted');
  p.at(800); p.video.seeking = false; p.event('seeked');
  assert.equal(p.sync.align(102, p.video.duration).corrected, true);
  assert.equal(p.video.currentTime, 102, 'the latest target replaces both queued requests');
  p.at(1200); p.sync.align(105, p.video.duration);
  assert.equal(p.seeks.length, 1, 'the queued intent is consumed once');
});

test('cancelled player listeners are removed and invalid clocks cannot seek', () => {
  const p = player(); p.follow(4800); p.abort.abort(); p.event('waiting'); p.follow(6000);
  assert.equal(p.seeks.length, 1, 'a disposed player does not retain media event observers');
  const q = player();
  assert.equal(q.sync.align(NaN, q.video.duration, true).corrected, false);
  assert.equal(q.sync.align(5, 0, true).corrected, false);
  assert.equal(q.seeks.length, 0);
});

function measuredSeek(p, start, cost) {
  p.at(start); p.video.seeking = true; p.event('seeking');
  p.at(start + cost); p.video.seeking = false; p.event('seeked');
}

test('a measured half-second seek prevents recurring interruptions for 770 ms drift', () => {
  const p = player(); measuredSeek(p, 0, 500);
  p.follow(60_000, 0.77);
  assert.equal(p.seeks.length, 0, 'the 750 ms allowance includes the actual 500 ms seek cost');
  assert.equal(p.video.playbackRate, undefined, 'the music stays at its original tempo');
});

test('a larger sustained offset still corrects after the measured seek-cost allowance', () => {
  const p = player(); measuredSeek(p, 0, 500);
  p.follow(6_500, 1.4);
  assert.equal(p.seeks.length, 1, '1.4 s exceeds the 1.25 s allowance and still obeys settling');
});

test('explicit live alignment bypasses the measured ordinary allowance', () => {
  const p = player(); measuredSeek(p, 0, 500);
  assert.equal(p.sync.align(20.77, p.video.duration, true).corrected, true);
  assert.equal(p.video.currentTime, 20.77);
});

test('the latest completed seek replaces old cost and unmatched seeked is neutral', () => {
  const p = player(); measuredSeek(p, 0, 1_000); measuredSeek(p, 1_500, 50);
  p.follow(8_000, 0.9);
  assert.equal(p.seeks.length, 1, 'the most recent 50 ms seek gives an 800 ms allowance');
  const q = player(); q.at(10_000); q.event('seeked'); q.follow(16_000, 0.9);
  assert.equal(q.seeks.length, 1, 'an unmatched event does not invent a ten-second seek cost');
});

test('emptying the video clears measured seek cost for a replacement engine', () => {
  const p = player(); measuredSeek(p, 0, 500); p.event('emptied');
  p.follow(6_500, 0.77);
  assert.equal(p.seeks.length, 1, 'a new pipeline starts with the existing 750 ms allowance');
});
