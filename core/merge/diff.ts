/**
 * Line diff: a longest-common-subsequence based matcher.
 *
 * Notes are small, so the quadratic DP is fine after common prefix/suffix
 * trimming. A size guard falls back to "everything differs" for pathological
 * input rather than allocating an enormous table.
 */

/** Maximum cells in the DP table before we stop trying to be clever. */
const MAX_DP_CELLS = 4_000_000;

/**
 * Matched index pairs `(i, j)` meaning `a[i] === b[j]`, in increasing order and
 * forming a longest common subsequence.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }

  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < lo; i++) pairs.push([i, i]);

  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);

  // When the middle is too large to diff precisely we simply report no middle
  // matches, leaving the caller to treat the span as one replacement. That is
  // conservative: it can cost an auto-merge, but it never loses content.
  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= MAX_DP_CELLS) {
    pushLcsPairs(midA, midB, lo, pairs);
  }

  for (let k = 0; k < a.length - hiA; k++) pairs.push([hiA + k, hiB + k]);
  return pairs;
}

function pushLcsPairs(
  a: readonly string[],
  b: readonly string[],
  base: number,
  out: Array<[number, number]>,
): void {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of LCS of a[i:] and b[j:]
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] === b[j]
          ? dp[at(i + 1, j + 1)]! + 1
          : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
    }
  }

  // Walk forward to recover the subsequence.
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([base + i, base + j]);
      i++;
      j++;
    } else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) {
      i++;
    } else {
      j++;
    }
  }
}

/** A contiguous replacement of `a[baseStart, baseEnd)` by `lines`. */
export interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/**
 * Turn a matcher into a list of hunks against `a`.
 *
 * Everything outside a hunk is unchanged.
 */
export function editHunks(a: readonly string[], b: readonly string[], matches: Array<[number, number]>): Hunk[] {
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;

  for (const [x, y] of matches) {
    if (x > ai || y > bi) {
      hunks.push({ baseStart: ai, baseEnd: x, lines: b.slice(bi, y) });
    }
    ai = x + 1;
    bi = y + 1;
  }
  if (ai < a.length || bi < b.length) {
    hunks.push({ baseStart: ai, baseEnd: a.length, lines: b.slice(bi) });
  }
  return hunks;
}

/** Compute the hunks that turn `a` into `b`. */
export function diffHunks(a: readonly string[], b: readonly string[]): Hunk[] {
  return editHunks(a, b, lcsPairs(a, b));
}

/** Apply `hunks` to `a`, returning a new array. */
export function applyHunks(a: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let ai = 0;
  for (const h of hunks) {
    // Copy the untouched lines before this hunk. The `ai < a.length` guard
    // keeps a malformed hunk from pushing `undefined` into the output.
    while (ai < h.baseStart && ai < a.length) {
      out.push(a[ai]!);
      ai++;
    }
    for (const line of h.lines) out.push(line);
    ai = Math.max(ai, h.baseEnd);
  }
  while (ai < a.length) {
    out.push(a[ai]!);
    ai++;
  }
  return out;
}