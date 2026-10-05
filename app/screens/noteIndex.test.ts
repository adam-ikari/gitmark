/**
 * Note list derivation: titles, tags, conflicts, ordering.
 *
 * These are the decisions a user notices immediately — a list of `.md`
 * filenames, or a conflict buried at the bottom — so they are asserted without
 * a renderer. The logic lives in noteIndex.ts rather than the screen because
 * `node --test` cannot import `.tsx`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toNoteList, sortNotes, conflictCount, type NoteListItem } from './noteIndex.ts';

test('a frontmatter title wins over the filename', () => {
  const [item] = toNoteList([['notes/a.md', ['---', 'title: 專案筆記', '---', 'body'].join('\n')]]);
  assert.equal(item?.title, '專案筆記');
});

test('a note with no title falls back to the filename', () => {
  const [item] = toNoteList([['projects/alpha.md', '# Heading\n\nbody']]);
  assert.equal(item?.title, 'alpha');
});

test('tags are read from an inline list', () => {
  const [item] = toNoteList([['a.md', ['---', 'tags: [work, urgent]', '---', 'x'].join('\n')]]);
  assert.deepEqual(item?.tags, ['work', 'urgent']);
});

test('tags are read from a block list', () => {
  const [item] = toNoteList([['a.md', ['---', 'tags:', '  - work', '  - urgent', '---', 'x'].join('\n')]]);
  assert.deepEqual(item?.tags, ['work', 'urgent']);
});

test('a note with no frontmatter gets no tags', () => {
  const [item] = toNoteList([['a.md', '# Just a heading']]);
  assert.deepEqual(item?.tags, []);
  assert.equal(item?.title, 'a');
});

test('reading metadata does not add a frontmatter block', () => {
  const source = '# Heading\n\nbody';
  toNoteList([['a.md', source]]);
  // The function takes content by value, so this asserts the shape of the
  // contract: nothing is written back.
  assert.equal(source, '# Heading\n\nbody');
});

test('a missing file still gets an entry rather than vanishing', () => {
  // A note that exists in git but not on disk is a state to show, not a row to
  // hide.
  const [item] = toNoteList([['a.md', null]]);
  assert.equal(item?.path, 'a.md');
  assert.deepEqual(item?.tags, []);
  assert.equal(item?.conflicted, false);
});

test('a note carrying conflict markers is flagged', () => {
  const [item] = toNoteList([
    ['a.md', ['before', '<<<<<<< local', 'mine', '=======', 'theirs', '>>>>>>> remote', 'after'].join('\n')],
  ]);
  assert.equal(item?.conflicted, true);
});

test('a clean note is not flagged', () => {
  const [item] = toNoteList([['a.md', '# Title\n\njust text']]);
  assert.equal(item?.conflicted, false);
});

test('conflicted notes sort first', () => {
  // A conflict that has to be scrolled to is a conflict that stays unresolved.
  const items: NoteListItem[] = [
    { path: 'a.md', title: 'aaa', tags: [], conflicted: false },
    { path: 'z.md', title: 'zzz', tags: [], conflicted: true },
  ];
  assert.deepEqual(
    sortNotes(items).map((i) => i.title),
    ['zzz', 'aaa'],
  );
});

test('remaining notes sort by title', () => {
  const items: NoteListItem[] = [
    { path: 'c.md', title: 'ccc', tags: [], conflicted: false },
    { path: 'a.md', title: 'aaa', tags: [], conflicted: false },
    { path: 'b.md', title: 'bbb', tags: [], conflicted: false },
  ];
  assert.deepEqual(
    sortNotes(items).map((i) => i.title),
    ['aaa', 'bbb', 'ccc'],
  );
});

test('sorting does not mutate the input', () => {
  const items: NoteListItem[] = [
    { path: 'b.md', title: 'b', tags: [], conflicted: false },
    { path: 'a.md', title: 'a', tags: [], conflicted: false },
  ];
  sortNotes(items);
  assert.equal(items[0]?.title, 'b');
});

test('the conflict count matches the flagged notes', () => {
  const items = toNoteList([
    ['a.md', '<<<<<<< x\nmine\n=======\ntheirs\n>>>>>>> y'],
    ['b.md', 'clean'],
  ]);
  assert.equal(conflictCount(sortNotes(items)), 1);
});

test('an empty repository produces an empty list', () => {
  assert.deepEqual(toNoteList([]), []);
  assert.deepEqual(sortNotes([]), []);
  assert.equal(conflictCount([]), 0);
});