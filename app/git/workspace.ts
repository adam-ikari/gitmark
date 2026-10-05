/**
 * Assembling a usable git workspace on a device.
 *
 * Everything here is a composition decision — where the repo lives, how the
 * transport gets its token, what the commit author is — kept out of both
 * `gitNotes.ts` and the screens so that neither has to know about the other.
 *
 * ## Why the token is resolved per request
 *
 * A GitHub App's access token lives eight hours, so a token captured when the app
 * launched is a token that will be dead by the evening. The workspace therefore
 * takes a function that yields a *currently valid* token, and the caller passes
 * `sessionForSync`, which renews silently when needed. Nothing here holds a token,
 * so there is nothing to go stale and nothing to repair after the fact.
 */

import { createFetchClient, redact } from './fetchClient.ts';
import { createExpoFs } from './expoFs.ts';
import { GitNotes } from './gitNotes.ts';
import { loadSettings, type RepoSettings } from './credentials.ts';
import { codedError, type GitOptions } from '../../core/git/types.ts';

/** Where the working tree lives inside the document directory. */
const REPO_DIRNAME = 'repo';

export interface Workspace {
  notes: GitNotes;
  settings: RepoSettings;
  /** Absolute POSIX path of the working tree, for the screens that read it. */
  dir: string;
  /** Yields a currently valid access token, renewing it if one is about to expire. */
  accessToken: () => Promise<string>;
}

export interface WorkspaceOptions {
  progress?: (p: { phase: string; loaded: number; total: number }) => void;
  accessToken: () => Promise<string>;
}

/**
 * Build a workspace over the note repository.
 *
 * `root` is the document directory. `progress` is forwarded to isomorphic-git,
 * which is what makes a first clone's progress bar possible; it is a callback
 * rather than state because this module does not own rendering.
 */
export async function openWorkspace(root: string, options: WorkspaceOptions): Promise<Workspace> {
  const settings = await loadSettings();

  if (!settings.remote) {
    throw codedError('ENOCONFIG', '尚未设置远端仓库');
  }

  const dir = `${root}/${REPO_DIRNAME}`;
  const fs = await createExpoFs(dir);

  // The transport asks for a token per request instead of receiving one at
  // construction. Building it with a captured token would keep presenting a
  // credential that expired hours ago, which GitHub answers as a bare 401 from
  // inside a fetch — with nothing in the message pointing at the real cause.
  const unauthenticated = createFetchClient({});

  const opts: GitOptions = {
    fs,
    http: {
      async request(req) {
        const token = await options.accessToken();
        return unauthenticated.request({ ...req, token });
      },
    },
    // A plain POSIX path, never a `file://` URI: isomorphic-git's own join()
    // collapses `file:///a` to `file:/a`, and every path after that is wrong.
    dir,
    onProgress: options.progress,
  };

  return {
    notes: new GitNotes(opts, { name: settings.authorName, email: settings.authorEmail }, settings.branch),
    settings,
    dir,
    accessToken: options.accessToken,
  };
}

/** Ensure the repository exists locally and points at the configured remote. */
export async function ensureRepo(workspace: Workspace): Promise<void> {
  await workspace.notes.init(workspace.settings.remote);
}

export { redact };
