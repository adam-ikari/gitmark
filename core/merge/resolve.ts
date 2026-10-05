/**
 * Resolving conflict regions one at a time.
 *
 * brain/pages/safe-auto-merge.md requires that a real conflict be resolved by
 * "三选一或手动编辑" — never a two-way choice with a "discard my changes"
 * default. This module is the three-way part: for each region the user picks
 * their own side, the other side, or edits it by hand in the editor.
 *
 * The unit of resolution is a **region**, not a file. A note with three
 * conflicts does not get a single "keep mine" button, because choosing per file
 * means accepting two of someone else's edits while rejecting the third, or the
 * reverse, with no way to express which was which.
 *
 * Two properties are load-bearing and asserted in the tests:
 *
 * - **Resolving is not completing.** Text with any undecided region still has
 *   markers, still counts as conflicted, and must not be committable. Otherwise
 *   "I resolved the one I looked at" becomes a silent partial push.
 * - **All decisions are applied in one pass.** Region indices are positions, not
 *   identities: resolving region 0 removes its markers, which renumbers every
 *   region after it. So decisions must be collected against the text as it was
 *   loaded and applied once, never applied one at a time and re-derived.
 *   {@link applyResolutions} therefore takes the full set.
 */

import { countConflicts, hasUnresolvedConflict } from './markers.ts';

/** What the user chose for one region. */
export type Resolution = 'local' | 'remote';

export interface ConflictRegionSpan {
  /** Index of this region within the text, from 0. */
  index: number;
  /** Line index of the opening marker. */
  startLine: number;
  /**
   * One past the closing marker, so the block is `lines[startLine..endLine)`.
   * Equal to `lines.length` when the block never closed, which is what makes an
   * unclosed region survive to the end of the file rather than being truncated.
   */
  endLine: number;
  /** The label after the start marker, when present. */
  label: string | null;
  /** This device's lines, verbatim from the file. */
  local: string[];
  /** The other side's lines. */
  remote: string[];
  /**
   * False when the block never closed.
   *
   * A malformed region cannot be resolved by choosing a side — the other side's
   * lines were never delimited — so it must be fixed by editing. Tracked as an
   * explicit flag rather than inferred from `remote.length === 0`, because an
   * empty side is perfectly legal: `<<<<<<< a` / `=======` / `>>>>>>> b` is a
   * real conflict where one person deleted everything.
   */
  closed: boolean;
}

/**
 * Locate every conflict region in `text`.
 *
 * Reads the file rather than trusting the last merge result, so a conflict left
 * by a crash, or written by another tool, is still found — the same reasoning as
 * `markers.ts`.
 *
 * Nested or overlapping markers are not supported and are not produced: a
 * resolved file never contains markers, so a marker inside a region means the
 * text was hand-edited into an invalid shape. This treats the first closing
 * marker as the end and continues scanning after it, which is the only choice
 * that makes progress on such a file.
 */
export function findRegions(text: string): ConflictRegionSpan[] {
  const lines = splitLines(text);
  const regions: ConflictRegionSpan[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!isStart(lines[i]!)) {
      i++;
      continue;
    }

    const startLine = i;
    const label = labelOf(lines[i]!);
    const local: string[] = [];

    let j = i + 1;
    while (j < lines.length && !isMiddle(lines[j]!) && !isEnd(lines[j]!)) {
      local.push(lines[j]!);
      j++;
    }

    // Never closed, and we never even found the separator. Report what exists
    // rather than dropping it: a half-open block is still broken and visible.
    if (j >= lines.length || !isMiddle(lines[j]!)) {
      regions.push({
        index: regions.length,
        startLine,
        endLine: lines.length,
        label,
        local,
        remote: [],
        closed: false,
      });
      break;
    }

    const remote: string[] = [];
    j++;
    while (j < lines.length && !isEnd(lines[j]!)) {
      remote.push(lines[j]!);
      j++;
    }

    const closed = j < lines.length;
    regions.push({
      index: regions.length,
      startLine,
      endLine: closed ? j + 1 : lines.length,
      label,
      local,
      remote,
      closed,
    });

    i = closed ? j + 1 : lines.length;
  }

  return regions;
}

