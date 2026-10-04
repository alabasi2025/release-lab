// The claim is the annotated tag message of an attempt ref. It binds, in one
// immutable object, everything a release run is allowed to know about itself.
// `admit` re-reads it from the remote object and refuses any drift.
//
// Flags live here, never as workflow inputs, so a recovery rerun cannot change
// them. To change a flag: abandon and cut again.

export const CLAIM_SCHEMA = 1;

export function formatClaim(claim) {
  validateClaim(claim);
  const lines = [
    `release-lab claim v${CLAIM_SCHEMA}`,
    '',
    `version: ${claim.version}`,
    `attempt: ${claim.attempt}`,
    `commit: ${claim.commit}`,
    `epoch: ${claim.epoch}`,
    `autopublish: ${claim.autopublish ? 'true' : 'false'}`,
    `skipTests: ${claim.skipTests ? 'true' : 'false'}`,
    `cutBy: ${claim.cutBy}`,
  ];
  return lines.join('\n') + '\n';
}

export function parseClaim(message) {
  const lines = (message ?? '').replace(/\r\n/g, '\n').split('\n');
  const header = /^release-lab claim v(\d+)$/u.exec(lines[0] ?? '');
  if (!header) throw new Error('not a release-lab claim: missing header');
  if (Number(header[1]) !== CLAIM_SCHEMA) throw new Error(`unsupported claim schema v${header[1]}`);
  const fields = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z]+): (.*)$/u.exec(line);
    if (!m) throw new Error(`malformed claim line: ${line}`);
    if (m[1] in fields) throw new Error(`duplicate claim field: ${m[1]}`);
    fields[m[1]] = m[2];
  }
  const claim = {
    version: fields.version,
    attempt: Number(fields.attempt),
    commit: fields.commit,
    epoch: fields.epoch,
    autopublish: fields.autopublish === 'true',
    skipTests: fields.skipTests === 'true',
    cutBy: fields.cutBy,
  };
  validateClaim(claim);
  return claim;
}

export function validateClaim(c) {
  if (!/^\d+\.\d+\.\d+$/u.test(c.version ?? '')) throw new Error(`claim.version invalid: ${c.version}`);
  if (!Number.isInteger(c.attempt) || c.attempt < 1) throw new Error(`claim.attempt invalid: ${c.attempt}`);
  if (!/^[0-9a-f]{40}$/u.test(c.commit ?? '')) throw new Error(`claim.commit invalid: ${c.commit}`);
  if (!/^\d{8}T\d{6}Z$/u.test(c.epoch ?? '')) throw new Error(`claim.epoch invalid: ${c.epoch}`);
  if (typeof c.autopublish !== 'boolean') throw new Error('claim.autopublish must be boolean');
  if (typeof c.skipTests !== 'boolean') throw new Error('claim.skipTests must be boolean');
  if (!c.cutBy || /\s/u.test(c.cutBy)) throw new Error(`claim.cutBy invalid: ${c.cutBy}`);
}

/** Monotonic UTC stamp, second precision: 20261004T231500Z */
export function epochNow(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
