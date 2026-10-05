/**
 * Assembling a usable git workspace on a device.
 *
 * Everything here is a composition decision — where the repo lives, how the
 * transport gets its token, what the commit author is — kept out of both
 * `gitNotes.ts` and the screens so that neither has to know about the other.
 *
 * The one rule worth stating: the token is read from the keystore at the moment
 * a client is built and is never written anywhere else. Not into `.git/config`,
 * not into the settings file, not into a log line.
 */

import { createFetchClient, redact } from './fetchClient.ts';
import { createExpoFs } from './expoFs.ts';
import { GitNotes } from './gitNotes.ts';
import { loadSettings, loadToken, type RepoSettings } from './credentials.ts';
import { codedError, type GitOptions } from '../../core/git/types.ts';

/** Where the working tree lives inside the document directory. */
const REPO_DIRNAME = 'repo';

export interface Workspace {
  notes: GitNotes;
  settings: RepoSettings;
  /** Absolute POSIX path of the working tree, for the screens that read it. */
  dir: string;
  /** True when a token is present, so a sync can be attempted. */
  hasToken: boolean;
}

/**
 * Build a workspace over the note repository.
 *
 * `root` is the document directory. `progress` is forwarded to isomorphic-git,
 * which is what makes a first clone's progress bar possible; it is a callback
 * rather than state because this module does not own rendering.
 */
export async function openWorkspace(
  root: string,
  progress?: (p: { phase: string; loaded: number; total: number }) => void,
): Promise<Workspace> {
  const settings = await loadSettings();
  const token = await loadToken();

  if (!settings.remote) {
    throw codedError('ENOCONFIG', '尚未設定遠端倉庫');
  }

  const dir = `${root}/${REPO_DIRNAME}`;
  const fs = await createExpoFs(dir);

  const opts: GitOptions = {
    fs,
    http: createFetchClient({ token }),
    // A plain POSIX path, never a `file://` URI: isomorphic-git's own join()
    // collapses `file:///a` to `file:/a`, and every path after that is wrong.
    dir,
    onProgress: progress,
  };

  return {
    notes: new GitNotes(opts, { name: settings.authorName, email: settings.authorEmail }, settings.branch),
    settings,
    dir,
    hasToken: Boolean(token),
  };
}

/** Ensure the repository exists locally and points at the configured remote. */
export async function ensureRepo(workspace: Workspace): Promise<void> {
  await workspace.notes.init(workspace.settings.remote);
}

export { redact };