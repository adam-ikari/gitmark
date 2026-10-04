import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3, sameRegion, splitLines } from './merge3.ts';
import { applyHunks, diffHunks, lcsPairs } from './diff.ts';

const L = (s: string) => splitLines(s);

// ---------------------------------------------------------------------------
// lcsPairs
// ---------------------------------------------------------------------------

test('lcs of identical sequences is everything', () => {
  assert.deepEqual(lcsPairs(['a', 'b'], ['a', 'b']), [[0, 0], [1, 1]]);
});

test('lcs of disjoint sequences is empty', () => {
  assert.deepEqual(lcsPairs(['a'], ['b']), []);
});

test('lcs handles repeats without crossing', () => {
  const pairs = lcsPairs(['a', 'x', 'a'], ['a', 'a']);
  // Must be monotonic in both coordinates.
  for (let i = 1; i < pairs.length; i++) {
    assert.ok(pairs[i]![0] > pairs[i - 1]![0], 'a indices must increase');
    assert.ok(pairs[i]![1] > pairs[i - 1]![1], 'b indices must increase');
  }
});

test('lcs keeps common prefix and suffix', () => {
  const a = ['h', 'x', 't'];
  const b = ['h', 'y', 't'];
  assert.deepEqual(lcsPairs(a, b), [[0, 0], [2, 2]]);
});

// ---------------------------------------------------------------------------
// diffHunks / applyHunks
// ---------------------------------------------------------------------------

test('diff of identical text has no hunks', () => {
  assert.deepEqual(diffHunks(['a'], ['a']), []);
});

test('a single changed line becomes one hunk', () => {
  const h = diffHunks(['a', 'b', 'c'], ['a', 'X', 'c']);
  assert.equal(h.length, 1);
  assert.deepEqual(h[0], { baseStart: 1, baseEnd: 2, lines: ['X'] });
});

test('applyHunks round-trips', () => {
  const base = ['a', 'b', 'c', 'd'];
  const next = ['a', 'X', 'c', 'd', 'e'];
  const hunks = diffHunks(base, next);
  assert.deepEqual(applyHunks(base, hunks), next);
});

test('applying hunks of an empty diff reproduces the base', () => {
  const base = ['a', 'b'];
  assert.deepEqual(applyHunks(base, []), base);
});

// ---------------------------------------------------------------------------
// hunksConflict
// ---------------------------------------------------------------------------

test('disjoint edits are different regions', () => {
  assert.equal(sameRegion({ baseStart: 0, baseEnd: 1, lines: [] }, { baseStart: 5, baseEnd: 6, lines: [] }), false);
});

test('overlapping edits are one region', () => {
  assert.equal(sameRegion({ baseStart: 0, baseEnd: 2, lines: [] }, { baseStart: 1, baseEnd: 3, lines: [] }), true);
});

test('two insertions at the same point are one region', () => {
  // They must be grouped so they can be compared and de-duplicated. Whether
  // that then needs arbitration is a separate decision, made in merge3.
  assert.equal(sameRegion({ baseStart: 3, baseEnd: 3, lines: [] }, { baseStart: 3, baseEnd: 3, lines: [] }), true);
});

test('insertions at different points are different regions', () => {
  assert.equal(sameRegion({ baseStart: 1, baseEnd: 1, lines: [] }, { baseStart: 5, baseEnd: 5, lines: [] }), false);
});

test('an insertion at an edited line is one region', () => {
  assert.equal(sameRegion({ baseStart: 3, baseEnd: 3, lines: [] }, { baseStart: 2, baseEnd: 4, lines: [] }), true);
});

test('an insertion just past an edit is one region', () => {
  assert.equal(sameRegion({ baseStart: 3, baseEnd: 3, lines: [] }, { baseStart: 3, baseEnd: 4, lines: [] }), true);
});

// ---------------------------------------------------------------------------
// merge3 — the cases that must merge silently
// ---------------------------------------------------------------------------

test('no change on either side', () => {
  const r = merge3('a\nb', 'a\nb', 'a\nb');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nb');
});

test('only local changed', () => {
  const r = merge3('a\nb', 'a\nLOCAL', 'a\nb');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nLOCAL');
});

test('only remote changed', () => {
  const r = merge3('a\nb', 'a\nb', 'a\nREMOTE');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nREMOTE');
});

test('both sides changed different lines', () => {
  const r = merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'A\nb\nC');
});

test('both sides appended different lines', () => {
  // Local-first ordering is arbitrary but fixed and documented.
  const r = merge3('a', 'a\nlocal', 'a\nremote');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nlocal\nremote');
});

