#!/usr/bin/env node
// One command for the whole release lifecycle (hermes-agent model):
//
//   release cut      --commit <sha|ref> [--bump patch|minor|major|auto] [--autopublish] [--skip-tests] [--dry-run]
//   release publish  --version X.Y.Z   [--dry-run]
//   release abandon  --version X.Y.Z   [--dry-run]
//   release status
//
// Invariants:
//   * The committed version is 0.0.0 forever. The version is derived here.
//   * cut pushes ONE annotated tag rc.<N>-vX.Y.Z atomically. Winning the push
//     is the lock. One outstanding attempt, of any version, blocks a new cut.
//   * The tag is not a workflow trigger. cut dispatches `Stable Release` on
//     that exact ref afterwards (needs gh CLI); without gh it prints the
//     command.
//   * publish creates the receipt vX.Y.Z ONLY from a green attempt, binding
//     the attempt ref, its object SHA, and the commit.
//   * abandon pushes abandoned-rc.<N>-vX.Y.Z and leaves the attempt ref in
//     place. The version is not spent; the next cut is rc.<N+1>.
//
// Everything that talks to the network is behind `--dry-run`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNotes, suggestBump } from './changelog.mjs';
import { epochNow, formatClaim, parseClaim } from './claim.mjs';
import {
  GIT_SHA, commitsBetween, createAnnotatedTag, fetchBranch, fetchTags, git, isAncestor,
  isWorktreeClean, pushNewTag, remoteBranchSha, remoteTags, revParse, tagMessage, tagObjectSha,
} from './git.mjs';
import {
  abandonedRef, attemptRef, bumpSemVer, latestPublished, nextAttempt, outstandingAttempts,
  parseAttemptRef, receiptTag,
} from './versioning.mjs';

export class ReleaseError extends Error {
  constructor(message, hint) { super(message); this.name = 'ReleaseError'; this.hint = hint; }
}

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return { command, opts };
}

function repoUrlFromRemote(cwd, remote) {
  const url = git(cwd, ['remote', 'get-url', remote], { allowFailure: true })?.trim() ?? '';
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/u.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFailure) return null;
    throw new ReleaseError(`gh ${args.join(' ')} failed: ${error.stderr ?? error.message}`);
  }
}

function hasGh() {
  return gh(['--version'], { allowFailure: true }) !== null;
}

function log(msg) { process.stdout.write(`${msg}\n`); }

// ---------------------------------------------------------------- cut

