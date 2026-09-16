import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMotorReport, motorSampleAt, motorSummary } from '../site/fly/motor.js';
import { verifySignedEvent } from '../site/fly/vendor/nostr-verify.js';
const event = JSON.parse(readFileSync(new URL('./fixtures/fly-motor-event.json', import.meta.url)));
const report = parseMotorReport(event.content);
const content = m => `Replay: seed ${m.seed.toString(16).padStart(8, '0')}.\nMotor: ${JSON.stringify(m)}`;

test('real connectome report has valid telemetry and a verifiable test signature', async () => {
  assert.equal(await verifySignedEvent(event), true);
  assert.ok(report);
  assert.match(motorSummary(report), /proboscis/);
  assert.ok(report.samples.some(s => s[1] > 0));
});
test('changing telemetry, claimed author or signature fails authentication', async () => {
  for (const changed of [{ ...event, content: event.content + ' ' }, { ...event, pubkey: '0'.repeat(64) }, { ...event, sig: '0'.repeat(128) }]) assert.equal(await verifySignedEvent(changed), false);
});
test('malformed relay events are rejected without throwing', async () => {
  for (const changed of [null, {}, { ...event, tags: [null] }, { ...event, content: 'x'.repeat(8001) }, { ...event, created_at: -1 }]) assert.equal(await verifySignedEvent(changed), false);
});
test('prose-only and unsupported reports never invent motor activity', () => {
  assert.equal(parseMotorReport('It startled, sang, and walked forward.'), null);
  assert.equal(parseMotorReport('Trophallaxis. The fly brought up 210 sats.'), null);
  assert.equal(parseMotorReport(content({ ...report, v: 2 })), null);
});
test('invalid ranges, channels, counts and sample lengths fail closed', () => {
  for (const mutate of [m => {m.samples[0][0] = 101;}, m => {m.samples[0][6] = -101;}, m => {m.windowMs = 1001;}, m => {m.samples.pop();}, m => {m.channels[0] = 'flight';}, m => {m.neurons[0][0] = -1;}, m => {m.spikes[0][0] = 200000001;}, m => {m.stepMs = 0;}]) {
    const m = structuredClone(report); mutate(m); assert.equal(parseMotorReport(content(m)), null);
  }
});
test('duplicate or seed-mismatched motor reports are refused', () => {
  assert.equal(parseMotorReport(event.content + '\n' + event.content), null);
  assert.equal(parseMotorReport(event.content.replace(/^Replay: seed .{8}/m, 'Replay: seed 00000000')), null);
});
test('a zero baseline run stays still; a fabricated active sample is refused', () => {
  const quiet = structuredClone(report); quiet.spikes = structuredClone(quiet.baseline); quiet.samples = quiet.samples.map(() => [0,0,0,0,0,0,0]);
  assert.ok(parseMotorReport(content(quiet)));
  assert.equal(motorSummary(quiet), 'no motor activity above baseline');
  quiet.samples[0][1] = 10;
  assert.equal(parseMotorReport(content(quiet)), null);
});
test('playback follows source bins at 10x slowdown and stops at the window end', () => {
  assert.deepEqual(motorSampleAt(report, 0), report.samples[0].map(n => n / 100));
  assert.deepEqual(motorSampleAt(report, .5), report.samples[1].map(n => n / 100));
  assert.deepEqual(motorSampleAt(report, report.windowMs / 100), [0,0,0,0,0,0,0]);
  assert.deepEqual(motorSampleAt(report, -1), [0,0,0,0,0,0,0]);
});
