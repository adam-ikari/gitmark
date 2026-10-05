/**
 * GitHub App sign-in: the parts that are pure.
 *
 * A GitHub App gives the narrowest grant we can offer — read and write on the
 * repositories it is installed on — which is what
 * brain/pages/github-pat-git-transport.md asks for. The grant is not ours to
 * widen: the user installs the App on a repository, and the App's permissions
 * were fixed when it was created.
 *
 * ## Why the authorization code flow, and not the device flow
 *
 * The device flow was the obvious candidate for a phone with no browser to hand,
 * and it is the wrong choice. GitHub's own guidance on Apps says not to enable
 * it unless the app is headless, because it has **no redirect URI at all** — so
 * anyone can start a device flow against our App's client id and convince a user
 * to enter a code that authorises *our* App on *their* account. A phone has a
 * browser, so the code flow with PKCE is both safer and available.
 *
 * ## Why a client secret is in here at all
 *
 * For a GitHub App, exchanging an authorization code requires a client secret,
 * and this app is a public client, so that secret ships inside the APK where it
 * can be extracted. That is not a mistake in the design and GitHub says so
 * plainly: PKCE is what actually secures the flow, and the secret is
 * defence in depth. Anyone who reads the APK gets the client id anyway, and
 * possessing the secret alone cannot mint a token — the user still has to
 * complete the consent screen.
 *
 * The consequence that matters for the user experience: because we have the
 * secret, we can use the refresh token, so **re-login is silent** rather than
 * something that interrupts a sync every eight hours.
 *
 * ## Why this module is separate
 *
 * URL construction, response parsing, and "is this token still good" are all
 * rules that fail quietly when inlined into a screen. They are here, pure, and
 * tested without a network or a browser.
 */

export const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** GitHub App user tokens are prefixed so a wrong credential is obvious in a log. */
export const TOKEN_PREFIX = 'ghu_';

/** Refresh tokens are prefixed differently, and must not be confused with access tokens. */
export const REFRESH_PREFIX = 'ghr_';

/** Access tokens live 8 hours. Refresh tokens, 6 months. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 28_800;
export const REFRESH_TOKEN_LIFETIME_SECONDS = 155_520_000;

/**
 * How early a token is treated as expired.
 *
 * Not zero. A token that is technically live for another four seconds will fail
 * mid-push, and a failed push after a merge is the one outcome in this codebase
 * that reads as "silently diverged from the remote".
 */
export const EXPIRY_SKEW_MS = 5 * 60_000;

export interface PkcePair {
  /** The random string. Held in memory only, never stored. */
  verifier: string;
  /** base64url(SHA256(verifier)). */
  challenge: string;
}

/** Build the URL the user is sent to in order to approve the App. */
export function authorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  /** Narrow the grant to one repository when known. */
  repositoryId?: string | null;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    code_challenge: options.challenge,
    // S256 only. The plain variant is not supported by GitHub, and asking for it
    // would be rejected — so there is nothing to choose here and no branch to test.
    code_challenge_method: 'S256',
  });

  if (options.repositoryId) params.set('repository_id', options.repositoryId);

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** The token response, once the user has approved. */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number | null;
}

export type GrantOutcome =
  | { kind: 'ok'; grant: TokenGrant }
  | { kind: 'error'; description: string; code: string };

/**
 * Parse a `/login/oauth/access_token` response.
 *
 * Handles both the success shape and the `{error, error_description}` shape,
 * because GitHub answers with HTTP 200 for errors on this endpoint — a caller
 * that only checked the status code would treat an error body as a token.
 */
export function parseTokenResponse(body: unknown, now: number): GrantOutcome {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'error', code: 'malformed', description: 'GitHub 返回了无法解析的内容' };
  }
  const record = body as Record<string, unknown>;

  if (typeof record.error === 'string' && record.error !== '') {
    return {
      kind: 'error',
      code: record.error,
      description:
        typeof record.error_description === 'string' && record.error_description !== ''
          ? record.error_description
          : describeGrantError(record.error),
    };
  }

  if (typeof record.access_token !== 'string' || record.access_token === '') {
    return { kind: 'error', code: 'malformed', description: 'GitHub 没有返回访问令牌' };
  }

  // GitHub omits `expires_in` when the App has token expiry disabled, and a
  // missing value must not become NaN or Infinity — both would make the token
  // look permanently valid, or permanently expired.
  const accessExpires = typeof record.expires_in === 'number' ? record.expires_in : 0;
  const refreshExpires = typeof record.refresh_token_expires_in === 'number' ? record.refresh_token_expires_in : 0;

  return {
    kind: 'ok',
    grant: {
      accessToken: record.access_token,
      refreshToken: typeof record.refresh_token === 'string' && record.refresh_token !== '' ? record.refresh_token : null,
      accessTokenExpiresAt: accessExpires === 0 ? Number.POSITIVE_INFINITY : now + accessExpires * 1000,
      refreshTokenExpiresAt: refreshExpires === 0 ? null : now + refreshExpires * 1000,
    },
  };
}

