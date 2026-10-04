/**
 * Inline markdown parser.
 *
 * Scans left to right, and when it meets a construct opener it locates the
 * matching closer and recurses into the contents. That structure gives us
 * source ranges for free, which the editor needs to translate a caret position
 * into a node.
 *
 * Precedence, highest first:
 *   1. backslash escape
 *   2. code span        (contents are literal)
 *   3. autolink / raw html
 *   4. image
 *   5. link
 *   6. strong / em / strike
 *
 * Deliberately not implemented (out of scope for a note app, and cheap to add
 * later): reference links, nested block constructs, HTML blocks.
 */

import type { Inline, RangedInline } from './types.ts';

const ESCAPABLE = new Set([
  '\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!',
  '|', '<', '>', '~',
]);

/**
 * Characters that may be backslash-escaped. Kept as a Set for O(1) lookup in
 * the hot scan loop.
 */
function isEscapable(c: string): boolean {
  return ESCAPABLE.has(c);
}

/**
 * Find the index of the closing delimiter that pairs with an opener at `from`.
 *
 * Scanning forward we must skip over escapes and complete code spans so that
 * `**a ` b**` does not close inside the code span.
 *
 * @param src    full source
 * @param from   index just past the opener
 * @param delim  the delimiter text being matched (e.g. '**', '*', '~~')
 * @returns index of the closer, or -1 when there is none
 */
function findCloser(src: string, from: number, delim: string): number {
  let i = from;
  while (i < src.length) {
    const c = src[i]!;

    if (c === '\\' && i + 1 < src.length) {
      i += 2;
      continue;
    }

    // Skip whole code spans so delimiters inside them are literal.
    if (c === '`') {
      const runStart = i;
      while (i < src.length && src[i] === '`') i++;
      const runLen = i - runStart;
      const close = src.indexOf('`'.repeat(runLen), i);
      if (close === -1) return -1;
      i = close + runLen;
      continue;
    }

    if (src.startsWith(delim, i)) return i;

    i++;
  }
  return -1;
}

/**
 * CommonMark-ish flanking test, simplified.
 *
 * The goal is narrow: stop `2 * 3 * 4` and `snake_case_name` from turning into
 * emphasis, while keeping `**bold**`, `*em*` and intra-word `**` working.
 *
 * A run is left-flanking if it is not followed by whitespace, and either not
 * followed by punctuation or preceded by whitespace/punctuation.
 */
function isLeftFlanking(text: string, runEnd: number, runLen: number): boolean {
  const after = text[runEnd];
  const before = runEnd - runLen > 0 ? text[runEnd - runLen - 1] : undefined;

  const afterIsWs = after === undefined || /\s/.test(after);
  const afterIsPunct = after !== undefined && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(after);
  const beforeIsWs = before === undefined || /\s/.test(before);
  const beforeIsPunct =
    before !== undefined && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(before);

  if (afterIsWs) return false;
  if (!afterIsPunct) return true;
  return beforeIsWs || beforeIsPunct;
}

