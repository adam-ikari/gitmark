/**
 * Inline formatting as surgical markdown splices.
 *
 * `toggleMark` is the interesting one. Given a selection, it must decide
 * between three outcomes:
 *
 *   1. the selection is already fully marked  -> remove the markers
 *   2. the selection is partially marked      -> mark the whole thing
 *   3. the selection is unmarked              -> wrap it
 *
 * Deciding this from the *parsed* selection rather than by searching backwards
 * for a delimiter is what makes it correct when the marker sits further out, as
 * in `**bo|ld**`.
 */

import { parseDocument } from '../markdown/blocks.ts';
import type { RangedInline } from '../markdown/types.ts';
import type { Inline } from '../markdown/types.ts';
import {
  applySplice,
  insertAtCaret,
  replaceRange,
  selectionRange,
  shiftSelection,
  type EditResult,
  type Selection,
} from './splice.ts';

/** Marks that can be toggled, and the markdown that expresses them. */
export const MARKS = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  code: { open: '`', close: '`' },
  strike: { open: '~~', close: '~~' },
} as const;

export type MarkName = keyof typeof MARKS;

export type MarkState = 'off' | 'on' | 'mixed';

function markType(name: MarkName): Inline['type'] {
  switch (name) {
    case 'bold':
      return 'strong';
    case 'italic':
      return 'em';
    case 'code':
      return 'code';
    case 'strike':
      return 'strike';
  }
}

/**
 * How many delimiter characters a mark node consumes on each side.
 *
 * Not a constant per mark type, because nesting changes it and a code span may
 * be fenced with several backticks. Measuring from the source keeps the
 * arithmetic honest instead of hard-coding an assumption that `***both***`
 * breaks.
 */
function delimitersFor(type: Inline['type'], srcStart: number, srcEnd: number, source: string): { open: string; close: string } {
  switch (type) {
    case 'strong':
      return { open: '**', close: '**' };
    case 'em':
      // In `***both***` the em node spans three asterisks per side but owns one;
      // the inner strong node supplies the other two.
      return { open: '*', close: '*' };
    case 'strike':
      return { open: '~~', close: '~~' };
    case 'code': {
      // A code span's fence is a run of backticks of equal length at both ends,
      // so counting the opening run gives the answer directly.
      const run = /^`+/.exec(source.slice(srcStart))?.[0] ?? '`';
      return { open: run, close: run };
    }
    default:
      return { open: '', close: '' };
  }
}

/**
 * The mark nodes of `type` whose content contains `[start, end)`.
 *
 * Containment, not equality. Selecting "both" inside `***both***` is both bold
 * and italic, because the selection sits inside an `em` that itself wraps a
 * `strong`. Requiring the content range to *equal* the selection would report
 * "not italic" for text that visibly is, and the toolbar would then wrap it
 * again — turning `***both***` into `****both****` every press.
 */
function nodesCovering(
  source: string,
  start: number,
  end: number,
  type: Inline['type'],
): Array<{ node: RangedInline; contentStart: number; contentEnd: number }> {
  const found: Array<{ node: RangedInline; contentStart: number; contentEnd: number }> = [];
  walkInline(parseDocument(source), (node) => {
    if (node.type !== type) return;
    const { open, close } = delimitersFor(type, node.srcStart, node.srcEnd, source);
    const contentStart = node.srcStart + open.length;
    const contentEnd = node.srcEnd - close.length;
    // Ignore nodes the selection does not touch at all.
    if (end < contentStart || contentEnd < start) return;
    found.push({ node, contentStart, contentEnd });
  });
  // Innermost first, so unwrapping removes the marker closest to the text.
  return found.sort((a, b) => b.node.srcEnd - b.node.srcStart - (a.node.srcEnd - a.node.srcStart));
}

/**
 * Is the selection bold, italic, code, or struck through?
 *
 * With a collapsed caret the answer is whether it sits *inside* a mark, which is
 * what decides whether the toolbar shows the mark as active as you type.
 */
export function markStateAt(source: string, sel: Selection, name: MarkName): MarkState {
  const [start, end] = selectionRange(sel);
  const type = markType(name);

  if (start === end) {
    const inside = inlineNodesAt(source, start).some(
      (n) => n.type === type && n.srcStart < start && start < n.srcEnd,
    );
    return inside ? 'on' : 'off';
  }

  const covering = nodesCovering(source, start, end, type);
  if (covering.length === 0) return 'off';

  // Every covered span must actually be inside the mark, otherwise a selection
  // that runs past the end of the bold run is only partly bold.
  const fullyInside = covering.every(
    (c) => c.contentStart <= start && end <= c.contentEnd,
  );
  return fullyInside ? 'on' : 'mixed';
}

