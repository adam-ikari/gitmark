/**
 * The expo-file-system adapter for isomorphic-git.
 *
 * Every hard part of this file is a requirement isomorphic-git does not state
 * and fails to explain. The full evidence is in brain/pages/git-fs-adapter-contract.md;
 * the four that bite hardest:
 *
 * 1. `dir` and every path must be plain POSIX paths, never `file://` URIs.
 *    isomorphic-git's `join()` collapses `file:///a` to `file:/a`. This
 *    adapter owns the conversion in both directions, via `toLocalPath`.
 * 2. Paths arrive with `.` segments still in them (`dir + '/' + '.'`), because
 *    `GitWalkerFs` concatenates rather than joining. `toLocalPath` collapses
 *    them; without it every `statusMatrix` dies on `ENOENT: lstat '.'`.
 * 3. `readFile` must never throw synchronously. isomorphic-git sniffs for
 *    promise-style fs by calling `readFile()` with no arguments; a synchronous
 *    throw makes it wrap everything in `pify` and fail somewhere unrelated.
 * 4. Errors need `code`. isomorphic-git branches on it to tell "not there"
 *    from "broken", and `mkdir` must report `EEXIST` so its `mkdirp` swallows it.
 *
 * The file is thin on purpose: everything worth testing lives in core/git/types.ts.
 */

import {
  toLocalPath,
  toFileUri,
  codedError,
  inodeFor,
  MODE_DIR,
  MODE_FILE,
  type FsLike,
  type StatLike,
} from '../../core/git/types.ts';

/**
 * The expo-file-system surface this adapter needs.
 *
 * Declared structurally rather than imported so the adapter can be driven by a
 * fake. The point of declaring it at all is that {@link expoApi} assigns the
 * *real* `File` and `Directory` to these types with no cast, so `tsc` proves the
 * adapter only calls methods expo actually has.
 *
 * That check is not academic. An earlier version of this file cast the result
 * with `as unknown as FileLike`, which hid a call to a `modifiedAt()` method
 * that expo's `File` does not have — the adapter would have thrown a TypeError
 * inside every `stat()` on a real device, breaking sync entirely, while
 * typecheck stayed green. The cost of a cast here is the whole reason the
 * contract can drift unnoticed.
 */
export interface ExpoFsApi {
  fileOf(localPath: string): FileLike;
  directoryOf(localPath: string): DirectoryLike;
}

export interface FileLike {
  readonly exists: boolean;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  write(contents: Uint8Array | string): void;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  delete(): void;
  /** Metadata; `modificationTime` is in ms since epoch and may be absent. */
  info(): { modificationTime?: number };
  modifiedAt(): number;
}

export interface DirectoryLike {
  readonly exists: boolean;
  /** Entries as objects, each carrying a `name` — not a string list. */
  list(): Array<{ name: string }>;
  create(options?: { intermediates?: boolean; overwrite?: boolean; idempotent?: boolean }): void;
  delete(): void;
}

/** Lazily resolved so importing this module never requires the native module. */
let cached: ExpoFsApi | null = null;

async function expoApi(): Promise<ExpoFsApi> {
  if (cached) return cached;
  const { File, Directory } = await import('expo-file-system');

  // No cast on purpose: these assignments are the assertion that the adapter's
  // assumptions about expo-file-system are true. If a future Expo release
  // changes the surface, typecheck fails here instead of on a device.
  cached = {
    fileOf: (p) => new File(toFileUri(p)),
    directoryOf: (p) => new Directory(toFileUri(p)),
  };
  return cached;
}

/**
 * Build an `FsLike` over expo-file-system.
 *
 * `root` is the document directory. isomorphic-git is given plain paths under
 * it; the `file://` scheme is added only at the expo boundary.
 */
export async function createExpoFs(root: string): Promise<FsLike> {
  const api = await expoApi();
  return createFsFrom(api, rootedAt(root));
}

/**
 * The one place expo-file-system is constructed.
 *
 * Four modules used to each open their own `File`, which is exactly the hazard
 * brain/pages/sync-chain-wiring.md warns about: two adapters over one filesystem
 * produce a sync where one side can see a file and the other cannot. Every
 * caller goes through here, and returns the real `File` with no cast, so tsc
 * still proves the surface matches.
 */
export async function expoFile(localPath: string): Promise<FileLike> {
  const { File } = await import('expo-file-system');
  return new File(toFileUri(localPath));
}

/** As {@link expoFile}, for directories. */
export async function expoDirectory(localPath: string): Promise<DirectoryLike> {
  const { Directory } = await import('expo-file-system');
  return new Directory(toFileUri(localPath));
}

/**
 * Resolve a path as given to the fs, relative to `root`.
 *
 * isomorphic-git builds paths with `join(dir, filepath)`, which for an absolute
 * `dir` yields an **absolute** path — so the root must not be prepended again,
 * or every stat lands somewhere that does not exist. A relative path is still
 * accepted because isomorphic-git does pass a bare `'.'` while walking.
 */
export function rootedAt(root: string): (p: string) => string {
  const base = toLocalPath(root);
  return (p: string) => {
    const clean = toLocalPath(p);
    return clean.startsWith('/') ? clean : toLocalPath(`${base}/${clean}`);
  };
}

