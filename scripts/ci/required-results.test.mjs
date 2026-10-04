import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './required-results.mjs';

test('success and not-applicable skips pass in normal mode', () => {
  const r = evaluate({ a: { result: 'success' }, b: { result: 'skipped' } });
  assert.deepEqual(r, { ok: true, failures: [] });
});
test('failure, cancelled and missing fail', () => {
  const r = evaluate({ a: { result: 'failure' }, b: { result: 'cancelled' }, c: {} });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures, ['a: failure', 'b: cancelled', 'c: missing']);
});
test('release mode: a skipped required job is a failure', () => {
  assert.equal(evaluate({ a: { result: 'skipped' } }, { release: true }).ok, false);
  assert.equal(evaluate({ a: { result: 'success' } }, { release: true }).ok, true);
});
test('release mode: an explicitly optional lane may be skipped', () => {
  const needs = { history_check: { result: 'skipped' }, tests: { result: 'success' } };
  assert.equal(evaluate(needs, { release: true }).ok, false);
  assert.equal(evaluate(needs, { release: true, optional: ['history_check'] }).ok, true);
});
