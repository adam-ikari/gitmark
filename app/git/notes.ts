/**
 * Reading and writing one note.
 *
 * The two operations the screens need that `GitNotes` does not expose, kept
 * separate so a screen never reaches for expo-file-system directly. Paths are
 * repo-relative and POSIX here; the `file://` scheme is added at the expo
 * boundary for the same reason isomorphic-git never sees one.
 *
 * `writeNote` refuses to write text that still carries conflict markers.
 *
 * That check is not this module's business — a note may legitimately be written
 * mid-conflict, since that is how the markers get there. It is here because
 * every path that writes a *resolved* note goes through this file, and the one
 * outcome the whole merge design exists to prevent is a resolved-looking file
 * being pushed with markers still inside it. `assertResolved` lives in core so
 * the rule is testable; this is the enforcement point.
 */

import { assertResolved } from '../../core/merge/resolve.ts';
import { expoFile } from './expoFs.ts';

/** Read one note, or null when it is absent or unreadable. */
export async function readNote(dir: string, path: string): Promise<string | null> {
  try {
    const file = await expoFile(`${dir}/${path}`.replace(/\/+/g, '/'));
    if (!file.exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

/**
 * Write one note, creating its folder if needed.
 *
 * `guard` is passed explicitly rather than always on: writing the conflicted
 * text is how markers get into the file in the first place, so the check cannot
 * be unconditional.
 */
export async function writeNote(
  dir: string,
  path: string,
  content: string,
  options: { guard?: boolean } = {},
): Promise<void> {
  if (options.guard) assertResolved(content);

  const file = await expoFile(`${dir}/${path}`.replace(/\/+/g, '/'));
  // `intermediates` because a note can be the first file in a new folder.
  file.create({ intermediates: true, overwrite: true });
  file.write(content);
}

/** Whether a note exists. */
export async function noteExists(dir: string, path: string): Promise<boolean> {
  try {
    return (await expoFile(`${dir}/${path}`.replace(/\/+/g, '/'))).exists;
  } catch {
    return false;
  }
}

/** Delete a note. Missing is not an error. */
export async function deleteNote(dir: string, path: string): Promise<void> {
  try {
    const file = await expoFile(`${dir}/${path}`.replace(/\/+/g, '/'));
    if (file.exists) file.delete();
  } catch {
    /* already gone */
  }
}