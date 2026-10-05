/**
 * A fetch-based HTTP client for isomorphic-git.
 *
 * Two things about this contract are easy to get wrong, and both fail with a
 * misleading error rather than a type error:
 *
 *  1. `body` must be an **async iterator of Uint8Array**. Returning a Buffer, or
 *     a function returning a Buffer, produces
 *     `EmptyServerResponseError: Empty response from git server` — which says
 *     nothing about the real problem. Verified against a real GitHub clone;
 *     see brain/pages/github-pat-git-transport.md.
 *  2. isomorphic-git's own Node client depends on `node:http` and cannot run in
 *     React Native, so the app has to supply its own.
 */

import { bodyIterator, type HttpClient, type HttpRequest, type HttpResponse } from '../../core/git/types.ts';
import { TOKEN_PREFIX } from '../../core/github/auth.ts';
import { base64FromAscii } from '../../core/github/base64.ts';

export interface FetchClientOptions {
  /** Sent as `Authorization` on every request. Never logged. */
  token?: string | null;
  /** Extra headers, e.g. a user agent. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface FetchClient {
  /** As {@link HttpClient}, plus a per-request token override. */
  request(req: HttpRequest & { token?: string | null }): Promise<HttpResponse>;
}

/** Collect an async iterable into one Uint8Array. */
async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of iterable) {
    parts.push(part);
    size += part.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * The `Authorization` header GitHub's git endpoints expect for a given token.
 *
 * GitHub App user tokens (`ghu_`) are not personal access tokens, and the git
 * transport is the one place the difference bites: git over HTTPS authenticates
 * with HTTP Basic, where the password is the token and the username is
 * `x-access-token`. Sending `Bearer` to the git endpoints is accepted for the
 * REST API but is not what git auth is specified as, so the two are distinguished
 * on the token prefix rather than on which client is asking.
 *
 * Both forms are built here, in one place, because a token reaching the wrong
 * header is exactly the kind of failure that surfaces as an opaque 401 from deep
 * inside a fetch.
 */
export function authHeaderFor(token: string): string {
  if (token.startsWith(TOKEN_PREFIX)) {
    // base64 from a tested helper rather than `Buffer`, which React Native does not
    // provide — a missing Buffer here would surface as an opaque 401.
    return `Basic ${base64FromAscii(`x-access-token:${token}`)}`;
  }
  return `Bearer ${token}`;
}

export function createFetchClient(options: FetchClientOptions = {}): FetchClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    async request(req: HttpRequest & { token?: string | null }): Promise<HttpResponse> {
      const headers: Record<string, string> = {
        'user-agent': 'mark-notes',
        ...options.headers,
        ...req.headers,
      };

      // A per-request token wins over the client's own, because a GitHub App's
      // access token expires every eight hours and the client is built once.
      const token = req.token ?? options.token;

      // A token is only attached when present, and never appears in an error
      // message: a thrown URL or header dump would leak it to logcat.
      if (token) {
        headers.authorization = authHeaderFor(token);
      }

      const body = req.body ? await collect(req.body) : undefined;

      const res = await doFetch(req.url, {
        method: req.method ?? 'GET',
        headers,
        body: body as BodyInit | undefined,
        signal: req.signal,
      });

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        url: res.url || req.url,
        method: req.method ?? 'GET',
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: responseHeaders,
        body: bodyIterator(res.body, new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))),
      };
    },
  };
}

/**
 * Strip anything token-shaped from a message before it is shown or logged.
 *
 * GitHub puts the credential in the URL for some endpoints, so a bare error
 * message can carry it. Errors reach the UI, which makes this worth doing even
 * though the code is otherwise careful.
 */
export function redact(message: string): string {
  return message
    .replace(/\/\/[^@/\s]+@/g, '//***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}