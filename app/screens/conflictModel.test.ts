/**
 * The conflict resolution session.
 *
 * The hazard this guards against is specific: a session that rewrites the note
 * on every tap renumbers the regions, and the user's remaining choices end up
 * applied to the wrong text. So the session holds a snapshot and applies all
 * decisions at the end — and the tests below assert that snapshot behaviour
 * directly rather than only the end result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startSession,
  decide,
  decideAll,
  undecide,
  regionsOf,
  outstanding,
  isReady,
  resolvedText,
  summary,
  assertCommitReady,
  stepFor,
} from './conflictModel.ts';
import { countConflicts } from '../../core/merge/markers.ts';
import { merge3 } from '../../core/merge/merge3.ts';

function twoConflicts() {
  const merged = merge3('1\n2\n3\n4\n5\n6', '1\nL2\n3\nL4\n5\n6', '1\nR2\n3\nR4\n5\n6');
  assert.equal(merged.conflicts.length, 2);
  return merged.text;
}

// ---------------------------------------------------------------------------
// The snapshot is immutable
// ---------------------------------------------------------------------------

test('deciding does not change the snapshot', () => {
  const text = twoConflicts();
  const session = startSession(text);
  const after = decide(session, 0, 'local');
  assert.equal(session.snapshot, text);
  assert.equal(after.snapshot, text);
});

test('the snapshot is unchanged however many decisions are made', () => {
  // This is the invariant that makes per-region choices safe: the indices a
  // decision refers to are positions in text that never moves.
  const text = twoConflicts();
  let session = startSession(text);
  session = decideAll(session, 'local');
  assert.equal(session.snapshot, text);
  assert.equal(regionsOf(session).length, 2);
});

test('decide returns a new session rather than mutating', () => {
  const session = startSession(twoConflicts());
  const first = decide(session, 0, 'local');
  const second = decide(session, 1, 'remote');
  assert.deepEqual(session.decisions, {});
  assert.deepEqual(Object.keys(first.decisions), ['0']);
  assert.deepEqual(Object.keys(second.decisions), ['1']);
});

// ---------------------------------------------------------------------------
// Recording choices
// ---------------------------------------------------------------------------

test('every region is outstanding to begin with', () => {
  assert.deepEqual(outstanding(startSession(twoConflicts())), [0, 1]);
});

test('deciding one leaves the other outstanding', () => {
  const session = decide(startSession(twoConflicts()), 0, 'local');
  assert.deepEqual(outstanding(session), [1]);
});

test('decideAll clears everything outstanding', () => {
  assert.deepEqual(outstanding(decideAll(startSession(twoConflicts()), 'remote')), []);
});

test('undecide puts a region back in the queue', () => {
  const session = undecide(decideAll(startSession(twoConflicts()), 'local'), 1);
  assert.deepEqual(outstanding(session), [1]);
});

test('a decision for a region that does not exist is not offered as ready', () => {
  // Renumbering means an index can go stale; it must not silently resolve the
  // wrong region.
  const session = decide(startSession(twoConflicts()), 5, 'local');
  assert.equal(isReady(session), false);
});

// ---------------------------------------------------------------------------
// Producing the resolved text
// ---------------------------------------------------------------------------

test('nothing is written while a region is undecided', () => {
  // The whole point of returning null: the commit path cannot write a note with
  // markers in it.
  assert.equal(resolvedText(startSession(twoConflicts())), null);
  assert.equal(resolvedText(decide(startSession(twoConflicts()), 0, 'local')), null);
});

test('the resolved text appears once every region is decided', () => {
  const text = resolvedText(decideAll(startSession(twoConflicts()), 'local'));
  assert.notEqual(text, null);
  assert.equal(countConflicts(text!), 0);
});

test('the resolved text matches the choices made', () => {
  const session = decide(decide(startSession(twoConflicts()), 0, 'local'), 1, 'remote');
  const resolved = resolvedText(session)!;
  assert.match(resolved, /\bL2\b/);
  assert.match(resolved, /\bR4\b/);
  assert.ok(!/\bR2\b/.test(resolved), 'the unchosen side is gone');
  assert.ok(!/\bL4\b/.test(resolved));
});

test('the resolved text is stable across repeated reads', () => {
  const session = decideAll(startSession(twoConflicts()), 'local');
  assert.equal(resolvedText(session), resolvedText(session));
});

test('a clean note is ready with no decisions', () => {
  const session = startSession('# clean');
  assert.equal(isReady(session), true);
  assert.equal(resolvedText(session), '# clean');
});

// ---------------------------------------------------------------------------
// Mixed choices stay independent
// ---------------------------------------------------------------------------

test('mixed choices keep every region’s own answer', () => {
  const local = resolvedText(decideAll(startSession(twoConflicts()), 'local'))!;
  const remote = resolvedText(decideAll(startSession(twoConflicts()), 'remote'))!;
  const mixed = resolvedText(
    decide(decide(startSession(twoConflicts()), 0, 'local'), 1, 'remote'),
  )!;

  assert.notEqual(local, remote);
  assert.notEqual(mixed, local);
  assert.notEqual(mixed, remote);
  assert.equal(countConflicts(mixed), 0);
});

// ---------------------------------------------------------------------------
// The commit gate
// ---------------------------------------------------------------------------

test('the commit gate refuses text with markers', () => {
  assert.throws(() => assertCommitReady(twoConflicts()), /冲突/);
});

test('the commit gate accepts a fully resolved note', () => {
  const resolved = resolvedText(decideAll(startSession(twoConflicts()), 'local'))!;
  assert.doesNotThrow(() => assertCommitReady(resolved));
});

test('a partially resolved session produces nothing the gate would accept', () => {
  const partial = decide(startSession(twoConflicts()), 0, 'local');
  const text = resolvedText(partial);
  assert.equal(text, null, 'no text means no commit path at all');
});

// ---------------------------------------------------------------------------
// The three-way choice
// ---------------------------------------------------------------------------

test('a closed region offers both sides and manual editing', () => {
  const [region] = regionsOf(startSession(twoConflicts()));
  assert.deepEqual(stepFor(region!), ['local', 'remote', 'manual']);
});

test('a malformed region offers only manual editing', () => {
  // No closing marker means no delimited "their side". Offering a side button
  // here would be a guess dressed as a choice.
  const [region] = regionsOf(startSession('<<<<<<< mine\nA\n=======\nB'));
  assert.deepEqual(stepFor(region!), ['manual']);
});

test('no step is preselected', () => {
  const session = startSession(twoConflicts());
  for (const region of regionsOf(session)) {
    assert.equal(session.decisions[region.index], undefined);
  }
});

// ---------------------------------------------------------------------------
// Summary text
// ---------------------------------------------------------------------------

test('an untouched conflict says how many are waiting', () => {
  assert.equal(summary(startSession(twoConflicts())), '2 个冲突待选择');
});

test('a partial resolution reports progress', () => {
  assert.equal(summary(decide(startSession(twoConflicts()), 0, 'local')), '1/2 个冲突已选择');
});

test('a clean note has nothing to report', () => {
  assert.equal(summary(startSession('# clean')), '没有冲突');
});