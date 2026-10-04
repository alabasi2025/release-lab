// End-to-end against a disposable bare repository standing in for GitHub.
// No network, no gh. Exercises the real git operations: atomic tag push as a
// lock, admission against the remote object, abandon markers, receipts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { abandon, admit, cut, publish, ReleaseError, status } from './release.mjs';
import { parseClaim } from './claim.mjs';

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepos(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'release-lab-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
  sh(work, ['config', 'user.name', 'Lab Operator']);
  sh(work, ['config', 'user.email', 'lab@example.invalid']);
  sh(work, ['config', 'commit.gpgsign', 'false']);
  sh(work, ['config', 'tag.gpgsign', 'false']);
  return { bare, work, root };
}

function commit(work, file, subject, body = '') {
  writeFileSync(path.join(work, file), `${subject}\n${Date.now()}\n`);
  sh(work, ['add', file]);
  sh(work, ['commit', '-q', '-m', body ? `${subject}\n\n${body}` : subject]);
  return sh(work, ['rev-parse', 'HEAD']);
}

const quiet = { write: () => true };
function silence(fn) {
  const orig = process.stdout.write;
  process.stdout.write = quiet.write;
  try { return fn(); } finally { process.stdout.write = orig; }
}

test('first cut derives 0.1.0, pushes rc.1 atomically, claim binds the commit', (t) => {
  const { work, bare } = makeRepos(t);
  const sha = commit(work, 'a.txt', 'feat(app): first feature');
  sh(work, ['push', '-q', 'origin', 'main']);

  const r = silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test', now: new Date('2026-10-04T23:15:00Z') }));
  assert.equal(r.version, '0.1.0');
  assert.equal(r.ref, 'rc.1-v0.1.0');
  assert.equal(r.commit, sha);
  assert.equal(r.claim.epoch, '20261004T231500Z');

  const remoteTag = sh(bare, ['for-each-ref', '--format=%(contents)', 'refs/tags/rc.1-v0.1.0']);
  const claim = parseClaim(remoteTag);
  assert.equal(claim.commit, sha);
  assert.equal(claim.attempt, 1);
  assert.match(r.notes, /## Features/);
  assert.match(r.notes, /first feature/);
});

test('an outstanding attempt of any version blocks a new cut', (t) => {
  const { work } = makeRepos(t);
  commit(work, 'a.txt', 'fix: one');
  sh(work, ['push', '-q', 'origin', 'main']);
  silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));
  commit(work, 'b.txt', 'fix: two');
  sh(work, ['push', '-q', 'origin', 'main']);
  assert.throws(
    () => silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' })),
    (e) => e instanceof ReleaseError && /rc\.1-v0\.1\.0 is outstanding/.test(e.message),
  );
});

test('two operators racing for the same attempt: exactly one wins the lock', (t) => {
  const { work, bare, root } = makeRepos(t);
  commit(work, 'a.txt', 'fix: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  const other = path.join(root, 'other');
  execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore' });
  sh(other, ['config', 'user.name', 'Other']); sh(other, ['config', 'user.email', 'o@example.invalid']);
  sh(other, ['config', 'tag.gpgsign', 'false']);

  // Simulate: `other` derived the same version and tagged locally, then `work` pushes first.
  const w = silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'A' }));
  assert.equal(w.ref, 'rc.1-v0.1.0');
  // `other` now tries to cut without having fetched: outstanding check sees the tag → refuses.
  assert.throws(() => silence(() => cut({ cwd: other, commit: 'HEAD', dispatch: false, cutBy: 'B' })), /outstanding/);
  // Force the raw race from a clone that never fetched the tag: its push of
  // the same name must be rejected by the remote and nothing may move.
  const stale = path.join(root, 'stale');
  execFileSync('git', ['clone', '-q', '--no-tags', bare, stale], { stdio: 'ignore' });
  sh(stale, ['config', 'user.name', 'Stale']); sh(stale, ['config', 'user.email', 's@example.invalid']);
  sh(stale, ['config', 'tag.gpgsign', 'false']);
  sh(stale, ['tag', '-a', 'rc.1-v0.1.0', 'HEAD', '-m', 'bogus']);
  assert.throws(() => sh(stale, ['push', 'origin', 'refs/tags/rc.1-v0.1.0']), /rejected|already exists/);
  const remoteMsg = sh(bare, ['for-each-ref', '--format=%(contents:subject)', 'refs/tags/rc.1-v0.1.0']);
  assert.equal(remoteMsg, 'release-lab claim v1');
});

