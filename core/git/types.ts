/**
 * Injectable seams for the git layer.
 *
 * `core` must stay free of React Native and of Node built-ins so it can run
 * under `node --test`. That forces every side effect behind an interface: the
 * filesystem, the HTTP transport, and the clock. The app supplies real
 * implementations; tests supply fakes.
 */

/** The subset of `isomorphic-git`'s fs adapter that we rely on. */
export interface FsLike {
  readFile(path: string, options: { encoding: null }): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readdir(path: string, options: { withFileTypes: true }): Promise<FileDirent[]>;
}

export interface FileDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * A response body must be an async iterator of `Uint8Array`.
 *
 * This is the single most surprising part of isomorphic-git's HTTP contract: a
 * Buffer, or a function returning a Buffer, produces a misleading
 * `EmptyServerResponseError` rather than a type error. Verified against a real
 * GitHub clone — see brain/pages/github-pat-git-transport.md.
 */
export interface HttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterator<Uint8Array>;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body, as an async iterator. */
  body?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
  onAuth?: () => Promise<{ username: string; password: string } | void>;
  onProgress?: (progress: { phase: string; loaded: number; total: number }) => void;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Options for a single git operation, so callers can cancel. */
export interface GitOptions {
  fs: FsLike;
  http: HttpClient;
  /** Absolute path to the working tree. */
  dir: string;
  signal?: AbortSignal;
  onProgress?: (p: { phase: string; loaded: number; total: number }) => void;
}

/**
 * Turn a fetch response body into the async iterator isomorphic-git wants.
 *
 * Kept in core (not app) because the shape of the transport is part of the
 * contract we are implementing against, and a test asserts it.
 */
export function bodyIterator(
  stream: unknown,
  fallback: Uint8Array,
): AsyncIterator<Uint8Array> {
  const candidate = stream as {
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
    [Symbol.asyncIterator]?: unknown;
  };

  if (candidate && typeof candidate[Symbol.asyncIterator] === 'function') {
    return (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  }
  if (candidate && typeof candidate.getReader === 'function') {
    const reader = candidate.getReader();
    return {
      next: () => reader.read() as Promise<IteratorResult<Uint8Array>>,
      return: () => {
        reader.releaseLock();
        return Promise.resolve({ done: true, value: undefined } as IteratorResult<Uint8Array>);
      },
    };
  }

  // No streaming available: hand the whole payload over as one chunk.
  let sent = false;
  return {
    next: () =>
      Promise.resolve(
        sent
          ? { done: true, value: undefined }
          : { done: false, value: fallback },
      ),
    return: () => Promise.resolve({ done: true, value: undefined } as IteratorResult<Uint8Array>),
  };
}