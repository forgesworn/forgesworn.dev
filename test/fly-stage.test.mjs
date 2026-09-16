import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behaviourOf } from '../site/fly/fly-stage.js';

test('runtime gift notices trigger sharing even when they also mention feeding', () => {
  assert.deepEqual(behaviourOf('Trophallaxis. The fly brought up 210 sats, and of everyone who wrote to it this poke drew them. Your link is in your messages.'), ['puke', 'Shared a drop.']);
  assert.equal(behaviourOf('extended its proboscis; gave a drop')[0], 'puke');
});

test('quiet or prospective prose does not trigger an invented gift', () => {
  assert.equal(behaviourOf('Trophallaxis is not live yet.')[0], 'cruise');
  assert.equal(behaviourOf('Corn: 2,100 sats')[0], 'cruise');
  assert.equal(behaviourOf('The fly extended its proboscis.')[0], 'fed');
});
