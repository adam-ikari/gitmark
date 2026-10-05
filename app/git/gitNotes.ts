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

import { readAtRef, listNotesAtRef, type NoteStore, type TriVersion } from '../../core/git/store.ts';
import { applyPlan, planSync, type SyncPlan, type SyncPhase } from '../../core/git/sync.ts';
import type { GitOptions } from '../../core/git/types.ts';
import { bodyOf } from '../../core/note/frontmatter.ts';
import { expoDirectory } from './expoFs.ts';
import { readNote, writeNote, deleteNote, noteExists } from './notes.ts';

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
    //
    // This is the new *local* head, not the remote's, and that is correct even
    // when the push failed: local head is what this device has actually
    // reconciled. Base = our merged result, local = our result, remote =
    // whatever they pushed means the next sync still merges their work
    // against ours rather than against a state neither of us ever had.
    const newHead = committed ?? localOid;
    if (newHead) await this.setRef('refs/mark/sync-base', newHead);

    if (!pushed) {
      // A local commit that never reached the remote is not "up to date", and
      // saying so is the whole point of the status bar.
      return {
        phase: 'failed',
        plan,
        committed: Boolean(committed),
        pushed: false,
        baseOid,
        remoteOid,
        message: committed ? '已合併，但推送失敗，下次同步會重試' : '推送失敗',
      };
    }

    return { phase: 'idle', plan, committed: Boolean(committed), pushed, baseOid, remoteOid };
  }

  private async readWorkingTree(paths: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const path of paths) {
      out.set(path, await readNote(this.opts.dir, path));
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
 * Delegates to app/git/notes.ts, which is the single place that touches the
 * device filesystem. This file used to open its own `File` — and passed a bare
 * POSIX path to a constructor that wants a `file://` URI, behind a cast that
 * stopped `tsc` from saying so. Two adapters over one filesystem is how a sync
 * ends up comparing a file one side can see and the other cannot; see
 * brain/pages/sync-chain-wiring.md.
 *
 * `create({ intermediates: true })`, inside writeNote, is what lets a merge
 * write the first note into a folder that does not exist yet.
 */

function storeFromFs(opts: GitOptions): NoteStore {
  return {
    read: (path) => readNote(opts.dir, path),
    write: (path, content) => writeNote(opts.dir, path, content),
    remove: (path) => deleteNote(opts.dir, path),
    exists: (path) => noteExists(opts.dir, path),
    /**
     * Note paths under the working tree.
     *
     * Recursive, because notes are organised in folders. Skips `.git` and
     * anything else starting with a dot: those are git's own files, and walking
     * them would be both slow and wrong to treat as notes.
     */
    list: () => listNotesUnder(opts.dir, ''),
  };
}

/**
 * Depth-first walk yielding repo-relative `.md` paths.
 *
 * `dir` is a POSIX path; `expoDirectory` adds the `file://` scheme at the
 * boundary, for the same reason isomorphic-git never sees one.
 */
export async function listNotesUnder(dir: string, prefix: string): Promise<string[]> {
  let entries: Array<{ name: string }>;
  try {
    const directory = await expoDirectory(`${dir}/${prefix}`.replace(/\/+/g, '/'));
    if (!directory.exists) return [];
    entries = directory.list();
  } catch {
    // A directory that cannot be read is an empty list, not a failure: the note
    // list should still render whatever else is readable.
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;

    // A note is a file whose name ends in `.md`; anything else is treated as a
    // folder to descend into. Deciding by extension rather than by asking the
    // filesystem avoids a stat per entry, and a folder named `x.md` is not a
    // case worth supporting.
    if (entry.name.endsWith('.md')) {
      out.push(child);
      continue;
    }
    out.push(...(await listNotesUnder(dir, child)));
  }
  return out;
}

export { bodyOf };
