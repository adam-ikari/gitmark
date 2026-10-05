/**
 * Where the session lives.
 *
 * Both tokens go in the OS keystore and nowhere else. The rule is the same one
 * that governed the personal access token before it: the filesystem is the thing
 * git tracks, so a credential written next to `.git/config` eventually gets
 * committed, and a committed credential is a leaked credential.
 *
 * The refresh token is the more sensitive of the two — valid for six months — so
 * it is stored beside the access token rather than derived from it, and both are
 * redacted from anything a screen can display.
 *
 * The module's type is used directly, with no cast, so `tsc` checks the keystore
 * API really has these methods. The previous version declared its own interface
 * and cast the import into it, which is how a call to a method that does not
 * exist can sit in a codebase with a green typecheck.
 */

import { signedOut, isSignedIn, type AuthSession } from '../../core/github/auth.ts';

const SESSION_KEY = 'mark.github.session';

/** The stored session, or a signed-out one. Never throws. */
export async function getStoredSession(): Promise<AuthSession> {
  try {
    const store = await import('expo-secure-store');
    if (!(await store.isAvailableAsync())) return signedOut();

    const raw = await store.getItemAsync(SESSION_KEY);
    if (raw === null || raw === '') return signedOut();

    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    const session: AuthSession = {
      accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : '',
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
      accessTokenExpiresAt: numberOrNull(parsed.accessTokenExpiresAt),
      refreshTokenExpiresAt: numberOrNull(parsed.refreshTokenExpiresAt),
      login: typeof parsed.login === 'string' ? parsed.login : null,
      installations: Array.isArray(parsed.installations) ? parsed.installations : [],
    };

    // A record that parses but holds no token is a signed-out session. Trusting
    // the shape alone would let a truncated record look like a live login.
    return isSignedIn(session) ? session : signedOut();
  } catch {
    return signedOut();
  }
}

export async function storeSession(session: AuthSession): Promise<void> {
  try {
    const store = await import('expo-secure-store');
    if (!(await store.isAvailableAsync())) return;
    await store.setItemAsync(SESSION_KEY, JSON.stringify(session));
  } catch {
    // A write failure means the next launch asks to sign in again. Failing loudly
    // here would leave the UI claiming to be signed in when it is not.
  }
}

export async function clearStoredSession(): Promise<void> {
  try {
    const store = await import('expo-secure-store');
    if (!(await store.isAvailableAsync())) return;
    await store.deleteItemAsync(SESSION_KEY);
  } catch {
    /* already gone */
  }
}

/**
 * Is a value a usable timestamp?
 *
 * `Infinity` becomes null: it is the in-memory marker for "no expiry", and
 * `JSON.stringify` turns it into null anyway — so accepting it here would make
 * the meaning depend on which direction the value was serialised.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
