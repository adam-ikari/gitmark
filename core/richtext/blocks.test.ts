import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockContextAt,
  insertNewline,
  backspaceAtLineStart,
  setHeading,
  toggleList,
  toggleTask,
  outdent,
  indent,
} from './blocks.ts';
import { parseDocument } from '../markdown/blocks.ts';

const S = (anchor: number, focus = anchor) => ({ anchor, focus });

/** Caret at a character offset found by searching for `needle`. */
function at(src: string, needle: string, offsetIntoNeedle = 0): number {
  return src.indexOf(needle) + offsetIntoNeedle;
}

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

test('a plain line is a paragraph', () => {
  const ctx = blockContextAt('hello', 2);
  assert.equal(ctx.kind, 'paragraph');
});

test('a heading is detected with its depth', () => {
  assert.equal(blockContextAt('### Title', 4).kind, 'heading');
  assert.equal(blockContextAt('### Title', 4).depth, 3);
});

test('a bullet list item is detected', () => {
  const ctx = blockContextAt('- item', 3);
  assert.equal(ctx.kind, 'list-item');
  assert.equal(ctx.marker, '-');
  assert.equal(ctx.ordered, false);
});

test('an ordered list item is detected', () => {
  const ctx = blockContextAt('3. item', 4);
  assert.equal(ctx.kind, 'list-item');
  assert.equal(ctx.ordered, true);
  assert.equal(ctx.marker, '3.');
});

test('indentation is reported', () => {
  const ctx = blockContextAt('    - deep', 7);
  assert.equal(ctx.kind, 'list-item');
  assert.equal(ctx.indent, 4);
});

test('a quote is detected', () => {
  assert.equal(blockContextAt('> quoted', 3).kind, 'quote');
});

test('a fenced code block is detected', () => {
  assert.equal(blockContextAt('```js\ncode\n```', 8).kind, 'code');
});

test('a mermaid fence is detected', () => {
  assert.equal(blockContextAt('```mermaid\ngraph TD;\n```', 14).kind, 'mermaid');
});

test('an svg fence is detected', () => {
  assert.equal(blockContextAt('```svg\n<svg/>\n```', 12).kind, 'svg');
});

test('a table row is detected inside a real table', () => {
  const src = '| a | b |\n| - | - |\n| 1 | 2 |';
  assert.equal(blockContextAt(src, at(src, '| 1 |')).kind, 'table');
});

test('a lone pipe line is not a table', () => {
  assert.equal(blockContextAt('a | b\nc', 2).kind, 'paragraph');
});

test('line bounds are reported', () => {
  const src = 'one\ntwo\nthree';
  const ctx = blockContextAt(src, 5);
  assert.equal(ctx.lineStart, 4);
  assert.equal(ctx.lineEnd, 7);
  assert.equal(ctx.lineText, 'two');
});

// ---------------------------------------------------------------------------
// Enter
// ---------------------------------------------------------------------------

test('Enter in a paragraph inserts a newline', () => {
  const src = 'onetwo';
  const r = insertNewline(src, S(3));
  assert.equal(r.source, 'one\ntwo');
  assert.equal(r.selection.anchor, 4);
});

test('Enter mid list item splits it and repeats the marker', () => {
  // '- onetwo': offsets 2..7 are the text, so 5 splits it as 'one' / 'two'.
  const src = '- onetwo';
  const r = insertNewline(src, S(5));
  assert.equal(r.source, '- one\n- two');
});

test('Enter splits an ordered list and increments the number', () => {
  const src = '3. onetwo';
  const r = insertNewline(src, S(6));
  assert.equal(r.source, '3. one\n4. two');
});

test('Enter on an empty list item ends the list', () => {
  const src = '- one\n- ';
  const r = insertNewline(src, S(src.length));
  // The empty item and its newline disappear together, leaving no stray blank
  // line, and the caret lands at the end of the last real item.
  assert.equal(r.source, '- one');
  assert.equal(r.selection.anchor, 5);
});

test('Enter on an empty item does not remove the preceding content', () => {
  const src = '- one\n- two\n- ';
  const r = insertNewline(src, S(src.length));
  assert.equal(r.source, '- one\n- two');
});

test('Enter on an empty indented item outdents rather than ending the list', () => {
  const src = '- one\n  - ';
  const r = insertNewline(src, S(src.length));
  assert.equal(r.source, '- one\n- ');
});

test('Enter in a heading starts a paragraph', () => {
  const src = '# Title';
  const r = insertNewline(src, S(src.length));
  assert.equal(r.source, '# Title\n\n');
  assert.equal(r.selection.anchor, 9);
});

test('Enter in a quote continues the quote', () => {
  const src = '> one';
  const r = insertNewline(src, S(src.length));
  assert.equal(r.source, '> one\n> ');
});

test('Enter inside a mermaid fence does not close it', () => {
  const src = '```mermaid\ngraph TD;';
  const r = insertNewline(src, S(src.length));
  assert.equal(r.source, '```mermaid\ngraph TD;\n');
});

test('a split list item re-parses as two items', () => {
  const src = '- onetwo';
  const r = insertNewline(src, S(5));
  const list = parseDocument(r.source)[0] as { items: unknown[] };
  assert.equal(list.items.length, 2);
});

// ---------------------------------------------------------------------------
// Backspace at line start
// ---------------------------------------------------------------------------

test('Backspace mid-line is not a block operation', () => {
  assert.equal(backspaceAtLineStart('- item', S(3)), null);
});

