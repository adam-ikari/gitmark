/**
 * The isomorphic-git adapter.
 *
 * Everything git-specific lives here, behind the interfaces core declares. That
 * boundary is what let the merge and sync logic be tested without git at all, and
 * it is why the transport and the filesystem are constructor arguments rather
 * than imports.
 *
 * The sync sequence is deliberately ordered:
 *
 *   fetch → read base/remote → three-way merge → **stop on conflict** → commit → push
 *
 * The stop is not a convenience. Pushing a commit that contains conflict markers
 * turns one person's unresolved edit into everybody's problem, because the next
 * device to pull inherits those markers.
 */

import { readAtRef, listNotesAtRef, type TriVersion } from '../../core/git/store.ts';
import { applyPlan, planSync, touchedPaths, type SyncPlan, type SyncPhase } from '../../core/git/sync.ts';
import type { GitOptions } from '../../core/git/types.ts';
import { bodyOf } from '../../core/note/frontmatter.ts';

export interface Author {
  name: string;
  email: string;
}

export interface SyncOutcome {
  phase: SyncPhase;
  plan: SyncPlan;
  committed: boolean;
  pushed: boolean;
  /** Base commit used for the merge; also what the next sync will use. */
  baseOid: string | null;
  remoteOid: string | null;
  message?: string;
}

const NOTE_GLOB = /\.md$/;

export class GitNotes {
  constructor(
    private readonly opts: GitOptions,
    private readonly author: Author,
    private readonly branch = 'main',
  ) {}

  private async git() {
    return import('isomorphic-git');
  }

  private ref(remote: boolean): string {
    return remote ? `refs/remotes/origin/${this.branch}` : `refs/heads/${this.branch}`;
  }

  /** Create the repository and point it at `remoteUrl`. */
  async init(remoteUrl: string): Promise<void> {
    const git = await this.git();
    const common = { fs: this.opts.fs as never, dir: this.opts.dir };
    await git.init({ ...common, defaultBranch: this.branch });
    await git.addRemote({ ...common, remote: 'origin', url: remoteUrl, force: true });
  }

  async head(): Promise<string | null> {
    const git = await this.git();
    try {
      return await git.resolveRef({ fs: this.opts.fs as never, dir: this.opts.dir, ref: this.ref(false) });
    } catch {
      return null;
    }
  }

  /**
   * The commit this device last synchronised.
   *
   * This is the base for the next three-way merge. It must be a real commit,
   * not "the current local head": after a sync that merged other people's work,
   * using local head would make the next sync compare against content that
   * already contains them.
   */
  async syncBase(): Promise<string | null> {
    return this.refOf('refs/mark/sync-base');
  }

  private async refOf(ref: string): Promise<string | null> {
    const git = await this.git();
    try {
      return await git.resolveRef({ fs: this.opts.fs as never, dir: this.opts.dir, ref });
    } catch {
      return null;
    }
  }

  private async setRef(ref: string, oid: string): Promise<void> {
    const git = await this.git();
    await git.writeRef({ fs: this.opts.fs as never, dir: this.opts.dir, ref, value: oid, force: true });
  }

  /** List note paths known to git at the synced base. */
  async listAtBase(): Promise<string[]> {
    const base = await this.syncBase();
    if (!base) return [];
    try {
      return (await listNotesAtRef(this.opts, base)).filter((p) => NOTE_GLOB.test(p));
    } catch {
      return [];
    }
  }

  /** Fetch the remote branch. */
  async fetch(): Promise<string | null> {
    const git = await this.git();
    await git.fetch({
      fs: this.opts.fs as never,
      http: this.opts.http as never,
      dir: this.opts.dir,
      ref: `refs/heads/${this.branch}`,
      remote: 'origin',
      singleBranch: true,
      onProgress: this.opts.onProgress,
    });
    return this.refOf(this.ref(true));
  }

  /** Note paths currently in the working tree, per the git index. */
  async listLocal(): Promise<string[]> {
    const git = await this.git();
    const matrix = await git.statusMatrix({ fs: this.opts.fs as never, dir: this.opts.dir });
    const paths = new Set<string>();
    for (const [filepath, head, workdir, stage] of matrix) {
      void stage;
      if (!NOTE_GLOB.test(filepath)) continue;
      // [1] is a deletion.
      if (head !== 1 && workdir !== 1) paths.add(filepath);
    }
    return [...paths];
  }

