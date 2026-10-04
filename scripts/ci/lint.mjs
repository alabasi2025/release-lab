// Minimal, dependency-free lint: no committed version other than 0.0.0, no
// secrets-looking literals, no CRLF, trailing newline present.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname, '..');
const problems = [];
const SKIP = new Set(['node_modules', 'dist', '.git', '.release-candidates']);
const TOKEN = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/u;

(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(mjs|js|json|md|yml|yaml)$/u.test(name)) continue;
    const text = readFileSync(full, 'utf8');
    const rel = path.relative(root, full);
    if (text.includes('\r\n')) problems.push(`${rel}: CRLF line endings`);
    if (text.length && !text.endsWith('\n')) problems.push(`${rel}: missing trailing newline`);
    if (TOKEN.test(text)) problems.push(`${rel}: credential-looking literal`);
  }
})(root);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== '0.0.0') problems.push('package.json: version must stay 0.0.0 (releases are stamped from the claim tag)');

if (problems.length) { for (const p of problems) console.error(`lint: ${p}`); process.exit(1); }
console.log('lint: clean');
