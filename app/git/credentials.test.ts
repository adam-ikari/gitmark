/**
 * The rules for what a sync needs before it can run.
 *
 * Validation is asserted here rather than in the screen because each rule
 * corresponds to a failure that isomorphic-git reports somewhere unhelpful:
 * a bad URL becomes `UnknownTransportError` inside a fetch, and a bad author
 * becomes an exception from `commit`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateRemote, validateAuthor, isConfigured, DEFAULT_SETTINGS } from './credentials.ts';

test('an empty remote is rejected', () => {
  assert.match(validateRemote('') ?? '', /遠端/);
});

test('a whitespace-only remote is rejected', () => {
  assert.ok(validateRemote('   '));
});

// Verified against isomorphic-git 1.43.0: file:// is not a transport it
// implements, and the failure surfaces as UnknownTransportError from a fetch.
test('a file:// remote is rejected with the reason', () => {
  assert.match(validateRemote('file:///tmp/notes') ?? '', /不支援本機路徑/);
});

test('an ssh remote is rejected, since the decision is HTTP plus PAT', () => {
  assert.ok(validateRemote('git@github.com:owner/repo.git'));
});

test('a plain path is rejected', () => {
  assert.ok(validateRemote('/tmp/notes'));
});

test('a url with a space is rejected', () => {
  assert.match(validateRemote('https://github.com/o/my repo.git') ?? '', /空格/);
});

test('a normal https remote is accepted', () => {
  assert.equal(validateRemote('https://github.com/owner/repo.git'), null);
  assert.equal(validateRemote('https://github.com/owner/repo'), null);
});

test('surrounding whitespace is tolerated', () => {
  assert.equal(validateRemote('  https://github.com/o/r.git  '), null);
});

test('a plain http remote is accepted for self-hosted servers', () => {
  assert.equal(validateRemote('http://git.example.com/o/r.git'), null);
});

test('an author without a name is rejected', () => {
  assert.match(validateAuthor('', 'a@b.co') ?? '', /作者名稱/);
});

test('an author with a malformed email is rejected', () => {
  assert.ok(validateAuthor('me', 'not-an-email'));
  assert.ok(validateAuthor('me', 'two@@at.com'));
  assert.ok(validateAuthor('me', ''));
});

test('a complete author is accepted', () => {
  assert.equal(validateAuthor('Me', 'me@example.com'), null);
});

test('a sync needs a remote, an author and a token', () => {
  const full = { ...DEFAULT_SETTINGS, remote: 'https://x/y.git', authorName: 'Me', authorEmail: 'me@x.co' };
  assert.equal(isConfigured(full, 'ghp_token'), true);
  assert.equal(isConfigured(full, null), false);
  assert.equal(isConfigured({ ...full, remote: '' }, 'ghp_token'), false);
  assert.equal(isConfigured({ ...full, authorName: '' }, 'ghp_token'), false);
  assert.equal(isConfigured({ ...full, authorEmail: '' }, 'ghp_token'), false);
});

test('an unconfigured repo is recognised before any git call', () => {
  assert.equal(isConfigured(DEFAULT_SETTINGS, null), false);
});