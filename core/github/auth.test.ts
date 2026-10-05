/**
 * GitHub App sign-in: token lifetime, silent refresh, and redaction.
 *
 * The behaviour under test is the one the user actually feels: whether they are
 * ever interrupted by an expiry. Most of these assertions are about *not*
 * bothering them, and about never treating an unusable token as usable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeUrl,
  parseTokenResponse,
  describeGrantError,
  signedOut,
  isSignedIn,
  needsRefresh,
  canRefreshSilently,
  withGrant,
  describeSession,
  redactTokens,
  EXPIRY_SKEW_MS,
  type AuthSession,
} from './auth.ts';

const NOW = 1_700_000_000_000;

/** A signed-in session eight hours from expiry, with a six-month refresh token. */
function liveSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'ghu_access',
    refreshToken: 'ghr_refresh',
    accessTokenExpiresAt: NOW + 8 * 3600_000,
    refreshTokenExpiresAt: NOW + 180 * 24 * 3600_000,
    login: 'someone',
    installations: ['someone/notes'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// authorizeUrl
// ---------------------------------------------------------------------------

test('the authorize URL carries the PKCE challenge and S256', () => {
  const url = new URL(
    authorizeUrl({ clientId: 'Iv1.abc123', redirectUri: 'mark://auth', challenge: 'challenge-value' }),
  );
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.abc123');
  assert.equal(url.searchParams.get('redirect_uri'), 'mark://auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(
    url.searchParams.get('code_challenge_method'),
    'S256',
    'GitHub only supports S256, and the plain variant would be rejected',
  );
});

test('the authorize URL narrows to one repository when one is known', () => {
  // This is the parameter that makes the minimal-permission principle real: the
  // token cannot reach a second repository even if the App is installed on it.
  const url = new URL(
    authorizeUrl({ clientId: 'c', redirectUri: 'mark://auth', challenge: 'x', repositoryId: '42' }),
  );
  assert.equal(url.searchParams.get('repository_id'), '42');
});

test('an unknown repository leaves the grant to the App installation', () => {
  const url = new URL(authorizeUrl({ clientId: 'c', redirectUri: 'mark://auth', challenge: 'x' }));
  assert.equal(url.searchParams.has('repository_id'), false);
});

// ---------------------------------------------------------------------------
// parseTokenResponse
// ---------------------------------------------------------------------------

test('a successful exchange yields a token and an expiry', () => {
  const out = parseTokenResponse(
    {
      access_token: 'ghu_abc',
      refresh_token: 'ghr_def',
      token_type: 'bearer',
      expires_in: 28_800,
      refresh_token_expires_in: 155_520_000,
    },
    NOW,
  );

  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.grant.accessToken, 'ghu_abc');
  assert.equal(out.grant.refreshToken, 'ghr_def');
  assert.equal(out.grant.accessTokenExpiresAt, NOW + 28_800_000);
});

test('an error body is an error even though GitHub answers HTTP 200', () => {
  // Checking the status code alone would read this body as a token, and then the
  // app would treat an error string as a credential.
  const out = parseTokenResponse(
    { error: 'bad_verification_code', error_description: 'The code passed is incorrect.' },
    NOW,
  );
  assert.equal(out.kind, 'error');
  if (out.kind !== 'error') return;
  assert.equal(out.code, 'bad_verification_code');
  assert.match(out.description, /incorrect/i);
});

test('a missing expiry means a token that does not expire', () => {
  // GitHub omits `expires_in` when expiry is disabled. Reading that as 0 would
  // make the token look already dead; reading it as Infinity must not leak into
  // the stored session as a number.
  const out = parseTokenResponse({ access_token: 'ghu_abc' }, NOW);
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.grant.accessTokenExpiresAt, Number.POSITIVE_INFINITY);
  assert.equal(out.grant.refreshTokenExpiresAt, null);
});

test('a body with no token at all is an error, not an empty grant', () => {
  assert.equal(parseTokenResponse({ token_type: 'bearer' }, NOW).kind, 'error');
  assert.equal(parseTokenResponse({ access_token: '' }, NOW).kind, 'error');
  assert.equal(parseTokenResponse(null, NOW).kind, 'error');
  assert.equal(parseTokenResponse('nonsense', NOW).kind, 'error');
});

test('an expired refresh token is reported in the user’s language', () => {
  assert.match(describeGrantError('bad_refresh_token'), /重新登录/);
  assert.match(describeGrantError('redirect_uri_mismatch'), /回调地址/);
  assert.match(describeGrantError('something_new'), /something_new/);
});

// ---------------------------------------------------------------------------
// Silent refresh — the question that shaped this design
// ---------------------------------------------------------------------------

test('a live session is signed in and does not need refreshing', () => {
  const session = liveSession();
  assert.equal(isSignedIn(session), true);
  assert.equal(needsRefresh(session, NOW), false);
});