  /**
   * Run a full synchronisation.
   *
   * Returns what happened rather than throwing, because "stopped because of a
   * conflict" is an outcome the UI has to render, not an exception.
   */
  async sync(message = 'sync notes'): Promise<SyncOutcome> {
    const baseOid = await this.syncBase();
    const localOid = await this.head();

    const remoteOid = await this.fetch();

    // Every path any side knows about.
    const [localPaths, basePaths] = [await this.listLocal(), await this.listAtBase()];
    const remotePaths = remoteOid ? await listNotesAtRef(this.opts, remoteOid).catch(() => []) : [];

    const paths = [...new Set([...localPaths, ...basePaths, ...remotePaths])].filter((p) =>
      NOTE_GLOB.test(p),
    );

    const localText = await this.readWorkingTree(paths);
    const baseText = await readAtRef(this.opts, baseOid, paths);
    const remoteText = await readAtRef(this.opts, remoteOid, paths);

    const versions: Array<[string, TriVersion]> = paths.map((path) => [
      path,
      {
        base: baseText.get(path) ?? null,
        local: localText.get(path) ?? null,
        remote: remoteText.get(path) ?? null,
      },
    ]);

    const plan = planSync(versions);

    // A conflict stops everything. No commit, no push, and the working tree is
    // left showing the user's own text.
    if (plan.conflicts.length > 0) {
      return {
        phase: 'conflicted',
        plan,
        committed: false,
        pushed: false,
        baseOid,
        remoteOid,
        message: `${plan.conflicts.length} 個檔案有衝突，已停止同步`,
      };
    }

    await applyPlan(storeFromFs(this.opts), plan);

    const committed = await this.commitAll(plan, message);
    const pushed = await this.push();

    // Record what we synced against, so the next merge has the right base.
    const newHead = committed ?? localOid;
    if (newHead) await this.setRef('refs/mark/sync-base', newHead);

    return { phase: pushed ? 'idle' : 'idle', plan, committed: Boolean(committed), pushed, baseOid, remoteOid };
  }

  private async readWorkingTree(paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const path of paths) {
      out.set(path, await readNoteFile(`${this.opts.dir}/${path}`));
    }
    return out;
  }

  /** Stage the plan's paths and commit, if anything actually changed. */
  private async commitAll(plan: SyncPlan, message: string): Promise<string | null> {
    const git = await this.git();
    const common = { fs: this.opts.fs as never, dir: this.opts.dir };

    for (const { path } of plan.writes) {
      await git.add({ ...common, filepath: path });
    }
    for (const path of plan.deletes) {
      await git.remove({ ...common, filepath: path });
    }

    const matrix = await git.statusMatrix(common);
    const dirty = matrix.some(([, head, workdir]) => head !== 1 && workdir !== 1);
    if (!dirty) return null;

    return git.commit({ ...common, message, author: this.author });
  }

  private async push(): Promise<boolean> {
    const git = await this.git();
    try {
      await git.push({
        fs: this.opts.fs as never,
        http: this.opts.http as never,
        dir: this.opts.dir,
        ref: this.ref(false),
        remote: 'origin',
        signal: this.opts.signal,
        onProgress: this.opts.onProgress,
      });
      return true;
    } catch {
      // A failed push leaves local commits in place; the next sync retries.
      return false;
    }
  }

  /** Commit the working tree on demand, for an explicit "save" action. */
  async commit(message: string): Promise<string | null> {
    const git = await this.git();
    const common = { fs: this.opts.fs as never, dir: this.opts.dir };
    await git.add({ ...common, filepath: '.' });
    const matrix = await git.statusMatrix(common);
    const dirty = matrix.some(([, head, workdir]) => head !== 1 && workdir !== 1);
    if (!dirty) return null;
    return git.commit({ ...common, message, author: this.author });
  }
}

/**
 * The filesystem operations the sync engine needs, over expo-file-system.
 *
 * Written against the imperative `File` class rather than the async functions
 * because `create({ intermediates: true })` creates parent directories, which a
 * merged note may need when it is the first file in a new folder.
 */

interface FileHandleLike {
  exists: boolean;
  text(): Promise<string>;
  write(content: string): void;
  create(options?: { intermediates?: boolean; overwrite?: boolean }): void;
  delete(): void;
}

async function openFile(uri: string): Promise<FileHandleLike> {
  const { File } = await import('expo-file-system');
  return new File(uri) as unknown as FileHandleLike;
}

async function readNoteFile(uri: string): Promise<string | null> {
  try {
    const file = await openFile(uri);
    if (!file.exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

function storeFromFs(opts: GitOptions) {
  return {
    async read(path: string) {
      return readNoteFile(`${opts.dir}/${path}`);
    },
    async write(path: string, content: string) {
      const file = await openFile(`${opts.dir}/${path}`);
      // `intermediates` covers the case where a merge creates a note in a folder
      // that does not exist yet.
      file.create({ intermediates: true, overwrite: true });
      file.write(content);
    },
    async remove(path: string) {
      try {
        const file = await openFile(`${opts.dir}/${path}`);
        if (file.exists) file.delete();
      } catch {
        /* already gone */
      }
    },
    async exists(path: string) {
      try {
        return (await openFile(`${opts.dir}/${path}`)).exists;
      } catch {
        return false;
      }
    },
    async list() {
      return [];
    },
  };
}

export { bodyOf };