/** A run is right-flanking by the mirrored rule. */
function isRightFlanking(text: string, runStart: number, runLen: number): boolean {
  const before = runStart > 0 ? text[runStart - 1] : undefined;
  const after = text[runStart + runLen];

  const beforeIsWs = before === undefined || /\s/.test(before);
  const beforeIsPunct =
    before !== undefined && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(before);
  const afterIsWs = after === undefined || /\s/.test(after);
  const afterIsPunct = after !== undefined && /[!"#$%&'()*+,\-./:@[\\\]^_`{|}~-]/.test(after);

  if (beforeIsWs) return false;
  if (!beforeIsPunct) return true;
  return afterIsWs || afterIsPunct;
}

/**
 * May this delimiter run open emphasis?
 *
 * This asymmetry is verified against markdown-it and commonmark, not guessed:
 *   `a**b**c` → strong, `a~~b~~c` → strike (GFM), `a*b*c` → em,
 *   but `a_b_c` → literal and `foo__bar__baz` → literal.
 *
 * So `*` and `~` need nothing beyond left-flanking, while `_` additionally
 * requires (not right-flanking OR preceded by punctuation). That guard is what
 * keeps `snake_case_name` intact — which matters in technical notes, where
 * snake_case identifiers are everywhere. It also means `中文__粗體__` stays
 * literal while `中文**粗體**` renders bold, exactly as both references do.
 */
function canOpenEmphasis(src: string, runStart: number, runLen: number): boolean {
  const c = src[runStart]!;
  if (!isLeftFlanking(src, runStart + runLen, runLen)) return false;
  if (c === '*' || c === '~') return true;
  if (!isRightFlanking(src, runStart, runLen)) return true;
  const before = runStart > 0 ? src[runStart - 1] : undefined;
  return before !== undefined && isPunctuation(before);
}

function isPunctuation(c: string): boolean {
  return /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(c);
}

/** Parse the inside of a code span: strip one leading+trailing space pair. */
function parseCodeSpan(raw: string): string {
  return raw.replace(/^ (.*) $/s, '$1').replace(/^ (.*)$/s, '$1');
}

/** Parse a link/image destination, tolerating <angle-bracket> form. */
function parseDestination(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
  return t;
}

/** Split `dest "title"` into its parts. */
function parseLinkTarget(raw: string): { dest: string; title: string | null } {
  const t = raw.trim();
  if (!t.startsWith('<')) {
    const m = /^(.*?)\s+(?:"([^"]*)"|'([^']*)')$/s.exec(t);
    if (m) {
      const title = m[2] ?? m[3] ?? null;
      return { dest: parseDestination(m[1] ?? ''), title };
    }
  }
  return { dest: parseDestination(t), title: null };
}

/**
 * Parse inline markdown within `[srcStart, srcEnd)`.
 *
 * @param srcStart absolute index into the source document
 */
