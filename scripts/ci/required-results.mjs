#!/usr/bin/env node
// The single gate. Reads the `needs` context (JSON on stdin) and decides.
//
//   normal run : every job must be success or skipped (skipped = not applicable)
//   --release  : strict — every job must be success; a skipped required job fails
//
// Branch protection requires only the job that runs this script, so adding a
// new check means adding it to `needs`, never editing the protection rule.
import { readFileSync } from 'node:fs';

export function evaluate(needs, { release = false, optional = [] } = {}) {
  const failures = [];
  for (const [job, info] of Object.entries(needs)) {
    const result = info?.result ?? 'missing';
    if (result === 'success') continue;
    if (result === 'skipped' && !release && !optional.includes(job)) continue;
    if (result === 'skipped' && optional.includes(job)) continue;
    failures.push(`${job}: ${result}`);
  }
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const release = process.argv.includes('--release');
  // Lanes that legitimately do not apply to some events (e.g. history_check
  // only exists for pull requests). Declared explicitly, like hermes-agent's
  // SKIPPED_BY table, so "skipped" is never silently accepted in release mode.
  const optional = process.argv.flatMap((a, i, all) => (a === '--optional' ? [all[i + 1]] : []));
  const needs = JSON.parse(readFileSync(0, 'utf8'));
  const { ok, failures } = evaluate(needs, { release, optional });
  for (const [job, info] of Object.entries(needs)) console.log(`${(info?.result ?? 'missing').padEnd(9)} ${job}`);
  if (!ok) {
    console.error(`\n${failures.length} required job(s) did not pass${release ? ' (release mode: skipped counts as failure)' : ''}:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nall ${Object.keys(needs).length} required checks pass`);
}
