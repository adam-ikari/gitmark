/**
 * The base64 encoder, against known-good vectors.
 *
 * Small and easy to get subtly wrong: an off-by-one in the padding shows up as a
 * credential that decodes to the wrong bytes, which GitHub answers with a bare
 * 401. So the expected values here come from the RFC 4648 test vectors rather than
 * from the implementation agreeing with itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toBase64, base64FromAscii, toBase64Url, fromBase64 } from './base64.ts';

// RFC 4648 section 10.
const VECTORS: Array<[string, string]> = [
  ['', ''],
  ['f', 'Zg=='],
  ['fo', 'Zm8='],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='],
  ['fooba', 'Zm9vYmE='],
  ['foobar', 'Zm9vYmFy'],
];

test('RFC 4648 vectors encode correctly', () => {
  for (const [plain, expected] of VECTORS) {
    assert.equal(base64FromAscii(plain), expected, `base64(${JSON.stringify(plain)})`);
  }
});

test('decoding the vectors returns the original bytes', () => {
  for (const [plain, expected] of VECTORS) {
    assert.equal(Buffer.from(fromBase64(expected)).toString('ascii'), plain);
  }
});

test('a Basic auth credential encodes to a known value', () => {
  // `x-access-token:ghu_test` — the exact shape the git transport sends.
  assert.equal(base64FromAscii('x-access-token:ghu_test'), 'eC1hY2Nlc3MtdG9rZW46Z2h1X3Rlc3Q=');
});

test('padding is omitted only where it must be', () => {
  assert.match(base64FromAscii('a'), /==$/);
  assert.match(base64FromAscii('ab'), /=$/);
  assert.doesNotMatch(base64FromAscii('abc'), /=/);
});

test('the URL-safe alphabet has no +, / or =', () => {
  // Required of a PKCE challenge: it travels in a query string, where `+` means
  // a space and `/` is a path separator.
  const withSpecials = toBase64(new Uint8Array([0xfb, 0xef, 0xbe, 0x01]));
  assert.match(withSpecials, /[+/]/, 'these bytes must produce + and / to be a real test');
  assert.doesNotMatch(toBase64Url(withSpecials), /[+/=]/);
});

test('base64url is standard base64 with the substitutions applied', () => {
  assert.equal(toBase64Url('ab+/cd=='), 'ab-_cd');
  assert.equal(toBase64Url('Zm9v'), 'Zm9v', 'unaffected input passes through');
});

test('a non-ASCII string is refused rather than silently mangled', () => {
  // Silently truncating to a byte would produce a credential that looks fine and
  // authenticates as something else.
  assert.throws(() => base64FromAscii('café'), /non-ASCII/);
});

test('32 random bytes is the smallest size that yields a legal verifier', () => {
  // RFC 7636 requires 43 to 128 characters. Unpadded base64 gives 4 characters per
  // 3 bytes, so 31 bytes lands on 42 — one short, and GitHub would reject the
  // authorize request for a reason that names nothing useful. 32 bytes gives 43.
  assert.equal(toBase64Url(base64FromAscii('a'.repeat(31))).length, 42);
  assert.equal(toBase64Url(base64FromAscii('a'.repeat(32))).length, 43);
});