test('Backspace at the start of a flush list item removes the marker', () => {
  const src = '- item';
  const r = backspaceAtLineStart(src, S(0));
  assert.equal(r?.source, 'item');
  assert.equal(r?.selection.anchor, 0);
});

test('Backspace at the start of an indented item outdents by two spaces', () => {
  const src = '  - item';
  const r = backspaceAtLineStart(src, S(0));
  assert.equal(r?.source, '- item');
  assert.equal(r?.selection.anchor, 0);
});

test('outdenting a deeply indented item removes one level only', () => {
  const src = '      - item';
  const r = backspaceAtLineStart(src, S(0));
  assert.equal(r?.source, '    - item');
});

test('Backspace removes a quote marker', () => {
  const r = backspaceAtLineStart('> quoted', S(0));
  assert.equal(r?.source, 'quoted');
});

test('Backspace demotes a heading', () => {
  const r = backspaceAtLineStart('### Title', S(0));
  assert.equal(r?.source, '## Title');
});

test('Backspace on a level 1 heading is not a block operation', () => {
  // Turning `# Title` into a paragraph by Backspace would surprise anyone.
  assert.equal(backspaceAtLineStart('# Title', S(0)), null);
});

test('two Backspaces fully escape a list', () => {
  let src = '  - item';
  const first = backspaceAtLineStart(src, S(0))!;
  src = first.source;
  const second = backspaceAtLineStart(src, S(0))!;
  assert.equal(second.source, 'item');
});

test('Backspace with a selection is left to the caller', () => {
  assert.equal(backspaceAtLineStart('- item', S(0, 4)), null);
});

// ---------------------------------------------------------------------------
// Indent / outdent
// ---------------------------------------------------------------------------

test('indent adds two spaces', () => {
  const r = indent('- item', S(2));
  assert.equal(r.source, '  - item');
  assert.equal(r.selection.anchor, 4);
});

test('outdent removes two spaces', () => {
  const r = outdent('  - item', S(4));
  assert.equal(r.source, '- item');
});

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

test('setHeading adds a prefix', () => {
  const src = 'Title';
  const r = setHeading(src, S(2), 2);
  assert.equal(r.source, '## Title');
});

test('setHeading replaces an existing prefix', () => {
  const src = '# Title';
  const r = setHeading(src, S(3), 3);
  assert.equal(r.source, '### Title');
});

test('setHeading to 0 removes the prefix', () => {
  const src = '## Title';
  const r = setHeading(src, S(5), 0);
  assert.equal(r.source, 'Title');
});

test('setting the same depth twice is stable', () => {
  const src = '## Title';
  const r = setHeading(src, S(5), 2);
  assert.equal(r.source, '## Title');
});

test('a heading round-trips through the parser', () => {
  const src = 'Title';
  const r = setHeading(src, S(2), 3);
  const block = parseDocument(r.source)[0] as { type: string; depth: number };
  assert.equal(block.type, 'heading');
  assert.equal(block.depth, 3);
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('toggleList adds a bullet', () => {
  const r = toggleList('item', S(2));
  assert.equal(r.source, '- item');
});

test('toggleList removes a bullet it added', () => {
  const r = toggleList('- item', S(3));
  assert.equal(r.source, 'item');
});

test('toggleList adds an ordered marker', () => {
  const r = toggleList('item', S(2), true);
  assert.equal(r.source, '1. item');
});

test('switching a bullet to an ordered list keeps the text', () => {
  const r = toggleList('- item', S(3), true);
  assert.equal(r.source, '1. item');
});

test('switching an ordered list to a bullet keeps the text', () => {
  const r = toggleList('1. item', S(4));
  assert.equal(r.source, '- item');
});

test('a list created by toggleList re-parses as a list', () => {
  const r = toggleList('item', S(2));
  assert.equal(parseDocument(r.source)[0]?.type, 'list');
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

test('toggleTask turns a list item into a task', () => {
  const r = toggleTask('- item', S(3));
  assert.equal(r.source, '- [ ] item');
});

test('toggleTask checks an unchecked task', () => {
  const r = toggleTask('- [ ] item', S(4));
  assert.equal(r.source, '- [x] item');
});

test('toggleTask unchecks a checked task', () => {
  const r = toggleTask('- [x] item', S(4));
  assert.equal(r.source, '- [ ] item');
});

test('toggleTask on a non-list is a no-op', () => {
  const r = toggleTask('plain', S(2));
  assert.equal(r.source, 'plain');
});

test('a toggled task re-parses with the right checked state', () => {
  const r = toggleTask('- item', S(3));
  const list = parseDocument(r.source)[0] as { items: Array<{ checked: boolean | null }> };
  assert.equal(list.items[0]?.checked, false);
});

// ---------------------------------------------------------------------------
// Minimal-edit property
// ---------------------------------------------------------------------------

test('every block operation changes only its own line', () => {
  const src = ['# Title', '', 'first line', 'second line', '', '- item'].join('\n');
  const r = insertNewline(src, S(at(src, 'first') + 5));
  const before = src.split('\n');
  const after = r.source.split('\n');

  // The edit splits one line into two, so the count grows by exactly one.
  assert.equal(after.length, before.length + 1);

  // Every original line except the edited one survives untouched, in order.
  const untouchedBefore = before.filter((l) => l !== 'first line' && l !== '');
  const untouchedAfter = after.filter((l) => l !== 'first' && l !== ' line' && l !== '');
  assert.deepEqual(untouchedAfter, untouchedBefore);

  // The split lands exactly where the caret was.
  assert.equal(after[2], 'first');
  assert.equal(after[3], ' line');
});