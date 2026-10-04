/**
 * Block-level markdown parser.
 *
 * Line oriented: walk the lines, recognise a block construct at the current
 * position, and hand the consumed lines to a sub-parser (a list item's content
 * is itself a block sequence).
 *
 * Every block records its source range so the editor can map a caret back to a
 * block. See brain/architecture.md for why the AST is always derived and the
 * markdown text is what actually gets stored.
 */

import type { Align, Block, Inline, ListItem, RangedBlock, RangedInline } from './types.ts';
import { inlineAt, inlineMapped, stripDeep, type LineSeg } from './inline.ts';

/** A source line plus its absolute offset, so ranges stay global. */
interface SrcLine {
  text: string;
  /** Absolute offset of the first character of this line. */
  offset: number;
}

function toLines(src: string): SrcLine[] {
  const out: SrcLine[] = [];
  let offset = 0;
  for (const text of src.split('\n')) {
    out.push({ text, offset });
    offset += text.length + 1; // +1 for the '\n'
  }
  return out;
}

const ATX = /^ {0,3}(#{1,6})(?:([ \t]+)(.*?))?[ \t]*#*[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^( *)([-*+])([ \t]+)(.*)$/;
const ORDERED = /^( *)(\d{1,9})([.)])([ \t]+)(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Fenced code languages that route to a dedicated renderer. */
const SPECIAL_FENCE_LANGS = new Set(['mermaid', 'svg']);

export function parseDocument(src: string): RangedBlock[] {
  const lines = toLines(src);
  const { blocks } = parseBlocks(lines, 0, lines.length);
  return blocks;
}

/** Convenience: parse and drop ranges. */
export function parseMarkdown(src: string): Block[] {
  return parseDocument(src).map((b) => stripBlock(b));
}

/** Drop range fields from a block and everything nested inside it. */
export function stripBlock({ srcStart: _s, srcEnd: _e, ...rest }: RangedBlock): Block {
  const b = rest as unknown as Block;
  switch (b.type) {
    case 'paragraph':
    case 'heading':
      return { ...b, children: stripDeep(b.children as RangedInline[]) };
    case 'quote':
      return { ...b, children: (b.children as RangedBlock[]).map((c) => stripBlock(c)) };
    case 'list':
      return {
        ...b,
        items: b.items.map((it) => ({
          ...it,
          children: (it.children as RangedBlock[]).map((c) => stripBlock(c)),
        })),
      };
    case 'table':
      return {
        ...b,
        header: b.header.map((row) => stripDeep(row as RangedInline[])),
        rows: b.rows.map((row) => row.map((cell) => stripDeep(cell as RangedInline[]))),
      };
    default:
      return b;
  }
}

/**
 * Parse `lines[from, to)` into blocks. The range is exclusive at `to`.
 */
function parseBlocks(lines: SrcLine[], from: number, to: number): { blocks: RangedBlock[]; next: number } {
  const blocks: RangedBlock[] = [];
  let i = from;

  while (i < to) {
    const line = lines[i]!;
    const t = line.text;

    // blank
    if (t.trim() === '') {
      i++;
      continue;
    }

    // --- fenced code / mermaid / svg -------------------------------------
    const fence = FENCE.exec(t);
    if (fence) {
      const { indent, marker, lang } = {
        indent: fence[1]!,
        marker: fence[2]!,
        lang: (fence[3] ?? '').toLowerCase(),
      };
      const markerChar = marker[0]!;
      // The closing fence must be the same character and at least as long.
      const closeRe = new RegExp(`^ {0,3}${markerChar === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      let j = i + 1;
      const body: string[] = [];
      while (j < to && !closeRe.test(lines[j]!.text)) {
        body.push(stripIndent(lines[j]!.text, indent.length));
        j++;
      }
      const endLine = j < to ? j + 1 : j;
      const start = line.offset;
      const end = endLine <= lines.length ? endOffsetOf(lines, endLine) : start;
      const value = body.join('\n');

      let block: Block;
      if (lang === 'mermaid') block = { type: 'mermaid', value };
      else if (lang === 'svg') block = { type: 'svg', value };
      else block = { type: 'code', lang: lang || null, value };

      blocks.push({ ...block, srcStart: start, srcEnd: end } as RangedBlock);
      i = endLine;
      continue;
    }

    // --- ATX heading -------------------------------------------------------
    const atx = ATX.exec(t);
    if (atx) {
      const depth = atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      // Content starts after the hashes *and* the whitespace that follows them;
      // parsing from just after the hashes would leave a leading space in the
      // first text node.
      // Content starts after the hashes *and* the whitespace that follows them;
      // parsing from just after the hashes would leave a leading space in the
      // first text node.
      const contentStart = line.offset + t.length - atx[3]!.length;
      blocks.push({
        type: 'heading',
        depth,
        children: inlineAt(atx[3]!, contentStart),
        srcStart: line.offset,
        srcEnd: line.offset + t.length,
      } as RangedBlock);
      i++;
      continue;
    }

    // --- thematic break ----------------------------------------------------
    // Checked before lists so `---` is a rule, not a setext underline.
    if (HR.test(t)) {
      blocks.push({
        type: 'hr',
        srcStart: line.offset,
        srcEnd: line.offset + t.length,
      } as RangedBlock);
      i++;
      continue;
    }

    // --- blockquote --------------------------------------------------------
    if (QUOTE.test(t)) {
      const { blocks: inner, next } = parseQuote(lines, i, to);
      blocks.push(inner);
      i = next;
      continue;
    }

    // --- table -------------------------------------------------------------
    if (t.includes('|') && i + 1 < to && TABLE_DELIM.test(lines[i + 1]!.text)) {
      const { blocks: table, next } = parseTable(lines, i, to);
      if (table) {
        blocks.push(table);
        i = next;
        continue;
      }
    }

    // --- list --------------------------------------------------------------
    if (BULLET.test(t) || ORDERED.test(t)) {
      const { blocks: list, next } = parseList(lines, i, to);
      blocks.push(list);
      i = next;
      continue;
    }

    // --- paragraph (greedy until a blank line or a block starter) ----------
    const start = line.offset;
    const para: string[] = [];
    const segs: LineSeg[] = [{ local: 0, abs: line.offset }];
    let j = i;
    while (j < to) {
      const lt = lines[j]!.text;
      if (lt.trim() === '') break;
      // Setext underline continues the paragraph as a heading. This must be
      // checked *before* the block-starters test, because `---` is both a
      // thematic break and a setext underline.
      if (j > i && /^ {0,3}(=+|-+)[ \t]*$/.test(lt)) {
        const depth = lt.trim().startsWith('=') ? 1 : 2;
        blocks.push({
          type: 'heading',
          depth: depth as 1 | 2,
          children: inlineMapped(para.join('\n'), segs),
          srcStart: start,
          srcEnd: endOffsetOf(lines, j + 1),
        } as RangedBlock);
        para.length = 0;
        j++;
        break;
      }
      // A line that starts a new block interrupts the paragraph.
      if (j > i && (ATX.test(lt) || FENCE.test(lt) || QUOTE.test(lt) || HR.test(lt) ||
          BULLET.test(lt) || ORDERED.test(lt))) {
        break;
      }
      if (para.length > 0) {
        segs.push({ local: para.join('\n').length + 1, abs: lines[j]!.offset });
      }
      para.push(lt);
      j++;
    }
    if (para.length > 0) {
      const text = para.join('\n');
      blocks.push({
        type: 'paragraph',
        children: inlineMapped(text, segs),
        srcStart: start,
        srcEnd: start + text.length,
      } as RangedBlock);
    }
    i = j > i ? j : i + 1;
  }

  return { blocks, next: i };
}

/** Consume a blockquote, stripping the `>` marker from each line. */
function parseQuote(lines: SrcLine[], from: number, to: number): { blocks: RangedBlock; next: number } {
  const inner: SrcLine[] = [];
  let j = from;
  while (j < to) {
    const m = QUOTE.exec(lines[j]!.text);
    if (m) {
      // Preserve absolute offsets: the content begins after `>` and one space.
      const consumed = lines[j]!.text.length - m[1]!.length;
      inner.push({ text: m[1]!, offset: lines[j]!.offset + consumed });
      j++;
      continue;
    }
    // A blank line ends the quote; anything else is a lazy continuation.
    if (lines[j]!.text.trim() === '') break;
    inner.push(lines[j]!);
    j++;
  }
  const { blocks } = parseBlocks(inner, 0, inner.length);
  const start = lines[from]!.offset;
  const end = j > from ? endOffsetOf(lines, j) : start;
  return {
    blocks: { type: 'quote', children: blocks, srcStart: start, srcEnd: end } as RangedBlock,
    next: j,
  };
}

/** Consume a GFM table starting at `from`. */
function parseTable(lines: SrcLine[], from: number, to: number): { blocks: RangedBlock | null; next: number } {
  const headerLine = lines[from]!;
  const delimLine = lines[from + 1]!;

  /**
   * Split a row on unescaped `|`, keeping each cell's absolute source offset.
   * Tracking offsets here (rather than searching for the cell text afterwards)
   * is what keeps inline ranges correct for repeated and empty cells.
   */
  const splitRow = (line: SrcLine): { text: string; offset: number }[] => {
    const s = line.text;
    const cells: { text: string; offset: number }[] = [];
    let start = 0;
    let endedWithPipe = false;

    for (let k = 0; k < s.length; k++) {
      const c = s[k]!;
      if (c === '\\' && k + 1 < s.length) {
        k++;
        continue;
      }
      if (c !== '|') continue;

      // A leading `|` is decoration, not a cell boundary.
      if (cells.length === 0 && start === 0 && k === 0) {
        start = 1;
        continue;
      }
      cells.push({ text: s.slice(start, k), offset: line.offset + start });
      start = k + 1;
      endedWithPipe = k === s.length - 1;
    }
    // `| a |` has one column, not two — a trailing pipe closes the last cell.
    if (!endedWithPipe) {
      cells.push({ text: s.slice(start), offset: line.offset + start });
    }
    return cells;
  };

  const parseRow = (line: SrcLine): RangedInline[][] =>
    splitRow(line).map((cell) => {
      const body = cell.text.trim();
      const lead = cell.text.length - cell.text.trimStart().length;
      return inlineAt(body, cell.offset + lead);
    });

  // Derived from the same splitter as the rows, so the column count of the
  // alignment row can never disagree with the header.
  const align: Align[] = splitRow(delimLine).map((cell) => {
    const c = cell.text.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center' as const;
    if (right) return 'right' as const;
    if (left) return 'left' as const;
    return null;
  });

  const header = parseRow(headerLine);
  const rows: Inline[][][] = [];
  let j = from + 2;
  while (j < to) {
    const lt = lines[j]!.text;
    if (lt.trim() === '' || !lt.includes('|')) break;
    rows.push(parseRow(lines[j]!));
    j++;
  }

  return {
    blocks: {
      type: 'table',
      align,
      header,
      rows,
      srcStart: headerLine.offset,
      srcEnd: endOffsetOf(lines, j),
    } as RangedBlock,
    next: j,
  };
}

interface ItemMatch {
  /** Leading indentation, i.e. nesting level. */
  indent: number;
  /** Everything after the marker and its padding. */
  body: string;
  /** Offset of `body` within the line. */
  bodyStart: number;
  ordinal: number;
}

/**
 * Read a list marker.
 *
 * The bullet and ordered patterns capture a different number of groups, so the
 * body index is resolved here rather than at each call site — reading the wrong
 * index silently yields an empty body, which loses every list item's text.
 */
function matchItem(t: string, ordered: boolean): ItemMatch | null {
  if (ordered) {
    const m = ORDERED.exec(t);
    if (!m) return null;
    const body = m[5]!;
    return { indent: m[1]!.length, body, bodyStart: t.length - body.length, ordinal: Number(m[2]) };
  }
  const m = BULLET.exec(t);
  if (!m) return null;
  const body = m[4]!;
  return { indent: m[1]!.length, body, bodyStart: t.length - body.length, ordinal: 1 };
}

/**
 * Consume a list starting at `from`.
 *
 * Items are collected as raw line groups (marker stripped, indentation
 * normalised) and then re-parsed as block sequences, which is what makes nested
 * lists fall out for free.
 */
function parseList(lines: SrcLine[], from: number, to: number): { blocks: RangedBlock; next: number } {
  const first = lines[from]!.text;
  const ordered = ORDERED.test(first);
  const firstMatch = matchItem(first, ordered)!;
  const baseIndent = firstMatch.indent;

  const items: { checked: boolean | null; lines: SrcLine[] }[] = [];
  let current: { checked: boolean | null; lines: SrcLine[] } | null = null;
  let j = from;
  let sawBlank = false;

  while (j < to) {
    const line = lines[j]!;
    const t = line.text;

    if (t.trim() === '') {
      sawBlank = true;
      // Keep the blank inside the current item; a following indented line
      // still belongs to it. A following non-indented line ends the list.
      if (current) current.lines.push({ text: '', offset: line.offset });
      j++;
      continue;
    }

    const indent = t.length - t.trimStart().length;
    const m = matchItem(t, ordered);
    const itemIndent = m ? m.indent : -1;

    if (m && itemIndent <= baseIndent) {
      // A sibling item. A blank line before it does *not* end the list —
      // CommonMark treats that as a "loose" list, and splitting here would
      // render two visually identical lists.
      const body = m.body;
      const bodyStart = line.offset + m.bodyStart;

      let checked: boolean | null = null;
      let bodyText = body;
      let bodyOff = bodyStart;
      const task = TASK.exec(body);
      if (task) {
        checked = task[1]!.toLowerCase() === 'x';
        bodyText = task[2]!;
        bodyOff = bodyStart + (body.length - task[2]!.length);
      }

      current = { checked, lines: [{ text: bodyText, offset: bodyOff }] };
      items.push(current);
      sawBlank = false;
      j++;
      continue;
    }

    if (m && itemIndent > baseIndent && current) {
      // A nested item. Hand it to the current item's own block parse with the
      // indentation removed, so recursion turns it into a nested list. Without
      // this the outer list stops and the nested list becomes a sibling.
      current.lines.push({ text: t.slice(itemIndent), offset: line.offset + itemIndent });
      sawBlank = false;
      j++;
      continue;
    }

    if (current && indent > baseIndent) {
      // Indented continuation: strip up to the content indent.
      const strip = Math.min(indent, baseIndent + 2);
      current.lines.push({ text: t.slice(strip), offset: line.offset + strip });
      j++;
      continue;
    }

    if (current && !sawBlank) {
      // Lazy continuation: an unindented line in the *same* paragraph.
      current.lines.push({ text: t, offset: line.offset });
      j++;
      continue;
    }

    // Unindented text after a blank line starts a new block, so the list is
    // over. Treating it as a continuation would swallow the rest of the note.
    break;
  }

  const listItems: ListItem[] = items.map((it) => ({
    checked: it.checked,
    children: parseBlocks(it.lines, 0, it.lines.length).blocks,
  }));

  return {
    blocks: {
      type: 'list',
      ordered,
      start: firstMatch.ordinal,
      items: listItems,
      srcStart: lines[from]!.offset,
      srcEnd: j > from ? endOffsetOf(lines, j) : lines[from]!.offset,
    } as unknown as RangedBlock,
    next: j,
  };
}

/** Absolute end offset just past line `idx` (i.e. including its newline). */
function endOffsetOf(lines: SrcLine[], idx: number): number {
  if (idx <= 0) return 0;
  const l = lines[idx - 1]!;
  return l.offset + l.text.length;
}

function stripIndent(text: string, n: number): string {
  let k = 0;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
  return text.slice(k);
}

function strip(nodes: RangedInline[]): Inline[] {
  return stripDeep(nodes);
}

export { SPECIAL_FENCE_LANGS };