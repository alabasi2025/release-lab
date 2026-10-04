// The one grammar for release refs. Mirrors hermes-agent's versioning.py:
//
//   rc.<N>-vX.Y.Z            attempt ref  — a public lock; the Nth attempt to
//                                           release X.Y.Z. Never a SemVer
//                                           prerelease (it is NOT vX.Y.Z-rc.N).
//   abandoned-rc.<N>-vX.Y.Z  marker ref   — records that attempt N was given up.
//   vX.Y.Z                   receipt tag  — created at publish, never at green.
//
// None of these is a workflow trigger. All three are immutable once pushed
// (repository ruleset).

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const ATTEMPT = /^rc\.([1-9]\d*)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const ABANDONED = /^abandoned-rc\.([1-9]\d*)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const RECEIPT = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;

export function isSemVer(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

export function parseSemVer(value) {
  const m = SEMVER.exec(value ?? '');
  if (!m) throw new TypeError(`not a SemVer core version: ${value}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareSemVer(a, b) {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  return (x.major - y.major) || (x.minor - y.minor) || (x.patch - y.patch);
}

export function bumpSemVer(version, bump) {
  const v = parseSemVer(version);
  switch (bump) {
    case 'major': return `${v.major + 1}.0.0`;
    case 'minor': return `${v.major}.${v.minor + 1}.0`;
    case 'patch': return `${v.major}.${v.minor}.${v.patch + 1}`;
    default: throw new TypeError(`bump must be major|minor|patch, got ${bump}`);
  }
}

/** rc.<N>-vX.Y.Z → { attempt, version } or null. */
export function parseAttemptRef(ref) {
  const m = ATTEMPT.exec(ref ?? '');
  return m ? { attempt: Number(m[1]), version: m[2] } : null;
}

/** abandoned-rc.<N>-vX.Y.Z → { attempt, version } or null. */
export function parseAbandonedRef(ref) {
  const m = ABANDONED.exec(ref ?? '');
  return m ? { attempt: Number(m[1]), version: m[2] } : null;
}

/** vX.Y.Z → version or null. */
export function parseReceiptTag(tag) {
  const m = RECEIPT.exec(tag ?? '');
  return m ? m[1] : null;
}

export function attemptRef(attempt, version) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError(`attempt must be a positive integer, got ${attempt}`);
  parseSemVer(version);
  return `rc.${attempt}-v${version}`;
}

export function abandonedRef(attempt, version) {
  return `abandoned-${attemptRef(attempt, version)}`;
}

export function receiptTag(version) {
  parseSemVer(version);
  return `v${version}`;
}

/**
 * Given every tag name in the repository, derive the published release line.
 * Only receipt tags move the version; attempts and abandonments never do.
 */
export function latestPublished(tags) {
  let best = null;
  for (const tag of tags) {
    const v = parseReceiptTag(tag);
    if (v && (best === null || compareSemVer(v, best) > 0)) best = v;
  }
  return best;
}

/** Next attempt number for a version, from all existing attempt + abandoned refs. */
export function nextAttempt(tags, version) {
  let max = 0;
  for (const tag of tags) {
    const a = parseAttemptRef(tag) ?? parseAbandonedRef(tag);
    if (a && a.version === version) max = Math.max(max, a.attempt);
  }
  return max + 1;
}

/**
 * Outstanding attempts: an rc.N-vX.Y.Z with no matching abandoned marker and
 * no receipt vX.Y.Z yet. One outstanding attempt, of any version, blocks a
 * new cut.
 */
export function outstandingAttempts(tags) {
  const set = new Set(tags);
  const out = [];
  for (const tag of tags) {
    const a = parseAttemptRef(tag);
    if (!a) continue;
    if (set.has(abandonedRef(a.attempt, a.version))) continue;
    if (set.has(receiptTag(a.version))) continue;
    out.push({ ref: tag, ...a });
  }
  return out.sort((p, q) => compareSemVer(p.version, q.version) || (p.attempt - q.attempt));
}
