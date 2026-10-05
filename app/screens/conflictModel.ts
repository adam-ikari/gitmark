/**
 * Conflict resolution state.
 *
 * The rules live in core/merge/resolve.ts; this is the part that is a *decision
 * about editing*, so it is separated from the screen and from the pure module:
 *
 * - **The conflicted text is a snapshot.** It is the text as it was loaded, and
 *   decisions are indices into that snapshot. The file is not rewritten per
 *   tap, because each rewrite renumbers every region after the resolved one and
 *   silently shifts the remaining choices onto the wrong text.
 * - **Manual editing is a peer of the two buttons,** not a fallback. Picking
 *   "手動編輯" hands the whole note to the editor with the snapshot on it, and
 *   the resolution screen re-derives its state from whatever the editor
 *   produced. That is what makes the third option real rather than a label.
 */

import {
  applyResolutions,
  describeResolution,
  findRegions,
  isFullyResolved,
  unresolvedIndices,
  chooseEverywhere,
  assertResolved,
  type ConflictRegionSpan,
  type Resolution,
} from '../../core/merge/resolve.ts';

export type ResolutionStep = Resolution | 'manual';

export interface ConflictSession {
  /** The conflicted text as loaded. Decisions index into this. */
  readonly snapshot: string;
  readonly decisions: Readonly<Record<number, Resolution>>;
}

export function startSession(conflictedText: string): ConflictSession {
  return { snapshot: conflictedText, decisions: {} };
}

export function regionsOf(session: ConflictSession): ConflictRegionSpan[] {
  return findRegions(session.snapshot);
}

/** Record one choice. Pure: returns a new session. */
export function decide(
  session: ConflictSession,
  index: number,
  choice: Resolution,
): ConflictSession {
  return { snapshot: session.snapshot, decisions: { ...session.decisions, [index]: choice } };
}

/** Fill every region with the same choice. */
export function decideAll(
  session: ConflictSession,
  choice: Resolution,
): ConflictSession {
  return {
    snapshot: session.snapshot,
    decisions: chooseEverywhere(choice, findRegions(session.snapshot).length),
  };
}

/** Clear one choice, putting that region back in the queue. */
export function undecide(session: ConflictSession, index: number): ConflictSession {
  const next = { ...session.decisions };
  delete next[index];
  return { snapshot: session.snapshot, decisions: next };
}

/** Regions still waiting on the user. */
export function outstanding(session: ConflictSession): number[] {
  return unresolvedIndices(session.snapshot, session.decisions);
}

/** Can this note be committed? */
export function isReady(session: ConflictSession): boolean {
  return isFullyResolved(session.snapshot, session.decisions);
}

/**
 * The text to write, or null when the session is not ready.
 *
 * Returning null rather than a partial string is the point: the commit path must
 * not be able to write a note with markers still in it, so there is nothing
 * meaningful to give it until every region is decided.
 */
export function resolvedText(session: ConflictSession): string | null {
  if (!isReady(session)) return null;
  return applyResolutions(session.snapshot, session.decisions);
}

export function summary(session: ConflictSession): string {
  return describeResolution(session.snapshot, session.decisions);
}

/**
 * The commit gate. Throws rather than returning false.
 *
 * Deliberately takes the resolved text rather than the session: the assertion
 * that reaches the user must be about the bytes being written, not about this
 * module's bookkeeping.
 */
export function assertCommitReady(text: string): void {
  assertResolved(text);
}

/**
 * What a region offers, as data.
 *
 * The three-way choice from brain/pages/safe-auto-merge.md, with the manual
 * option included so the screen cannot accidentally ship a two-way choice with
 * a destructive default. There is no "discard my changes" button, and no
 * preselected choice.
 */
export function stepFor(region: ConflictRegionSpan): ResolutionStep[] {
  const steps: ResolutionStep[] = ['local', 'remote'];
  if (!region.closed) {
    // A region with no closing marker has no delimited "their side", so
    // choosing one would be a guess. Manual editing is the only honest option.
    return ['manual'];
  }
  steps.push('manual');
  return steps;
}