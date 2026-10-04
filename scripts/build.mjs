// Deterministic build: copies app/ into dist/, stamps the version supplied by
// the release pipeline (RELEASE_VERSION) or 0.0.0, and writes a manifest with
// SHA-256 per file so the same bytes can be verified at publish time.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dist = path.join(root, 'dist');
const version = process.env.RELEASE_VERSION ?? '0.0.0';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`RELEASE_VERSION must be X.Y.Z, got ${version}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(path.join(root, 'app'), path.join(dist, 'app'), {
  recursive: true,
  filter: (src) => !src.endsWith('.test.mjs'),
});
writeFileSync(path.join(dist, 'app', 'stamp.json'), JSON.stringify({
  version,
  sourceGitSha: process.env.RELEASE_SOURCE_SHA ?? null,
  claimTag: process.env.RELEASE_CLAIM_TAG ?? null,
}, null, 2) + '\n');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(path.join(dist, 'app'));

const manifest = {
  schemaVersion: 1,
  version,
  files: files.map((file) => ({
    path: path.relative(dist, file).split(path.sep).join('/'),
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  })),
};
writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`built release-lab ${version}: ${manifest.files.length} files -> dist/`);
