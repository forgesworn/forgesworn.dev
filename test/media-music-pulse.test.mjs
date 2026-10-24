import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyseRhythm } from '../scripts/package-media-rhythm.mjs';
import { decodeRhythm, sampleMusicPulse, createMusicPulse } from '../site/media-music-pulse.mjs';

const asset = JSON.parse(await readFile(new URL('../site/media/dejavu-rhythm.json', import.meta.url), 'utf8'));

test('offline extraction finds audible bass attacks and gives silence no heartbeat', () => {
  const pcm = Buffer.alloc(8000 * 3 * 4);
  for (const onset of [0.4, 1.2, 2]) {
    for (let sample = Math.round(onset * 8000); sample < (onset + 0.08) * 8000; sample++) {
      pcm.writeFloatLE(Math.sin(sample / 8000 * 75 * 2 * Math.PI) * 0.5, sample * 4);
    }
  }
  const pulse = analyseRhythm(pcm, 3000);
  for (const at of [0.4, 1.2, 2]) assert(pulse.beats.some(([frame]) => Math.abs(frame * 0.04 - at) < 0.041));
  const silent = analyseRhythm(Buffer.alloc(pcm.length), 3000);
  assert.equal(silent.beats.length, 0); assert(Buffer.from(silent.energy, 'base64').every(value => value === 0));
  assert.throws(() => analyseRhythm(Buffer.alloc(3), 3000));
  assert.throws(() => analyseRhythm(pcm, 400_000));
  const rounded = analyseRhythm(pcm, 1040.1);
  assert.equal(Buffer.from(rounded.energy, 'base64').length, Math.ceil(rounded.durationMs / rounded.sampleMs));
});

test('the small published rhythm track covers both exact recording timelines', () => {
  const timelines = decodeRhythm(asset);
  assert.equal(timelines.full.duration, 268.6); assert.equal(timelines.preview.duration, 29.96);
  assert(timelines.full.beats.length > 100); assert(timelines.preview.beats.length > 10);
  assert(Buffer.byteLength(JSON.stringify(asset)) < 20 * 1024);
  assert.equal(sampleMusicPulse(timelines.full, 268).energy, 0, 'the original audio ends before the video');
  assert.equal(sampleMusicPulse(timelines.full, 268).beat, 0, 'silence has no invented beat');
});

test('pulse attacks follow exact media time, decay and return to the same place after seeks or loops', () => {
  const timeline = decodeRhythm(asset).full, [at, strength] = timeline.beats[10];
  assert(Math.abs(sampleMusicPulse(timeline, at).beat - strength) < 1e-9);
  assert(sampleMusicPulse(timeline, at + 0.08).beat < strength);
  for (const [position] of timeline.beats) {
    const first = sampleMusicPulse(timeline, position), loop = sampleMusicPulse(timeline, position + timeline.duration);
    assert(Math.abs(first.beat - loop.beat) < 1e-8); assert(Math.abs(first.energy - loop.energy) < 1e-8);
  }
  assert.deepEqual(sampleMusicPulse(timeline, NaN), { energy: 0, beat: 0 });
});

test('corrupt, oversized or mismatched rhythm data cannot drive the pulse', () => {
  for (const change of [value => { value.sourceSha256 = '0'.repeat(64); }, value => { value.qualities.full.energy = '!'; },
    value => { value.qualities.full.durationMs = 1; }, value => { value.qualities.full.sampleMs = 1; },
    value => { value.qualities.full.beats = [[10, 100], [5, 100]]; }, value => { value.qualities.full.beats[0][1] = 1000; }]) {
    const copy = structuredClone(asset); change(copy); assert.throws(() => decodeRhythm(copy));
  }
});

