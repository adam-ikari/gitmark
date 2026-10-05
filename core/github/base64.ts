/**
 * base64, without assuming a Node runtime.
 *
 * React Native has no `Buffer` by default, and `btoa` is not guaranteed either.
 * Both would be silent single-point failures: sign-in would work in a Node test,
 * pass typecheck, and then throw `Buffer is not defined` on the one device that
 * matters.
 *
 * So the encoder is here, pure and tested. It only has to handle ASCII, because
 * both of its callers are building ASCII: a Basic auth credential
 * (`x-access-token:ghu_…`) and a PKCE challenge.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;

    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0b11) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 0b1111) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[b2 & 0b111111] : '=';
  }
  return out;
}

/** Encode an ASCII string as base64. Throws on non-ASCII, which no caller sends. */
export function base64FromAscii(text: string): string {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new Error(`base64FromAscii received a non-ASCII character at ${i}`);
    }
    bytes[i] = code;
  }
  return toBase64(bytes);
}

/** The URL-safe, unpadded alphabet PKCE requires. */
export function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode standard base64 back to bytes. Used to assert the encoder against itself. */
export function fromBase64(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`not base64: ${char}`);
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (value >> bits) & 0xff;
    }
  }
  return bytes;
}
