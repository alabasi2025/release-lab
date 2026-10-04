import assert from 'node:assert/strict';
import test from 'node:test';
import { greet, version } from './index.mjs';

test('greet trims and formats', () => {
  assert.equal(greet('  Ada '), 'hello, Ada');
  assert.equal(greet(), 'hello, world');
});

test('greet rejects empty names', () => {
  assert.throws(() => greet(''), TypeError);
  assert.throws(() => greet(42), TypeError);
});

test('source checkout reports 0.0.0 until stamped', () => {
  // Behaviour contract, not a snapshot: either the committed placeholder or a
  // stamped SemVer. Never a hand-edited version in source.
  assert.match(version(), /^(0\.0\.0|\d+\.\d+\.\d+)$/);
});
