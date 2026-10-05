/**
 * A small XML reader for SVG, producing a shape tree the renderer can consume.
 *
 * Lives in core rather than the app so it is testable under `node --test`
 * without a renderer. It is deliberately not a general XML parser: it handles
 * what SVG in a note actually uses, and rejects the rest loudly rather than
 * guessing.
 *
 * Unsupported elements are preserved in the tree with `unsupported: true` so the
 * UI can show a placeholder instead of silently dropping part of a diagram.
 */

export type SvgNode = SvgElement | SvgText;

export interface SvgElement {
  kind: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: SvgNode[];
  /** Source offset, for diagnostics. */
  at: number;
  unsupported?: boolean;
}

export interface SvgText {
  kind: 'text';
  value: string;
  at: number;
}

export interface SvgDocument {
  root: SvgElement | null;
  /** viewBox in user units, when the root declared one. */
  viewBox: { x: number; y: number; width: number; height: number } | null;
  width: number | null;
  height: number | null;
}

const VOID_OK = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use', 'stop', 'image']);

/** Tags we can render. Anything else is flagged so the UI can say so. */
export const SUPPORTED_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'title', 'desc', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask',
]);

export class SvgParseError extends Error {
  /** Byte offset in the source where the problem was found. */
  readonly at: number;

  constructor(message: string, at: number) {
    super(`${message} (at offset ${at})`);
    this.name = 'SvgParseError';
    this.at = at;
  }
}

interface Token {
  type: 'open' | 'close' | 'selfclose' | 'text' | 'cdata';
  name?: string;
  attrs?: Record<string, string>;
  value?: string;
  at: number;
}

/** Tokenise SVG source. Throws on malformed input rather than guessing. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  while (i < src.length) {
    if (src[i] !== '<') {
      const start = i;
      while (i < src.length && src[i] !== '<') i++;
      const value = src.slice(start, i);
      if (value.trim() !== '') tokens.push({ type: 'text', value: decodeEntities(value), at: start });
      continue;
    }

    // Comment, CDATA, doctype or processing instruction.
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      if (end === -1) throw new SvgParseError('unterminated comment', i);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      if (end === -1) throw new SvgParseError('unterminated CDATA', i);
      tokens.push({ type: 'cdata', value: src.slice(i + 9, end), at: i });
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', i) || src.startsWith('<!', i)) {
      const end = src.indexOf('>', i);
      if (end === -1) throw new SvgParseError('unterminated declaration', i);
      i = end + 1;
      continue;
    }

    const isClose = src[i + 1] === '/';
    const start = i;
    i += isClose ? 2 : 1;

    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(src.slice(i));
    if (!nameMatch) throw new SvgParseError('expected a tag name', start);
    const name = nameMatch[0];
    i += name.length;

    if (isClose) {
      skipSpace();
      if (src[i] !== '>') throw new SvgParseError('unterminated close tag', start);
      i++;
      tokens.push({ type: 'close', name, at: start });
      continue;
    }

    // `readAttributes` stops on `>` or `/`, so the cursor must come back for
    // the tag terminator to be read here.
    const cur: Cursor = { i };
    const attrs = readAttributes(src, cur, start);
    i = cur.i;
    skipSpace();
    const selfClose = src[i] === '/';
    if (selfClose) i++;
    if (src[i] !== '>') throw new SvgParseError(`unterminated tag <${name}>`, start);
    i++;

    tokens.push({ type: selfClose ? 'selfclose' : 'open', name, attrs, at: start });
  }

  return tokens;
}

/** A mutable cursor, so callers can advance it without returning a value. */
interface Cursor {
  i: number;
}

function readAttributes(src: string, cur: Cursor, tagStart: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  const skipSpace = () => {
    while (cur.i < src.length && /\s/.test(src[cur.i]!)) cur.i++;
  };

  for (;;) {
    skipSpace();
    if (cur.i >= src.length) throw new SvgParseError('unterminated tag', tagStart);

    const ch = src[cur.i]!;
    if (ch === '>' || ch === '/') return attrs;

    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(src.slice(cur.i));
    if (!nameMatch) throw new SvgParseError(`malformed attribute near ${JSON.stringify(ch)}`, cur.i);
    const key = nameMatch[0];
    cur.i += key.length;
    skipSpace();

    if (src[cur.i] !== '=') {
      // Valueless attribute, e.g. `hidden`.
      attrs[key] = '';
      continue;
    }
    cur.i++;
    skipSpace();

    const quote = src[cur.i];
    if (quote !== '"' && quote !== "'") throw new SvgParseError(`unquoted value for ${key}`, cur.i);
    cur.i++;
    const end = src.indexOf(quote, cur.i);
    if (end === -1) throw new SvgParseError(`unterminated value for ${key}`, cur.i);
    attrs[key] = decodeEntities(src.slice(cur.i, end));
    cur.i = end + 1;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse SVG source into a document with a viewBox when one can be derived. */
export function parseSvg(src: string): SvgDocument {
  const tokens = tokenize(src);
  const stack: SvgElement[] = [];
  let root: SvgElement | null = null;

  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
      case 'cdata': {
        const parent = stack[stack.length - 1];
        if (parent) {
          const value = tok.type === 'cdata' ? tok.value : tok.value;
          const last = parent.children[parent.children.length - 1];
          if (last && last.kind === 'text') {
            last.value += value ?? '';
          } else {
            parent.children.push({ kind: 'text', value: value ?? '', at: tok.at });
          }
        }
        break;
      }

      case 'open':
      case 'selfclose': {
        const name = tok.name!;
        const el: SvgElement = {
          kind: 'element',
          tag: name,
          attrs: tok.attrs ?? {},
          children: [],
          at: tok.at,
          unsupported: !SUPPORTED_TAGS.has(name),
        };

        if (stack.length === 0) {
          // A second root element is a malformed document.
          if (root !== null) throw new SvgParseError('more than one root element', tok.at);
          root = el;
        } else {
          stack[stack.length - 1]!.children.push(el);
        }

        if (tok.type === 'open' && !VOID_OK.has(name)) stack.push(el);
        break;
      }

      case 'close': {
        const open = stack.pop();
        if (!open) throw new SvgParseError(`unexpected </${tok.name}>`, tok.at);
        if (open.tag !== tok.name) {
          throw new SvgParseError(`</${tok.name}> does not close <${open.tag}>`, tok.at);
        }
        break;
      }
    }
  }

  if (stack.length > 0) {
    throw new SvgParseError(`unclosed <${stack[stack.length - 1]!.tag}>`, stack[stack.length - 1]!.at);
  }
  if (root === null) throw new SvgParseError('no root element', 0);
  if (root.tag !== 'svg') throw new SvgParseError(`root must be <svg>, found <${root.tag}>`, root.at);

  return { root, viewBox: readViewBox(root), width: readLength(root.attrs.width), height: readLength(root.attrs.height) };
}

function readViewBox(root: SvgElement) {
  const raw = root.attrs.viewBox ?? root.attrs.viewbox;
  if (!raw) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
}

/** Parse a CSS length, ignoring units other than px (the only one we honour). */
export function readLength(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Every element in the tree, depth first. */
export function* walkSvg(node: SvgNode): Generator<SvgElement> {
  if (node.kind !== 'element') return;
  yield node;
  for (const child of node.children) yield* walkSvg(child);
}