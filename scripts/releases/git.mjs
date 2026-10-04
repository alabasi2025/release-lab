// Thin git adapter. Every command is explicit and runs with an explicit cwd so
// the release scripts can be tested against a disposable repository.
import { execFileSync } from 'node:child_process';

export class GitError extends Error {
  constructor(args, stderr) {
    super(`git ${args.join(' ')} failed: ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

export function git(cwd, args, { input, allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).replace(/\r\n/g, '\n');
  } catch (error) {
    if (allowFailure) return null;
    throw new GitError(args, error.stderr?.toString() ?? String(error));
  }
}

export const GIT_SHA = /^[0-9a-f]{40}$/u;

export function revParse(cwd, ref) {
  const out = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  return out ? out.trim() : null;
}

export function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }) !== null;
}

export function isWorktreeClean(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']).trim() === '';
}

/** Tag names on the remote (not local), so two operators see the same locks. */
export function remoteTags(cwd, remote) {
  const out = git(cwd, ['ls-remote', '--tags', '--refs', remote]) ?? '';
  return out.split('\n').filter(Boolean).map((line) => line.split('\t')[1].replace('refs/tags/', ''));
}

export function remoteBranchSha(cwd, remote, branch) {
  const out = git(cwd, ['ls-remote', '--heads', remote, branch]);
  const line = out.split('\n').find(Boolean);
  return line ? line.split('\t')[0] : null;
}

/** The annotated tag object SHA (not the commit it points to). */
export function tagObjectSha(cwd, tag) {
  const out = git(cwd, ['rev-parse', '--verify', `refs/tags/${tag}`], { allowFailure: true });
  return out ? out.trim() : null;
}

export function tagMessage(cwd, tag) {
  return git(cwd, ['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`]);
}

export function createAnnotatedTag(cwd, tag, commit, message) {
  git(cwd, ['tag', '-a', tag, commit, '-F', '-'], { input: message });
}

/**
 * Push one tag atomically. `--atomic` plus a fresh ref means: if anyone else
 * pushed the same name first, this push fails and nothing else moves. That
 * failure IS the lock contention signal.
 */
export function pushNewTag(cwd, remote, tag) {
  try {
    git(cwd, ['push', '--atomic', remote, `refs/tags/${tag}:refs/tags/${tag}`]);
    return { won: true };
  } catch (error) {
    if (/already exists|rejected|fetch first|cannot lock ref/iu.test(error.stderr ?? '')) {
      return { won: false, stderr: error.stderr };
    }
    throw error;
  }
}

export function fetchTags(cwd, remote) {
  git(cwd, ['fetch', '--tags', '--prune', '--prune-tags', remote]);
}

export function fetchBranch(cwd, remote, branch) {
  git(cwd, ['fetch', remote, branch]);
}

export function commitsBetween(cwd, from, to) {
  const range = from ? `${from}..${to}` : to;
  const out = git(cwd, ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range]);
  return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [sha, subject, body] = rec.split('\x1f');
    return { sha, subject: subject ?? '', body: (body ?? '').trim() };
  });
}