/** A human message for GitHub's error codes. */
export function describeGrantError(code: string): string {
  switch (code) {
    case 'bad_verification_code':
      return '授权码无效，请重新登录';
    case 'incorrect_client_credentials':
      return 'App 的 client id 或 secret 不正确';
    case 'redirect_uri_mismatch':
      return '回调地址与应用设置不一致';
    case 'bad_refresh_token':
      return '登录已过期，请重新登录';
    default:
      return `授权失败（${code}）`;
  }
}

/** What the app remembers about a sign-in. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms, or null when the grant does not expire. */
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  /** GitHub login, shown so the user can tell which account is connected. */
  login: string | null;
  /** Repositories the App is installed on, as `owner/name`. */
  installations: string[];
}

/** An empty, signed-out session. */
export function signedOut(): AuthSession {
  return {
    accessToken: '',
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    login: null,
    installations: [],
  };
}

/** Is the user signed in at all? */
export function isSignedIn(session: AuthSession): boolean {
  return session.accessToken !== '';
}

/**
 * Does the access token need renewing?
 *
 * True when it is past its life, close enough to it to be risky, or already
 * unusable — including the case where the App has expiry disabled, which is
 * represented as a null expiry and must never be read as "expired".
 */
export function needsRefresh(session: AuthSession, now: number): boolean {
  if (session.accessToken === '') return false;
  if (session.accessTokenExpiresAt === null) return false;
  return now >= session.accessTokenExpiresAt - EXPIRY_SKEW_MS;
}

/**
 * Can the app renew on its own, without asking the user?
 *
 * This is the whole question behind "无感刷新". It is answered purely from what
 * is stored, so the answer is knowable before any network call is attempted.
 */
export function canRefreshSilently(session: AuthSession, now: number): boolean {
  if (session.refreshToken === null) return false;
  if (session.refreshTokenExpiresAt === null) return true;
  return now < session.refreshTokenExpiresAt;
}

/**
 * Replace the token fields of a session, leaving login and installations alone.
 *
 * A response that omits `refresh_token` keeps the previous one: GitHub only
 * sends a new refresh token when it rotates one, and treating its absence as
 * "no refresh token" would silently end the user's silent-refresh ability.
 */
export function withGrant(session: AuthSession, grant: TokenGrant): AuthSession {
  return {
    ...session,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken ?? session.refreshToken,
    accessTokenExpiresAt: Number.isFinite(grant.accessTokenExpiresAt) ? grant.accessTokenExpiresAt : null,
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt ?? session.refreshTokenExpiresAt,
  };
}

/** A one-line description of the session, for the settings screen. */
export function describeSession(session: AuthSession, now: number): string {
  if (!isSignedIn(session)) return '未登录';
  const who = session.login ? `${session.login}` : 'GitHub 帐号';
  if (session.accessTokenExpiresAt === null) return `已登录：${who}（长期有效）`;
  const minutes = Math.max(0, Math.round((session.accessTokenExpiresAt - now) / 60_000));
  if (minutes < 1) return `已登录：${who}（即将过期）`;
  if (minutes < 60) return `已登录：${who}（${minutes} 分钟后过期）`;
  return `已登录：${who}（${Math.round(minutes / 60)} 小时后过期）`;
}

/**
 * Strip anything token-shaped out of a message before it reaches the screen.
 *
 * The access token and the refresh token are both bearer credentials, and the
 * refresh token is the one that lasts six months — so an error string carrying it
 * into a bug report is a six-month exposure, not an eight-hour one.
 */
export function redactTokens(message: string): string {
  return message
    .replace(/\/\/[^@/\s]+@/g, '//***@')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}
