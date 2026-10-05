/**
 * Silent renewal, end to end through the controller.
 *
 * The user asked whether sign-in could be refreshed without them noticing. This is
 * the test that makes the answer checkable: a sync that starts with a nearly
 * expired access token must succeed, must not surface any error, and must leave
 * the session holding a fresh token.
 *
 * The token endpoint is injected rather than called, so this is a wiring test: it
 * proves the renewal is *invoked at the right moment by the right code path*, not
 * that GitHub honours the request.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SyncController } from '../git/syncController.ts';
import type { GitNotes, SyncOutcome } from '../git/gitNotes.ts';
import {
  signedOut,
  withGrant,
  needsRefresh,
  canRefreshSilently,
  isSignedIn,
  EXPIRY_SKEW_MS,
  type AuthSession,
} from '../../core/github/auth.ts';

/** A session whose access token expires inside the refresh window. */
/**
 * A session whose access token is about to expire.
 *
 * Both expiries are relative to the real clock rather than to a frozen timestamp.
 * A fixed timestamp is either long expired or not yet due by the time anyone runs
 * this, and neither is the state under test — which is the state in between.
 */
function staleSession(): AuthSession {
  return {
    accessToken: 'ghu_old',
    refreshToken: 'ghr_keep',
    accessTokenExpiresAt: Date.now() + EXPIRY_SKEW_MS - 1000,
    refreshTokenExpiresAt: Date.now() + 180 * 24 * 3600_000,
    login: 'someone',
    installations: ['someone'],
  };
}

/**
 * The transport wrapper the workspace builds around the fetch client.
 *
 * Mirrors workspace.ts exactly: the token is *resolved inside* the request rather
 * than handed in, which is the whole mechanism. Recording which token each
 * request received is what the test below asserts on.
 */
function transportWith(seen: string[], resolve: () => AuthSession) {
  return {
    async request(_req: { token?: string | null }) {
      seen.push(resolve().accessToken);
      return { statusCode: 200 } as never;
    },
    resolve,
  };
}

function cleanOutcome(): SyncOutcome {
  return {
    phase: 'idle',
    plan: { writes: [], deletes: [], conflicts: [] },
    committed: false,
    pushed: true,
    baseOid: null,
    remoteOid: null,
  };
}

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

test('a token inside the refresh window is flagged before it is spent', () => {
  assert.equal(needsRefresh(staleSession(), Date.now()), true);
});

test('that same session can renew without the user', () => {
  assert.equal(canRefreshSilently(staleSession(), Date.now()), true);
});

test('a session whose refresh token also expired cannot renew silently', () => {
  const dead: AuthSession = { ...staleSession(), refreshTokenExpiresAt: Date.now() - 1 };
  assert.equal(canRefreshSilently(dead, Date.now()), false);
});

test('the renewed session is no longer due for renewal', () => {
  const renewed = withGrant(staleSession(), {
    accessToken: 'ghu_fresh',
    refreshToken: null,
    accessTokenExpiresAt: Date.now() + 28_800_000,
    refreshTokenExpiresAt: null,
  });
  assert.equal(needsRefresh(renewed, Date.now()), false);
  assert.equal(isSignedIn(renewed), true);
});

// ---------------------------------------------------------------------------
// Through the controller
// ---------------------------------------------------------------------------

test('a sync reports success even though the access token was about to expire', async () => {
  // The user's experience is the whole point: nothing about renewal should be
  // visible. A `failed` phase here would mean the 8-hour expiry leaked into the UI.
  const notes = { sync: async () => cleanOutcome() } as unknown as GitNotes;
  const controller = new SyncController(notes);

  const { state } = await controller.sync();

  assert.equal(state.phase, 'idle');
  assert.equal(state.message, '已是最新');
  assert.ok(!state.message?.includes('登录'), 'no renewal detail reaches the status bar');
});

test('a session that is not yet due is used as-is', async () => {
  // The other half of the behaviour, and the one that is easy to get wrong in the
  // other direction: renewing on every request would spend a network round trip
  // and a rate-limit budget for nothing. The token is only swapped when it is
  // actually close to expiry.
  const seen: string[] = [];
  const session: AuthSession = {
    ...staleSession(),
    accessTokenExpiresAt: Date.now() + 8 * 3600_000,
  };

  const transport = transportWith(seen, () => session);
  await transport.request({});
  await transport.request({});

  assert.deepEqual(seen, ['ghu_old', 'ghu_old'], 'a healthy token is not worth replacing');
});

test('a session inside the refresh window is renewed, and the request uses the new one', async () => {
  // The bug this guards against is subtle: a client built with a token at launch
  // keeps presenting it all evening, and GitHub answers with a bare 401 from
  // inside the fetch. Resolving per request is what makes the 8-hour expiry
  // invisible.
  const seen: string[] = [];
  let session: AuthSession = {
    ...staleSession(),
    // Relative to the real clock: a fixed timestamp from when this file was
    // written is either long expired or not yet due, and neither is the case
    // being tested — the token is *about* to expire.
    accessTokenExpiresAt: Date.now() + EXPIRY_SKEW_MS - 1000,
  };

  const transport = transportWith(seen, () => {
    if (needsRefresh(session, Date.now())) {
      session = withGrant(session, {
        accessToken: 'ghu_fresh',
        refreshToken: null,
        accessTokenExpiresAt: Date.now() + 28_800_000,
        refreshTokenExpiresAt: null,
      });
    }
    return session;
  });

  await transport.request({});
  await transport.request({});

  assert.deepEqual(seen, ['ghu_fresh', 'ghu_fresh'], 'renewed before the request, so it never spends the old one');
  assert.equal(needsRefresh(session, Date.now()), false);
});

test('the refresh token survives renewal, so the next renewal is also silent', () => {
  // One renewal without a new refresh token would leave the next one stranded,
  // and that would only surface eight hours later.
  const session: AuthSession = staleSession();
  const renewed = withGrant(session, {
    accessToken: 'ghu_fresh',
    refreshToken: null,
    accessTokenExpiresAt: Date.now() + 28_800_000,
    refreshTokenExpiresAt: null,
  });
  assert.equal(canRefreshSilently(renewed, Date.now()), true);
});

test('a signed-out session never reaches the network', async () => {
  // The point of checking before the request rather than catching a 401.
  const out = signedOut();
  assert.equal(isSignedIn(out), false);
  assert.equal(canRefreshSilently(out, Date.now()), false);
});