/**
 * Note-level git operations.
 *
 * This module is the seam between "git" and "notes". It knows how to read a
 * file's content from three places (the working tree, a commit, a fetched ref),
 * which is all a three-way merge needs, and it hides isomorphic-git entirely so
 * the sync engine can be tested against fakes.
 */

import { merge3, type MergeResult } from '../merge/merge3.ts';
import { parseFrontmatter, bodyOf, fieldString, fieldList } from '../note/frontmatter.ts';
import type { GitOptions, HttpClient } from './types.ts';

/**
 * Everything the sync engine needs from "storage", independent of git.
 *
 * Keeping this narrow is what makes the conflict-handling logic testable: the
 * engine can be driven with an in-memory implementation and no git at all.
 */
export interface NoteStore {
  /** Read the current working-tree content of a note path. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(): Promise<string[]>;
}

/** Content of one file at three points in history. */
export interface TriVersion {
  base: string | null;
  local: string | null;
  remote: string | null;
}

export type MergeOutcome =
  | { kind: 'clean'; content: string; changed: boolean }
  | { kind: 'unchanged' }
  | { kind: 'conflict'; result: MergeResult; content: string }
  /** One side deleted the file while the other modified it. */
  | { kind: 'delete-modify'; winner: 'local' | 'remote' | 'conflict'; content: string | null };

/**
 * Decide what a note's content should be after a sync.
 *
 * The delete/modify cases are handled explicitly because they have no natural
 * diff3 answer: `base` exists, one side is null. Silently preferring one side
 * would discard someone's edits, so anything but "both deleted" escalates.
 */
export function resolveNote(v: TriVersion): MergeOutcome {
  const { base, local, remote } = v;

  // Both deleted, or nothing changed at all.
  if (local === null && remote === null) {
    return base === null ? { kind: 'unchanged' } : { kind: 'clean', content: '', changed: true };
  }

  // Only one side has it and the other deleted it.
  if (remote === null && local !== null) {
    if (base === null) return { kind: 'clean', content: local, changed: true };
    return { kind: 'delete-modify', winner: 'conflict', content: local };
  }
  if (local === null && remote !== null) {
    if (base === null) return { kind: 'clean', content: remote, changed: true };
    return { kind: 'delete-modify', winner: 'conflict', content: remote };
  }

  // Both present. `base` is null only when the file is new on both sides.
  const baseText = base ?? '';
  const result = merge3(baseText, local!, remote!);

  if (!result.clean) {
    return { kind: 'conflict', result, content: result.text };
  }

  const localChanged = local !== baseText;
  const remoteChanged = remote !== baseText;

  if (!localChanged && !remoteChanged) return { kind: 'unchanged' };

  return { kind: 'clean', content: result.text, changed: true };
}

// ---------------------------------------------------------------------------
// Note metadata, read from frontmatter
// ---------------------------------------------------------------------------

export interface NoteMeta {
  title: string | null;
  tags: string[];
  created: string | null;
  updated: string | null;
}

/** Derive display metadata, falling back to the filename. */
export function readMeta(path: string, content: string): NoteMeta {
  const fm = parseFrontmatter(content);
  return {
    title: fieldString(fm, 'title') ?? fallbackTitle(path),
    tags: fieldList(fm, 'tags'),
    created: fieldString(fm, 'created'),
    updated: fieldString(fm, 'updated'),
  };
}

function fallbackTitle(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/, '');
}

/**
 * First non-empty body line, used as a fallback title when a note has no
 * frontmatter title.
 */
export function firstLine(content: string): string | null {
  const body = bodyOf(content);
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    return t.replace(/^#+\s*/, '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git-backed implementation
// ---------------------------------------------------------------------------

/**
 * Read blobs for a set of paths from a given commit.
 *
 * isomorphic-git is imported lazily so that tests which only exercise the pure
 * merge logic never load it (and never need a real filesystem).
 */
export async function readAtRef(
  opts: Pick<GitOptions, 'fs' | 'dir'>,
  ref: string | null,
  paths: string[],
): Promise<Map<string, string | null>> {
  if (ref === null) {
    const out = new Map<string, string | null>();
    for (const p of paths) out.set(p, null);
    return out;
  }

  const git = await import('isomorphic-git');
  const out = new Map<string, string | null>();

  // `readBlob` requires a commit oid, not a symbolic ref, so the ref has to be
  // resolved first. A ref that does not exist is treated as "no base".
  let oid: string;
  try {
    oid = await git.resolveRef({ fs: opts.fs as never, dir: opts.dir, ref });
  } catch {
    for (const p of paths) out.set(p, null);
    return out;
  }

  const decoder = new TextDecoder();
  for (const path of paths) {
    try {
      const { blob } = await git.readBlob({
        fs: opts.fs as never,
        dir: opts.dir,
        oid,
        filepath: path,
      });
      out.set(path, decoder.decode(blob));
    } catch {
      // A path absent from this commit simply has no base version.
      out.set(path, null);
    }
  }
  return out;
}

export async function listNotesAtRef(
  opts: Pick<GitOptions, 'fs' | 'dir'>,
  ref: string,
): Promise<string[]> {
  const git = await import('isomorphic-git');
  const files = await git.listFiles({ fs: opts.fs as never, dir: opts.dir, ref });
  return files.filter((f) => f.endsWith('.md'));
}

export function transportIsSet(_http: HttpClient): boolean {
  return true;
}