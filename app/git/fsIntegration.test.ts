/**
 * isomorphic-git, actually driven through the adapter.
 *
 * This is the test that matters most in the git layer. Everything else asserts
 * what the adapter *looks* like; this runs `init` → `add` → `commit` →
 * `statusMatrix` → `listFiles` → `log` against the real library and the real
 * adapter code, with only expo-file-system swapped for an in-memory fake.
 *
 * That combination covers the whole contract at once: the required method set
 * that `bindFs` binds unconditionally, the promise-style sniff on `readFile`,
 * the `code` on every error, and the stat fields that `normalizeStats` feeds
 * into the binary index. Each of those fails as something unrelated to its
 * cause when it is wrong, which is why they were each worth probing first.
 *
 * Brain: pages/git-fs-adapter-contract.md
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFsFrom, rootedAt } from './expoFs.ts';
import { FakeExpoFs, seedFile } from './fakeExpoFs.ts';
import { codedError, toLocalPath, type FsLike } from '../../core/git/types.ts';

const ROOT = '/doc/notes';

function setup() {
  const fake = new FakeExpoFs();
  fake.ensureParents(ROOT);
  const fs: FsLike = createFsFrom(fake, rootedAt(ROOT));
  return { fake, fs };
}

async function isomorphicGit() {
  return import('isomorphic-git');
}

test('a file:// URI is not a usable dir, which is why we pass a plain path', async () => {
  // isomorphic-git's own join() collapses `file:///a` to `file:/a`, so a URI
  // silently becomes a different path. This asserts that behaviour rather than
  // our adapter's, to keep the reason for `toLocalPath` from being folklore.
  const git = await isomorphicGit();
  const seen: string[] = [];

  const spy: FsLike = {
    async readFile() {
      return new Uint8Array();
    },
    async writeFile() {},
    async mkdir() {},
    async rmdir() {},
    async unlink() {},
    async stat(p: string) {
      seen.push(p);
      throw codedError('ENOENT', `ENOENT ${p}`);
    },
    async lstat(p: string) {
      throw codedError('ENOENT', `ENOENT ${p}`);
    },
    async readdir() {
      return [];
    },
    async readlink() {
      throw codedError('ENOSYS', 'ENOSYS');
    },
    async symlink() {
      throw codedError('ENOSYS', 'ENOSYS');
    },
  };

  await git.init({ fs: spy, dir: `file://${ROOT}`, defaultBranch: 'main' }).catch(() => undefined);

  assert.ok(
    seen.some((p) => p.startsWith('file:/') && !p.startsWith('file://')),
    `expected a collapsed single-slash URI, saw: ${seen[0]}`,
  );
  assert.equal(toLocalPath(`file://${ROOT}`), ROOT);
});

test('init creates a repository with the requested default branch', async () => {
  const git = await isomorphicGit();
  const { fs } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });

  const head = await fs.readFile(`${ROOT}/.git/HEAD`, { encoding: 'utf8' });
  assert.equal(head, 'ref: refs/heads/main\n');
});

test('a full commit cycle works, and the blob round-trips', async () => {
  const git = await isomorphicGit();
  const { fs, fake } = setup();
  const content = '# 笔记\n\n第一段。\n';

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/note.md`, content);

  await git.add({ fs, dir: ROOT, filepath: 'note.md' });
  const oid = await git.commit({
    fs,
    dir: ROOT,
    message: 'first note',
    author: { name: 'tester', email: 'tester@example.com' },
  });

  assert.match(oid, /^[0-9a-f]{40}$/);

  const { blob } = await git.readBlob({ fs, dir: ROOT, oid, filepath: 'note.md' });
  assert.equal(new TextDecoder().decode(blob), content);

  const files = await git.listFiles({ fs, dir: ROOT, ref: 'HEAD' });
  assert.deepEqual(files, ['note.md']);
});

test('statusMatrix reports a clean tree after a commit', async () => {
  // This is where the `.` path and the readdir shape both get exercised:
  // GitWalkerFs recurses the working tree, then hands `dir + '/' + '.'` to
  // lstat. An adapter that does not normalise dies here with
  // `ENOENT: lstat '.'`.
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/note.md`, 'x\n');
  await git.add({ fs, dir: ROOT, filepath: 'note.md' });
  await git.commit({ fs, dir: ROOT, message: 'c', author: { name: 't', email: 't@e' } });

  assert.deepEqual(await git.statusMatrix({ fs, dir: ROOT }), [['note.md', 1, 1, 1]]);
});

test('statusMatrix sees an edited file as modified', async () => {
  // Proves the stat fields are coherent: a wrong mtime or size would make an
  // unchanged file look dirty, or a changed one look clean.
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/note.md`, 'x\n');
  await git.add({ fs, dir: ROOT, filepath: 'note.md' });
  await git.commit({ fs, dir: ROOT, message: 'c', author: { name: 't', email: 't@e' } });

  seedFile(fake, `${ROOT}/note.md`, 'x\ny\n');
  fake.mtimes.set(`${ROOT}/note.md`, 1_700_000_001_000);

  assert.deepEqual(await git.statusMatrix({ fs, dir: ROOT }), [['note.md', 1, 2, 1]]);
});

test('nested directories are walked, which is how note folders work', async () => {
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/projects/alpha.md`, 'a\n');
  seedFile(fake, `${ROOT}/projects/beta.md`, 'b\n');
  seedFile(fake, `${ROOT}/top.md`, 't\n');

  await git.add({ fs, dir: ROOT, filepath: '.' });
  const oid = await git.commit({ fs, dir: ROOT, message: 'nested', author: { name: 't', email: 't@e' } });

  assert.deepEqual(
    (await git.listFiles({ fs, dir: ROOT, ref: oid })).sort(),
    ['projects/alpha.md', 'projects/beta.md', 'top.md'],
  );
});

test('deleting a file is seen as a deletion', async () => {
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/gone.md`, 'x\n');
  await git.add({ fs, dir: ROOT, filepath: '.' });
  await git.commit({ fs, dir: ROOT, message: 'c', author: { name: 't', email: 't@e' } });

  await fs.unlink(`${ROOT}/gone.md`);
  const matrix = await git.statusMatrix({ fs, dir: ROOT });
  assert.deepEqual(matrix, [['gone.md', 1, 0, 1]]);
});

test('the index survives a round trip through writeFile', async () => {
  // The index is written as binary with `% MAX_UINT32` applied to every stat
  // field. A NaN here writes garbage rather than raising, so the assertion is
  // that reading it back still yields a usable index.
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/a.md`, 'a\n');
  await git.add({ fs, dir: ROOT, filepath: 'a.md' });
  await git.commit({ fs, dir: ROOT, message: 'c', author: { name: 't', email: 't@e' } });

  const index = await fs.readFile(`${ROOT}/.git/index`);
  assert.ok(index instanceof Uint8Array && index.byteLength > 0);

  // And the commit it points at is still readable, which it would not be if a
  // NaN had been written into the index.
  const oid = await git.resolveRef({ fs, dir: ROOT, ref: 'HEAD' });
  const { commit } = await git.readCommit({ fs, dir: ROOT, oid });
  assert.equal(commit.message.trim(), 'c');
});

test('log reads back the commit history', async () => {
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/a.md`, 'a\n');
  await git.add({ fs, dir: ROOT, filepath: '.' });
  await git.commit({ fs, dir: ROOT, message: 'first', author: { name: 't', email: 't@e' } });

  seedFile(fake, `${ROOT}/b.md`, 'b\n');
  await git.add({ fs, dir: ROOT, filepath: '.' });
  await git.commit({ fs, dir: ROOT, message: 'second', author: { name: 't', email: 't@e' } });

  const history = await git.log({ fs, dir: ROOT });
  assert.deepEqual(
    history.map((c) => c.commit.message.trim()),
    ['second', 'first'],
  );
});

test('a ref outside refs/ can be written, which is how sync-base is recorded', async () => {
  // `refs/mark/sync-base` is the whole basis of the next three-way merge: it
  // must survive being written and read back by name.
  const git = await isomorphicGit();
  const { fs, fake } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  seedFile(fake, `${ROOT}/a.md`, 'a\n');
  await git.add({ fs, dir: ROOT, filepath: '.' });
  const oid = await git.commit({ fs, dir: ROOT, message: 'c', author: { name: 't', email: 't@e' } });

  await git.writeRef({ fs, dir: ROOT, ref: 'refs/mark/sync-base', value: oid, force: true });
  assert.equal(await git.resolveRef({ fs, dir: ROOT, ref: 'refs/mark/sync-base' }), oid);

  // A ref that was never written must read as absent, not as a crash.
  await assert.rejects(() => git.resolveRef({ fs, dir: ROOT, ref: 'refs/mark/never' }));
});

test('addRemote records the remote url without contacting it', async () => {
  const git = await isomorphicGit();
  const { fs } = setup();

  await git.init({ fs, dir: ROOT, defaultBranch: 'main' });
  await git.addRemote({ fs, dir: ROOT, remote: 'origin', url: 'https://github.com/o/r.git' });

  const config = await fs.readFile(`${ROOT}/.git/config`, { encoding: 'utf8' });
  assert.match(String(config), /github\.com\/o\/r\.git/);
});