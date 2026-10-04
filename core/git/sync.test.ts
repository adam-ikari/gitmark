import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNote, readMeta, firstLine, type TriVersion, type MergeOutcome } from './store.ts';
import {
  planSync,
  canProceed,
  phaseAfterPlan,
  applyPlan,
  touchedPaths,
  describePlan,
  type SyncPlan,
} from './sync.ts';
import type { NoteStore } from './store.ts';

// ---------------------------------------------------------------------------
// resolveNote
// ---------------------------------------------------------------------------

/** Merged content when the outcome was clean, else null. */
function contentOf(r: MergeOutcome): string | null {
  return r.kind === 'clean' ? r.content : null;
}

const v = (base: string | null, local: string | null, remote: string | null): TriVersion => ({
  base,
  local,
  remote,
});

test('unchanged when all three match', () => {
  assert.deepEqual(resolveNote(v('a', 'a', 'a')), { kind: 'unchanged' });
});

test('adopts a remote-only change', () => {
  const r = resolveNote(v('a', 'a', 'R'));
  assert.equal(r.kind, 'clean');
  assert.equal(contentOf(r), 'R');
});

test('keeps a local-only change', () => {
  const r = resolveNote(v('a', 'L', 'a'));
  assert.equal(contentOf(r), 'L');
});

test('merges disjoint changes', () => {
  const r = resolveNote(v('a\nb\nc', 'A\nb\nc', 'a\nb\nC'));
  assert.equal(contentOf(r), 'A\nb\nC');
});

test('reports a conflict on the same line', () => {
  const r = resolveNote(v('a\nb', 'a\nL', 'a\nR'));
  assert.equal(r.kind, 'conflict');
  assert.equal(r.kind === 'conflict' && r.result.conflicts.length, 1);
});

test('a new file on both sides is treated as a merge from empty', () => {
  // base is null, so both sides "added" the file. merge3 sees an empty base and
  // two competing versions, which is a genuine conflict.
  const r = resolveNote(v(null, 'a\nL', 'a\nR'));
  assert.equal(r.kind, 'conflict');
});

test('a new file with identical content on both sides merges cleanly', () => {
  const r = resolveNote(v(null, 'same', 'same'));
  assert.equal(r.kind, 'clean');
  assert.equal(r.kind === 'clean' ? r.content : null, 'same');
});

test('two people creating the same new note differently is a conflict', () => {
  const r = resolveNote(v(null, 'a', 'a\nb'));
  assert.equal(r.kind, 'conflict');
});

test('two people creating the same new note identically merges cleanly', () => {
  const r = resolveNote(v(null, 'a\nb', 'a\nb'));
  assert.equal(r.kind, 'clean');
  assert.equal(contentOf(r), 'a\nb');
});

test('a new file on one side is adopted', () => {
  const r = resolveNote(v(null, 'fresh', null));
  assert.equal(contentOf(r), 'fresh');
});

test('a new file on the remote side is adopted', () => {
  const r = resolveNote(v(null, null, 'fresh'));
  assert.equal(contentOf(r), 'fresh');
});

test('both deleted is a clean delete', () => {
  const r = resolveNote(v('a', null, null));
  assert.equal(r.kind, 'clean');
  assert.equal(contentOf(r), '', 'a delete is modelled as an empty write');
  assert.equal((r as { kind: string; changed: boolean }).changed, true);
});

test('nothing anywhere is unchanged', () => {
  assert.deepEqual(resolveNote(v(null, null, null)), { kind: 'unchanged' });
});

test('delete versus modify escalates rather than picking a side', () => {
  const r = resolveNote(v('a\nb', 'a\nb', null));
  assert.equal(r.kind, 'delete-modify');
  assert.equal(r.kind === 'delete-modify' && r.winner, 'conflict');
});

test('modify versus delete escalates too', () => {
  const r = resolveNote(v('a\nb', null, 'a\nb'));
  assert.equal(r.kind, 'delete-modify');
});

test('delete versus edit escalates', () => {
  const r = resolveNote(v('a\nb\nc', 'a\nd\nc', null));
  assert.equal(r.kind, 'delete-modify');
});

// ---------------------------------------------------------------------------
// planSync
// ---------------------------------------------------------------------------

test('a clean plan collects writes', () => {
  const plan = planSync([['a.md', v('x', 'x', 'R')]]);
  assert.deepEqual(plan.writes, [{ path: 'a.md', content: 'R' }]);
  assert.equal(plan.conflicts.length, 0);
});

test('a delete is planned as a delete, not an empty write', () => {
  const plan = planSync([['a.md', v('x', null, null)]]);
  assert.deepEqual(plan.deletes, ['a.md']);
  assert.deepEqual(plan.writes, []);
});

test('conflicts are collected per region, with both sides', () => {
  const plan = planSync([['a.md', v('a\nb\nc', 'a\nL\nc', 'a\nR\nc')]]);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0], {
    path: 'a.md',
    line: 1,
    local: ['L'],
    remote: ['R'],
    base: ['b'],
  });
});

test('multiple conflicts across files are all collected', () => {
  const plan = planSync([
    ['a.md', v('x', 'L', 'R')],
    ['b.md', v('y', 'M', 'N')],
  ]);
  assert.equal(plan.conflicts.length, 2);
  assert.deepEqual(plan.conflicts.map((c) => c.path), ['a.md', 'b.md']);
});

