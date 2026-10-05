/**
 * Conflict resolution.
 *
 * The properties that matter are the safety ones: an undecided region must stay
 * visible and countable, a malformed region must not be silently dropped, and
 * nothing may be committable while markers remain. The rest is mechanics, and
 * mechanics are cheap to get right once the safety rules are pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findRegions,
  applyResolutions,
  resolveRegion,
  unresolvedIndices,
  isFullyResolved,
  chooseEverywhere,
  describeResolution,
  assertResolved,
  type Resolution,
} from './resolve.ts';
import { countConflicts } from './markers.ts';
import { merge3 } from './merge3.ts';

/**
 * A document with two genuinely separate conflicts, produced by a real merge.
 *
 * Both sides edit lines 2 and 4 of the base, differently, so `merge3` escalates
 * two regions rather than one. Hand-built marker text would drift from what the
 * merge actually writes; this cannot.
 */
function twoRegionMerge(): string {
  const merged = merge3('1\n2\n3\n4\n5\n6', '1\nL2\n3\nL4\n5\n6', '1\nR2\n3\nR4\n5\n6');
  assert.equal(merged.clean, false);
  assert.equal(merged.conflicts.length, 2);
  return merged.text;
}

// ---------------------------------------------------------------------------
// findRegions
// ---------------------------------------------------------------------------

test('no markers means no regions', () => {
  assert.deepEqual(findRegions('# Title\n\nprose with <<< arrows'), []);
});

test('a region reports both sides and its line span', () => {
  const text = ['top', '<<<<<<< mine', 'A', '=======', 'B', '>>>>>>> theirs', 'bottom'].join('\n');
  const [region] = findRegions(text);

  assert.equal(region?.index, 0);
  assert.equal(region?.startLine, 1);
  assert.equal(region?.endLine, 6, 'half-open: one past the closing marker');
  assert.deepEqual(region?.local, ['A']);
  assert.deepEqual(region?.remote, ['B']);
  assert.equal(region?.closed, true);
});

test('a label is read from the start marker', () => {
  const [region] = findRegions('<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> origin/main');
  assert.equal(region?.label, 'HEAD');
});

test('an unlabelled marker yields null, not an empty string', () => {
  const [region] = findRegions('<<<<<<<\nA\n=======\nB\n>>>>>>>');
  assert.equal(region?.label, null);
});

test('a multi-line side is captured whole', () => {
  const text = ['<<<<<<< a', 'L1', 'L2', 'L3', '=======', 'R1', '>>>>>>> b'].join('\n');
  const [region] = findRegions(text);
  assert.deepEqual(region?.local, ['L1', 'L2', 'L3']);
  assert.deepEqual(region?.remote, ['R1']);
});

test('regions are indexed in document order', () => {
  const regions = findRegions(twoRegionMerge());
  assert.deepEqual(
    regions.map((r) => r.index),
    [0, 1],
  );
  assert.ok((regions[1]!.startLine ?? 0) > (regions[0]!.startLine ?? 0));
});

test('a deleted side is a closed region with an empty side', () => {
  // One person removed the lines. This is a real conflict, not a malformed file.
  const [region] = findRegions('<<<<<<< mine\n=======\nB\n>>>>>>> theirs');
  assert.equal(region?.closed, true);
  assert.deepEqual(region?.local, []);
});

test('a region with no end marker is reported as unclosed', () => {
  const regions = findRegions('<<<<<<< mine\nA\n=======\nB');
  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.closed, false);
});

test('a region with no separator is reported as unclosed', () => {
  const regions = findRegions('<<<<<<< mine\nA\nB');
  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.closed, false);
  assert.deepEqual(regions[0]?.local, ['A', 'B']);
});

test('content after the last region is still found', () => {
  const text = ['<<<<<<< a', 'L', '=======', 'R', '>>>>>>> b', 'tail'].join('\n');
  assert.equal(findRegions(text).length, 1);
});

test('a longer run of angle brackets is not a marker', () => {
  // Eight or more is prose, not a conflict; treating it as one would let a
  // quoted email in a note look unresolved forever.
  assert.deepEqual(findRegions('<<<<<<<<\ntext'), []);
  assert.deepEqual(findRegions('>>>>>>>>>>'), []);
});

// ---------------------------------------------------------------------------
// applyResolutions
// ---------------------------------------------------------------------------

