/**
 * The fs adapter, driven against a fake expo-file-system.
 *
 * This is not a substitute for running on a device — the fake cannot tell us
 * whether expo really accepts a `file://` URI built from a path with a trailing
 * `/.` in it. What it does verify is that the adapter reports the codes and
 * shapes isomorphic-git branches on, which is where the silent failures live.
 *
 * Brain: pages/git-fs-adapter-contract.md
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFsFrom, rootedAt, type ExpoFsApi } from './expoFs.ts';
import { FakeExpoFs, seedFile } from './fakeExpoFs.ts';
import { toLocalPath, MODE_DIR, MODE_FILE, type FsLike } from '../../core/git/types.ts';

function setup() {
  const fake = new FakeExpoFs();
  const root = '/root';
  // The document directory exists before any git call, as it does on device.
  fake.ensureParents(root);
  const fs: FsLike = createFsFrom(fake, rootedAt(root));
  return { fake, fs, root };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test('a path with a trailing /. resolves to the directory', async () => {
  // GitWalkerFs builds `${dir}/${filepath}` with filepath === '.'.
  const { fs } = setup();
  const stat = await fs.stat('/.');
  assert.equal(stat.isDirectory(), true);
});

test('the file:// scheme appears only at the expo boundary', async () => {
  const fake = new FakeExpoFs();
  const seen: string[] = [];
  const spy: ExpoFsApi = {
    fileOf: (p) => {
      seen.push(p);
      return fake.fileOf(p);
    },
    directoryOf: (p) => {
      seen.push(p);
      return fake.directoryOf(p);
    },
  };
  const fs = createFsFrom(spy, rootedAt('/root'));
  fake.ensureParents('/root');
  await fs.stat('/');
  assert.ok(
    seen.every((p) => p.startsWith('/') && !p.includes('file://')),
    `expo saw non-plain paths: ${seen.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

test('readFile returns bytes by default', async () => {
  const { fs, fake } = setup();
  seedFile(fake, '/root/a.md', '# hi\n');
  assert.deepEqual(await fs.readFile('a.md'), new TextEncoder().encode('# hi\n'));
});

test('readFile honours encoding utf8', async () => {
  const { fs, fake } = setup();
  seedFile(fake, '/root/a.md', '# hi\n');
  assert.equal(await fs.readFile('a.md', { encoding: 'utf8' }), '# hi\n');
});

test('a missing file is ENOENT, not a crash', async () => {
  // isomorphic-git's readdir turns ENOENT into an empty list; without a code it
  // would propagate as a genuine failure.
  const { fs } = setup();
  assert.equal(await codeOf(() => fs.readFile('nope.md')), 'ENOENT');
});

test('readFile with no arguments returns a promise instead of throwing', async () => {
  // isomorphic-git sniffs promise-style fs by calling readFile() bare. A
  // synchronous throw here makes it wrap every method in pify and then fail
  // with a stack trace that names pify rather than the cause.
  const { fs } = setup();
  let threw = false;
  let probe: Promise<unknown>;
  try {
    // Deliberately malformed: the signature says `path` is required, because
    // every real caller passes one. The library's probe is the exception, and
    // the adapter has to survive it.
    probe = (fs.readFile as () => Promise<unknown>)().then(
      () => undefined,
      () => undefined,
    );
  } catch {
    threw = true;
    probe = Promise.resolve();
  }
  assert.equal(threw, false, 'readFile() must not throw synchronously');
  await probe;
});

// ---------------------------------------------------------------------------
// writeFile / mkdir / rmdir / unlink
// ---------------------------------------------------------------------------

test('writeFile creates missing parent directories', async () => {
  // isomorphic-git writes `objects/ab/cdef…`; its mkdirp only creates the
  // two-level prefix it asked about.
  const { fs, fake } = setup();
  await fs.writeFile('objects/ab/cdef0123', new Uint8Array([1]));
  assert.ok(fake.files.has('/root/objects/ab/cdef0123'));
});

test('mkdir on an existing directory reports EEXIST', async () => {
  // isomorphic-git's mkdirp swallows EEXIST and treats any other code as fatal,
  // so this exact string matters.
  const { fs, fake } = setup();
  fake.ensureParents('/root/objects');
  assert.equal(await codeOf(() => fs.mkdir('objects')), 'EEXIST');
});

test('mkdir creates a fresh directory', async () => {
  const { fs, fake } = setup();
  await fs.mkdir('objects/pack');
  assert.ok(fake.dirs.has('/root/objects/pack'));
});

test('rmdir with recursive removes the whole tree', async () => {
  const { fs, fake } = setup();
  fake.ensureParents('/root/a/b');
  seedFile(fake, '/root/a/b/c', 'x');
  await fs.rmdir('a', { recursive: true });
  assert.equal(fake.dirs.has('/root/a'), false);
  assert.equal(fake.files.has('/root/a/b/c'), false);
});

test('rmdir without recursive refuses a non-empty directory', async () => {
  const { fs, fake } = setup();
  fake.ensureParents('/root/a');
  seedFile(fake, '/root/a/c', 'x');
  assert.equal(await codeOf(() => fs.rmdir('a')), 'ENOTEMPTY');
});

test('rmdir on a missing directory is a no-op', async () => {
  // isomorphic-git's rmdir wrapper swallows ENOENT itself, but a note app that
  // asks to remove a folder another device already removed should not fail.
  const { fs } = setup();
  await fs.rmdir('gone');
});

test('unlink reports ENOENT for a missing file', async () => {
  const { fs } = setup();
  assert.equal(await codeOf(() => fs.unlink('gone.md')), 'ENOENT');
});

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

test('a file stat reports blob mode and its real size', async () => {
  const { fs, fake } = setup();
  seedFile(fake, '/root/a.md', 'hello');
  const stat = await fs.stat('a.md');
  assert.equal(stat.mode, MODE_FILE);
  assert.equal(stat.size, 5);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isDirectory(), false);
});

test('a directory stat reports tree mode', async () => {
  const { fs, fake } = setup();
  fake.ensureParents('/root/sub');
  const stat = await fs.stat('sub');
  assert.equal(stat.mode, MODE_DIR);
  assert.equal(stat.isDirectory(), true);
});

test('every numeric stat field is a real number', async () => {
  // An undefined becomes NaN in isomorphic-git's normalizeStats and is then
  // written into the binary index — corruption, not an error.
  const { fs, fake } = setup();
  seedFile(fake, '/root/a.md', 'abc');
  const stat = await fs.stat('a.md');
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs'] as const) {
    assert.ok(Number.isFinite(stat[key]), `${key} is ${stat[key]}`);
  }
});

test('the inode is stable across calls, so an unmodified file is not restaged', async () => {
  const { fs, fake } = setup();
  seedFile(fake, '/root/a.md', 'a');
  assert.equal((await fs.stat('a.md')).ino, (await fs.lstat('a.md')).ino);
});

test('a missing path is ENOENT', async () => {
  const { fs } = setup();
  assert.equal(await codeOf(() => fs.stat('nope.md')), 'ENOENT');
  assert.equal(await codeOf(() => fs.lstat('nope.md')), 'ENOENT');
});

// ---------------------------------------------------------------------------
// readdir
// ---------------------------------------------------------------------------

test('readdir returns bare names, not expo objects', async () => {
  // expo's Directory.list() returns File/Directory instances; isomorphic-git
  // expects string[] and calls `.sort()` on it.
  const { fs, fake } = setup();
  seedFile(fake, '/root/a.md', 'a');
  fake.ensureParents('/root/sub');
  assert.deepEqual((await fs.readdir('.')).sort(), ['a.md', 'sub']);
});

test('readdir of a missing directory is ENOENT', async () => {
  const { fs } = setup();
  assert.equal(await codeOf(() => fs.readdir('gone')), 'ENOENT');
});

// ---------------------------------------------------------------------------
// symlinks
// ---------------------------------------------------------------------------

test('readlink and symlink report ENOSYS rather than pretending', async () => {
  // isomorphic-git's own init writes `core.symlinks = false`, so this is
  // unreachable for a repo we created — but not for one whose notes contain a
  // link someone else's tool added.
  const { fs } = setup();
  assert.equal(await codeOf(() => fs.readlink('link')), 'ENOSYS');
  assert.equal(await codeOf(() => fs.symlink('a', 'link')), 'ENOSYS');
});

// ---------------------------------------------------------------------------
// The whole contract, as isomorphic-git binds it
// ---------------------------------------------------------------------------

test('every method isomorphic-git binds is present and returns a promise', async () => {
  // bindFs calls `.bind()` on each of these unconditionally, so a missing one
  // throws on the first git call rather than at construction.
  const { fs } = setup();
  const required = [
    'readFile',
    'writeFile',
    'mkdir',
    'rmdir',
    'unlink',
    'stat',
    'lstat',
    'readdir',
    'readlink',
    'symlink',
  ] as const;

  for (const name of required) {
    assert.equal(typeof fs[name], 'function', `${name} is missing`);
    assert.equal(typeof (fs[name] as { bind?: unknown }).bind, 'function', `${name} cannot be bound`);
  }

  for (const name of required) {
    const call = () => (fs[name] as (...a: never[]) => Promise<unknown>)('/probe/nope' as never);
    let result: Promise<unknown> | undefined;
    try {
      result = call();
    } catch {
      assert.fail(`${name} threw synchronously; isomorphic-git would then treat the whole fs as callback-style`);
    }
    assert.ok(result !== undefined, `${name} returned nothing`);
    assert.equal(typeof result.then, 'function', `${name} did not return a promise`);
    // Rejecting is expected for a missing path. What matters is that it
    // rejected rather than threw.
    await result.then(
      () => undefined,
      () => undefined,
    );
  }
});
