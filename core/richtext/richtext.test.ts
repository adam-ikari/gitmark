import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySplice,
  shiftOffset,
  shiftSelection,
  selectionRange,
  isCollapsed,
  replaceRange,
  deleteBackward,
  deleteForward,
} from './splice.ts';
import { toggleMark, toggleCode, markStateAt, sanitizePaste, MARKS } from './marks.ts';
import { parseDocument } from '../markdown/blocks.ts';

/** Select `[start, end)` and return the result source. */
function sel(text: string, start: number, end = start): Selection {
  return { anchor: start, focus: end };
}
type Selection = { anchor: number; focus: number };

// ---------------------------------------------------------------------------
// Splices
// ---------------------------------------------------------------------------

test('applySplice replaces a range', () => {
  assert.equal(applySplice('hello world', { start: 6, end: 11, text: 'there' }), 'hello there');
});

test('applySplice inserts', () => {
  assert.equal(applySplice('ab', { start: 1, end: 1, text: 'X' }), 'aXb');
});

test('applySplice deletes', () => {
  assert.equal(applySplice('abc', { start: 1, end: 2, text: '' }), 'ac');
});

test('selectionRange normalises direction', () => {
  assert.deepEqual(selectionRange({ anchor: 5, focus: 2 }), [2, 5]);
  assert.deepEqual(selectionRange({ anchor: 2, focus: 5 }), [2, 5]);
});

test('isCollapsed', () => {
  assert.equal(isCollapsed({ anchor: 3, focus: 3 }), true);
  assert.equal(isCollapsed({ anchor: 3, focus: 4 }), false);
});

test('an offset before the splice is unaffected', () => {
  assert.equal(shiftOffset(2, { start: 5, end: 7, text: 'XXX' }), 2);
});

test('an offset after the splice shifts by the length delta', () => {
  assert.equal(shiftOffset(10, { start: 5, end: 7, text: 'XXX' }), 11);
});

test('an offset inside the splice collapses to the end of the new text', () => {
  assert.equal(shiftOffset(6, { start: 5, end: 7, text: 'XXX' }), 8);
});

test('a deletion pulls later offsets back', () => {
  assert.equal(shiftOffset(10, { start: 5, end: 7, text: '' }), 8);
});

test('shiftSelection moves both ends past the splice', () => {
  // The splice grows the text by 0 (2 chars removed, 2 added), so offsets after
  // it are unchanged. Use a growing edit to check the shift itself.
  const s = shiftSelection({ anchor: 10, focus: 12 }, { start: 2, end: 4, text: 'XXXX' });
  assert.deepEqual(s, { anchor: 12, focus: 14 });
});

test('shiftSelection does not move a selection before the splice', () => {
  const s = shiftSelection({ anchor: 0, focus: 1 }, { start: 2, end: 4, text: 'XXXX' });
  assert.deepEqual(s, { anchor: 0, focus: 1 });
});

test('replaceRange inserts and places the caret after', () => {
  const r = replaceRange('ac', sel('ac', 1), 'b');
  assert.equal(r.source, 'abc');
  assert.equal(r.selection.anchor, 2);
});

test('replaceRange replaces a selection and collapses the caret', () => {
  const r = replaceRange('abcd', sel('abcd', 1, 3), 'X');
  assert.equal(r.source, 'aXd');
  assert.equal(r.selection.anchor, 2);
});

test('deleteBackward removes the selection', () => {
  const r = deleteBackward('abcd', sel('abcd', 1, 3));
  assert.equal(r.source, 'ad');
  assert.equal(r.selection.anchor, 1);
});

test('deleteBackward removes one character when collapsed', () => {
  assert.equal(deleteBackward('abc', sel('abc', 2)).source, 'ac');
});

test('deleteBackward at the start does nothing', () => {
  const r = deleteBackward('abc', sel('abc', 0));
  assert.equal(r.source, 'abc');
});

test('deleteForward removes one character', () => {
  assert.equal(deleteForward('abc', sel('abc', 1)).source, 'ac');
});

test('deleteForward at the end does nothing', () => {
  assert.equal(deleteForward('abc', sel('abc', 3)).source, 'abc');
});

// ---------------------------------------------------------------------------
// Toggling marks
// ---------------------------------------------------------------------------

