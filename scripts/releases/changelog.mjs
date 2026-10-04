// Conventional Commits → release notes. The operator reviews and edits the
// result; nobody writes a changelog from scratch.

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<desc>.+)$/u;

const SECTIONS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['ci', 'CI / release'],
  ['build', 'Build'],
  ['test', 'Tests'],
  ['chore', 'Chores'],
  ['other', 'Other'],
];

export function classify(commit) {
  const m = CONVENTIONAL.exec(commit.subject);
  const breakingInBody = /^BREAKING[ -]CHANGE:/mu.test(commit.body ?? '');
  if (!m) return { section: 'other', scope: null, desc: commit.subject, breaking: breakingInBody };
  const { type, scope, bang, desc } = m.groups;
  const breaking = Boolean(bang) || breakingInBody;
  const known = SECTIONS.some(([key]) => key === type);
  return { section: breaking ? 'breaking' : (known ? type : 'other'), scope: scope ?? null, desc, breaking };
}

export function buildNotes({ version, previous, commits, repoUrl }) {
  const buckets = Object.fromEntries(SECTIONS.map(([key]) => [key, []]));
  for (const c of commits) {
    const k = classify(c);
    const short = c.sha.slice(0, 7);
    const link = repoUrl ? `[\`${short}\`](${repoUrl}/commit/${c.sha})` : `\`${short}\``;
    const scope = k.scope ? `**${k.scope}:** ` : '';
    buckets[k.section].push(`- ${scope}${k.desc} (${link})`);
  }
  const out = [`# release-lab v${version}`, ''];
  out.push(previous
    ? `Changes since v${previous}: ${commits.length} commit${commits.length === 1 ? '' : 's'}.`
    : `First release: ${commits.length} commit${commits.length === 1 ? '' : 's'}.`);
  out.push('');
  for (const [key, title] of SECTIONS) {
    if (!buckets[key].length) continue;
    out.push(`## ${title}`, '', ...buckets[key], '');
  }
  if (repoUrl && previous) out.push(`**Full changelog:** ${repoUrl}/compare/v${previous}...v${version}`, '');
  return out.join('\n');
}

/** Minimum bump implied by the commits: breaking → major (or minor pre-1.0), feat → minor, else patch. */
export function suggestBump(commits, currentVersion) {
  let bump = 'patch';
  for (const c of commits) {
    const k = classify(c);
    if (k.breaking) return currentVersion?.startsWith('0.') ? 'minor' : 'major';
    if (k.section === 'feat') bump = 'minor';
  }
  return bump;
}
