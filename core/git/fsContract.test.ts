/**
 * The parts of the fs adapter that do not need a device.
 *
 * The adapter itself is untestable in CI, so everything that can be pulled out
 * is pulled out and asserted here: the path conversions (which isomorphic-git
 * gets wrong for us) and the stat shape (whose absence corrupts the index
 * silently rather than throwing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toLocalPath,
  toFileUri,
  codedError,
  inodeFor,
  MODE_DIR,
  MODE_FILE,
  type StatLike,
} from './types.ts';

// ---------------------------------------------------------------------------
// toLocalPath
// ---------------------------------------------------------------------------

test('a file:// URI loses its scheme', () => {
  // isomorphic-git's join() collapses `file:///a` to `file:/a`, which is why
  // `dir` must never be a URI in the first place.
  assert.equal(toLocalPath('file:///data/user/0/app/files/notes'), '/data/user/0/app/files/notes');
});

test('a plain path passes through unchanged', () => {
  assert.equal(toLocalPath('/a/b/c'), '/a/b/c');
});

test('a trailing /. is collapsed', () => {
  // GitWalkerFs builds `${dir}/${filepath}` with filepath === '.', which is
  // what makes an unnormalised adapter fail with `ENOENT: lstat '.'`.
  assert.equal(toLocalPath('/data/notes/.'), '/data/notes');
});

test('repeated slashes collapse', () => {
  assert.equal(toLocalPath('/a//b///c'), '/a/b/c');
});

test('.. is resolved, not passed through', () => {
  assert.equal(toLocalPath('/a/b/../c'), '/a/c');
  assert.equal(toLocalPath('/a/b/./../c'), '/a/c');
});

test('a leading .. cannot escape the root', () => {
  assert.equal(toLocalPath('/../..'), '/');
});

test('the path joining the repo and the walker root is stable', () => {
  const dir = toLocalPath('file:///data/user/0/app/files/notes');
  assert.equal(toLocalPath(`${dir}/.`), dir);
  assert.equal(toLocalPath(`${dir}/.git/config`), `${dir}/.git/config`);
});

// ---------------------------------------------------------------------------
// toFileUri
// ---------------------------------------------------------------------------

test('an absolute path becomes a three-slash URI', () => {
  assert.equal(toFileUri('/data/notes'), 'file:///data/notes');
});

test('toFileUri undoes toLocalPath', () => {
  const local = '/data/user/0/app/files/notes';
  assert.equal(toLocalPath(toFileUri(local)), local);
});

// ---------------------------------------------------------------------------
// codedError
// ---------------------------------------------------------------------------

test('an error carries the code isomorphic-git branches on', () => {
  // Without `code`, `FileSystem.exists` cannot tell a missing path from a real
  // failure and rethrows instead of returning false.
  const err = codedError('ENOENT', 'no such file');
  assert.equal(err.code, 'ENOENT');
  assert.match(err.message, /no such file/);
});

// ---------------------------------------------------------------------------
// inodeFor
// ---------------------------------------------------------------------------

test('an inode is stable for a path', () => {
  assert.equal(inodeFor('/a/b.md'), inodeFor('/a/b.md'));
});

test('different paths get different inodes', () => {
  assert.notEqual(inodeFor('/a/b.md'), inodeFor('/a/c.md'));
});

test('an inode fits in 32 bits and is never zero', () => {
  for (const p of ['/', '/a', '', '/very/deeply/nested/path/file.md']) {
    const ino = inodeFor(p);
    assert.ok(Number.isInteger(ino) && ino > 0 && ino <= 0xffffffff, `${p} -> ${ino}`);
  }
});

// ---------------------------------------------------------------------------
// stat shape, checked against isomorphic-git's own normalisation
// ---------------------------------------------------------------------------

/**
 * isomorphic-git's `normalizeStats`, transcribed.
 *
 * Copied rather than imported because the point of these tests is that our stat
 * shape satisfies it. Reimplementing the consumer is what makes a change to the
 * expected shape fail here instead of corrupting a real index.
 */
function normalizeStats(e: StatLike) {
  const MAX = 2 ** 32;
  return {
    dev: e.dev % MAX,
    ino: e.ino % MAX,
    mode: e.mode % MAX,
    uid: e.uid % MAX,
    gid: e.gid % MAX,
    size: (e.size > -1 ? e.size % MAX : 0),
    mtimeMs: e.mtimeMs % MAX,
    ctimeMs: e.ctimeMs % MAX,
  };
}

function statOf(mode: number, size: number): StatLike {
  return {
    dev: 1,
    ino: inodeFor(`/x/${mode}`),
    mode,
    uid: 0,
    gid: 0,
    size,
    mtimeMs: 1700000000000,
    ctimeMs: 1700000000000,
    isDirectory: () => mode === MODE_DIR,
    isFile: () => mode === MODE_FILE,
    isSymbolicLink: () => false,
  };
}

test('every normalised field is a real integer, not NaN', () => {
  // An undefined field becomes NaN here and is then written to the binary
  // index. This is the assertion that would catch a stat missing a field.
  const n = normalizeStats(statOf(MODE_FILE, 42));
  for (const [key, value] of Object.entries(n)) {
    assert.ok(Number.isInteger(value), `${key} is ${value}`);
  }
});

test('a file stat normalises to a git blob mode', () => {
  assert.equal(normalizeStats(statOf(MODE_FILE, 0)).mode, 0o100644);
});

test('a directory stat normalises to a git tree mode', () => {
  assert.equal(normalizeStats(statOf(MODE_DIR, 0)).mode, 0o40000);
});

test('mtime survives the round trip, so a stale index is detectable', () => {
  const a = normalizeStats(statOf(MODE_FILE, 10));
  const later = { ...statOf(MODE_FILE, 10), mtimeMs: 1700000001000 };
  assert.notEqual(a.mtimeMs, normalizeStats(later).mtimeMs);
});
