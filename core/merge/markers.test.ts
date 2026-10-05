import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inspectMarkers, countConflicts, hasUnresolvedConflict, keepLocal, keepRemote } from './markers.ts';
import { merge3 } from './merge3.ts';

test('a note with no markers has no conflicts', () => {
  assert.equal(countConflicts('# title\n\nprose with <<< arrows'), 0);
});

test('one region counts once', () => {
  const text = ['a', '<<<<<<< local', 'mine', '=======', 'theirs', '>>>>>>> remote', 'b'].join('\n');
  assert.equal(countConflicts(text), 1);
  assert.equal(inspectMarkers(text).unterminated, false);
});

test('two regions count twice', () => {
  const text = [
    '<<<<<<< a', 'x', '=======', 'y', '>>>>>>> b',
    'middle',
    '<<<<<<< a', 'p', '=======', 'q', '>>>>>>> b',
  ].join('\n');
  assert.equal(countConflicts(text), 2);
});

test('an unterminated region is reported as such', () => {
  const r = inspectMarkers('<<<<<<< a\nmine\n=======\ntheirs');
  assert.equal(r.conflicts, 1);
  assert.equal(r.unterminated, true);
  assert.equal(hasUnresolvedConflict(r && '<<<<<<< a\nmine'), true);
});

/**
 * The property that ties the writer to the reader: whatever merge3 produces, the
 * counter agrees. A disagreement in either direction is a bug — either the user
 * is never warned, or warned about nothing.
 */
test('the counter always agrees with what merge3 wrote', () => {
  const cases: Array<[string, string, string]> = [
    ['a\nb', 'a\nL', 'a\nR'],
    ['1\n2\n3\n4', '1\nX\n3\n4', '1\nY\nZ\n4'],
    ['# t\n\n- x\n', '# t\n\n- y\n', '# t\n\n- z\n'],
    ['1\n2\n3\n4\n5', '1\nL\n3\n4\n5', '1\nP\n3\nR\n5'],
  ];

  for (const [base, local, remote] of cases) {
    const merged = merge3(base, local, remote);
    assert.equal(
      countConflicts(merged.text),
      merged.conflicts.length,
      `counter disagreed for ${JSON.stringify({ base, local, remote })}`,
    );
  }
});

test('a clean merge leaves nothing to count', () => {
  const merged = merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC');
  assert.equal(merged.clean, true);
  assert.equal(countConflicts(merged.text), 0);
  assert.equal(hasUnresolvedConflict(merged.text), false);
});

test('keepLocal keeps the first side and drops the second', () => {
  const text = ['top', '<<<<<<< mine', 'A', '=======', 'B', '>>>>>>> theirs', 'bottom'].join('\n');
  assert.equal(keepLocal(text), ['top', 'A', 'bottom'].join('\n'));
});

test('keepRemote keeps the second side', () => {
  const text = ['top', '<<<<<<< mine', 'A', '=======', 'B', '>>>>>>> theirs', 'bottom'].join('\n');
  assert.equal(keepRemote(text), ['top', 'B', 'bottom'].join('\n'));
});

test('keeping a side removes the markers', () => {
  const merged = merge3('a\nb', 'a\nL', 'a\nR');
  assert.equal(countConflicts(keepLocal(merged.text)), 0);
  assert.equal(countConflicts(keepRemote(merged.text)), 0);
});

test('keepLocal is idempotent', () => {
  const merged = merge3('a\nb', 'a\nL', 'a\nR');
  assert.equal(keepLocal(keepLocal(merged.text)), keepLocal(merged.text));
});