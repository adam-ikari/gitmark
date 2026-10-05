import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact } from './fetchClient.ts';
import { countConflicts } from '../../core/merge/markers.ts';
import { merge3 } from '../../core/merge/merge3.ts';

test('a token in a URL is redacted', () => {
  assert.equal(
    redact('failed to fetch https://x-access-token:ghp_abcdefghijklmnopqrst@github.com/a/b.git'),
    'failed to fetch https://***@github.com/a/b.git',
  );
});

test('a GitHub token in free text is redacted', () => {
  assert.equal(redact('auth failed for ghp_1234567890abcdefghij'), 'auth failed for ***');
  assert.equal(redact('token gho_ABCDEFGHIJKLMNOPQRST'), 'token ***');
});

test('a bearer header value is redacted', () => {
  assert.equal(redact('sent Bearer abc.def-ghi'), 'sent Bearer ***');
});

test('ordinary text is untouched', () => {
  const msg = 'could not read from remote repository';
  assert.equal(redact(msg), msg);
});

test('a clean merge has no markers to count', () => {
  const merged = merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC');
  assert.equal(merged.clean, true);
  assert.equal(countConflicts(merged.text), 0);
});