test('a token inside the skew window is refreshed before it is spent', () => {
  // Not at expiry: before it. A token that dies mid-push turns a merge into an
  // apparent divergence, which is the one failure this codebase treats as
  // unacceptable.
  const soon = liveSession({ accessTokenExpiresAt: NOW + EXPIRY_SKEW_MS - 1000 });
  assert.equal(needsRefresh(soon, NOW), true);
});

test('a token that never expires is never refreshed', () => {
  const forever = liveSession({ accessTokenExpiresAt: null });
  assert.equal(needsRefresh(forever, NOW), false);
  assert.equal(needsRefresh(forever, NOW + 10 * 365 * 24 * 3600_000), false);
});

test('a signed-out session is not "expired", it is signed out', () => {
  const out = signedOut();
  assert.equal(isSignedIn(out), false);
  assert.equal(needsRefresh(out, NOW), false, 'there is nothing to refresh');
  assert.equal(canRefreshSilently(out, NOW), false);
});

test('a session with a refresh token can renew without the user', () => {
  // This is the answer to "无感刷新": yes, because the client secret ships in
  // the app, so the six-month refresh token is usable.
  assert.equal(canRefreshSilently(liveSession(), NOW), true);
});

test('a session without a refresh token cannot renew silently', () => {
  assert.equal(canRefreshSilently(liveSession({ refreshToken: null }), NOW), false);
});

test('an expired refresh token is not silently refreshable', () => {
  const stale = liveSession({ refreshTokenExpiresAt: NOW - 1000 });
  assert.equal(canRefreshSilently(stale, NOW), false);
});

test('a refresh token that does not expire is always usable', () => {
  assert.equal(canRefreshSilently(liveSession({ refreshTokenExpiresAt: null }), NOW), true);
});

// ---------------------------------------------------------------------------
// withGrant
// ---------------------------------------------------------------------------

test('a new grant replaces the access token and its expiry', () => {
  const next = withGrant(liveSession(), {
    accessToken: 'ghu_new',
    refreshToken: 'ghr_new',
    accessTokenExpiresAt: NOW + 28_800_000,
    refreshTokenExpiresAt: NOW + 155_520_000,
  });
  assert.equal(next.accessToken, 'ghu_new');
  assert.equal(next.refreshToken, 'ghr_new');
  assert.equal(needsRefresh(next, NOW), false);
});

test('a grant with no new refresh token keeps the old one', () => {
  // GitHub only sends a new refresh token when it rotates one. Treating its
  // absence as "no refresh token" would silently end silent refresh after the
  // first renewal — a bug that would only show up eight hours later.
  const next = withGrant(liveSession(), {
    accessToken: 'ghu_new',
    refreshToken: null,
    accessTokenExpiresAt: NOW + 28_800_000,
    refreshTokenExpiresAt: null,
  });
  assert.equal(next.refreshToken, 'ghr_refresh');
  assert.equal(canRefreshSilently(next, NOW), true);
});

test('a grant preserves who is signed in and which repositories are installed', () => {
  const next = withGrant(liveSession(), {
    accessToken: 'ghu_new',
    refreshToken: null,
    accessTokenExpiresAt: NOW + 1000,
    refreshTokenExpiresAt: null,
  });
  assert.equal(next.login, 'someone');
  assert.deepEqual(next.installations, ['someone/notes']);
});

test('an infinite expiry is stored as null, never as Infinity', () => {
  const next = withGrant(signedOut(), {
    accessToken: 'ghu_x',
    refreshToken: null,
    accessTokenExpiresAt: Number.POSITIVE_INFINITY,
    refreshTokenExpiresAt: null,
  });
  assert.equal(next.accessTokenExpiresAt, null);
});

// ---------------------------------------------------------------------------
// describeSession
// ---------------------------------------------------------------------------

test('a signed-out session says so', () => {
  assert.equal(describeSession(signedOut(), NOW), '未登录');
});

test('a session names the account', () => {
  assert.match(describeSession(liveSession(), NOW), /someone/);
});

test('a session without a login still describes the provider', () => {
  assert.match(describeSession(liveSession({ login: null }), NOW), /GitHub/);
});

test('a long-lived session is described as long-lived', () => {
  assert.match(describeSession(liveSession({ accessTokenExpiresAt: null }), NOW), /长期有效/);
});

test('an expiring session reports roughly how long is left', () => {
  assert.match(describeSession(liveSession(), NOW), /8 小时后过期/);
});

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test('an access token is redacted', () => {
  assert.equal(redactTokens('bad token ghu_abcdefghijklmnopqrst'), 'bad token ***');
});

test('a refresh token is redacted', () => {
  // The one that matters most: it is valid for six months.
  assert.equal(redactTokens('refresh ghr_ABCDEFGHIJKLMNOPQRST'), 'refresh ***');
});

test('a token in a URL is redacted', () => {
  assert.equal(
    redactTokens('failed https://x-access-token:ghu_abcdefghijklmnop@github.com/a/b.git'),
    'failed https://***@github.com/a/b.git',
  );
});

test('ordinary text is untouched', () => {
  const msg = 'could not read from remote repository';
  assert.equal(redactTokens(msg), msg);
});
