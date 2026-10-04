import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abandonedRef, attemptRef, bumpSemVer, compareSemVer, latestPublished, nextAttempt,
  outstandingAttempts, parseAbandonedRef, parseAttemptRef, parseReceiptTag, receiptTag,
} from './versioning.mjs';

test('attempt ref grammar is rc.<N>-vX.Y.Z and nothing else', () => {
  assert.deepEqual(parseAttemptRef('rc.1-v0.21.5'), { attempt: 1, version: '0.21.5' });
  assert.deepEqual(parseAttemptRef('rc.12-v1.0.0'), { attempt: 12, version: '1.0.0' });
  for (const bad of ['v0.21.5-rc.1', 'rc.0-v0.1.0', 'rc.1-v01.0.0', 'rc.1-0.1.0', 'rc1-v0.1.0', 'RC.1-v0.1.0', '']) {
    assert.equal(parseAttemptRef(bad), null, bad);
  }
  assert.equal(attemptRef(3, '0.2.0'), 'rc.3-v0.2.0');
  assert.throws(() => attemptRef(0, '0.2.0'));
  assert.throws(() => attemptRef(1, '0.2'));
});

test('abandoned marker and receipt tag grammars', () => {
  assert.deepEqual(parseAbandonedRef('abandoned-rc.2-v0.3.1'), { attempt: 2, version: '0.3.1' });
  assert.equal(parseAbandonedRef('rc.2-v0.3.1'), null);
  assert.equal(parseReceiptTag('v1.2.3'), '1.2.3');
  assert.equal(parseReceiptTag('v1.2.3-rc.1'), null);
  assert.equal(parseReceiptTag('1.2.3'), null);
  assert.equal(abandonedRef(2, '0.3.1'), 'abandoned-rc.2-v0.3.1');
  assert.equal(receiptTag('0.3.1'), 'v0.3.1');
});

test('semver compare and bump', () => {
  assert.ok(compareSemVer('0.10.0', '0.9.9') > 0);
  assert.ok(compareSemVer('1.0.0', '0.99.99') > 0);
  assert.equal(compareSemVer('2.3.4', '2.3.4'), 0);
  assert.equal(bumpSemVer('0.21.4', 'patch'), '0.21.5');
  assert.equal(bumpSemVer('0.21.4', 'minor'), '0.22.0');
  assert.equal(bumpSemVer('0.21.4', 'major'), '1.0.0');
  assert.throws(() => bumpSemVer('0.21.4', 'huge'));
});

test('only receipt tags move the published line', () => {
  const tags = ['v0.1.0', 'rc.1-v0.2.0', 'rc.2-v0.2.0', 'abandoned-rc.1-v0.2.0', 'v0.1.1', 'rc.1-v9.9.9'];
  assert.equal(latestPublished(tags), '0.1.1');
  assert.equal(latestPublished([]), null);
});

test('next attempt counts both live and abandoned attempts of that version only', () => {
  const tags = ['rc.1-v0.2.0', 'abandoned-rc.1-v0.2.0', 'rc.2-v0.2.0', 'rc.1-v0.3.0'];
  assert.equal(nextAttempt(tags, '0.2.0'), 3);
  assert.equal(nextAttempt(tags, '0.3.0'), 2);
  assert.equal(nextAttempt(tags, '0.4.0'), 1);
});

test('outstanding = attempt without abandonment and without receipt', () => {
  const tags = [
    'rc.1-v0.2.0', 'abandoned-rc.1-v0.2.0',   // abandoned → not outstanding
    'rc.2-v0.2.0', 'v0.2.0',                  // published → not outstanding
    'rc.1-v0.3.0',                            // live → outstanding
    'rc.1-v0.2.5',                            // live → outstanding, sorts before 0.3.0
  ];
  assert.deepEqual(outstandingAttempts(tags), [
    { ref: 'rc.1-v0.2.5', attempt: 1, version: '0.2.5' },
    { ref: 'rc.1-v0.3.0', attempt: 1, version: '0.3.0' },
  ]);
});
