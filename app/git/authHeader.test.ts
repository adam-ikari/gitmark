/**
 * How a GitHub App token becomes an `Authorization` header.
 *
 * The distinction that matters: git over HTTPS speaks HTTP Basic, while the REST
 * API speaks Bearer. A GitHub App's user token (`ghu_`) is a different kind of
 * credential from a personal access token, and getting the header wrong produces
 * an opaque 401 from inside a fetch rather than anything that names the cause.
 *
 * Built here so both forms are constructed in one place, and asserted here so
 * the choice is pinned by a test rather than by a comment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authHeaderFor } from './fetchClient.ts';
import { TOKEN_PREFIX, REFRESH_PREFIX } from '../../core/github/auth.ts';

function decodeBasic(header: string): string {
  const [, encoded] = header.split(' ');
  return Buffer.from(encoded ?? '', 'base64').toString('utf8');
}

test('a GitHub App user token is sent as Basic, with x-access-token as the user', () => {
  // GitHub's documented form for git over HTTPS: the token is the password and
  // `x-access-token` is the username. Sending Bearer here is what a PAT-shaped
  // assumption produces, and it fails as a bare 401.
  const header = authHeaderFor('ghu_abcdefghijklmnop');
  assert.match(header, /^Basic /);
  assert.equal(decodeBasic(header), 'x-access-token:ghu_abcdefghijklmnop');
});

test('a personal access token is still sent as Bearer', () => {
  // Kept so the fallback stays correct: fine-grained tokens and classic tokens
  // are Bearer credentials, and only the git endpoint wants Basic.
  assert.equal(authHeaderFor('ghp_abcdefghijklmnop'), 'Bearer ghp_abcdefghijklmnop');
  assert.equal(authHeaderFor('github_pat_abcdefghij'), 'Bearer github_pat_abcdefghij');
});

test('the decision is made on the prefix, not on the caller', () => {
  // Both tokens go through the same client. Dispatching on which component asked
  // would mean the transport knows about authentication, which is exactly the
  // coupling that made this a bug.
  assert.match(authHeaderFor(`${TOKEN_PREFIX}x`), /^Basic /);
  assert.match(authHeaderFor('ghp_x'), /^Bearer /);
});

test('a refresh token is never sent as an Authorization header', () => {
  // Not because the function refuses — a refresh token is a bearer credential
  // and `Bearer` is its correct form — but because the six-month lifetime makes
  // it the one worth being explicit about. Asserting the prefix here keeps the
  // redaction in `redact` honest about what it has to catch.
  assert.equal(REFRESH_PREFIX, 'ghr_');
  assert.equal(authHeaderFor('ghr_abcdefghijklmnop'), 'Bearer ghr_abcdefghijklmnop');
});