function environment(t, response = () => new Response(JSON.stringify(asset))) {
  const saved = new Map(['requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'IntersectionObserver'].map(key => [key, globalThis[key]]));
  const frames = new Map(), reduced = Object.assign(new EventTarget(), { matches: false }); let next = 0, intersection;
  globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.matchMedia = () => reduced;
  globalThis.IntersectionObserver = class {
    constructor(callback) { intersection = callback; }
    observe() {}
    disconnect() { intersection = null; }
  };
  const page = Object.assign(new EventTarget(), { hidden: false });
  const video = Object.assign(new EventTarget(), { ownerDocument: page, currentTime: 2.64,
    paused: true, ended: false, seeking: false, readyState: 4 });
  const container = { dataset: {} }, values = [], abort = new AbortController(); let requests = 0;
  const pulse = createMusicPulse({ video, container, signal: abort.signal, onPulse: value => values.push(value),
    fetchImpl: async () => { requests++; return response(); } });
  t.after(() => {
    pulse.destroy();
    for (const [key, value] of saved) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  });
  return { video, page, container, values, frames, reduced, abort, pulse, get requests() { return requests; },
    visible(value) { intersection?.([{ isIntersecting: value, intersectionRatio: value ? 1 : 0 }]); },
    play() { video.paused = false; video.dispatchEvent(new Event('playing')); },
    paint(at) { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(at); },
    async loaded() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); },
  };
}

test('the driver loads lazily, paints only while visible and cancels on pause, hiding, reduced motion and abort', async t => {
  const e = environment(t);
  assert.equal(e.requests, 0); e.play(); assert.equal(e.requests, 0, 'offscreen media needs no visual data');
  e.visible(true); await e.loaded(); assert.equal(e.requests, 1); assert.equal(e.frames.size, 1);
  e.paint(1000); assert(e.values.at(-1).energy > 0); assert.equal(e.container.dataset.musicPulseState, 'live');
  e.video.paused = true; e.video.dispatchEvent(new Event('pause'));
  assert.equal(e.frames.size, 0); assert.deepEqual(e.values.at(-1), { energy: 0, beat: 0 });
  e.play(); assert.equal(e.frames.size, 1);
  e.page.hidden = true; e.page.dispatchEvent(new Event('visibilitychange')); assert.equal(e.frames.size, 0);
  e.page.hidden = false; e.page.dispatchEvent(new Event('visibilitychange')); assert.equal(e.frames.size, 1);
  e.reduced.matches = true; e.reduced.dispatchEvent(new Event('change')); assert.equal(e.frames.size, 0);
  e.reduced.matches = false; e.reduced.dispatchEvent(new Event('change')); assert.equal(e.frames.size, 1);
  e.visible(false); assert.equal(e.frames.size, 0); e.visible(true); assert.equal(e.frames.size, 1);
  e.abort.abort(); assert.equal(e.frames.size, 0); e.play(); assert.equal(e.frames.size, 0);
  assert.equal(e.requests, 1); assert.equal(e.video.currentTime, 2.64, 'the driver never seeks playback');
});

test('a frozen playhead stops pulse motion until media resumes, even without a waiting event', async t => {
  const e = environment(t); e.visible(true); e.play(); await e.loaded();
  e.paint(1000); e.paint(1300); assert.equal(e.frames.size, 0);
  assert.equal(e.container.dataset.musicPulseState, 'waiting'); assert.deepEqual(e.values.at(-1), { energy: 0, beat: 0 });
  e.video.dispatchEvent(new Event('timeupdate')); e.paint(1400);
  assert.equal(e.frames.size, 0, 'unchanged timeupdate cannot fabricate another beat');
  assert.deepEqual(e.values.at(-1), { energy: 0, beat: 0 });
  e.video.currentTime += 0.1; e.video.dispatchEvent(new Event('timeupdate')); e.paint(1500);
  assert(e.values.at(-1).energy > 0); assert.equal(e.frames.size, 1);
});

test('rhythm loading failure leaves the player alone and does not create a retry or animation loop', async t => {
  const e = environment(t, () => new Response('unavailable', { status: 404 })); e.visible(true); e.play(); await e.loaded();
  assert.equal(e.container.dataset.musicPulseState, 'unavailable'); assert.equal(e.frames.size, 0);
  for (let i = 0; i < 5; i++) e.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(e.requests, 1); assert.equal(e.video.paused, false); assert.equal(e.video.currentTime, 2.64);
});
