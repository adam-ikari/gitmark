/**
 * Block-level editing: what Enter, Backspace and Tab should do.
 *
 * All of it is expressed as splices over the markdown source, never by
 * re-serialising the AST. See ./splice.ts for why that matters.
 *
 * The hard part of a markdown editor is not inserting text; it is *not*
 * inserting text in places where markdown has implied structure. Pressing
 * Enter in the middle of a list item must split the item, not create a second
 * list. Pressing Backspace at the start of a list item must outdent it, and
 * only demote it to a paragraph on a second press.
 */

import { parseDocument } from '../markdown/blocks.ts';
import type { RangedBlock } from '../markdown/types.ts';
import { applySplice, clampSelection, selectionRange, type EditResult, type Selection } from './splice.ts';

/** What kind of block the caret is in. */
export interface BlockContext {
  kind: 'paragraph' | 'heading' | 'list-item' | 'code' | 'quote' | 'table' | 'mermaid' | 'svg' | 'hr';
  /** 1-6 for headings. */
  depth?: number;
  /** Bullet character or ordered marker, for lists. */
  marker?: string;
  ordered?: boolean;
  /** Indentation width of the line the caret is on. */
  indent: number;
  /** Offset of the first character of the line. */
  lineStart: number;
  /** Offset just past the last character of the line. */
  lineEnd: number;
  /** The text of the line, without its newline. */
  lineText: string;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;

/**
 * Locate the fence block containing `offset`.
 *
 * Scanning the line for a fence marker is not enough: the *content* lines of a
 * block carry no marker, yet the editor still has to know they are inside code
 * so that Enter inserts a plain newline rather than a list marker. So the
 * parsed blocks are consulted, which is why a caret on line 2 of a fenced block
 * correctly reports `code`.
 */
function fenceAt(source: string, offset: number): { kind: BlockContext['kind'] } | null {
  for (const block of parseDocument(source) as RangedBlock[]) {
    if (block.type !== 'code' && block.type !== 'mermaid' && block.type !== 'svg') continue;
    if (offset >= block.srcStart && offset <= block.srcEnd) return { kind: block.type };
  }
  return null;
}
const HEADING_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Describe the block containing `offset`. */
export function blockContextAt(source: string, offset: number): BlockContext {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let lineEnd = source.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = source.length;
  const lineText = source.slice(lineStart, lineEnd);

  const base: BlockContext = {
    kind: 'paragraph',
    indent: lineText.length - lineText.trimStart().length,
    lineStart,
    lineEnd,
    lineText,
  };

  // Inside a fenced block (including its content lines).
  const fenced = fenceAt(source, offset);
  if (fenced) return { ...base, kind: fenced.kind };

  const trimmed = lineText.trimStart();

  // Opening or closing fence line of a block we did not match above.
  const fence = FENCE_RE.exec(trimmed);
  if (fence) {
    const lang = fence[3]!.trim().toLowerCase();
    return { ...base, kind: lang === 'mermaid' ? 'mermaid' : lang === 'svg' ? 'svg' : 'code' };
  }

  const heading = HEADING_RE.exec(trimmed);
  if (heading) {
    return { ...base, kind: 'heading', depth: heading[1]!.length };
  }

  if (/^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(lineText)) {
    const list = LIST_RE.exec(lineText);
    if (list) {
      const ordered = /\d/.test(list[2]!);
      return {
        ...base,
        kind: 'list-item',
        indent: list[1]!.length,
        marker: list[2]!,
        ordered,
      };
    }
  }

  if (/^\s*>\s?/.test(lineText)) return { ...base, kind: 'quote' };

  // A pipe row belongs to a table when the document actually has one.
  if (trimmed.includes('|') && documentHasTableAt(source, offset)) {
    return { ...base, kind: 'table' };
  }

  return base;
}

function documentHasTableAt(source: string, offset: number): boolean {
  for (const block of parseDocument(source)) {
    if (block.type !== 'table') continue;
    if (offset >= block.srcStart && offset <= block.srcEnd) return true;
  }
  return false;
}

/**
 * Press Enter.
 *
 * Behaviour by context:
 *  - empty list item      -> outdent, and demote to a paragraph when already at 0
 *  - non-empty list item  -> split the item, keeping the marker
 *  - heading              -> start a paragraph (finishing the heading)
 *  - quote                -> continue the quote
 *  - otherwise            -> plain newline
 */
export function insertNewline(source: string, rawSel: Selection): EditResult {
  // A caret past the end of the text would make every line lookup wrong.
  const sel = clampSelection(rawSel, source.length);
  const { focus } = sel;
  const ctx = blockContextAt(source, focus);
  // Only what follows the *newline* counts as "the rest of the list". Looking at
  // `source.slice(ctx.lineEnd)` alone is wrong when the caret sits mid line: the
  // remainder of the current line is not a continuation, so a caret in the middle
  // of `- onetwo` would look like the last item and get demoted instead of split.
  const afterLine = source.slice(ctx.lineEnd).replace(/^\n/, '');

  // Enter on an empty item, with nothing after it, finishes the list. An indented
  // empty item only outdents first.
  //
  // The whole line is removed rather than demoted to an empty paragraph, so
  // finishing a list does not leave a stray blank line behind.
  if (ctx.kind === 'list-item' && isEmptyItem(ctx.lineText) && afterLine.trim() === '') {
    if (ctx.indent > 0) return outdent(source, sel);

    const lineStart = ctx.lineStart;
    const removeFrom = lineStart > 0 ? lineStart - 1 : lineStart;
    const removeTo = lineStart > 0 ? ctx.lineEnd : lineStart;
    const next = applySplice(source, { start: removeFrom, end: removeTo, text: '' });
    const caret = Math.max(0, removeFrom);
    return { source: next, selection: { anchor: caret, focus: caret } };
  }

  if (ctx.kind === 'list-item') {
    return splitListItem(source, sel, ctx);
  }

  if (ctx.kind === 'quote') {
    const marker = /^(\s*>\s?)/.exec(ctx.lineText)![1]!;
    return {
      source: applySplice(source, { start: focus, end: focus, text: `\n${marker}` }),
      selection: { anchor: focus + 1 + marker.length, focus: focus + 1 + marker.length },
    };
  }

  if (ctx.kind === 'heading') {
    // Finish the heading and start a paragraph.
    return {
      source: applySplice(source, { start: ctx.lineEnd, end: ctx.lineEnd, text: '\n\n' }),
      selection: { anchor: ctx.lineEnd + 2, focus: ctx.lineEnd + 2 },
    };
  }

  // Inside a fence, or at the end of one, a plain newline keeps the fence open.
  if (ctx.kind === 'mermaid' || ctx.kind === 'svg' || ctx.kind === 'code') {
    return {
      source: applySplice(source, { start: focus, end: focus, text: '\n' }),
      selection: { anchor: focus + 1, focus: focus + 1 },
    };
  }

  return {
    source: applySplice(source, { start: focus, end: focus, text: '\n' }),
    selection: { anchor: focus + 1, focus: focus + 1 },
  };
}

/** Split a list item in two, carrying the marker to the new line. */
function splitListItem(source: string, sel: Selection, ctx: BlockContext): EditResult {
  const { focus } = sel;
  const [selStart] = selectionRange(sel);
  // Split at the caret, keeping the tail of the line.
  const tail = source.slice(focus, ctx.lineEnd);

  // A selection that spans lines needs the newline replaced too.
  const caret = selStart === sel.focus ? focus : ctx.lineEnd;

  const indent = ' '.repeat(ctx.indent);
  let marker: string;
  if (ctx.ordered) {
    const n = Number(/^\d+/.exec(ctx.marker!)![0]) + 1;
    const punct = ctx.marker!.slice(String(Number(/^\d+/.exec(ctx.marker!)![0])).length);
    marker = `${n}${punct}`;
  } else {
    marker = ctx.marker!;
  }

  // Only carry the marker when there is content after the caret; an empty new
  // item is what ends the list, which `insertNewline` handles separately.
  const insert = tail.length > 0 ? `\n${indent}${marker} ` : `\n${indent}${marker} `;

  const range = caret === focus ? { start: focus, end: focus } : { start: focus, end: sel.focus };
  const next = applySplice(source, { ...range, text: insert });
  const newCaret = caret + insert.length;
  return { source: next, selection: { anchor: newCaret, focus: newCaret } };
}

/** Is this list item's line just a marker with no text? */
function isEmptyItem(lineText: string): boolean {
  const m = LIST_RE.exec(lineText);
  return m !== null && m[4]!.trim() === '';
}

/** Replace a list item's line with plain paragraph text. */
function toParagraph(source: string, ctx: BlockContext, sel: Selection): EditResult {
  const body = source.slice(ctx.lineStart, ctx.lineEnd).replace(LIST_RE, '$4');
  const next = applySplice(source, { start: ctx.lineStart, end: ctx.lineEnd, text: body });
  const delta = body.length - (ctx.lineEnd - ctx.lineStart);
  return {
    source: next,
    selection: { anchor: sel.anchor + delta, focus: sel.focus + delta },
  };
}

/**
 * Press Backspace at the start of a line.
 *
 * First press outdents a list item; a second press turns it into a paragraph.
 * This two-step behaviour is what makes a list escapable without hunting for a
 * toolbar button.
 */
export function backspaceAtLineStart(source: string, sel: Selection): EditResult | null {
  const { anchor, focus } = sel;
  const [start, end] = selectionRange(sel);
  if (start !== end) return null; // let the caller delete the selection

  const ctx = blockContextAt(source, start);
  if (start !== ctx.lineStart) return null; // not at the start of a line

  if (ctx.kind === 'list-item') {
    if (ctx.indent > 0) return outdent(source, sel);

    // Already flush: convert to a paragraph.
    return removeListMarker(source, ctx, sel);
  }

  if (ctx.kind === 'quote') {
    return removeQuoteMarker(source, ctx, sel);
  }

  if (ctx.kind === 'heading' && ctx.depth && ctx.depth > 1) {
    return demoteHeading(source, ctx, sel);
  }

  return null;
}

/** Remove one indent level (at most two spaces) from the caret's line. */
export function outdent(source: string, sel: Selection): EditResult {
  const [start] = selectionRange(sel);
  const ctx = blockContextAt(source, start);
  const remove = Math.min(2, ctx.indent);
  if (remove === 0) return { source, selection: sel };

  const next = applySplice(source, { start: ctx.lineStart, end: ctx.lineStart + remove, text: '' });
  // Clamp so an edit at the very start of the line cannot produce a negative
  // offset. Removing two characters from offset 0 would otherwise give -2.
  const caret = Math.max(0, start - remove);
  return { source: next, selection: { anchor: caret, focus: caret } };
}

/** Add one indent level (two spaces), for Tab. */
export function indent(source: string, sel: Selection): EditResult {
  const ctx = blockContextAt(source, selectionRange(sel)[0]);
  const next = applySplice(source, { start: ctx.lineStart, end: ctx.lineStart, text: '  ' });
  return { source: next, selection: { anchor: sel.anchor + 2, focus: sel.focus + 2 } };
}

/**
 * Rewrite the caret's whole line, keeping the caret on the same *text*.
 *
 * `delta` is the change in line length, and the caret moves with it. Computing
 * the selection from the raw offsets would drift as soon as the marker is wider
 * than two characters — stripping `10. ` pushed the caret to a negative offset.
 */
function rewriteLine(
  source: string,
  ctx: BlockContext,
  sel: Selection,
  replace: (line: string) => string,
): EditResult {
  const body = replace(ctx.lineText);
  const next = applySplice(source, { start: ctx.lineStart, end: ctx.lineEnd, text: body });
  const delta = body.length - (ctx.lineEnd - ctx.lineStart);
  const clamp = (o: number) => Math.max(ctx.lineStart, Math.min(o + delta, ctx.lineStart + body.length));
  return { source: next, selection: { anchor: clamp(sel.anchor), focus: clamp(sel.focus) } };
}

function removeListMarker(source: string, ctx: BlockContext, sel: Selection): EditResult {
  return rewriteLine(source, ctx, sel, (line) => line.replace(LIST_RE, '$4'));
}

function removeQuoteMarker(source: string, ctx: BlockContext, sel: Selection): EditResult {
  return rewriteLine(source, ctx, sel, (line) => line.replace(/^(\s*)>[ \t]?/, ''));
}

function demoteHeading(source: string, ctx: BlockContext, sel: Selection): EditResult {
  const hashes = '#'.repeat((ctx.depth ?? 1) - 1);
  const start = ctx.lineStart + (ctx.lineText.length - ctx.lineText.trimStart().length);
  const next = applySplice(source, { start, end: start + (ctx.depth ?? 1), text: hashes });
  return { source: next, selection: sel };
}

/** Convert the current block to a heading of the given depth. */
export function setHeading(source: string, sel: Selection, depth: 0 | 1 | 2 | 3 | 4 | 5 | 6): EditResult {
  const [start] = selectionRange(sel);
  const ctx = blockContextAt(source, start);

  // Replace an existing heading prefix.
  const lead = /^(\s*)(#{1,6})([ \t]+.*)?$/.exec(ctx.lineText);
  if (lead) {
    const contentOffset = ctx.lineStart + lead[1]!.length + lead[2]!.length + (lead[3] ? lead[3].length - lead[3].trimStart().length : 0);
    const body = depth === 0 ? '' : '#'.repeat(depth) + ' ';
    if (depth === 0) {
      const next = applySplice(source, { start: ctx.lineStart, end: contentOffset, text: '' });
      const caret = Math.max(start - (contentOffset - ctx.lineStart), ctx.lineStart);
      return { source: next, selection: { anchor: caret, focus: caret } };
    }
    const next = applySplice(source, { start: ctx.lineStart, end: contentOffset, text: body });
    const caret = ctx.lineStart + body.length;
    return { source: next, selection: { anchor: caret, focus: caret } };
  }

  if (depth === 0) return { source, selection: sel };

  return {
    source: applySplice(source, { start: ctx.lineStart, end: ctx.lineStart, text: '#'.repeat(depth) + ' ' }),
    selection: { anchor: start + depth + 1, focus: start + depth + 1 },
  };
}

/** Turn the current line into a list item, or toggle it off if already one. */
export function toggleList(source: string, sel: Selection, ordered = false): EditResult {
  const [start] = selectionRange(sel);
  const ctx = blockContextAt(source, start);

  if (ctx.kind === 'list-item' && ctx.ordered === ordered) {
    return removeListMarker(source, ctx, sel);
  }

  const indentStr = ' '.repeat(ctx.indent);
  if (ctx.kind === 'list-item') {
    // Switching between bullet and ordered: replace only the marker.
    const m = LIST_RE.exec(ctx.lineText)!;
    // Groups: 1 = indent, 2 = marker, 3 = spacing, 4 = body.
    const markerEnd = ctx.lineStart + m[1]!.length + m[2]!.length + m[3]!.length;
    const nextMarker = ordered ? '1. ' : '- ';
    return {
      source: applySplice(source, { start: ctx.lineStart + m[1]!.length, end: markerEnd, text: nextMarker }),
      selection: { anchor: start + (nextMarker.length - (m[2]!.length + m[3]!.length)), focus: start + (nextMarker.length - (m[2]!.length + m[3]!.length)) },
    };
  }

  if (ordered) {
    return prefixLine(source, ctx, sel, '1. ');
  }

  return prefixLine(source, ctx, sel, '- ');
}

/** Prepend `marker` to the caret's line, following the caret. */
function prefixLine(source: string, ctx: BlockContext, sel: Selection, marker: string): EditResult {
  const next = applySplice(source, { start: ctx.lineStart, end: ctx.lineStart, text: marker });
  const caret = caretOffset(sel) + marker.length;
  return { source: next, selection: { anchor: caret, focus: caret } };
}

function caretOffset(sel: Selection): number {
  return sel.anchor <= sel.focus ? sel.anchor : sel.focus;
}

/** Flip a task list checkbox, or turn a plain list item into a task. */
export function toggleTask(source: string, sel: Selection): EditResult {
  const [start] = selectionRange(sel);
  const ctx = blockContextAt(source, start);
  if (ctx.kind !== 'list-item') return { source, selection: sel };

  const m = LIST_RE.exec(ctx.lineText)!;
  const bodyStart = ctx.lineStart + m[1]!.length + m[2]!.length + m[3]!.length;
  const task = /^(\[[ xX]\][ \t]+)?/.exec(source.slice(bodyStart, ctx.lineEnd));

  if (task && task[1]) {
    const checked = task[1]![1]!.toLowerCase() === 'x';
    const mark = checked ? '[ ]' : '[x]';
    return {
      source: applySplice(source, { start: bodyStart, end: bodyStart + 3, text: mark }),
      selection: sel,
    };
  }

  return {
    source: applySplice(source, { start: bodyStart, end: bodyStart, text: '[ ] ' }),
    selection: sel,
  };
}

/** All block-level edit entry points, keyed by what the UI will call. */
export const blockOps = {
  insertNewline,
  backspaceAtLineStart,
  outdent,
  indent,
  setHeading,
  toggleList,
  toggleTask,
  blockContextAt,
} as const;

export type BlockOps = typeof blockOps;
export type { RangedBlock };