// Anatomical renderer checks, offline. No relay connections or publications.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { safeShot } from '../shotguard.mjs';
mkdirSync('captures-out/fly-body', { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.route('**/rig-test', route => route.fulfill({ contentType: 'text/html', body: '<style>body{margin:0}canvas{width:1000px;height:600px}</style><canvas></canvas>' }));
  await page.goto('http://127.0.0.1:8826/fly/rig-test');
  const results = await page.evaluate(async () => {
    const { createFlyBody } = await import('./fly-body.js');
    const { BodyController } = await import('./body-controller.js');
    const { SceneDirector } = await import('./scene-director.js');
    const view = await createFlyBody(document.querySelector('canvas')), results = [];
    // Sample the complete pose and projection without issuing thousands of GPU
    // draws. Actual rendered flight and feeding are captured by the browser checks.
    const render = view.renderer.render.bind(view.renderer);
    view.renderer.render = (scene, camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); };
    for (const [width, height] of [[1208, 580], [358, 388], [288, 300]]) {
      view.resize(width, height);
      const body = new BodyController(), scene = new SceneDirector(); scene.limit = width < 600 ? .11 : .22;
      let clippedFrames = 0, min = 1, max = -1, lift = 0, stanceError = 0, stanceCount = 0;
      for (let i = 0; i < 240; i++) {
        scene.step(body, 1 / 15); view.pose(body, i / 15, { groom: scene.mode === 'groom' });
        if (!view.framed()) clippedFrames++;
        const d = view.debug(); min = Math.min(min, d.screen[0]); max = Math.max(max, d.screen[0]);
        if (scene.mode === 'forward') for (const f of d.feet) {
          if (f.swing) lift = Math.max(lift, f.actual[2] + .131);
          else { stanceError += Math.hypot(...f.actual.map((n, j) => n - f.planted[j])); stanceCount++; }
        }
      }
      results.push({ width, name: 'ambient', clippedFrames, pixelTravel: (max - min) * width / 2, footLift: lift, meanStanceError: stanceError / stanceCount });
      for (const [name, sample] of [['forward', [0,0,1,0,0,0,0]], ['backward', [0,.5,0,0,1,0,0]], ['escape', [1,0,0,0,0,0,0]]]) {
        const body = new BodyController(); body.limitX = scene.limit; let clippedFrames = 0;
        for (let i = 0; i < 100; i++) { body.step(sample, 1 / 20); view.pose(body, i / 20); if (!view.framed()) clippedFrames++; }
        results.push({ width, name, clippedFrames });
      }
    }
    const airborne = new BodyController(); airborne.air = 1; airborne.z = .18;
    view.pose(airborne, 0); const flyingWings = view.debug().wings;
    airborne.air = 0; airborne.z = 0; view.pose(airborne, 1);
    results.push({ name: 'wingExposure', flying: flyingWings, landed: view.debug().wings });
    view.renderer.render = render;
    // Extension must emerge from below the head, and the drop must actually fall.
    const body = new BodyController(); body.feed = 1; view.resize(1000, 600);
    view.pose(body, 0, { share: 1 }); const attached = view.debug();
    view.pose(body, 0, { share: 1, release: 1 }); const released = view.debug();
    window.rigCapture = { view, body };
    results.push({ name: 'regurgitation', attached: attached.drop.position, released: released.drop.position });
    return results;
  });
  assert.ok(results.filter(r => 'clippedFrames' in r).every(r => r.clippedFrames === 0), JSON.stringify(results));
  for (const r of results.filter(r => r.name === 'ambient')) {
    assert.ok(r.pixelTravel > (r.width > 600 ? 300 : 60), 'Visible screen travel');
    assert.ok(r.footLift > .03, 'Feet visibly lift');
    assert.ok(r.meanStanceError < .005, 'Planted feet hold their place');
  }
  const wings = results.find(r => r.name === 'wingExposure');
  assert.ok(wings.flying.blur && !wings.flying.sharp && wings.flying.samples === 64);
  assert.ok(!wings.landed.blur && wings.landed.sharp);
  const drop = results.find(r => r.name === 'regurgitation');
  assert.ok(drop.attached[0] > .09 && drop.attached[2] < -.06, 'Extended mouthparts emerge below the head');
  assert.ok(drop.released[2] < drop.attached[2] - .025, 'Drop falls to the surface');
  for (const [name, phase] of [['step-a', .7], ['step-b', .2]]) {
    await page.evaluate(phase => { const { body, view } = window.rigCapture; body.feed = 0; body.speed = .1; body.phase = phase; view.pose(body, phase); }, phase);
    await safeShot(page, `captures-out/fly-body/${name}.png`);
  }
  writeFileSync('captures-out/fly-body/checks.json', JSON.stringify(results, null, 2) + '\n');
  console.log('Desktop, phone and small-phone framing, screen travel, six-leg footwork and visible droplet release pass.');
} finally { await browser.close(); }
