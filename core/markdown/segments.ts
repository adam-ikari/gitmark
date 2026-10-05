/**
 * Flat styled segments for one line (or block) of markdown.
 *
 * The editor shows a styled layer behind a transparent `TextInput`. Alignment
 * only works if both layers lay out **the same characters**, so the styled layer
 * must not hide anything: `**` stays in the stream and is merely dimmed.
 *
 * That is why this produces a flat, contiguous segment list rather than a tree.
 * A tree would tempt a renderer into dropping delimiters, which silently
 * breaks alignment. Segments are contiguous and gap-free by construction, so a
 * test can assert `segments.map(s => s.text).join('') === input`.
 */

import { parseInlineRange } from './inline.ts';
import type { Inline, RangedInline } from './types.ts';

export interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  /** Destination when this segment is link text. */
  href: string | null;
  /** True for markdown punctuation: `**`, `*`, `` ` ``, `[`, `](url)`. */
  delimiter: boolean;
  /** Source offsets, so a caret can be mapped back onto a segment. */
  start: number;
  end: number;
}

interface Marks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
}

const NONE: Marks = { bold: false, italic: false, strike: false, code: false, href: null };

/** Layer extra marks onto an existing set. `with` is a reserved word here. */
function layer(m: Marks, patch: Partial<Marks>): Marks {
  return { ...m, ...patch };
}

/**
 * Split one line of markdown into styled segments.
 *
 * Guarantees, all covered by tests:
 *  - segments are in source order, contiguous, and non-overlapping
 *  - concatenating their text reproduces the input exactly
 */
export function toSegments(src: string): Segment[] {
  const out: Segment[] = [];
  const nodes = parseInlineRange(src, 0, src.length);

  let cursor = 0;
  const emit = (text: string, start: number, marks: Marks, delimiter: boolean) => {
    if (text === '') return;
    out.push({ text, ...marks, delimiter, start, end: start + text.length });
  };

  for (const node of nodes) {
    // The parser guarantees contiguity; a gap here would mean a silent hole in
    // the rendered layer.
    if (node.srcStart > cursor) emit(src.slice(cursor, node.srcStart), cursor, NONE, false);

    switch (node.type) {
      case 'text':
        emit(node.value, node.srcStart, NONE, false);
        break;

      case 'strong':
        emitWrapped(src, node, '**', layer(NONE, { bold: true }), emit);
        break;

      case 'em':
        emitWrapped(src, node, '*', layer(NONE, { italic: true }), emit);
        break;

      case 'strike':
        emitWrapped(src, node, '~~', layer(NONE, { strike: true }), emit);
        break;

      case 'code': {
        // The fence may be several backticks when the content contains some.
        const fence = /^`+/.exec(src.slice(node.srcStart))?.[0] ?? '`';
        emit(fence, node.srcStart, NONE, true);
        emit(src.slice(node.srcStart + fence.length, node.srcEnd - fence.length), node.srcStart + fence.length, layer(NONE, { code: true }), false);
        emit(fence, node.srcEnd - fence.length, NONE, true);
        break;
      }

      case 'link':
        emitLink(src, node, emit);
        break;

      case 'image':
        emitImage(src, node, emit);
        break;

      case 'hardbreak':
        // The source is `  \n` or `\\\n`. Emitting its raw text keeps the styled
        // layer the same width as the input — normalising it to a bare `\n` would
        // drop the two trailing spaces and break alignment.
        emit(src.slice(node.srcStart, node.srcEnd), node.srcStart, NONE, true);
        break;

      case 'softbreak':
        // A bare newline in the source. Rendered as-is so it wraps exactly where
        // the input wraps.
        emit(src.slice(node.srcStart, node.srcEnd), node.srcStart, NONE, false);
        break;
    }

    cursor = node.srcEnd;
  }

  if (cursor < src.length) emit(src.slice(cursor), cursor, NONE, false);
  return out;
}

/** Emit `open`, the styled children, then `close`. */
function emitWrapped(
  src: string,
  node: RangedInline & { children?: unknown },
  delim: string,
  marks: Marks,
  emit: Emit,
): void {
  emit(delim, node.srcStart, NONE, true);
  walkChildren(src, rangedChildren(node), node.srcStart + delim.length, marks, emit);
  emit(delim, node.srcEnd - delim.length, NONE, true);
}

type Emit = (text: string, start: number, marks: Marks, delimiter: boolean) => void;

/** Children as ranged nodes, regardless of how the parser declared them. */
function rangedChildren(node: { children?: unknown }): RangedInline[] {
  return Array.isArray(node.children) ? (node.children as RangedInline[]) : [];
}

function walkChildren(src: string, children: readonly RangedInline[], expectedStart: number, marks: Marks, emit: Emit): void {
  let cursor = expectedStart;
  for (const child of children) {
    if (child.srcStart > cursor) emit(src.slice(cursor, child.srcStart), cursor, marks, false);

    switch (child.type) {
      case 'text':
        emit(child.value, child.srcStart, marks, false);
        break;
      case 'strong':
        emitWrapped(src, child as RangedInline & Inline, '**', layer(marks, { bold: true }), emit);
        break;
      case 'em':
        emitWrapped(src, child as RangedInline & Inline, '*', layer(marks, { italic: true }), emit);
        break;
      case 'strike':
        emitWrapped(src, child as RangedInline & Inline, '~~', layer(marks, { strike: true }), emit);
        break;
      case 'code': {
        const fence = /^`+/.exec(src.slice(child.srcStart))?.[0] ?? '`';
        emit(fence, child.srcStart, marks, true);
        emit(src.slice(child.srcStart + fence.length, child.srcEnd - fence.length), child.srcStart + fence.length, layer(marks, { code: true }), false);
        emit(fence, child.srcEnd - fence.length, marks, true);
        break;
      }
      default:
        // Anything else inside a construct falls back to raw text so no
        // characters are ever dropped.
        emit(src.slice(child.srcStart, child.srcEnd), child.srcStart, marks, false);
        break;
    }
    cursor = child.srcEnd;
  }
}

/** `[label](href)`: brackets and the destination are delimiters. */
function emitLink(src: string, node: RangedInline & Extract<Inline, { type: 'link' }>, emit: Emit): void {
  const labelEnd = findLabelEnd(src, node.srcStart, node.srcEnd);
  emit('[', node.srcStart, NONE, true);
  walkChildren(src, rangedChildren(node), node.srcStart + 1, layer(NONE, { href: node.href }), emit);
  // The tail is `](href)`, with an optional title already inside the parens.
  emit(src.slice(labelEnd, node.srcEnd), labelEnd, NONE, true);
}

/** Index of the `]` that closes the label, tracking nesting. */
function findLabelEnd(src: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open + 1; i < limit; i++) {
    const c = src[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return limit;
}

/** `![alt](src)`: the whole thing is one delimiter run around the alt text. */
function emitImage(src: string, node: RangedInline & Extract<Inline, { type: 'image' }>, emit: Emit): void {
  emit(src.slice(node.srcStart, node.srcEnd), node.srcStart, NONE, true);
}

export { NONE as NO_MARKS };