export function cut({ cwd, remote = 'origin', commit, bump = 'patch', autopublish = false, skipTests = false, dryRun = false, cutBy, now = new Date(), repoUrl, dispatch = true }) {
  if (!commit) throw new ReleaseError('--commit is required (a SHA or ref already on the remote main)');
  if (!isWorktreeClean(cwd)) throw new ReleaseError('worktree is dirty', 'commit or stash before cutting; the claim binds an exact tree');

  fetchBranch(cwd, remote, 'main');
  fetchTags(cwd, remote);
  const tags = remoteTags(cwd, remote);

  // 1) one outstanding attempt of any version blocks a new cut
  const outstanding = outstandingAttempts(tags);
  if (outstanding.length) {
    const o = outstanding[0];
    throw new ReleaseError(
      `attempt ${o.ref} is outstanding`,
      `publish it:   release publish --version ${o.version}\n  or abandon it: release abandon --version ${o.version}`,
    );
  }

  // 2) resolve + validate the commit: on remote main, descends from last receipt
  const sha = revParse(cwd, commit);
  if (!sha || !GIT_SHA.test(sha)) throw new ReleaseError(`cannot resolve commit ${commit}`);
  const remoteMain = remoteBranchSha(cwd, remote, 'main');
  if (!remoteMain) throw new ReleaseError(`remote ${remote} has no main branch`);
  if (!isAncestor(cwd, sha, remoteMain)) throw new ReleaseError(`${sha.slice(0, 7)} is not on ${remote}/main`, 'push it to main (through a pull request) first');

  const previous = latestPublished(tags);
  if (previous) {
    const prevSha = revParse(cwd, `refs/tags/${receiptTag(previous)}`);
    if (prevSha && !isAncestor(cwd, prevSha, sha)) {
      throw new ReleaseError(`${sha.slice(0, 7)} does not descend from the newest published v${previous}`);
    }
  }

  // 3) derive version
  const commits = commitsBetween(cwd, previous ? `refs/tags/${receiptTag(previous)}` : null, sha);
  if (bump === 'auto') bump = suggestBump(commits, previous ?? '0.0.0');
  const version = previous ? bumpSemVer(previous, bump) : (bump === 'major' ? '1.0.0' : '0.1.0');
  if (tags.includes(receiptTag(version))) {
    throw new ReleaseError(`v${version} already has a receipt tag`, 'a receipt means that version is published; bump differently');
  }
  const attempt = nextAttempt(tags, version);
  const ref = attemptRef(attempt, version);
  const epoch = epochNow(now);
  const claim = { version, attempt, commit: sha, epoch, autopublish, skipTests, cutBy: cutBy ?? whoami(cwd) };
  const notes = buildNotes({ version, previous, commits, repoUrl: repoUrl ?? repoUrlFromRemote(cwd, remote) });

  log(`cut: v${version} (bump=${bump}, previous=${previous ?? 'none'}, ${commits.length} commits)`);
  log(`     attempt ref ${ref} on ${sha.slice(0, 7)}, epoch ${epoch}`);
  if (dryRun) {
    log('     dry-run: no tag pushed, no dispatch');
    return { dryRun: true, version, attempt, ref, commit: sha, claim, notes };
  }

  // 4) write the notes draft locally (reviewable, not committed)
  const draftDir = path.join(cwd, '.release-candidates', ref);
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(path.join(draftDir, 'notes.md'), notes);
  writeFileSync(path.join(draftDir, 'claim.txt'), formatClaim(claim));

  // 5) atomic lock: the first push of this tag name wins
  createAnnotatedTag(cwd, ref, sha, formatClaim(claim));
  const pushed = pushNewTag(cwd, remote, ref);
  if (!pushed.won) {
    git(cwd, ['tag', '-d', ref], { allowFailure: true });
    throw new ReleaseError(`lost the lock for ${ref}: someone pushed it first`, 'run `release status` and retry; the next attempt number will be allocated');
  }
  log(`     pushed ${ref} (lock acquired)`);

  // 6) dispatch Stable Release on that exact ref (tags are never triggers)
  if (dispatch) {
    if (hasGh()) {
      gh(['workflow', 'run', 'stable-release.yml', '--ref', `refs/tags/${ref}`, '-f', `tag=${ref}`]);
      log(`     dispatched Stable Release on refs/tags/${ref}`);
    } else {
      log(`     gh not available — dispatch manually:\n       gh workflow run stable-release.yml --ref refs/tags/${ref} -f tag=${ref}`);
    }
  }
  return { dryRun: false, version, attempt, ref, commit: sha, claim, notes, draftDir };
}

function whoami(cwd) {
  const name = git(cwd, ['config', 'user.name'], { allowFailure: true })?.trim();
  return (name || process.env.USER || 'unknown').replace(/\s+/g, '-');
}

// ---------------------------------------------------------------- publish