test('choosing local keeps this device’s lines', () => {
  const text = ['top', '<<<<<<< mine', 'A', '=======', 'B', '>>>>>>> theirs', 'bottom'].join('\n');
  assert.equal(resolveRegion(text, 0, 'local'), ['top', 'A', 'bottom'].join('\n'));
});

test('choosing remote keeps the other side’s lines', () => {
  const text = ['top', '<<<<<<< mine', 'A', '=======', 'B', '>>>>>>> theirs', 'bottom'].join('\n');
  assert.equal(resolveRegion(text, 0, 'remote'), ['top', 'B', 'bottom'].join('\n'));
});

test('choosing remote for a deleted side removes the lines', () => {
  const text = ['<<<<<<< mine', '=======', 'B', '>>>>>>> theirs'].join('\n');
  assert.equal(resolveRegion(text, 0, 'remote'), 'B');
});

test('choosing local for a deleted side keeps the deletion', () => {
  const text = ['<<<<<<< mine', '=======', 'B', '>>>>>>> theirs'].join('\n');
  assert.equal(resolveRegion(text, 0, 'local'), '');
});

test('an undecided region keeps its markers', () => {
  const resolved = resolveRegion(twoRegionMerge(), 0, 'local');
  assert.equal(countConflicts(resolved), 1, 'the other region is still marked');
});

test('every marker is gone once all regions are decided', () => {
  const text = twoRegionMerge();
  assert.equal(countConflicts(applyResolutions(text, { 0: 'local', 1: 'remote' })), 0);
});

test('regions are decided independently', () => {
  const text = twoRegionMerge();
  const allLocal = applyResolutions(text, chooseEverywhere('local', findRegions(text).length));
  const allRemote = applyResolutions(text, chooseEverywhere('remote', findRegions(text).length));

  assert.notEqual(allLocal, allRemote);
  assert.equal(countConflicts(allLocal), 0);
  assert.equal(countConflicts(allRemote), 0);
  // Deciding each region differently must not equal deciding them all the same.
  assert.notEqual(applyResolutions(text, { 0: 'local', 1: 'remote' }), allLocal);
  assert.notEqual(applyResolutions(text, { 0: 'local', 1: 'remote' }), allRemote);
});

test('unrelated text around the regions is preserved', () => {
  const text = ['before', '<<<<<<< a', 'L', '=======', 'R', '>>>>>>> b', 'middle', '<<<<<<< a', 'L2', '=======', 'R2', '>>>>>>> b', 'after'].join('\n');
  const resolved = applyResolutions(text, { 0: 'local', 1: 'remote' });
  assert.equal(resolved, ['before', 'L', 'middle', 'R2', 'after'].join('\n'));
});

test('resolving a document with no conflicts is a no-op', () => {
  const text = '# Title\n\nbody';
  assert.equal(applyResolutions(text, { 0: 'local' }), text);
});

test('a decision beyond the last region is ignored', () => {
  const text = ['<<<<<<< a', 'L', '=======', 'R', '>>>>>>> b'].join('\n');
  assert.equal(applyResolutions(text, { 7: 'remote' }), text);
});

test('an unclosed region is never resolved away by a choice', () => {
  // The other side's lines were never delimited, so "keep theirs" would be a
  // guess. It has to stay broken until a person edits it.
  const text = ['<<<<<<< mine', 'A', '=======', 'B'].join('\n');
  const resolved = resolveRegion(text, 0, 'local');
  assert.equal(countConflicts(resolved), 1);
  assert.equal(isFullyResolved(resolved, { 0: 'local' }), false);
});

// ---------------------------------------------------------------------------
// unresolvedIndices / isFullyResolved
// ---------------------------------------------------------------------------

test('nothing is outstanding before any choice', () => {
  assert.deepEqual(unresolvedIndices(twoRegionMerge(), {}), [0, 1]);
});

test('a partially resolved document lists only what remains', () => {
  assert.deepEqual(unresolvedIndices(twoRegionMerge(), { 0: 'local' }), [1]);
});

test('a clean document has nothing outstanding', () => {
  assert.deepEqual(unresolvedIndices('# clean', {}), []);
});

test('isFullyResolved is false with markers present', () => {
  assert.equal(isFullyResolved(twoRegionMerge()), false);
});

test('isFullyResolved is true once every region is decided', () => {
  assert.equal(isFullyResolved(twoRegionMerge(), { 0: 'local', 1: 'remote' }), true);
});