/** Apply decisions by region index, leaving undecided regions as they are. */
export function applyResolutions(text: string, decisions: Readonly<Record<number, Resolution>>): string {
  const regions = findRegions(text);
  if (regions.length === 0) return text;

  const lines = splitLines(text);
  const out: string[] = [];
  let cursor = 0;

  for (const region of regions) {
    const choice = decisions[region.index];

    // Everything before this region, verbatim.
    out.push(...lines.slice(cursor, region.startLine));

    if (choice !== undefined && region.closed) {
      out.push(...(choice === 'local' ? region.local : region.remote));
    } else {
      // Undecided, or malformed: keep the block so it stays visible and
      // countable. Silently dropping an unclosed region would make the file
      // look clean while losing whatever the markers were standing for.
      out.push(...lines.slice(region.startLine, region.endLine));
    }

    cursor = region.endLine;
  }

  out.push(...lines.slice(cursor));
  return out.join('\n');
}

/**
 * Resolve exactly one region.
 *
 * Convenient for a single-region document and for tests, but a real resolution
 * screen should hold the conflicted text and a decision set and call
 * {@link applyResolutions} once — indices renumber as regions are removed.
 */
export function resolveRegion(text: string, index: number, choice: Resolution): string {
  return applyResolutions(text, { [index]: choice });
}

/** Regions still needing a decision, including malformed ones. */
export function unresolvedIndices(
  text: string,
  decisions: Readonly<Record<number, Resolution>>,
): number[] {
  return findRegions(text)
    .filter((region) => decisions[region.index] === undefined || !region.closed)
    .map((region) => region.index);
}

/**
 * Is every region decided and well-formed?
 *
 * The gate before a resolved note may be committed. Stricter than "no markers
 * remain": a malformed region counts as unresolved even though removing it
 * would leave no marker behind.
 */
export function isFullyResolved(
  text: string,
  decisions: Readonly<Record<number, Resolution>> = {},
): boolean {
  const regions = findRegions(text);
  if (regions.length === 0) return true;
  return regions.every((region) => region.closed && decisions[region.index] !== undefined);
}

/** A decision for every region, for "accept mine everywhere". */
export function chooseEverywhere(choice: Resolution, regionCount: number): Record<number, Resolution> {
  const out: Record<number, Resolution> = {};
  for (let i = 0; i < regionCount; i++) out[i] = choice;
  return out;
}

/** A one-line summary for a resolution screen. */
export function describeResolution(
  text: string,
  decisions: Readonly<Record<number, Resolution>>,
): string {
  const total = findRegions(text).length;
  if (total === 0) return '没有冲突';
  const done = total - unresolvedIndices(text, decisions).length;
  return done === 0 ? `${total} 个冲突待选择` : `${done}/${total} 个冲突已选择`;
}

/**
 * The last line of defence before committing a resolved note.
 *
 * Takes the text that is *about to be committed* — that is, the output of
 * {@link applyResolutions}, not the conflicted original — so it can check the
 * markers directly rather than re-deriving them from a decision set. A decision
 * set passed here would be about a different text than the one being written,
 * which is exactly the kind of mismatch that should fail loudly.
 *
 * A throwing function rather than a boolean so the commit path cannot forget to
 * check. Pushing conflict markers to a shared repo hands them to the next device
 * to pull, which is the outcome brain/pages/safe-auto-merge.md exists to prevent.
 */
export function assertResolved(text: string): void {
  const regions = findRegions(text);
  if (regions.length > 0) {
    throw new Error(`仍有 ${regions.length} 个冲突未解决`);
  }
  if (hasUnresolvedConflict(text)) {
    throw new Error(`档案仍有 ${countConflicts(text)} 个冲突标记`);
  }
}

// ---------------------------------------------------------------------------

function isStart(line: string): boolean {
  return /^<{7}(?!<)/.test(line);
}

function isMiddle(line: string): boolean {
  return /^={7}(?!=)/.test(line);
}

function isEnd(line: string): boolean {
  return /^>{7}(?!>)/.test(line);
}

function labelOf(line: string): string | null {
  const rest = line.slice(7).trim();
  return rest === '' ? null : rest;
}

/**
 * Split into lines, dropping a single trailing newline.
 *
 * Same convention as `merge3.splitLines`, so line indices mean the same thing in
 * the merge output and in this parser.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}