test('admit verifies tag object, claim, commit on main; rejects drift and abandoned attempts', (t) => {
  const { work } = makeRepos(t);
  const sha = commit(work, 'a.txt', 'fix: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  const r = silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));

  const ok = silence(() => admit({ cwd: work, tag: r.ref, checkedOutSha: sha }));
  assert.equal(ok.commit, sha);
  assert.equal(ok.version, '0.1.0');

  assert.throws(() => silence(() => admit({ cwd: work, tag: r.ref, checkedOutSha: 'f'.repeat(40) })), /checked out .* but claim binds/);
  assert.throws(() => silence(() => admit({ cwd: work, tag: 'v0.1.0' })), /not an attempt ref/);

  silence(() => abandon({ cwd: work, version: '0.1.0', reason: 'red build' }));
  assert.throws(() => silence(() => admit({ cwd: work, tag: r.ref })), /was abandoned/);
});

test('abandon keeps the attempt ref, writes a marker, and frees the version for rc.2', (t) => {
  const { work, bare } = makeRepos(t);
  commit(work, 'a.txt', 'fix: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));
  const a = silence(() => abandon({ cwd: work, version: '0.1.0', reason: 'flaky' }));
  assert.equal(a.marker, 'abandoned-rc.1-v0.1.0');
  const tags = sh(bare, ['tag', '-l']).split('\n').sort();
  assert.deepEqual(tags, ['abandoned-rc.1-v0.1.0', 'rc.1-v0.1.0']);

  const r2 = silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));
  assert.equal(r2.ref, 'rc.2-v0.1.0');
});

test('publish refuses a non-green attempt and creates the receipt from a green one', (t) => {
  const { work, bare } = makeRepos(t);
  const sha = commit(work, 'a.txt', 'feat: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));

  assert.throws(
    () => silence(() => publish({ cwd: work, version: '0.1.0', gateResult: { conclusion: 'failure' } })),
    /not green \(failure\)/,
  );
  const p = silence(() => publish({ cwd: work, version: '0.1.0', gateResult: { conclusion: 'success', url: 'https://example.invalid/run/1' } }));
  assert.equal(p.receipt, 'v0.1.0');
  assert.equal(sh(bare, ['rev-parse', 'v0.1.0^{commit}']), sha);
  const receiptMsg = sh(bare, ['for-each-ref', '--format=%(contents)', 'refs/tags/v0.1.0']);
  assert.match(receiptMsg, /attemptRef: rc\.1-v0\.1\.0/);
  assert.match(receiptMsg, new RegExp(`commit: ${sha}`));
  assert.match(receiptMsg, /workflowRun: https:\/\/example\.invalid\/run\/1/);

  // Receipt is final: publish again is refused; abandon is refused.
  assert.throws(() => silence(() => publish({ cwd: work, version: '0.1.0', gateResult: { conclusion: 'success' } })), /already exists/);
  assert.throws(() => silence(() => abandon({ cwd: work, version: '0.1.0' })), /is published/);
});

test('next cut after a receipt bumps from the receipt and requires descent from it', (t) => {
  const { work } = makeRepos(t);
  commit(work, 'a.txt', 'feat: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));
  silence(() => publish({ cwd: work, version: '0.1.0', gateResult: { conclusion: 'success' } }));

  commit(work, 'b.txt', 'fix(app): tiny');
  sh(work, ['push', '-q', 'origin', 'main']);
  const patch = silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test', bump: 'auto' }));
  assert.equal(patch.version, '0.1.1');
  silence(() => abandon({ cwd: work, version: '0.1.1' }));

  commit(work, 'c.txt', 'feat(app)!: breaking');
  sh(work, ['push', '-q', 'origin', 'main']);
  const minor = silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test', bump: 'auto' }));
  assert.equal(minor.version, '0.2.0', 'breaking pre-1.0 → minor');
  assert.match(minor.notes, /## Breaking changes/);
});

test('status reports published, outstanding and abandoned', (t) => {
  const { work } = makeRepos(t);
  commit(work, 'a.txt', 'feat: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));
  silence(() => publish({ cwd: work, version: '0.1.0', gateResult: { conclusion: 'success' } }));
  commit(work, 'b.txt', 'fix: x'); sh(work, ['push', '-q', 'origin', 'main']);
  silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' }));
  const s = silence(() => status({ cwd: work }));
  assert.equal(s.published, '0.1.0');
  assert.deepEqual(s.outstanding.map((o) => o.ref), ['rc.1-v0.1.1']);
  assert.equal(s.abandoned, 0);
});

test('cut refuses a commit that is not on remote main or does not descend from the last receipt', (t) => {
  const { work } = makeRepos(t);
  commit(work, 'a.txt', 'feat: base');
  sh(work, ['push', '-q', 'origin', 'main']);
  commit(work, 'local.txt', 'fix: unpushed');
  assert.throws(() => silence(() => cut({ cwd: work, commit: 'HEAD', dispatch: false, cutBy: 'test' })), /not on origin\/main/);
});
