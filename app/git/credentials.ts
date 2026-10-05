/**
 * Repository settings.
 *
 * Sign-in moved to app/github/. What remains here is not secret and has no
 * business in the keystore: the remote, the commit author, the branch. Keeping
 * them apart is what makes "is the user signed in?" a question with one obvious
 * answer.
 *
 * The token — and now the refresh token too — lives in app/github/store.ts and
 * nowhere else. brain/pages/github-pat-git-transport.md: the filesystem is the
 * thing git tracks, so a credential written beside `.git/config` eventually gets
 * committed, and a committed credential is a leaked one.
 */

import { expoFile } from './expoFs.ts';

export interface RepoSettings {
  /** The remote, e.g. `https://github.com/owner/repo.git`. */
  remote: string;
  /** Commit author recorded in every commit this device makes. */
  authorName: string;
  authorEmail: string;
  branch: string;
}

export const DEFAULT_SETTINGS: RepoSettings = {
  remote: '',
  authorName: '',
  authorEmail: '',
  branch: 'main',
};

/**
 * Reject a remote that is not a usable HTTP(S) git URL.
 *
 * isomorphic-git only speaks Smart HTTP and SSH, so a `file://` path or a local
 * directory produces `UnknownTransportError` deep inside a fetch — a confusing
 * place to learn the URL was wrong. Validating at the point of entry turns that
 * into a message next to the field.
 */
export function validateRemote(remote: string): string | null {
  const url = remote.trim();
  if (url === '') return '请填写远端仓库网址';
  if (url.startsWith('file://')) return '不支持本机路径作为远端，请使用 GitHub 网址';
  if (!/^https?:\/\//.test(url)) return '请使用 https:// 开头的网址';
  if (/\s/.test(url)) return '网址不能包含空格';
  return null;
}

/** Reject an author git would refuse, before a commit fails opaquely. */
export function validateAuthor(name: string, email: string): string | null {
  if (name.trim() === '') return '请填写作者名称';
  if (!/^[^@\s]+@[^@\s]+$/.test(email.trim())) return '请填写有效的 email';
  return null;
}

/** The document directory, as a `file://` URI. */
async function documentUri(): Promise<string> {
  const { Paths } = await import('expo-file-system');
  return Paths.document.uri;
}

export async function loadSettings(): Promise<RepoSettings> {
  try {
    const file = await expoFile(`${documentUri()}/repo.json`);
    if (!file.exists) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(await file.text()) as Partial<RepoSettings>;
    // Spread over the defaults so a settings file written by an older build, or
    // hand-edited, cannot leave a field undefined.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: RepoSettings): Promise<void> {
  const file = await expoFile(`${documentUri()}/repo.json`);
  file.create({ intermediates: true, overwrite: true });
  file.write(JSON.stringify(settings, null, 2));
}

/**
 * The `owner/name` a remote points at, or null.
 *
 * Needed to tell the user the most likely reason a push fails: the App is
 * installed on their account but not on the repository they typed.
 */
export function repoFromRemote(remote: string): string | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Whether a sync could possibly succeed.
 *
 * A repository and an author are needed for a commit; a session is needed for the
 * network. Signature is over the session's token rather than the session itself,
 * so this stays a pure function of what a caller can see without importing the
 * keystore.
 */
export function isConfigured(settings: RepoSettings, accessToken: string | null): boolean {
  return (
    settings.remote !== '' &&
    settings.authorName !== '' &&
    settings.authorEmail !== '' &&
    typeof accessToken === 'string' &&
    accessToken !== ''
  );
}
