/**
 * Three-way merge (diff3 style).
 *
 * The contract that matters here is defined in brain/pages/safe-auto-merge.md:
 * auto-merge only when the two sides touched *different* places; anything else
 * is escalated to a visible conflict. Silent data loss is the one unacceptable
 * outcome, so every path is biased towards reporting a conflict over guessing.
 */

import { applyHunks, diffHunks, type Hunk } from './diff.ts';

export interface ConflictRegion {
  /** Zero-based line number in the merged output where the region starts. */
  mergedLine: number;
  base: string[];
  local: string[];
  remote: string[];
}

export interface MergeResult {
  /** Merged text. Unresolved conflicts are written with standard markers. */
  text: string;
  /** True when no conflict remained. */
  clean: boolean;
  /** One entry per unresolved conflict, in output order. */
  conflicts: ConflictRegion[];
  /** Base lines consumed by a conflict region, for progress reporting. */
  conflictLineCount: number;
}

export const DEFAULT_MARKERS = {
  start: '<<<<<<<',
  middle: '=======',
  end: '>>>>>>>',
} as const;

/**
 * Merge `local` and `remote` relative to their common ancestor `base`.
 *
 * @param base   content both sides started from
 * @param local  this device's version
 * @param remote the other side's version
 */
export function merge3(
  base: string,
  local: string,
  remote: string,
  markers: { start: string; middle: string; end: string } = DEFAULT_MARKERS,
): MergeResult {
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);

  const localHunks = diffHunks(baseLines, localLines);
  const remoteHunks = diffHunks(baseLines, remoteLines);

  const out: string[] = [];
  const conflicts: ConflictRegion[] = [];
  let conflictLineCount = 0;

  let bi = 0;
  for (const cluster of clusterHunks(localHunks, remoteHunks)) {
    // Everything between the last consumed base line and this cluster is
    // untouched by both sides.
    while (bi < cluster.baseStart) {
      out.push(baseLines[bi]!);
      bi++;
    }
    bi = Math.max(bi, cluster.baseEnd);

    const span = baseLines.slice(cluster.baseStart, cluster.baseEnd);

    if (cluster.baseStart === cluster.baseEnd) {
      // A pure insertion point: both sides only added lines, deleted nothing.
      // That is losslessly combinable, so prefer merging over escalating —
      // two people appending their own sections to the same note is routine,
      // and forcing a conflict there would be hostile. Order is local first.
      for (const h of cluster.local) out.push(...h.lines);
      for (const h of cluster.remote) out.push(...h.lines);
      continue;
    }

    // Hunk offsets are relative to the whole base, but `span` is a slice of it,
    // so they must be rebased before being applied — otherwise they address
    // lines outside the span.
    const localRegion = applyHunks(span, rebase(cluster.local, cluster.baseStart));
    const remoteRegion = applyHunks(span, rebase(cluster.remote, cluster.baseStart));

    if (sameLines(localRegion, remoteRegion)) {
      // Both sides made the identical change. Nothing to decide.
      out.push(...localRegion);
      continue;
    }

    const localUntouched = sameLines(localRegion, span);
    const remoteUntouched = sameLines(remoteRegion, span);

    if (localUntouched) {
      out.push(...remoteRegion);
      continue;
    }
    if (remoteUntouched) {
      out.push(...localRegion);
      continue;
    }

    // Both sides changed the same span, differently. Escalate.
    conflicts.push({
      mergedLine: out.length,
      base: span,
      local: localRegion,
      remote: remoteRegion,
    });
    conflictLineCount += span.length;

    out.push(markers.start);
    out.push(...localRegion);
    out.push(markers.middle);
    out.push(...remoteRegion);
    out.push(markers.end);
  }

  while (bi < baseLines.length) {
    out.push(baseLines[bi]!);
    bi++;
  }

  return {
    text: out.join('\n'),
    clean: conflicts.length === 0,
    conflicts,
    conflictLineCount,
  };
}

interface HunkCluster {
  baseStart: number;
  baseEnd: number;
  local: Hunk[];
  remote: Hunk[];
}

/**
 * Group hunks from both sides into clusters of mutually overlapping edits.
 *
 * A pure insertion at `k` (baseStart === baseEnd) is treated as overlapping any
 * edit that also sits at `k`. That is stricter than strictly necessary, and
 * deliberately so: it turns an ambiguous case into a visible conflict instead of
 * an arbitrary interleaving.
 */
function clusterHunks(local: readonly Hunk[], remote: readonly Hunk[]): HunkCluster[] {
  const tagged = [
    ...local.map((h) => ({ h, side: 'local' as const })),
    ...remote.map((h) => ({ h, side: 'remote' as const })),
  ].sort((x, y) => x.h.baseStart - y.h.baseStart || x.h.baseEnd - y.h.baseEnd);

  const clusters: HunkCluster[] = [];

  for (const { h, side } of tagged) {
    const current = clusters[clusters.length - 1];
    const spansCurrent =
      current !== undefined &&
      hunksConflict({ baseStart: current.baseStart, baseEnd: current.baseEnd, lines: [] }, h);

    if (current && spansCurrent) {
      current.baseStart = Math.min(current.baseStart, h.baseStart);
      current.baseEnd = Math.max(current.baseEnd, h.baseEnd);
      current[side].push(h);
      continue;
    }
    clusters.push({
      baseStart: h.baseStart,
      baseEnd: h.baseEnd,
      local: side === 'local' ? [h] : [],
      remote: side === 'remote' ? [h] : [],
    });
  }

  return clusters;
}

/** Shift hunk offsets so they address `lines` rather than the whole base. */
function rebase(hunks: readonly Hunk[], offset: number): Hunk[] {
  return hunks.map((h) => ({
    baseStart: h.baseStart - offset,
    baseEnd: h.baseEnd - offset,
    lines: h.lines,
  }));
}

/** Do two half-open base intervals overlap? */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Do two hunks belong to the same conflict cluster?
 *
 * A pure insertion at `k` (`baseStart === baseEnd`) counts as overlapping any
 * edit that also sits at `k`, and as touching the boundary of an edit. That is
 * stricter than strictly necessary, and deliberately so: it turns an ambiguous
 * case into a visible conflict instead of an arbitrary interleaving.
 *
 * Exported because this single rule decides how precise the merge is, so it is
 * worth pinning down directly in tests.
 */
export function hunksConflict(a: Hunk, b: Hunk): boolean {
  if (overlaps(a.baseStart, a.baseEnd, b.baseStart, b.baseEnd)) return true;

  const aPure = a.baseStart === a.baseEnd;
  const bPure = b.baseStart === b.baseEnd;

  // Two pure insertions never conflict, even at the same point: insertions
  // delete nothing, so merge3 can just concatenate them. Forcing a conflict
  // there would make two people appending to the same note fight, which is
  // routine and needs no arbitration.
  if (aPure && bPure) return false;

  // An insertion sitting on a line the other side edited or deleted is
  // genuinely ambiguous: there is no defensible place to put the new line.
  if (aPure && b.baseStart <= a.baseStart && a.baseStart <= b.baseEnd) return true;
  if (bPure && a.baseStart <= b.baseStart && b.baseStart <= a.baseEnd) return true;

  return false;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Split into lines, dropping a single trailing newline so that
 * `splitLines("a\nb\n")` is `["a","b"]`. A trailing newline is restored by the
 * caller's join.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}