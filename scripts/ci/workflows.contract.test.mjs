// Pins the pipeline's invariants in the workflow files themselves, so a later
// edit cannot silently reintroduce a known failure mode. Reads from
// .github/workflows/ when present (after the human move), else pending/.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname, '..');
const dir = existsSync(path.join(root, '.github/workflows/ci.yml'))
  ? path.join(root, '.github/workflows')
  : path.join(root, 'pending/workflows');
// Strip YAML comments so a comment that *mentions* a forbidden construct is not
// mistaken for the construct itself.
const read = (name) => readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n')
  .split('\n').map((line) => line.replace(/^(\s*)#.*$/u, '$1')).join('\n');
const ci = read('ci.yml');
const stable = read('stable-release.yml');
const canary = read('canary.yml');

test('ci runs on pull requests and main pushes, and holds no secrets', () => {
  assert.match(ci, /\non:\n(?:.*\n)*?  pull_request:\n/u);
  assert.match(ci, /  push:\n    branches: \[main\]/u);
  assert.doesNotMatch(ci, /secrets:/u);
  assert.doesNotMatch(ci, /\$\{\{\s*secrets\./u);
});

test('the aggregate gate is the only check and depends on every lane', () => {
  const lanes = [...ci.matchAll(/^  ([a-z_]+):\n    (?:#.*\n    )*name: /gmu)].map((m) => m[1]).filter((j) => j !== 'all-checks-pass');
  assert.ok(lanes.length >= 4, `lanes: ${lanes}`);
  const gate = ci.slice(ci.indexOf('\n  all-checks-pass:\n'));
  assert.match(gate, /name: All required checks pass/u);
  assert.match(gate, /if: always\(\)/u);
  const needs = /needs: \[([^\]]+)\]/u.exec(gate)[1].split(',').map((s) => s.trim());
  for (const lane of lanes) assert.ok(needs.includes(lane), `gate does not depend on ${lane}`);
});

test('tags never trigger a workflow', () => {
  for (const [name, text] of [['ci', ci], ['stable', stable], ['canary', canary]]) {
    assert.doesNotMatch(text, /\n\s+tags:/u, `${name} triggers on tags`);
  }
  assert.match(stable, /\non:\n  workflow_dispatch:\n/u);
});

test('stable release admits before anything else and joins at acceptance', () => {
  assert.match(stable, /\n  admit:\n/u);
  for (const job of ['ci', 'build', 'verify', 'draft']) {
    const block = stable.slice(stable.indexOf(`\n  ${job}:\n`));
    assert.match(block.slice(0, 600), /needs: (\[?admit|\[admit)/u, `${job} does not need admit`);
  }
  const acceptance = stable.slice(stable.indexOf('\n  acceptance:\n'));
  assert.match(acceptance, /needs: \[admit, ci, build, verify, draft\]/u);
  assert.match(acceptance, /if: always\(\)/u);
  assert.match(acceptance, /--release/u);
});

test('stable release never inherits secrets into the reusable ci call', () => {
  const ciCall = stable.slice(stable.indexOf('\n  ci:\n'), stable.indexOf('\n  build:\n'));
  assert.match(ciCall, /uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.doesNotMatch(ciCall, /secrets: inherit/u);
});

test('the draft is never published by the workflow', () => {
  const draft = stable.slice(stable.indexOf('\n  draft:\n'), stable.indexOf('\n  acceptance:\n'));
  assert.match(draft, /--draft/u);
  assert.doesNotMatch(draft, /--draft=false|--latest/u);
});

test('every third-party action is pinned to a 40-hex commit SHA', () => {
  for (const [name, text] of [['ci', ci], ['stable', stable], ['canary', canary]]) {
    for (const m of text.matchAll(/uses: ([^\s@]+)@([^\s#]+)/gu)) {
      if (m[1].startsWith('./')) continue;
      assert.match(m[2], /^[0-9a-f]{40}$/u, `${name}: ${m[1]}@${m[2]} is not SHA-pinned`);
    }
  }
});

test('canary only runs from the default branch and publishes prereleases', () => {
  assert.match(canary, /if: github\.ref_name == github\.event\.repository\.default_branch/u);
  assert.match(canary, /--prerelease/u);
  assert.match(canary, /schedule:\n\s+- cron:/u);
});
