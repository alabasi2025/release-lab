// A deliberately tiny application: enough surface to build, test, and stamp.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Reads the stamped version written by the release build, or 0.0.0 in a source checkout. */
export function version() {
  try {
    return JSON.parse(readFileSync(path.join(here, 'stamp.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export function greet(name = 'world') {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('name must be a non-empty string');
  return `hello, ${name.trim()}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log(`${greet(process.argv[2])} (release-lab ${version()})`);
}
