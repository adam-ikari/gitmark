/**
 * Sign-in: the part that touches a browser, the network, and the keystore.
 *
 * ## 无感刷新 — how the 8-hour expiry stops being a problem
 *
 * A GitHub App's access token lives 8 hours, so a naive implementation makes the
 * user sign in again roughly twice a day, at a moment they did not choose. That
 * is unacceptable for an app whose whole point is that your notes are always
 * there.
 *
 * It is avoidable, and the reason is in the design rather than in luck: for a
 * public client GitHub expects the client secret to ship inside the app, which
 * means we hold it, which means the six-month refresh token is usable. So the
 * flow is:
 *
 *   1. First run: browser consent → access token + refresh token, stored.
 *   2. Before any sync: if the access token is near expiry, swap it silently.
 *   3. If the *refresh* token has also expired, or was revoked: sign-in again.
 *
 * Step 2 is the only one the user ever notices not happening. Step 3 happens
 * about twice a year, and is prompted rather than sprung.
 *
 * The alternative — configuring the App so tokens never expire — is possible and
 * GitHub documents it, but it is explicitly "not recommended for security
 * reasons". A silent refresh is the better trade: it keeps the short-lived token
 * short-lived.
 */

import {
  authorizeUrl,
  parseTokenResponse,
  signedOut,
  isSignedIn,
  needsRefresh,
  canRefreshSilently,
  withGrant,
  redactTokens,
  ACCESS_TOKEN_URL,
  type AuthSession,
  type PkcePair,
  type TokenGrant,
} from '../../core/github/auth.ts';
import { toBase64, toBase64Url } from '../../core/github/base64.ts';
import { getStoredSession, storeSession, clearStoredSession } from './store.ts';
import { redact } from '../git/fetchClient.ts';

/** Where GitHub sends the browser back to. Matches `scheme` in app.json. */
export const REDIRECT_URI = 'mark://auth';

export interface AppCredentials {
  clientId: string;
  /**
   * Ships in the binary. Not actually secret — see the note in
   * core/github/auth.ts. Its presence is what makes silent refresh possible.
   */
  clientSecret: string;
}

/** Why a sign-in attempt ended without a session. */
export class SignInError extends Error {
  constructor(
    message: string,
    readonly reason: 'cancelled' | 'denied' | 'config' | 'network' | 'unknown',
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

/**
 * The credentials the app ships with.
 *
 * ## Both of these are public, and the `EXPO_PUBLIC_` prefix is what says so
 *
 * Expo inlines `EXPO_PUBLIC_*` into the JavaScript bundle, which is exactly what
 * a public client requires: the client id is public by definition, and GitHub's
 * guidance for a native app is to ship the client secret and let PKCE be the
 * actual protection. So the secret is not a secret in the sense of being
 * unguessable — anyone who unzips the APK can read it, and by design they can.
 *
 * The naming is the hazard, not the mechanism. `EXPO_PUBLIC_GITHUB_CLIENT_SECRET`
 * looks like a server-side secret that somebody fat-fingered into a public
 * variable, and the next maintainer to need a genuinely secret value may add it
 * here — where it would be committed to this repository and shipped to every
 * device. Anything confidential belongs on a server, not in this app.
 *
 * See brain/pages/github-app-account-auth.md.
 */
export function credentials(): AppCredentials {
  const clientId = (process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.EXPO_PUBLIC_GITHUB_CLIENT_SECRET ?? '').trim();
  return { clientId, clientSecret };
}

/** Whether the build has credentials at all, so the UI can say so usefully. */
export function isConfigured(): boolean {
  const { clientId, clientSecret } = credentials();
  return clientId !== '' && clientSecret !== '';
}

/**
 * The PKCE verifier for the sign-in currently in progress.
 *
 * Module scope, not storage: the verifier must survive the trip to the browser
 * and back, and must not outlive it. It is the value that proves the code came
 * from the request we made, so it is held in memory only and dropped once used.
 *
 * Generating a challenge and throwing its verifier away — which this did on the
 * first attempt — produces an exchange that can only fail, with GitHub's
 * `bad_verification_code` naming a problem the user cannot act on.
 */
let pendingVerifier: string | null = null;

/**
 * Generate a PKCE verifier/challenge pair and remember the verifier.
 *
 * expo-crypto rather than node's `crypto`, which does not exist in a React Native
 * runtime, and a tested base64url helper rather than `Buffer`, which is also not
 * there. Both assumptions would pass typecheck and a Node test and then fail on
 * the device.
 */
async function pkce(): Promise<PkcePair> {
  const { getRandomBytesAsync, digestStringAsync, CryptoDigestAlgorithm, CryptoEncoding } = await import(
    'expo-crypto'
  );

  // 32 bytes is the smallest size whose unpadded base64 is 43 characters, which is
  // RFC 7636's minimum for a verifier. 31 would be 42 and be rejected.
  const bytes = await getRandomBytesAsync(32);
  const verifier = toBase64Url(toBase64(bytes));

  // base64url(SHA256(verifier)) over the base64url *text* of the verifier, which
  // is what the RFC specifies. GitHub accepts only S256.
  const base64 = await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: CryptoEncoding.BASE64,
  });

  pendingVerifier = verifier;
  return { verifier, challenge: toBase64Url(base64) };
}

