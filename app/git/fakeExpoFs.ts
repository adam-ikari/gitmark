/**
 * An in-memory `ExpoFsApi`, for driving the adapter without a device.
 *
 * Shaped to match expo-file-system exactly where the adapter could plausibly be
 * wrong: `list()` returns objects carrying `name` rather than strings,
 * `delete()` is recursive with no non-recursive form, and `create()` requires
 * the parent to exist unless `intermediates` is set.
 *
 * Brain: pages/git-fs-adapter-contract.md
 */

import type { DirectoryLike, ExpoFsApi, FileLike } from './expoFs.ts';

export class FakeExpoFs implements ExpoFsApi {
  readonly dirs = new Set<string>(['/']);
  readonly files = new Map<string, Uint8Array>();
  readonly mtimes = new Map<string, number>();

  fileOf(localPath: string): FileLike {
    const fs = this;
    return {
      get exists() {
        return fs.files.has(localPath);
      },
      get size() {
        return fs.files.get(localPath)?.byteLength ?? 0;
      },
      async bytes() {
        const bytes = fs.files.get(localPath);
        if (!bytes) throw new Error(`no such file ${localPath}`);
        return bytes;
      },
      async text() {
        const bytes = fs.files.get(localPath);
        if (!bytes) throw new Error(`no such file ${localPath}`);
        return new TextDecoder().decode(bytes);
      },
      write(contents) {
        fs.files.set(localPath, typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);
        if (!fs.mtimes.has(localPath)) fs.mtimes.set(localPath, 1_700_000_000_000);
      },
      create(options) {
        if (options?.intermediates) {
          fs.ensureParents(localPath);
          return;
        }
        const parent = localPath.slice(0, localPath.lastIndexOf('/'));
        if (parent && !fs.dirs.has(parent)) throw new Error(`ENOENT: ${parent}`);
      },
      delete() {
        fs.files.delete(localPath);
      },
      // Shaped like expo's `info()`, including the possibility of an absent
      // modificationTime — the fake should not be more forgiving than the real
      // thing, or it will not catch an adapter that assumes otherwise.
      info() {
        return { modificationTime: fs.mtimes.get(localPath) };
      },
      modifiedAt() {
        return fs.mtimes.get(localPath) ?? 0;
      },
    };
  }

  directoryOf(localPath: string): DirectoryLike {
    const fs = this;
    return {
      get exists() {
        return fs.dirs.has(localPath);
      },
      list() {
        const prefix = localPath === '/' ? '/' : `${localPath}/`;
        const names = new Set<string>();
        for (const d of fs.dirs) {
          if (d !== localPath && d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0]!);
        }
        for (const f of fs.files.keys()) {
          if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!);
        }
        return [...names].map((name) => ({ name }));
      },
      create(options) {
        const parent = localPath.slice(0, localPath.lastIndexOf('/'));
        if (!options?.intermediates && parent && !fs.dirs.has(parent)) throw new Error(`ENOENT: ${parent}`);
        fs.ensureParents(localPath);
      },
      delete() {
        // expo's delete() has no non-recursive form.
        for (const d of [...fs.dirs]) {
          if (d === localPath || d.startsWith(`${localPath}/`)) fs.dirs.delete(d);
        }
        for (const f of [...fs.files.keys()]) {
          if (f.startsWith(`${localPath}/`)) fs.files.delete(f);
        }
      },
    };
  }

  /** Create `localPath` and every parent, as `create({ intermediates: true })` would. */
  ensureParents(localPath: string): void {
    const parts = localPath.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.dirs.add(`/${parts.slice(0, i).join('/')}`);
  }
}

/** Seed a file, creating its parent directories. */
export function seedFile(fs: FakeExpoFs, path: string, content: string): void {
  fs.ensureParents(path);
  fs.files.set(path, new TextEncoder().encode(content));
  fs.mtimes.set(path, 1_700_000_000_000);
}
