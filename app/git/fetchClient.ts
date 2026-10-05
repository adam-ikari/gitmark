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

export interface FetchClientOptions {
  /** Sent as `Authorization` on every request. Never logged. */
  token?: string | null;
  /** Extra headers, e.g. a user agent. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
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

export function createFetchClient(options: FetchClientOptions = {}): HttpClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const headers: Record<string, string> = {
        'user-agent': 'mark-notes',
        ...options.headers,
        ...req.headers,
      };

      // A token is only attached when present, and never appears in an error
      // message: a thrown URL or header dump would leak it to logcat.
      if (options.token) {
        headers.authorization = `Bearer ${options.token}`;
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