/**
 * The adapter itself, over an injected API and path resolver.
 *
 * Separated from {@link createExpoFs} so the mapping can be exercised against a
 * fake filesystem — the closest thing to a test available without a device.
 */
export function createFsFrom(api: ExpoFsApi, resolve: (p: string) => string): FsLike {
  const statOf = async (p: string): Promise<StatLike> => {
    const local = resolve(p);

    // A path can be either; expo's File and Directory both expose `exists`, so
    // the cheaper probe decides which kind it is.
    const asFile = api.fileOf(local);
    const asDir = api.directoryOf(local);

    if (!asFile.exists && !asDir.exists) {
      throw codedError('ENOENT', `ENOENT: no such file or directory, '${p}'`);
    }

    const isDir = !asFile.exists && asDir.exists;
    const size = isDir ? 0 : (asFile.size ?? 0);
    // `info()` rather than a dedicated accessor: expo's File exposes the
    // modification time there, and `modificationTime` is documented as possibly
    // absent, so a missing value falls back to 0 rather than NaN — see the
    // note in core/git/types.ts on why NaN would corrupt the index.
    const mtimeMs = isDir ? 0 : (asFile.modifiedAt() ?? 0);

    return {
      dev: 1,
      ino: inodeFor(local),
      mode: isDir ? MODE_DIR : MODE_FILE,
      uid: 0,
      gid: 0,
      size,
      mtimeMs,
      // Creation time is not exposed per-platform, and isomorphic-git only
      // compares it for staleness — the mtime is the field that matters.
      ctimeMs: mtimeMs,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isSymbolicLink: () => false,
    };
  };

  return {
    // Never throws synchronously: see the note above `isPromiseFs`.
    async readFile(p, options) {
      try {
        const file = api.fileOf(resolve(p));
        if (!file.exists) throw codedError('ENOENT', `ENOENT: '${p}'`);
        if (options?.encoding === 'utf8') return file.text();
        return file.bytes();
      } catch (err) {
        throw withCode(err, 'ENOENT', p);
      }
    },

    async writeFile(p, contents) {
      const file = api.fileOf(resolve(p));
      try {
        // `intermediates` because isomorphic-git writes `objects/ab/cdef…`,
        // and its `mkdirp` only creates the two-level prefix it asked for.
        file.create({ intermediates: true, overwrite: true });
        file.write(contents);
      } catch (err) {
        throw withCode(err, 'EACCES', p);
      }
    },

    async mkdir(p) {
      const dir = api.directoryOf(resolve(p));
      if (dir.exists) {
        // isomorphic-git's `mkdirp` treats EEXIST as success and anything else
        // as a real failure, so this code is load-bearing, not decoration.
        throw codedError('EEXIST', `EEXIST: file already exists, mkdir '${p}'`);
      }
      try {
        dir.create({ intermediates: true });
      } catch (err) {
        throw withCode(err, 'EACCES', p);
      }
    },

    async rmdir(p, options) {
      const dir = api.directoryOf(resolve(p));
      if (!dir.exists) return;
      if (options?.recursive) {
        // expo's delete() is already recursive; it has no non-recursive form.
        dir.delete();
        return;
      }
      try {
        const entries = dir.list();
        if (entries.length > 0) {
          throw codedError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${p}'`);
        }
        dir.delete();
      } catch (err) {
        throw withCode(err, 'ENOTEMPTY', p);
      }
    },

    async unlink(p) {
      const file = api.fileOf(resolve(p));
      if (!file.exists) {
        throw codedError('ENOENT', `ENOENT: no such file or directory, unlink '${p}'`);
      }
      try {
        file.delete();
      } catch (err) {
        throw withCode(err, 'EACCES', p);
      }
    },

    stat: statOf,
    lstat: statOf,

    async readdir(p) {
      const dir = api.directoryOf(resolve(p));
      if (!dir.exists) {
        throw codedError('ENOENT', `ENOENT: no such file or directory, scandir '${p}'`);
      }
      try {
        // expo returns objects; isomorphic-git wants bare names.
        return dir.list().map((entry) => entry.name);
      } catch (err) {
        throw withCode(err, 'ENOTDIR', p);
      }
    },

    async readlink(p) {
      // A note repo has no symlinks, and `core.symlinks = false` is written by
      // isomorphic-git's own init. Reporting ENOSYS keeps `lstat` consumers
      // from mistaking an unsupported link for a readable one.
      throw codedError('ENOSYS', `ENOSYS: symlinks are not supported, readlink '${p}'`);
    },

    async symlink(_target, p) {
      throw codedError('ENOSYS', `ENOSYS: symlinks are not supported, symlink '${p}'`);
    },
  };
}

/** Guarantee an `err.code`, defaulting to the operation's expected failure. */
function withCode(err: unknown, fallback: string, path: string): Error & { code: string } {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return err as Error & { code: string };
  }
  const message = err instanceof Error ? err.message : String(err);
  return codedError(fallback, `${fallback}: ${message} ('${path}')`);
}