export function parseInlineRange(src: string, srcStart: number, srcEnd: number): RangedInline[] {
  const out: RangedInline[] = [];
  let buf = '';
  let bufStart = srcStart;

  const flush = (end: number) => {
    if (buf.length > 0) {
      out.push({ type: 'text', value: buf, srcStart: bufStart, srcEnd: end });
      buf = '';
    }
  };

  let i = srcStart;

  const push = (node: Inline, start: number, end: number) => {
    flush(start);
    out.push({ ...node, srcStart: start, srcEnd: end } as RangedInline);
    bufStart = end;
  };

  while (i < srcEnd) {
    const c = src[i]!;

    // --- 1. backslash escape -------------------------------------------------
    if (c === '\\' && i + 1 < srcEnd) {
      const next = src[i + 1]!;
      if (next === '\n') {
        push({ type: 'hardbreak' }, i, i + 2);
        i += 2;
        bufStart = i;
        continue;
      }
      if (isEscapable(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    // --- 2. code span -------------------------------------------------------
    if (c === '`') {
      const runStart = i;
      while (i < srcEnd && src[i] === '`') i++;
      const runLen = i - runStart;
      const fence = '`'.repeat(runLen);
      const close = src.indexOf(fence, i);
      if (close !== -1 && close < srcEnd) {
        const raw = src.slice(i, close);
        // A code span that only contains whitespace is not a code span.
        if (raw.trim().length > 0 || raw.length === 0) {
          push({ type: 'code', value: parseCodeSpan(raw) }, runStart, close + runLen);
          i = close + runLen;
          bufStart = i;
          continue;
        }
      }
      i = runStart;
    }

    // --- 3. autolink <https://…> -------------------------------------------
    if (c === '<' && src[i + 1] !== '<' && src[i + 1] !== ' ') {
      const close = src.indexOf('>', i);
      if (close !== -1 && close < srcEnd) {
        const inner = src.slice(i + 1, close);
        if (/^(https?:\/\/|mailto:)\S+$/.test(inner)) {
          push(
            {
              type: 'link',
              href: inner,
              title: null,
              children: [{ type: 'text', value: inner }],
            },
            i,
            close + 1,
          );
          i = close + 1;
          bufStart = i;
          continue;
        }
      }
    }

    // --- 4/5. image and link -----------------------------------------------
    // `[` may open a link, `![` an image. Resolve the opening bracket first,
    // then look for the `(dest)` suffix which both share.
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const bracket = isImage ? i + 1 : i;
      const labelEnd = matchBracket(src, bracket, srcEnd);
      if (labelEnd !== -1 && src[labelEnd + 1] === '(') {
        const parenEnd = matchParen(src, labelEnd + 1, srcEnd);
        if (parenEnd !== -1) {
          const label = src.slice(bracket + 1, labelEnd);
          const { dest, title } = parseLinkTarget(src.slice(labelEnd + 2, parenEnd));
          if (isImage) {
            push({ type: 'image', src: dest, alt: label, title }, i, parenEnd + 1);
          } else {
            push(
              {
                type: 'link',
                href: dest,
                title,
                children: parseInlineRange(src, bracket + 1, labelEnd),
              },
              i,
              parenEnd + 1,
            );
          }
          i = parenEnd + 1;
          bufStart = i;
          continue;
        }
      }
      if (isImage) {
        // A lone '!' is just text.
        buf += '!';
        i += 1;
        continue;
      }
    }

    // --- 6. strong / em / strike -------------------------------------------
    if (c === '~' || c === '*' || c === '_') {
      let runLen = 0;
      while (i + runLen < srcEnd && src[i + runLen] === c) runLen++;
      const delim = c.repeat(runLen);
      const afterRun = i + runLen;

      // A lone `~` is not emphasis in GFM — only `~~` is strikethrough.
      const runIsConstruct = c !== '~' || runLen >= 2;

      const close = runIsConstruct && canOpenEmphasis(src, i, runLen)
        ? findCloser(src, afterRun, delim)
        : -1;

      if (close !== -1 && close < srcEnd && isRightFlanking(src, close, runLen) &&
          close > afterRun) {
        // `***x***` is em[strong[x]] — verified against markdown-it/commonmark.
        const triple = runLen >= 3;
        const innerStart = triple ? i + 3 : i + runLen;
        const innerEnd = close;
        const leaf: Inline =
          runLen === 1
            ? { type: 'em', children: parseInlineRange(src, innerStart, innerEnd) }
            : c === '~'
              ? { type: 'strike', children: parseInlineRange(src, innerStart, innerEnd) }
              : { type: 'strong', children: parseInlineRange(src, innerStart, innerEnd) };

        if (triple) {
          // `***x***` is em[strong[x]]. The inner strong node must carry real
          // ranges, because the editor maps a caret onto them — leaving it
          // range-less makes its srcStart/srcEnd undefined, which silently
          // breaks mark toggling.
          const strong: RangedInline = {
            ...leaf,
            srcStart: i + 1,
            srcEnd: close + 2,
          } as RangedInline;
          push({ type: 'em', children: [strong] }, i, close + 3);
        } else {
          push(leaf, i, close + runLen);
        }
        i = close + (triple ? 3 : runLen);
        bufStart = i;
        continue;
      }

      // Not a construct. Consume the *whole run* as literal text — advancing
      // one character would let the second delimiter of the run re-trigger as
      // a fresh opener, turning `foo__bar__baz` into emphasis.
      buf += delim;
      i += runLen;
      continue;
    }

    // --- breaks -------------------------------------------------------------
    if (c === '\n') {
      // Two or more trailing spaces before the newline make it a hard break.
      const trailing = countTrailingSpaces(buf);
      if (trailing >= 2) {
        buf = buf.slice(0, buf.length - 2);
        push({ type: 'hardbreak' }, i, i + 1);
        i += 1;
        bufStart = i;
        continue;
      }
      buf = buf.slice(0, buf.length - trailing);
      push({ type: 'softbreak' }, i, i + 1);
      i += 1;
      bufStart = i;
      continue;
    }

    buf += c;
    i++;
  }

  flush(srcEnd);
  return out;
}

function countTrailingSpaces(s: string): number {
  let n = 0;
  for (let k = s.length - 1; k >= 0 && s[k] === ' '; k--) n++;
  return n;
}

/**
 * Given the index of an opening `[`, return the index of its matching `]`,
 * honouring nesting and backslash escapes. Returns -1 when unbalanced.
 */
function matchBracket(src: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = src[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      const close = src.indexOf('`', i + 1);
      if (close !== -1 && close < limit) {
        i = close;
        continue;
      }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Given the index of an opening `(`, return the index of its matching `)`. */
function matchParen(src: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = src[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse a whole string as inline markdown. Offsets are relative to `src`. */
export function parseInline(src: string): Inline[] {
  return parseInlineRange(src, 0, src.length).map(stripRange);
}

/** Drop the range annotations from one node, leaving a plain AST node. */
export function stripRange({ srcStart: _s, srcEnd: _e, ...rest }: RangedInline): Inline {
  return rest as Inline;
}

/** Drop the range annotations from a list of nodes. */
export function stripRanges(nodes: RangedInline[]): Inline[] {
  return nodes.map(stripRange);
}

/**
 * Rewrite every descendant's source range through `map`, recursively.
 *
 * `map` exists because the text handed to the scanner is not always a verbatim
 * slice of the document: a table cell is trimmed and a list item line is
 * dedented. Scanning such text with absolute offsets indexes past the end of
 * the buffer, so callers scan with local indices and re-map afterwards.
 */
export function remapInline(nodes: RangedInline[], map: (local: number) => number): RangedInline[] {
  return nodes.map((node) => {
    const { srcStart, srcEnd, ...rest } = node;
    const shape = remapShape(rest as unknown as Inline, map);
    return { ...shape, srcStart: map(srcStart), srcEnd: map(srcEnd) } as RangedInline;
  });
}

function remapShape(node: Inline, map: (local: number) => number): Inline {
  switch (node.type) {
    case 'strong':
    case 'em':
    case 'strike':
    case 'link':
      return { ...node, children: remapInline(node.children as RangedInline[], map) } as Inline;
    default:
      return node;
  }
}

/** Where one source line sits inside a joined buffer, and in the document. */
export interface LineSeg {
  /** Offset of this line's text inside the joined buffer. */
  local: number;
  /** Absolute document offset of the same character. */
  abs: number;
}

/** Translate a local offset in a joined buffer to a document offset. */
export function localToAbsolute(segs: readonly LineSeg[], local: number): number {
  if (segs.length === 0) return local;
  let best = segs[0]!;
  for (const s of segs) {
    if (s.local <= local) best = s;
    else break;
  }
  return best.abs + (local - best.local);
}

/**
 * Scan `text` with local indices and return nodes whose ranges are expressed in
 * document coordinates via `segs`.
 */
export function inlineMapped(text: string, segs: readonly LineSeg[]): RangedInline[] {
  return remapInline(parseInlineRange(text, 0, text.length), (l) => localToAbsolute(segs, l));
}

/**
 * Convenience for the common case: the scanned text is a contiguous slice of
 * the document starting at `base`.
 */
export function inlineAt(text: string, base: number): RangedInline[] {
  return remapInline(parseInlineRange(text, 0, text.length), (l) => base + l);
}

/** Drop range fields recursively, leaving plain AST nodes. */
export function stripDeep(nodes: RangedInline[]): Inline[] {
  return nodes.map(stripDeepNode);
}

function stripDeepNode(node: RangedInline): Inline {
  const { srcStart: _s, srcEnd: _e, ...rest } = node;
  const shape = rest as unknown as Inline;
  switch (shape.type) {
    case 'strong':
    case 'em':
    case 'strike':
    case 'link':
      return { ...shape, children: stripDeep(shape.children as RangedInline[]) } as Inline;
    default:
      return shape;
  }
}