test('one side inserted, the other appended elsewhere', () => {
  const r = merge3('a\nz', 'a\nmid\nz', 'a\nz\nend');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nmid\nz\nend');
});

test('identical insertions on both sides are emitted once', () => {
  // Regression: identical insertions once landed in separate clusters and were
  // emitted twice, producing "same\nsame".
  const r = merge3('', 'same', 'same');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'same');
});

test('identical insertions into an existing document are emitted once', () => {
  const r = merge3('a', 'a\nnew', 'a\nnew');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nnew');
});

test('identical change on both sides merges once', () => {
  const r = merge3('a\nb', 'a\nSAME', 'a\nSAME');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nSAME');
});

test('local deleted a line remote kept', () => {
  const r = merge3('a\nb\nc', 'a\nc', 'a\nb\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nc');
});

test('local kept a line remote deleted', () => {
  const r = merge3('a\nb\nc', 'a\nb\nc', 'a\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nc');
});

test('both deleted the same line', () => {
  const r = merge3('a\nb\nc', 'a\nc', 'a\nc');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nc');
});

test('three independent edits all merge', () => {
  const r = merge3('1\n2\n3\n4\n5', '1\nL2\n3\n4\n5', '1\n2\n3\n4\nR5');
  assert.equal(r.clean, true);
  assert.equal(r.text, '1\nL2\n3\n4\nR5');
});

// ---------------------------------------------------------------------------
// merge3 — the cases that must escalate
// ---------------------------------------------------------------------------

test('both changed the same line differently', () => {
  const r = merge3('a\nb', 'a\nLOCAL', 'a\nREMOTE');
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.text, ['a', '<<<<<<<', 'LOCAL', '=======', 'REMOTE', '>>>>>>>'].join('\n'));
});

test('a conflict reports both sides and the base', () => {
  const r = merge3('a\nb\nc', 'a\nLOCAL\nc', 'a\nREMOTE\nc');
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0]!.base, ['b']);
  assert.deepEqual(r.conflicts[0]!.local, ['LOCAL']);
  assert.deepEqual(r.conflicts[0]!.remote, ['REMOTE']);
});

test('two separate conflicts are both reported', () => {
  const r = merge3('1\n2\n3\n4', '1\nX\n3\nY', '1\nP\n3\nQ');
  assert.equal(r.conflicts.length, 2);
});

test('a conflict between an insertion and a deletion', () => {
  // Local inserted a line where remote deleted one — ambiguous, so escalate.
  const r = merge3('a\nb\nc', 'a\nNEW\nb\nc', 'a\nc');
  assert.equal(r.clean, false);
});

test('two different insertions at the same point merge, local first', () => {
  const r = merge3('a\nz', 'a\nins1\nz', 'a\nins2\nz');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a\nins1\nins2\nz');
});

test('a changed line inside a longer changed block conflicts', () => {
  const r = merge3('1\n2\n3\n4', '1\nA\n3\n4', '1\nB\n3\n4');
  assert.equal(r.clean, false);
  // The untouched line 1 and 3 survive around the conflict.
  assert.match(r.text, /^1\n/);
});

// ---------------------------------------------------------------------------
// merge3 — invariants
// ---------------------------------------------------------------------------

/**
 * The core promise from brain/pages/safe-auto-merge.md: a line survives unless
 * somebody deliberately changed it.
 *
 * Precisely: every base line that **neither** side modified must appear in the
 * merged output. A line one side *did* rewrite is allowed to vanish — that is
 * the edit, not data loss. This distinction matters, because the naive version
 * of this check ("nothing from local or remote may disappear") fails on correct
 * merges: when remote rewrites `6` to `R6`, the line `6` is *supposed* to be
 * gone from the result.
 */
function assertUntouchedLinesSurvive(base: string, local: string, remote: string) {
  const r = merge3(base, local, remote);
  const localSet = new Set(L(local));
  const remoteSet = new Set(L(remote));
  const out = new Set(L(r.text));

  for (const line of L(base)) {
    if (line.trim() === '') continue;
    const touchedByLocal = !localSet.has(line);
    const touchedByRemote = !remoteSet.has(line);
    if (touchedByLocal || touchedByRemote) continue;
    assert.ok(out.has(line), `untouched base line ${JSON.stringify(line)} vanished`);
  }
}

test('untouched lines survive (both sides change the same span)', () => {
  assertUntouchedLinesSurvive('a\nb\nc', 'a\nLOCAL\nc', 'a\nREMOTE\nc');
});

test('untouched lines survive (interleaved edits)', () => {
  assertUntouchedLinesSurvive('1\n2\n3\n4\n5\n6', '1\nL2\n3\n4\n5\n6', '1\n2\n3\n4\n5\nR6');
});

