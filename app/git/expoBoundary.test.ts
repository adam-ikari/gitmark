/**
 * The expo boundary, enforced.
 *
 * Two bugs lived here at once, and both were invisible to `tsc`:
 *
 * 1. `expoFs.ts` called `file.modifiedAt()`, which expo's `File` does not have.
 *    Every `stat()` would have thrown on a device, breaking sync completely,
 *    while typecheck stayed green — because the result was cast with
 *    `as unknown as FileLike`.
 * 2. Four modules each opened their own `File`, and two of them passed a bare
 *    POSIX path to a constructor that wants a `file://` URI.
 *
 * Neither is reachable from a Node test, so these assertions are about the
 * *shape* of the code rather than its runtime behaviour. The real guarantee is
 * the absence of casts, asserted below by scanning the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { toFileUri, toLocalPath } from '../../core/git/types.ts';

const APP_DIR = new URL('../', import.meta.url).pathname;

/** Strip comments, so prose about a past cast is not read as a present one. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every source file under app/, excluding tests. */
function appSources(dir = APP_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      appSources(full, found);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

test('no source file casts away the expo types', () => {
  // The cast is what let a missing method pass review and pass typecheck. Its
  // return is the cheapest regression guard available without a device.
  const offenders = appSources().filter((file) => codeOf(file).includes('as unknown as'));
  assert.deepEqual(offenders, [], 'these files cast instead of type-checking against expo');
});

test('expo-file-system is constructed in exactly one place', () => {
  // Four copies meant four chances to get the path form wrong, and two did.
  const constructors = appSources().filter((file) => /new (File|Directory)\(/.test(codeOf(file)));
  assert.deepEqual(
    constructors.map((f) => f.slice(APP_DIR.length)),
    ['git/expoFs.ts'],
  );
});

test('the adapter type-checks against the real expo classes', () => {
  // `expoApi` assigns `new File(...)` and `new Directory(...)` to `FileLike` and
  // `DirectoryLike` with no cast. This test cannot reproduce that assignment, but
  // it can state the requirement, and `pnpm typecheck` in CI is what enforces it.
  const source = codeOf(join(APP_DIR, 'git/expoFs.ts'));
  assert.ok(
    /fileOf: \(p\) => new File\(/.test(source),
    'expoApi must construct File without a cast, so tsc verifies the surface',
  );
  assert.ok(/directoryOf: \(p\) => new Directory\(/.test(source));
});

test('the modification time comes from info(), which is what expo exposes', () => {
  // expo's File has no `modifiedAt()`. The documented source is
  // `info().modificationTime`, which may be absent, hence the `?? 0` — a NaN
  // would reach isomorphic-git's normalizeStats and corrupt the binary index.
  const source = codeOf(join(APP_DIR, 'git/expoFs.ts'));
  assert.ok(!source.includes('modifiedAt'), 'expo File has no modifiedAt(); do not call it');
  assert.match(source, /info\(\)\.modificationTime \?\? 0/);
});

test('the adapter reads the modification time through the shared interface', () => {
  const source = codeOf(join(APP_DIR, 'git/expoFs.ts'));
  assert.match(source, /info\(\): \{ modificationTime\?: number \}/);
});

// ---------------------------------------------------------------------------
// The path contract that the bugs above violated
// ---------------------------------------------------------------------------

test('a path is turned into a URI before reaching expo', () => {
  // Every constructor in the codebase takes a path and adds the scheme itself.
  assert.equal(toFileUri('/data/notes'), 'file:///data/notes');
});

test('expo may hand us a URI already, and it survives', () => {
  assert.equal(toFileUri('file:///data/notes'), 'file:///data/notes');
});

test('a path and its URI are interchangeable at the boundary', () => {
  const path = '/data/user/0/app/files/repo';
  assert.equal(toLocalPath(toFileUri(path)), path);
  assert.equal(toFileUri(toLocalPath(toFileUri(path))), toFileUri(path));
});