test('isFullyResolved is true for a document with no conflicts', () => {
  assert.equal(isFullyResolved('# clean', {}), true);
});

test('an undecided region blocks completion even with others decided', () => {
  const text = twoRegionMerge();
  assert.equal(isFullyResolved(text, { 0: 'local', 1: 'remote' }), true);
  assert.equal(isFullyResolved(text, { 0: 'local' }), false);
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test('applying decisions to already-resolved text changes nothing', () => {
  const text = twoRegionMerge();
  const decisions: Record<number, Resolution> = { 0: 'local', 1: 'remote' };
  const once = applyResolutions(text, decisions);
  // No regions remain, so the second pass must return the text untouched.
  assert.equal(applyResolutions(once, decisions), once);
});

/**
 * Region indices are positions, not identities.
 *
 * Resolving region 0 deletes its markers, so the region that was index 1 becomes
 * index 0. A caller that resolved one region at a time would therefore apply its
 * second choice to the wrong region — or to nothing. This is why `applyResolutions`
 * takes the whole decision set and is applied once, and the test pins the
 * renumbering that makes the mistake possible.
 */
test('resolving renumbers the regions after it', () => {
  const text = twoRegionMerge();
  const before = findRegions(text);
  const after = findRegions(applyResolutions(text, { 0: 'local' }));

  assert.equal(before.length, 2);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.index, 0, 'the survivor is now first');
  assert.deepEqual(after[0]?.local, ['L4'], 'and it is the region that was second');
});

// ---------------------------------------------------------------------------
// describeResolution / assertResolved
// ---------------------------------------------------------------------------

test('a clean document says so', () => {
  assert.equal(describeResolution('# clean', {}), '沒有衝突');
});

test('an undecided document says how many are waiting', () => {
  assert.equal(describeResolution(twoRegionMerge(), {}), '2 個衝突待選擇');
});

test('a partial resolution reports progress', () => {
  assert.equal(describeResolution(twoRegionMerge(), { 0: 'local' }), '1/2 個衝突已選擇');
});

/**
 * The commit gate takes the text about to be written, not the conflicted
 * original plus a decision set.
 *
 * Checking the resolved text directly is what makes the assertion independent of
 * the caller's bookkeeping: if markers survived for any reason, the commit stops.
 */
test('assertResolved throws while markers remain', () => {
  assert.throws(() => assertResolved(twoRegionMerge()), /未解決/);
});

test('assertResolved passes on the output of a full resolution', () => {
  const resolved = applyResolutions(twoRegionMerge(), { 0: 'local', 1: 'remote' });
  assert.doesNotThrow(() => assertResolved(resolved));
});

test('assertResolved rejects markers surviving in the text', () => {
  // Defence in depth: even if a caller believes it resolved everything, markers
  // in the text stop the commit.
  assert.throws(() => assertResolved('<<<<<<< a\nL\n=======\nR\n>>>>>>> b'), /未解決/);
});

test('assertResolved rejects an unclosed region', () => {
  assert.throws(() => assertResolved('<<<<<<< a\nL\n=======\nR'), /未解決/);
});

test('assertResolved passes for a clean note', () => {
  assert.doesNotThrow(() => assertResolved('# clean\n\nbody'));
});

// ---------------------------------------------------------------------------
// Agreement with the merge that wrote the markers
// ---------------------------------------------------------------------------

test('every region found matches one merge3 reported', () => {
  const merged = merge3('a\nb\nc\nd', 'a\nL1\nc\nd', 'a\nR1\nc\nR2\nd');
  const regions = findRegions(merged.text);
  assert.equal(regions.length, merged.conflicts.length);
  assert.equal(countConflicts(merged.text), merged.conflicts.length);
});

test('resolving each reported conflict clears every marker', () => {
  const merged = merge3('1\n2\n3\n4\n5\n6', '1\nL2\n3\nL4\n5\n6', '1\nR2\n3\nR4\n5\n6');
  const decisions: Record<number, Resolution> = {};
  merged.conflicts.forEach((_, i) => {
    decisions[i] = i % 2 === 0 ? 'local' : 'remote';
  });
  const resolved = applyResolutions(merged.text, decisions);

  assert.ok(merged.conflicts.length >= 1, 'the fixture must actually conflict');
  assert.equal(countConflicts(resolved), 0);
  assert.ok(isFullyResolved(merged.text, decisions));
  assert.doesNotThrow(() => assertResolved(resolved));
});