test('wrap an unmarked selection in bold', () => {
  const src = 'hello world';
  const r = toggleMark(src, sel(src, 6, 11), 'bold');
  assert.equal(r.source, 'hello **world**');
  assert.deepEqual(r.selection, { anchor: 8, focus: 13 });
});

test('unwrap a fully bold selection', () => {
  const src = 'hello **world**';
  const r = toggleMark(src, sel(src, 8, 13), 'bold');
  assert.equal(r.source, 'hello world');
  assert.deepEqual(r.selection, { anchor: 6, focus: 11 });
});

test('bold is idempotent', () => {
  const src = 'hello world';
  const once = toggleMark(src, sel(src, 6, 11), 'bold');
  const twice = toggleMark(once.source, once.selection, 'bold');
  assert.equal(twice.source, src);
});

test('mark state: off, on and mixed', () => {
  const src = 'a **bold** and plain';
  // The bold run's content is [4, 8) — the `**` delimiters sit outside it.
  assert.equal(markStateAt(src, sel(src, 4, 8), 'bold'), 'on');
  assert.equal(markStateAt(src, sel(src, 11, 16), 'bold'), 'off');
  // A selection spanning both bold and plain text is neither fully on nor off.
  assert.equal(markStateAt(src, sel(src, 0, 19), 'bold'), 'mixed');
});

test('mark state: a caret before the bold content is not "on"', () => {
  // The `**` occupies offsets 2..4 and the content starts at 4. A caret at 2 or
  // 3 sits on or before the opening delimiter, so no bold text is to its left.
  const src = 'a **bold**';
  assert.equal(markStateAt(src, sel(src, 2), 'bold'), 'off');
  assert.equal(markStateAt(src, sel(src, 5), 'bold'), 'on');
});

test('mark state: a caret between bold and plain text reports the plain side', () => {
  const src = 'a **b** c';
  assert.equal(markStateAt(src, sel(src, 9), 'bold'), 'off');
});

test('mark state: a selection that only clips the bold run is mixed', () => {
  const src = 'a **bold** c';
  // [0, 6) covers `a **bo` — partly bold, partly not.
  assert.equal(markStateAt(src, sel(src, 0, 6), 'bold'), 'mixed');
});

test('a collapsed caret inside bold reports on', () => {
  const src = 'a **bold**';
  assert.equal(markStateAt(src, sel(src, 5), 'bold'), 'on');
  assert.equal(markStateAt(src, sel(src, 2), 'bold'), 'off');
});

test('a collapsed caret inserts empty markers with the caret between them', () => {
  const src = 'ab';
  const r = toggleMark(src, sel(src, 1), 'bold');
  assert.equal(r.source, 'a****b');
  assert.equal(r.selection.anchor, 3);
});

test('italic toggles independently of bold', () => {
  const src = 'x';
  const bolded = toggleMark(src, sel(src, 0, 1), 'bold');
  const both = toggleMark(bolded.source, bolded.selection, 'italic');
  assert.equal(both.source, '***x***');
});

test('italic on text that is only bold wraps it, since it is not italic yet', () => {
  // `**bold**` parses as strong[text]; the text is not italic, so toggling
  // italic must add a delimiter rather than remove one.
  const src = '**bold**';
  const r = toggleMark(src, sel(src, 2, 6), 'italic');
  assert.equal(r.source, '***bold***');
});

test('italic can be removed from text that is both bold and italic', () => {
  const src = '***both***';
  const r = toggleMark(src, sel(src, 3, 7), 'italic');
  assert.equal(r.source, '**both**');
});

test('code mark wraps in backticks', () => {
  const src = 'run this';
  const r = toggleMark(src, sel(src, 4, 8), 'code');
  assert.equal(r.source, 'run `this`');
});

test('strike wraps in tildes', () => {
  const src = 'run this';
  const r = toggleMark(src, sel(src, 4, 8), 'strike');
  assert.equal(r.source, 'run ~~this~~');
});

