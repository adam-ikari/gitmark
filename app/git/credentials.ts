/**
 * Credentials and settings.
 *
 * The token lives in the OS keystore and nothing else. The rule from
 * brain/pages/github-pat-git-transport.md is not "avoid logging the token" —
 * it is that the token never touches the filesystem, because the filesystem is
 * the thing git tracks. A token written next to `.git/config` gets committed,
 * and a committed token is a leaked token.
 *
 * So this module is the only place that reads or writes a credential, and it
 * returns the token to a caller that hands it straight to the HTTP client
 * without ever storing it in a React state, a log line, or an error message.
 */

import { expoFile } from './expoFs.ts';

const TOKEN_KEY = 'mark.git.token';

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
  if (url === '') return '請填寫遠端仓库網址';
  if (url.startsWith('file://')) return '不支援本機路徑作為遠端，請使用 GitHub 網址';
  if (!/^https?:\/\//.test(url)) return '請使用 https:// 開頭的網址';
  if (/\s/.test(url)) return '網址不能包含空格';
  return null;
}

/** Reject an author git would refuse, before a commit fails opaquely. */
export function validateAuthor(name: string, email: string): string | null {
  if (name.trim() === '') return '請填寫作者名稱';
  if (!/^[^@\s]+@[^@\s]+$/.test(email.trim())) return '請填寫有效的 email';
  return null;
}

async function secureStore() {
  return import('expo-secure-store');
}

/** The document directory, as a `file://` URI. */
async function documentUri(): Promise<string> {
  const { Paths } = await import('expo-file-system');
  return Paths.document.uri;
}

/**
 * The saved token, or null.
 *
 * Returns null rather than throwing when the keystore is unavailable, because a
 * device without a secure enclave should still let someone edit notes offline —
 * it just cannot sync.
 */
export async function loadToken(): Promise<string | null> {
  try {
    const { getItemAsync, isAvailableAsync } = await secureStore();
    if (!(await isAvailableAsync())) return null;
    return await getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  const { setItemAsync } = await secureStore();
  await setItemAsync(TOKEN_KEY, token.trim());
}

export async function clearToken(): Promise<void> {
  try {
    const { deleteItemAsync, isAvailableAsync } = await secureStore();
    if (!(await isAvailableAsync())) return;
    await deleteItemAsync(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
}

/**
 * Repo settings, stored as a plain JSON file.
 *
 * Deliberately *not* in the keystore: none of this is secret, and putting it
 * there would make "is a token configured?" ambiguous.
 */
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

/** Whether a sync could possibly succeed: a remote, an author, and a token. */
export function isConfigured(settings: RepoSettings, token: string | null): boolean {
  return settings.remote !== '' && settings.authorName !== '' && settings.authorEmail !== '' && Boolean(token);
}