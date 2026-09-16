import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BodyController } from '../site/fly/body-controller.js';
import { parseMotorReport, motorSampleAt } from '../site/fly/motor.js';
import { verifySignedEvent } from '../site/fly/vendor/nostr-verify.js';
const recordings = JSON.parse(readFileSync(new URL('../site/fly/assets/brain-recordings.json', import.meta.url)));
const zero = [0,0,0,0,0,0,0];
function replay(name) {
  const b = new BodyController(), r = parseMotorReport(recordings.recordings.find(r => r.name === name).content);
  assert.ok(r);
  const states = [];
  for (let t = 0; t < r.windowMs / 100; t += 1 / 60) { b.step(motorSampleAt(r, t), 1 / 60); states.push({ ...b }); }
  return { b, states };
}
test('actual looming run triggers takeoff and bounded flight, then lands and stops', () => {
  const { b, states } = replay('escape');
  assert.ok(states.some(s => s.mode === 'takeoff'));
  assert.ok(states.some(s => s.mode === 'flight' && s.z > .2));
  b.finish();
  for (let i = 0; i < 120; i++) b.step(zero, 1 / 60);
  assert.equal(b.mode, 'rest'); assert.equal(b.z, 0);
  const x = b.x; for (let i = 0; i < 600; i++) b.step(zero, 1 / 60);
  assert.equal(b.x, x); assert.equal(b.air, 0);
});
test('actual mixed feeding and retreat retains backward travel and independent proboscis drive', () => {
  const { b, states } = replay('retreat');
  assert.ok(b.x < -.1); assert.ok(b.phase > 1);
  assert.ok(states.some(s => s.speed < 0 && s.feed > .1));
  assert.ok(states.every(s => s.z === 0));
});
test('sugar feeds without head-touch retreat; quiet recording cannot create flight', () => {
  const feed = replay('feed'), quiet = replay('quiet');
  assert.equal(feed.b.x, 0); assert.ok(feed.b.feed > .1);
  assert.equal(quiet.b.x, 0); assert.equal(quiet.b.phase, 0); assert.equal(quiet.b.z, 0);
});
test('forward walking and a turn change travel while keeping heading continuous', () => {
  const b = new BodyController();
  for (let i = 0; i < 30; i++) b.step([0,0,1,0,0,0,0], 1 / 60);
  assert.ok(b.x > 0); const heading = b.heading;
  b.step([0,0,1,1,0,0,-1], 1 / 60);
  assert.ok(b.heading > heading && b.heading < Math.PI / 2);
  for (let i = 0; i < 180; i++) b.step([0,0,1,1,0,0,-1], 1 / 60);
  assert.ok(b.x < 0);
});
test('unsigned recordings remain labelled examples; signed escape fixture authenticates', async () => {
  assert.equal(recordings.kind, 'offline-brain-recordings'); assert.equal(recordings.signed, false);
  const e = JSON.parse(readFileSync(new URL('./fixtures/fly-escape-event.json', import.meta.url)));
  assert.equal(await verifySignedEvent(e), true); assert.ok(parseMotorReport(e.content));
});