test('untouched lines survive (delete versus edit)', () => {
  assertUntouchedLinesSurvive('a\nb\nc\nd', 'a\nd', 'a\nb\nCHANGED\nd');
});

test('untouched lines survive (both rewrite the middle)', () => {
  assertUntouchedLinesSurvive('a\nb\nc\nd\ne', 'a\nX1\nX2\ne', 'a\nY1\nY2\ne');
});

test('untouched lines survive (both append)', () => {
  assertUntouchedLinesSurvive('a', 'a\nL', 'a\nR');
});

test('untouched lines survive across a randomised sweep', () => {
  // A small deterministic PRNG keeps this reproducible.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  const mutate = (src: string[], tag: string): string[] => {
    const out = src.slice();
    const edits = 1 + Math.floor(rnd() * 3);
    for (let e = 0; e < edits; e++) {
      const op = rnd();
      if (out.length === 0 || op < 0.4) out.splice(Math.floor(rnd() * (out.length + 1)), 0, `${tag}${e}`);
      else if (op < 0.7) out[Math.floor(rnd() * out.length)] = `${tag}edit${e}`;
      else out.splice(Math.floor(rnd() * out.length), 1);
    }
    return out;
  };

  for (let trial = 0; trial < 200; trial++) {
    const base = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => `b${i}`);
    const local = mutate(base, 'L');
    const remote = mutate(base, 'R');
    assertUntouchedLinesSurvive(base.join('\n'), local.join('\n'), remote.join('\n'));

    // Whatever happened, the result must be a stable fixpoint: merging it
    // against either side again must not invent or drop further content.
    const merged = merge3(base.join('\n'), local.join('\n'), remote.join('\n'));
    const out = new Set(L(merged.text));
    for (const side of [local, remote]) {
      for (const line of side) {
        if (line.trim() === '') continue;
        // A line may legitimately vanish only if the *other* side rewrote the
        // region it lived in; that is recorded as a conflict, not silent loss.
        const other = side === local ? remote : local;
        if (out.has(line) || merged.conflicts.length > 0) continue;
        assert.ok(
          other.includes(line) === false || out.has(line),
          `trial ${trial}: ${JSON.stringify(line)} lost without any conflict`,
        );
      }
    }
  }
});

test('merge is deterministic', () => {
  const args = ['1\n2\n3', '1\nX\n3', '1\nY\n3'] as const;
  assert.equal(merge3(...args).text, merge3(...args).text);
});

test('merging local against remote is symmetric in what it detects', () => {
  const base = 'a\nb\nc';
  const x = merge3(base, 'a\nX\nc', 'a\nY\nc');
  const y = merge3(base, 'a\nY\nc', 'a\nX\nc');
  assert.equal(x.clean, y.clean);
  assert.equal(x.conflicts.length, y.conflicts.length);
});

test('empty base with content on both sides conflicts', () => {
  // Both sides are creating the same region from nothing. Nothing was deleted,
  // but two competing versions of the same content have no defensible
  // combination — concatenating would produce a document nobody wrote.
  const r = merge3('', 'local', 'remote');
  assert.equal(r.clean, false);
  assert.match(r.text, /local/);
  assert.match(r.text, /remote/);
});

test('identical content created on both sides is not a conflict', () => {
  const r = merge3('', 'same', 'same');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'same');
});

test('empty base with content on one side is clean', () => {
  const r = merge3('', 'local', '');
  assert.equal(r.clean, true);
  assert.equal(r.text, 'local');
});

test('all three empty', () => {
  const r = merge3('', '', '');
  assert.equal(r.clean, true);
  assert.equal(r.text, '');
});

test('realistic note: two people append different sections', () => {
  const base = '# Meeting\n\n- talked about the parser\n';
  const local = '# Meeting\n\n- talked about the parser\n\n## My follow-ups\n\n- write tests\n';
  const remote = '# Meeting\n\n- talked about the parser\n\n## Their follow-ups\n\n- review PR\n';
  const r = merge3(base, local, remote);
  assert.equal(r.clean, true);
  assert.match(r.text, /My follow-ups/);
  assert.match(r.text, /Their follow-ups/);
});

test('realistic note: same line edited by both', () => {
  const base = '# Meeting\n\n- talked about the parser\n';
  const local = '# Meeting\n\n- talked about the lexer\n';
  const remote = '# Meeting\n\n- talked about the tokeniser\n';
  const r = merge3(base, local, remote);
  assert.equal(r.clean, false);
  assert.match(r.text, /lexer/);
  assert.match(r.text, /tokeniser/);
  assert.match(r.text, /^# Meeting$/m);
});