export function publish({ cwd, remote = 'origin', version, dryRun = false, gateResult }) {
  if (!version) throw new ReleaseError('--version X.Y.Z is required');
  fetchTags(cwd, remote);
  const tags = remoteTags(cwd, remote);
  const receipt = receiptTag(version);
  if (tags.includes(receipt)) throw new ReleaseError(`${receipt} already exists — v${version} is published`);

  const live = outstandingAttempts(tags).filter((a) => a.version === version);
  if (!live.length) throw new ReleaseError(`no outstanding attempt for v${version}`, 'cut one first');
  const attempt = live[live.length - 1]; // newest attempt of that version
  const claim = parseClaim(tagMessage(cwd, attempt.ref));
  const objectSha = tagObjectSha(cwd, attempt.ref);

  // The gate: a successful Stable Release run on this exact attempt ref.
  const gate = gateResult ?? readGateFromGh(attempt.ref);
  if (gate.conclusion !== 'success') {
    throw new ReleaseError(`${attempt.ref} is not green (${gate.conclusion ?? 'no run found'})`, 'fix and rerun, or abandon');
  }

  const message = [
    `release-lab receipt v1`,
    '',
    `version: ${version}`,
    `attemptRef: ${attempt.ref}`,
    `attemptObject: ${objectSha}`,
    `commit: ${claim.commit}`,
    `epoch: ${claim.epoch}`,
    `skipTests: ${claim.skipTests}`,
    `workflowRun: ${gate.url ?? 'n/a'}`,
    '',
  ].join('\n');

  log(`publish: v${version} from ${attempt.ref} (${claim.commit.slice(0, 7)}), run ${gate.url ?? 'n/a'}`);
  if (dryRun) { log('     dry-run: no receipt pushed'); return { dryRun: true, receipt, attempt: attempt.ref, claim }; }

  createAnnotatedTag(cwd, receipt, claim.commit, message);
  const pushed = pushNewTag(cwd, remote, receipt);
  if (!pushed.won) throw new ReleaseError(`could not push ${receipt}: it appeared concurrently`);
  log(`     pushed receipt ${receipt}`);

  if (hasGh()) {
    // Retarget the draft release (created by the workflow) onto the receipt and publish it.
    const draft = gh(['release', 'view', attempt.ref, '--json', 'id,isDraft,body'], { allowFailure: true });
    if (draft) {
      gh(['release', 'edit', attempt.ref, '--tag', receipt, '--title', `v${version}`, '--draft=false', '--latest']);
      log(`     GitHub release published as ${receipt}`);
    } else {
      log('     no draft release found for the attempt; create one from the workflow artifacts if needed');
    }
  }
  return { dryRun: false, receipt, attempt: attempt.ref, claim };
}

function readGateFromGh(ref) {
  if (!hasGh()) return { conclusion: null };
  const out = gh(['run', 'list', '--workflow', 'stable-release.yml', '--branch', ref, '--limit', '1', '--json', 'conclusion,url,status,headBranch'], { allowFailure: true });
  if (!out) return { conclusion: null };
  const [run] = JSON.parse(out);
  return run ? { conclusion: run.conclusion, url: run.url, status: run.status } : { conclusion: null };
}

// ---------------------------------------------------------------- abandon

export function abandon({ cwd, remote = 'origin', version, dryRun = false, reason = '' }) {
  if (!version) throw new ReleaseError('--version X.Y.Z is required');
  fetchTags(cwd, remote);
  const tags = remoteTags(cwd, remote);
  if (tags.includes(receiptTag(version))) throw new ReleaseError(`v${version} is published; a receipt cannot be abandoned`);
  const live = outstandingAttempts(tags).filter((a) => a.version === version);
  if (!live.length) throw new ReleaseError(`no outstanding attempt for v${version}`);
  const attempt = live[live.length - 1];
  const marker = abandonedRef(attempt.attempt, version);
  const claim = parseClaim(tagMessage(cwd, attempt.ref));

  log(`abandon: ${attempt.ref} → ${marker}${reason ? ` (${reason})` : ''}`);
  if (dryRun) { log('     dry-run: no marker pushed'); return { dryRun: true, marker }; }

  if (hasGh()) {
    gh(['run', 'cancel', ...runIdsFor(attempt.ref)], { allowFailure: true });
    gh(['release', 'delete', attempt.ref, '--yes'], { allowFailure: true });
  }
  createAnnotatedTag(cwd, marker, claim.commit, `abandoned ${attempt.ref}\n\nreason: ${reason || 'unspecified'}\n`);
  const pushed = pushNewTag(cwd, remote, marker);
  if (!pushed.won) throw new ReleaseError(`could not push ${marker}`);
  log(`     pushed ${marker}; attempt ref kept as history; next cut is rc.${attempt.attempt + 1}-v${version}`);
  return { dryRun: false, marker };
}

function runIdsFor(ref) {
  const out = gh(['run', 'list', '--workflow', 'stable-release.yml', '--branch', ref, '--status', 'in_progress', '--json', 'databaseId'], { allowFailure: true });
  return out ? JSON.parse(out).map((r) => String(r.databaseId)) : [];
}

// ---------------------------------------------------------------- status

