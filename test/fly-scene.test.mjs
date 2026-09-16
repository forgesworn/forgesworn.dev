import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyController } from '../site/fly/body-controller.js';
import { SceneDirector } from '../site/fly/scene-director.js';

test('arrival explores forwards, takes off, crosses the scene, lands and turns before walking', () => {
  const b = new BodyController(), s = new SceneDirector(), modes = new Set();
  let min = 0, max = 0;
  for (let i = 0; i < 960; i++) {
    const x = b.x; s.step(b, 1 / 60); modes.add(b.mode);
    min = Math.min(min, b.x); max = Math.max(max, b.x);
    if (b.mode === 'forward') assert.ok((b.x - x) * Math.cos(b.heading) >= -1e-8, 'Walk in the direction the head faces');
    assert.ok(b.z >= 0 && b.z <= .216);
  }
  for (const mode of ['forward', 'takeoff', 'flight', 'landing', 'turn', 'groom']) assert.ok(modes.has(mode));
  assert.ok(max - min > .39); assert.ok(b.phase > 5);
});
test('feeding from either side turns towards the food, lands, drinks and releases a drop', () => {
  for (const [x, z] of [[.2, 0], [-.2, 0], [.2, .2]]) {
    const b = new BodyController(), s = new SceneDirector(), modes = new Set();
    b.x = x; b.z = z; s.feed(b);
    let released = false, drank = false;
    for (let i = 0; i < 510; i++) {
      const oldX = b.x; s.step(b, 1 / 60); modes.add(b.mode);
      if (b.mode === 'forward') assert.ok((b.x - oldX) * Math.cos(b.heading) >= -1e-8);
      if (b.mode === 'feed') { assert.equal(b.z, 0); drank ||= b.feed > .9 && s.food < .5; }
      released ||= s.release > .95 && s.share === 1;
    }
    assert.ok(drank && released); assert.equal(s.meal, null);
    for (const mode of ['feed', 'swallow', 'share']) assert.ok(modes.has(mode));
    if (z) assert.ok(modes.has('landing'));
  }
});
test('returning from a report preserves position and steps back into exploration', () => {
  const b = new BodyController(), s = new SceneDirector(); b.x = .2; b.heading = Math.PI;
  s.resume(b); s.step(b, 1 / 60); assert.equal(b.x, .2);
  for (let i = 0; i < 110; i++) s.step(b, 1 / 60);
  assert.equal(s.home, null); assert.ok(Math.abs(b.x) < .01);
});
