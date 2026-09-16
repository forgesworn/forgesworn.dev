import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wingStroke, wingDeployment } from '../site/fly/wing-motion.js';
import { verifiedZap } from '../site/fly/zap-receipt.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/fly-confirmed-zap.json', import.meta.url)));
test('wing sweep reverses while feathering flips, within the anatomical hinge limits', () => {
  const ranges = [[-1.5,1.5],[-1,1.5],[-1.27,2.92]];
  for (let i = 0; i <= 100; i++) wingStroke(i / 100).forEach((v,j) => assert.ok(v >= ranges[j][0] && v <= ranges[j][1]));
  assert.ok(wingStroke(.25)[2] > wingStroke(.75)[2] + 2);
  assert.ok(wingStroke(.5)[0] > wingStroke(0)[0] + 2);
  assert.equal(wingDeployment(0), 0); assert.equal(wingDeployment(1), 1);
  assert.ok(wingDeployment(.01) < .01, 'Unfold without a sudden snap');
});
test('only the recipient mint can confirm a zap with matching request and invoice amounts', async () => {
  assert.equal((await verifiedZap(fixture.receipt, fixture)).sats, 210);
  for (const [name, receipt] of Object.entries(fixture.invalid)) assert.equal(await verifiedZap(receipt, fixture), null, name);
  assert.equal(await verifiedZap(fixture.receipt, { ...fixture, lnurl: 'lnurl1elsewhere' }), null);
  assert.equal(await verifiedZap({ ...fixture.receipt, content: 'tampered' }, fixture), null);
});