export function status({ cwd, remote = 'origin' }) {
  fetchTags(cwd, remote);
  const tags = remoteTags(cwd, remote);
  const published = latestPublished(tags);
  const outstanding = outstandingAttempts(tags);
  const abandoned = tags.filter((t) => t.startsWith('abandoned-rc.')).length;
  const lines = [
    `published : ${published ? `v${published}` : 'none'}`,
    `outstanding: ${outstanding.length ? outstanding.map((o) => o.ref).join(', ') : 'none'}`,
    `abandoned : ${abandoned}`,
    `receipts  : ${tags.filter((t) => /^v\d/.test(t)).sort().join(', ') || 'none'}`,
  ];
  for (const l of lines) log(l);
  return { published, outstanding, abandoned };
}

// ---------------------------------------------------------------- admit (used by the workflow)

/**
 * Admission: the dispatched ref must be an attempt ref; the remote tag object
 * must exist; its claim must bind the same commit the workflow checked out;
 * that commit must be on main. Emits GitHub outputs when GITHUB_OUTPUT is set.
 */
export function admit({ cwd, remote = 'origin', tag, checkedOutSha }) {
  const parsed = parseAttemptRef(tag);
  if (!parsed) throw new ReleaseError(`${tag} is not an attempt ref (rc.<N>-vX.Y.Z)`);
  fetchTags(cwd, remote);
  fetchBranch(cwd, remote, 'main');
  const objectSha = tagObjectSha(cwd, tag);
  if (!objectSha) throw new ReleaseError(`tag ${tag} not found on ${remote}`);
  const claim = parseClaim(tagMessage(cwd, tag));
  if (claim.version !== parsed.version || claim.attempt !== parsed.attempt) throw new ReleaseError('claim does not match the tag name');
  const peeled = revParse(cwd, `refs/tags/${tag}`);
  if (peeled !== claim.commit) throw new ReleaseError(`tag points at ${peeled} but claim says ${claim.commit}`);
  if (checkedOutSha && checkedOutSha !== claim.commit) throw new ReleaseError(`checked out ${checkedOutSha} but claim binds ${claim.commit}`);
  const remoteMain = remoteBranchSha(cwd, remote, 'main');
  if (!isAncestor(cwd, claim.commit, remoteMain)) throw new ReleaseError(`${claim.commit} is not on ${remote}/main`);
  const tags = remoteTags(cwd, remote);
  if (tags.includes(receiptTag(claim.version))) throw new ReleaseError(`v${claim.version} already published`);
  if (tags.includes(abandonedRef(claim.attempt, claim.version))) throw new ReleaseError(`${tag} was abandoned`);

  const outputs = { tag, 'claim-object': objectSha, commit: claim.commit, version: claim.version, attempt: String(claim.attempt), epoch: claim.epoch, 'skip-tests': String(claim.skipTests), autopublish: String(claim.autopublish) };
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''), { flag: 'a' });
  }
  log(`admit: ${tag} object ${objectSha.slice(0, 7)} → commit ${claim.commit.slice(0, 7)} v${claim.version} attempt ${claim.attempt} epoch ${claim.epoch}`);
  return outputs;
}

// ---------------------------------------------------------------- main

function main(argv) {
  const { command, opts } = parseArgs(argv);
  const cwd = process.cwd();
  const common = { cwd, remote: opts.remote ?? 'origin', dryRun: Boolean(opts['dry-run']) };
  switch (command) {
    case 'cut':
      return cut({ ...common, commit: opts.commit, bump: opts.bump ?? 'patch', autopublish: Boolean(opts.autopublish), skipTests: Boolean(opts['skip-tests']), dispatch: !opts['no-dispatch'] });
    case 'publish':
      return publish({ ...common, version: opts.version });
    case 'abandon':
      return abandon({ ...common, version: opts.version, reason: typeof opts.reason === 'string' ? opts.reason : '' });
    case 'status':
      return status(common);
    case 'admit':
      return admit({ ...common, tag: opts.tag, checkedOutSha: opts['checked-out'] });
    default:
      throw new ReleaseError(`unknown command: ${command ?? '(none)'}`, 'cut | publish | abandon | status | admit');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ReleaseError) {
      process.stderr.write(`error: ${error.message}\n`);
      if (error.hint) process.stderr.write(`  ${error.hint}\n`);
      process.exit(2);
    }
    throw error;
  }
}
