/**
 * Injectable seams for the git layer.
 *
 * `core` must stay free of React Native and of Node built-ins so it can run
 * under `node --test`. That forces every side effect behind an interface: the
 * filesystem, the HTTP transport, and the clock. The app supplies real
 * implementations; tests supply fakes.
 */

/**
 * What `stat` must return.
 *
 * Every numeric field is load-bearing. `normalizeStats` in isomorphic-git does
 * `% MAX_UINT32` on each one, so an `undefined` becomes `NaN` and is then
 * written into the binary index — a corrupted index, not a caught error. `mode`
 * must be a real git file mode (`0o40000` directory, `0o100644` file) or
 * `mode2type` throws `InternalError`.
 *
 * Brain: pages/git-fs-adapter-contract.md.
 */
export interface StatLike {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The subset of `isomorphic-git`'s fs adapter that we rely on.
 *
 * These nine methods are the whole contract. isomorphic-git's `bindFs`
 * unconditionally `.bind()`s each name in its `commands` list, so a missing
 * one throws `Cannot read properties of undefined (reading 'bind')` on the
 * *first git call*, not at construction. Notably absent: `rename` and a
 * `withFileTypes` overload of `readdir` are never called, so they are not here.
 *
 * Two behaviours are not visible in the types but are required:
 *
 * - **`readFile` must never throw synchronously.** isomorphic-git detects
 *   promise-style fs by calling `readFile()` with no arguments and inspecting
 *   the result. A synchronous throw makes it conclude the fs is callback-style,
 *   wrap every method in `pify`, and fail with a stack trace that names pify
 *   rather than the real cause.
 * - **Errors must carry `code`** (`ENOENT`, `EEXIST`, `ENOTDIR`). isomorphic-git
 *   branches on `err.code` to decide whether a missing path is `null` or a
 *   genuine failure, and whether an existing `mkdir` is fine.
 */
export interface FsLike {
  readFile(path: string, options?: { encoding?: 'utf8' | null }): Promise<Uint8Array | string>;
  writeFile(path: string, contents: Uint8Array | string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<StatLike>;
  lstat(path: string): Promise<StatLike>;
  /** Returns entry *names*, not paths. */
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<Uint8Array>;
  symlink(target: string, path: string): Promise<void>;
}

/** Git's mode bits for a directory and a regular file. */
export const MODE_DIR = 0o40000;
export const MODE_FILE = 0o100644;

/**
 * Strip a `file://` scheme and collapse `.` / `..` segments.
 *
 * isomorphic-git normalises paths itself, but not completely enough for the
 * device filesystem: it hands us `dir + '/' + filepath` where `filepath` may be
 * `'.'`, producing a trailing `/.`. And it destroys a `file://` URI passed as
 * `dir` outright — `join()` turns `file:///a/b` into `file:/a/b`. So every path
 * crossing this boundary is a plain POSIX path, and the adapter owns the
 * conversion in both directions.
 *
 * Pure, so it is the one part of the adapter testable without a device.
 * Brain: pages/git-fs-adapter-contract.md.
 */
export function toLocalPath(input: string): string {
  let path = input.replace(/^file:\/\//, '');
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return (absolute ? '/' : '') + out.join('/');
}

/**
 * The inverse of {@link toLocalPath}, for handing a path to expo-file-system.
 *
 * Idempotent, because a caller may legitimately have a URI already — expo hands
 * out `Paths.document.uri`, and a function that double-prefixed it would produce
 * `file://file:///…`, which fails at runtime rather than at compile time.
 */
export function toFileUri(localPath: string): string {
  if (localPath.startsWith('file://')) return localPath;
  return localPath.startsWith('/') ? `file://${localPath}` : `file:///${localPath}`;
}

/** An error shaped the way isomorphic-git branches on it. */
export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * A stable inode number derived from the path.
 *
 * isomorphic-git compares `ino` when deciding whether the index is stale, and
 * a constant would make every file look unchanged while a random value would
 * make every file look modified. Hashing the path is stable across calls and
 * across app restarts, which is exactly the property needed.
 */
export function inodeFor(path: string): number {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  }
  // Keep it non-zero so a zero inode is never mistaken for "unset".
  return hash === 0 ? 1 : hash;
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