test('a conflicted file yields no write', () => {
  const plan = planSync([['a.md', v('x', 'L', 'R')]]);
  assert.deepEqual(plan.writes, []);
});

test('a delete-modify appears as a conflict', () => {
  const plan = planSync([['a.md', v('x\ny', 'x\ny', null)]]);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0]!.base, ['x', 'y']);
});

test('clean and conflicted files coexist in one plan', () => {
  const plan = planSync([
    ['clean.md', v('a', 'a', 'R')],
    ['bad.md', v('b', 'L', 'R')],
  ]);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.conflicts.length, 1);
});

// ---------------------------------------------------------------------------
// The stop-on-conflict rule
// ---------------------------------------------------------------------------

test('a conflicted plan may not proceed', () => {
  const plan = planSync([['a.md', v('x', 'L', 'R')]]);
  assert.equal(canProceed(plan), false);
  assert.equal(phaseAfterPlan(plan), 'conflicted');
});

test('a clean plan proceeds to push', () => {
  const plan = planSync([['a.md', v('x', 'x', 'R')]]);
  assert.equal(canProceed(plan), true);
  assert.equal(phaseAfterPlan(plan), 'pushing');
});

test('one conflict blocks the whole sync, even with clean files present', () => {
  // This is the property that matters: a single unresolved file must not be
  // pushed while the rest is committed, because the commit would contain
  // half-merged content.
  const plan = planSync([
    ['a.md', v('x', 'x', 'R')],
    ['b.md', v('y', 'L', 'N')],
  ]);
  assert.equal(canProceed(plan), false);
  assert.equal(plan.writes.length, 1, 'the clean file is still planned');
});

// ---------------------------------------------------------------------------
// applyPlan
// ---------------------------------------------------------------------------

class FakeStore implements NoteStore {
  files = new Map<string, string>();
  writes: string[] = [];
  removals: string[] = [];

  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
    this.writes.push(path);
  }
  async remove(path: string) {
    this.files.delete(path);
    this.removals.push(path);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async list() {
    return [...this.files.keys()];
  }
}

test('applyPlan writes and removes', async () => {
  const store = new FakeStore();
  store.files.set('gone.md', 'x');
  const plan: SyncPlan = {
    writes: [{ path: 'new.md', content: 'body' }],
    deletes: ['gone.md'],
    conflicts: [],
  };
  await applyPlan(store, plan);
  assert.equal(store.files.get('new.md'), 'body');
  assert.equal(store.files.has('gone.md'), false);
});

test('applyPlan leaves conflicted files untouched in the working tree', async () => {
  // The editor must keep showing the user's own text while they decide.
  const store = new FakeStore();
  store.files.set('bad.md', 'mine');
  const plan = planSync([['bad.md', v('x', 'mine', 'theirs')]]);
  await applyPlan(store, plan);
  assert.equal(store.files.get('bad.md'), 'mine');
  assert.deepEqual(store.writes, []);
});

test('touchedPaths covers writes, deletes and conflicts', () => {
  const plan = planSync([
    ['w.md', v('a', 'a', 'R')],
    ['d.md', v('a', null, null)],
    ['c.md', v('a', 'L', 'R')],
  ]);
  assert.deepEqual(touchedPaths(plan).sort(), ['c.md', 'd.md', 'w.md']);
});

test('describePlan reports conflicts first', () => {
  const plan = planSync([['a.md', v('x', 'L', 'R')]]);
  assert.match(describePlan(plan), /衝突/);
});

test('describePlan reports a clean plan', () => {
  assert.equal(describePlan({ writes: [], deletes: [], conflicts: [] }), '已是最新');
  assert.match(describePlan(planSync([['a.md', v('x', 'x', 'R')]])), /合併/);
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('title comes from frontmatter', () => {
  const meta = readMeta('notes/x.md', '---\ntitle: Real Title\n---\nbody');
  assert.equal(meta.title, 'Real Title');
});

test('title falls back to the filename', () => {
  const meta = readMeta('notes/my-note.md', '# Heading\n\ntext');
  assert.equal(meta.title, 'my-note');
});

test('tags are read', () => {
  const meta = readMeta('n.md', '---\ntags: [a, b]\n---\n');
  assert.deepEqual(meta.tags, ['a', 'b']);
});

test('dates are read', () => {
  const meta = readMeta('n.md', '---\ncreated: 2026-01-02\nupdated: 2026-03-04\n---\n');
  assert.equal(meta.created, '2026-01-02');
  assert.equal(meta.updated, '2026-03-04');
});

test('firstLine strips heading marks and skips blanks', () => {
  assert.equal(firstLine('---\ntitle: T\n---\n\n## Heading here\n\nmore'), 'Heading here');
  assert.equal(firstLine(''), null);
  assert.equal(firstLine('---\ntitle: T\n---\n'), null);
});

test('metadata is read without disturbing frontmatter', () => {
  const src = '---\ntitle: T\n---\nbody\n';
  readMeta('n.md', src);
  assert.equal(src, '---\ntitle: T\n---\nbody\n', 'readMeta must not mutate');
});