test('every mark has a matching delimiter pair', () => {
  for (const [name, { open, close }] of Object.entries(MARKS)) {
    assert.equal(open, close, `${name} must use the same delimiter on both sides`);
    assert.ok(open.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Toggling code, which needs care with existing backticks
// ---------------------------------------------------------------------------

test('code containing a backtick gets a wider fence', () => {
  // Offsets 0..4 is the whole string 'a `b'.
  const src = 'a `b';
  const r = toggleCode(src, sel(src, 0, 4));
  assert.equal(r.source, '``a `b``');
});

test('code containing a double backtick gets a triple fence', () => {
  const src = 'x ``y';
  const r = toggleCode(src, sel(src, 0, 5));
  assert.equal(r.source, '```x ``y```');
});

test('a code span survives a re-parse as a single span', () => {
  const src = 'a `b';
  const r = toggleCode(src, sel(src, 0, 4));
  const blocks = parseDocument(r.source);
  const code = (blocks[0] as { children: Array<{ type: string; value: string }> }).children[0];
  assert.equal(code?.type, 'code');
  assert.equal(code?.value, 'a `b');
});

test('plain code without backticks uses a single fence', () => {
  const src = 'run this';
  const r = toggleCode(src, sel(src, 4, 8));
  assert.equal(r.source, 'run `this`');
});

// ---------------------------------------------------------------------------
// The property that keeps git history clean
// ---------------------------------------------------------------------------

test('toggling a mark changes only the selected span', () => {
  // The property that keeps git history usable: an edit must be a minimal
  // splice. If this fails, editing normalises unrelated formatting and every
  // keystroke produces a diff.
  const src = [
    '#  Heading   with   odd   spacing',
    '',
    'some *italic* text and `code`',
    '',
    '- item one',
    '-   item two with odd indent',
    '',
    '| a | b |',
    '| - | - |',
  ].join('\n');

  const word = 'italic';
  const at = src.indexOf(word);
  const r = toggleMark(src, sel(src, at, at + word.length), 'bold');

  const before = src.split('\n');
  const after = r.source.split('\n');

  assert.equal(after.length, before.length, 'line count must not change');
  for (let i = 0; i < before.length; i++) {
    if (i === 2) continue; // the one line we intentionally edited
    assert.equal(after[i], before[i], `line ${i} must be byte-identical`);
  }
  assert.equal(after[2], 'some ***italic*** text and `code`');
});

test('toggling a mark inside a list leaves the markers alone', () => {
  const src = '-   item with *emphasis* here';
  const at = src.indexOf('emphasis');
  const r = toggleMark(src, sel(src, at, at + 8), 'bold');
  assert.equal(r.source, '-   item with ***emphasis*** here');
});

test('a sequence of edits only changes the touched spans', () => {
  let src = 'one two three';
  let s: Selection = { anchor: 4, focus: 7 };

  const r1 = toggleMark(src, s, 'bold');
  src = r1.source;
  s = r1.selection;
  assert.equal(src, 'one **two** three');

  const r2 = toggleMark(src, s, 'italic');
  assert.equal(r2.source, 'one ***two*** three');
});

test('repeated edits do not accumulate whitespace', () => {
  let src = 'x y';
  let s: Selection = { anchor: 0, focus: 1 };
  for (let i = 0; i < 5; i++) {
    const r = toggleMark(src, s, 'bold');
    src = r.source;
    s = r.selection;
    const r2 = toggleMark(src, s, 'bold');
    src = r2.source;
    s = r2.selection;
  }
  assert.equal(src, 'x y', 'toggling on and off five times must return to the original');
});

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

test('paste collapses CRLF', () => {
  const src = '';
  const r = sanitizePaste(src, sel(src, 0), 'a\r\nb');
  assert.equal(r.source, 'a\nb');
});

test('paste collapses runs of blank lines', () => {
  const src = '';
  const r = sanitizePaste(src, sel(src, 0), 'a\n\n\n\nb');
  assert.equal(r.source, 'a\nb');
});

test('paste preserves single newlines', () => {
  const src = '';
  const r = sanitizePaste(src, sel(src, 0), 'a\nb\nc');
  assert.equal(r.source, 'a\nb\nc');
});

test('paste replaces the selection', () => {
  const src = 'keep DROP keep';
  const start = src.indexOf('DROP');
  const r = sanitizePaste(src, sel(src, start, start + 4), 'new');
  assert.equal(r.source, 'keep new keep');
});