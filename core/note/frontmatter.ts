/**
 * YAML-ish frontmatter, delimited by `---` fences at the very start of a note.
 *
 * Scope is deliberately narrow: a flat `key: value` map with optional quotes,
 * plus list values written inline (`tags: [a, b]`) or as `- item` lines. That
 * covers note metadata (title, tags, dates) without pulling in a YAML parser,
 * which would be a large dependency for a format we also have to keep stable in
 * git.
 *
 * The parser is lossless about *placement* — it reports exactly which byte range
 * the frontmatter occupies — so editing a note's body never risks rewriting its
 * metadata, and vice versa.
 */

export interface Frontmatter {
  /** Scalar and list values, in source order. */
  fields: Record<string, string | string[]>;
  /** Offset of the opening `---`, i.e. where a rewrite would start. */
  start: number;
  /** Offset just past the closing fence line. */
  end: number;
  /** True when the document had no frontmatter block. */
  present: boolean;
}

const FENCE = /^---[ \t]*\r?$/;

export function parseFrontmatter(source: string): Frontmatter {
  // A frontmatter block must open on the very first line. Tolerating a UTF-8
  // BOM avoids a confusing "no frontmatter" on notes exported from some tools.
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const bom = source.startsWith('\uFEFF') ? 1 : 0;

  const lines = text.split('\n');
  if (lines.length === 0 || !FENCE.test(lines[0]!)) {
    return { fields: {}, start: 0, end: 0, present: false };
  }

  const fields: Record<string, string | string[]> = {};
  let offset = bom + (lines[0]!.length + 1);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;

    if (FENCE.test(line)) {
      return { fields, start: bom, end: offset + line.length, present: true };
    }

    // `key: value`
    const kv = /^([A-Za-z0-9_.\-\u4e00-\u9fff]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1]!;
      const raw = kv[2]!.trim();
      if (raw === '') {
        // Either an empty value or the head of a `- item` list.
        const listStart = i + 1;
        const listStop = listEnd(lines, listStart);
        const list = collectList(lines, listStart);
        fields[key] = list.length > 0 ? list : '';
        // Advance past the key line *and* every list line consumed, otherwise
        // `offset` drifts and the reported block range is wrong.
        for (let k = i; k < listStop; k++) offset += lines[k]!.length + 1;
        i = listStop - 1;
        continue;
      }
      fields[key] = parseScalar(raw);
      offset += line.length + 1;
      continue;
    }

    offset += line.length + 1;
  }

  // Unterminated block: treat the whole document as having no frontmatter,
  // because a half-open block is more likely a stray `---` than real metadata.
  return { fields: {}, start: 0, end: 0, present: false };
}

const ITEM = /^[ \t]*-[ \t]+/;

/** Read the run of `- item` lines starting at `from`. */
function collectList(lines: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < lines.length && ITEM.test(lines[i]!); i++) {
    out.push(unquote(lines[i]!.replace(ITEM, '').trim()));
  }
  return out;
}

/** Index one past the last `- item` line. */
function listEnd(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && ITEM.test(lines[i]!)) i++;
  return i;
}

function parseScalar(raw: string): string | string[] {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => unquote(s.trim()));
  }
  return unquote(raw);
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** The note body with frontmatter removed. */
export function bodyOf(source: string): string {
  const fm = parseFrontmatter(source);
  if (!fm.present) return source;
  return source.slice(fm.end).replace(/^\r?\n/, '');
}

/**
 * Replace the frontmatter block, leaving the body byte-identical.
 *
 * Returns the source unchanged when there was no block and `fields` is empty,
 * so a note that never had metadata does not grow a block just from being read.
 */
export function withFrontmatter(source: string, fields: Record<string, string | string[]>): string {
  const fm = parseFrontmatter(source);
  const body = bodyOf(source);
  if (!fm.present && Object.keys(fields).length === 0) return source;
  return `${renderFrontmatter(fields)}${body}`;
}

export function renderFrontmatter(fields: Record<string, string | string[]>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quoteIfNeeded(item)}`);
      continue;
    }
    lines.push(`${key}: ${quoteIfNeeded(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function quoteIfNeeded(s: string): string {
  if (s === '') return '""';
  if (/^[\s]|[\s]$|[:#]|^["'[\]]|,/.test(s)) {
    return /[:#]/.test(s) ? JSON.stringify(s) : JSON.stringify(s);
  }
  return s;
}

/** Convenience readers used by the note list. */
export function fieldString(fm: Frontmatter, key: string): string | null {
  const v = fm.fields[key];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function fieldList(fm: Frontmatter, key: string): string[] {
  const v = fm.fields[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : v === '' ? [] : [v];
}