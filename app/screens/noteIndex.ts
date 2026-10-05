/**
 * Turning the working tree into a note list.
 *
 * Separate from the screen because these are the decisions a user notices
 * immediately — a list of `.md` filenames, or a conflict buried at the bottom —
 * and because `.tsx` cannot be imported by `node --test`, so logic inside a
 * screen component cannot be tested at all.
 */

import { readMeta } from '../../core/git/store.ts';
import { hasUnresolvedConflict } from '../../core/merge/markers.ts';

export interface NoteListItem {
  path: string;
  title: string;
  tags: string[];
  conflicted: boolean;
}

/**
 * Build list items from path/content pairs.
 *
 * A note is in the list because it is in the repository, so a `null` content —
 * present in git, absent on disk — still produces a row. Hiding it would make a
 * sync state invisible at exactly the moment it matters.
 *
 * Metadata is read, never written: a note that has never had frontmatter should
 * not grow a block just from being listed.
 */
export function toNoteList(entries: Iterable<[string, string | null]>): NoteListItem[] {
  const items: NoteListItem[] = [];
  for (const [path, content] of entries) {
    const meta = content === null ? null : readMeta(path, content);
    items.push({
      path,
      title: meta?.title ?? path,
      tags: meta?.tags ?? [],
      conflicted: content !== null && hasUnresolvedConflict(content),
    });
  }
  return items;
}

/** Conflicted notes first, then alphabetical. */
export function sortNotes(items: readonly NoteListItem[]): NoteListItem[] {
  return [...items].sort((a, b) => {
    if (a.conflicted !== b.conflicted) return a.conflicted ? -1 : 1;
    return a.title.localeCompare(b.title, 'zh-Hant');
  });
}

/** How many notes need a human. */
export function conflictCount(items: readonly NoteListItem[]): number {
  return items.filter((item) => item.conflicted).length;
}