/** Depth-first walk over every inline node in a document. */
function walkInline(blocks: ReturnType<typeof parseDocument>, visit: (n: RangedInline) => void): void {
  const visitInline = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes as RangedInline[]) {
      visit(n);
      const kids = (n as { children?: unknown }).children;
      if (Array.isArray(kids)) visitInline(kids);
    }
  };

  const visitBlock = (bs: unknown): void => {
    if (!Array.isArray(bs)) return;
    for (const b of bs as Array<Record<string, unknown>>) {
      visitInline(b.children);
      if (Array.isArray(b.header)) visitInline(b.header);
      if (Array.isArray(b.rows)) {
        for (const row of b.rows as unknown[][]) visitInline(row);
      }
      if (b.type === 'quote') visitBlock(b.children);
      // A list holds items, and each item holds blocks. Reading `children`
      // directly off the list — as an earlier version did — silently missed
      // every inline inside every list item.
      if (b.type === 'list' && Array.isArray(b.items)) {
        for (const item of b.items as Array<Record<string, unknown>>) {
          visitBlock(item.children);
        }
      }
    }
  };

  visitBlock(blocks);
}

/** Inline nodes whose range contains `offset`. */
function inlineNodesAt(source: string, offset: number): RangedInline[] {
  const out: RangedInline[] = [];
  walkInline(parseDocument(source), (n) => {
    if (n.srcStart <= offset && offset < n.srcEnd) out.push(n);
  });
  return out;
}

/**
 * Toggle a mark across the selection.
 *
 * With a collapsed selection this inserts the markers and parks the caret
 * between them, which is what a rich text toolbar is expected to do.
 */
export function toggleMark(source: string, sel: Selection, name: MarkName): EditResult {
  const [start, end] = selectionRange(sel);
  const { open, close } = MARKS[name];
  const state = markStateAt(source, sel, name);

  if (state === 'on') {
    // Strip exactly this pair of delimiters, keeping the caret on the text the
    // user was looking at. The closing delimiter must go first, otherwise the
    // earlier removal invalidates the offset of the later one.
    //
    // (Removing the opening delimiter first is the classic bug here: it yields
    // 'hello **world' — a dangling opener with no closer.)
    const source1 = applySplice(source, { start: end, end: end + close.length, text: '' });
    return {
      source: applySplice(source1, { start: start - open.length, end: start, text: '' }),
      selection: { anchor: start - open.length, focus: end - open.length },
    };
  }

  if (start === end) {
    const r = insertAtCaret(source, sel, open + close);
    // Caret between the delimiters.
    return { source: r.source, selection: { anchor: start + open.length, focus: start + open.length } };
  }

  return {
    source: applySplice(source, { start, end, text: open + source.slice(start, end) + close }),
    selection: { anchor: start + open.length, focus: end + open.length },
  };
}

/**
 * Toggle inline code, taking care that the content gets one extra backtick when
 * it already ends with one — otherwise the span closes early.
 */
export function toggleCode(source: string, sel: Selection): EditResult {
  const [start, end] = selectionRange(sel);
  if (start !== end && source.slice(start, end).includes('`')) {
    const fence = '`'.repeat(longestBacktickRun(source.slice(start, end)) + 1);
    return {
      source: applySplice(source, {
        start,
        end,
        text: fence + source.slice(start, end) + fence,
      }),
      selection: { anchor: start + fence.length, focus: end + fence.length },
    };
  }
  return toggleMark(source, sel, 'code');
}

function longestBacktickRun(s: string): number {
  let best = 0;
  for (const run of s.match(/`+/g) ?? []) best = Math.max(best, run.length);
  return best;
}

/**
 * Apply inline formatting to plain text pasted from elsewhere.
 *
 * Pasting a heading from a document into a paragraph would otherwise paste a
 * literal `#` on its own line. Collapsing newlines keeps the result inside the
 * current block instead of silently splitting the note.
 */
export function sanitizePaste(source: string, sel: Selection, pasted: string): EditResult {
  const cleaned = pasted.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n');
  return replaceRange(source, sel, cleaned);
}

export { shiftSelection };