/**
 * Begin sign-in: mint a verifier and return the URL the user must visit.
 *
 * The verifier stays in memory until {@link completeSignIn} consumes it.
 */
export async function consentUrl(repositoryId: string | null = null): Promise<string> {
  const { clientId } = credentials();
  if (clientId === '') {
    throw new SignInError('这个版本没有配置 GitHub App，无法登录', 'config');
  }
  const { challenge } = await pkce();
  return authorizeUrl({ clientId, redirectUri: REDIRECT_URI, challenge, repositoryId });
}

/** Forget the pending verifier, for when the user backs out. */
export function abandonSignIn(): void {
  pendingVerifier = null;
}

/** Exchange the authorization code for a token pair. */
async function exchange(body: Record<string, string>): Promise<TokenGrant> {
  const { clientId, clientSecret } = credentials();
  let response: Response;
  try {
    response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...body }),
    });
  } catch (err) {
    // Never surface the raw message: it can carry the URL, and therefore the
    // request body, and therefore the secret.
    throw new SignInError('连不上 GitHub，请检查网络', 'network');
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SignInError('GitHub 返回了无法解析的内容', 'unknown');
  }

  const outcome = parseTokenResponse(parsed, Date.now());
  if (outcome.kind === 'error') {
    throw new SignInError(redactTokens(outcome.description), 'denied');
  }
  return outcome.grant;
}

/**
 * Complete sign-in from the redirect URL.
 *
 * The verifier minted by {@link consentUrl} is consumed here and then dropped, so
 * a redirect cannot be replayed against a second exchange.
 */
export async function completeSignIn(redirectUrl: string): Promise<AuthSession> {
  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code');

  const verifier = pendingVerifier;
  pendingVerifier = null;

  if (code === null || code === '') {
    const denial = url.searchParams.get('error_description');
    throw new SignInError(denial === null ? '授权未完成' : redactTokens(denial), 'denied');
  }
  if (verifier === null) {
    // Reaching here means the app was restarted, or the redirect arrived without
    // a sign-in having been started. Either way there is nothing to verify the
    // code against, and guessing would defeat the point of PKCE.
    throw new SignInError('登录流程已中断，请重新开始', 'unknown');
  }

  const grant = await exchange({ code, code_verifier: verifier });
  return persist(withGrant(signedOut(), grant));
}

/** Swap an expiring access token for a fresh one, without involving the user. */
export async function refreshSilently(session: AuthSession): Promise<AuthSession> {
  if (!canRefreshSilently(session, Date.now())) {
    throw new SignInError('登录已过期，请重新登录', 'denied');
  }
  try {
    const grant = await exchange({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken as string,
    });
    return persist(withGrant(session, grant));
  } catch (err) {
    // A rejected refresh token is not a transient failure; it means the grant is
    // gone and only a fresh consent can restore it. Reporting it as "signed out"
    // is what makes the UI ask at the right moment rather than on the next sync.
    if (err instanceof SignInError && (err.reason === 'denied' || err.reason === 'network')) {
      throw err;
    }
    throw new SignInError('登录已过期，请重新登录', 'denied');
  }
}

/**
 * The session to sync with, renewing it first if it is about to expire.
 *
 * This is the function the sync path calls, and the reason expiry is invisible:
 * the renewal happens inside the same call the user already made.
 */
export async function sessionForSync(): Promise<AuthSession> {
  const stored = await getStoredSession();
  if (!isSignedIn(stored)) {
    throw new SignInError('尚未登录 GitHub', 'denied');
  }
  if (!needsRefresh(stored, Date.now())) return stored;
  if (!canRefreshSilently(stored, Date.now())) {
    throw new SignInError('登录已过期，请重新登录', 'denied');
  }
  return refreshSilently(stored);
}

/** Store the session, then fill in who is signed in and where the App is installed. */
async function persist(session: AuthSession): Promise<AuthSession> {
  await storeSession(session);
  const enriched = await describeSessionToUser(session);
  await storeSession(enriched);
  return enriched;
}

/**
 * Ask GitHub who this is and which repositories the App can reach.
 *
 * Both are needed to give the user something better than a bare "connected": the
 * login proves the token works, and the installation list is what turns "the App
 * is not installed on your notes repository" from a confusing push failure into
 * a sentence on the setup screen.
 */
async function describeSessionToUser(session: AuthSession): Promise<AuthSession> {
  try {
    const headers = {
      authorization: `Bearer ${session.accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'mark-notes',
      'x-github-api-version': '2022-11-28',
    };

    const me = await fetch('https://api.github.com/user', { headers });
    if (!me.ok) return session;
    const profile = (await me.json()) as { login?: string };

    const repos = await fetch('https://api.github.com/user/installations?per_page=100', { headers });
    const installations: string[] = [];
    if (repos.ok) {
      const body = (await repos.json()) as { installations?: Array<{ account?: { login?: string } }> };
      for (const item of body.installations ?? []) {
        const owner = item.account?.login;
        if (owner) installations.push(owner);
      }
    }

    return { ...session, login: profile.login ?? null, installations };
  } catch {
    // Descriptive only. A failure here must not fail the sign-in, because the
    // token itself is already valid and that is what syncing needs.
    return session;
  }
}

/** Sign out: forget the token, keep the repository settings. */
export async function signOut(): Promise<void> {
  await clearStoredSession();
}

export { redact };
