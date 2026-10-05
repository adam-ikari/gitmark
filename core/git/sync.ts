/**
 * Sync state machine.
 *
 * The rule that shapes everything here: on a real conflict the sync **stops**.
 * It does not commit, and it certainly does not push. Half-resolved work pushed
 * to a shared repo is worse than an unresolved conflict, because the conflict
 * markers become everybody's problem.
 *
 * Brain: pages/safe-auto-merge.md.
 */

import { resolveNote, type NoteStore, type MergeOutcome, type TriVersion } from './store.ts';

export type SyncPhase =
  | 'idle'
  | 'fetching'
  | 'merging'
  | 'pushing'
  | 'conflicted'
  | 'failed';

export interface ConflictFile {
  path: string;
  /** Line in the merged text where the conflict begins. */
  line: number;
  local: string[];
  remote: string[];
  base: string[];
}

export interface SyncPlanEntry {
  path: string;
  outcome: MergeOutcome;
}

export interface SyncPlan {
  /** Files that will be written and committed. */
  writes: Array<{ path: string; content: string }>;
  /** Files that should be removed from the working tree. */
  deletes: string[];
  /** Files whose merge could not be decided automatically. */
  conflicts: ConflictFile[];
}

export interface SyncResult {
  phase: SyncPhase;
  plan: SyncPlan;
  /** Human-readable reason when the sync stopped early. */
  blocked?: string;
}

/**
 * Build the plan for a sync given the three versions of every touched note.
 *
 * Pure: no filesystem, no git. This is where the conflict policy is enforced,
 * and where the tests concentrate.
 */
export function planSync(versions: Iterable<[string, TriVersion]>): SyncPlan {
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  const conflicts: ConflictFile[] = [];

  for (const [path, v] of versions) {
    const outcome = resolveNote(v);

    switch (outcome.kind) {
      case 'unchanged':
        break;

      case 'clean':
        if (outcome.changed) {
          if (outcome.content === '') deletes.push(path);
          else writes.push({ path, content: outcome.content });
        }
        break;

      case 'delete-modify':
        // Never resolve this silently. Someone's words are on one side and a
        // delete on the other; only a person can say which is intended.
        conflicts.push({
          path,
          line: 0,
          local: v.local === null ? [] : v.local.split('\n'),
          remote: v.remote === null ? [] : v.remote.split('\n'),
          base: v.base === null ? [] : v.base.split('\n'),
        });
        break;

      case 'conflict':
        for (const c of outcome.result.conflicts) {
          conflicts.push({
            path,
            line: c.mergedLine,
            local: c.local,
            remote: c.remote,
            base: c.base,
          });
        }
        break;
    }
  }

  return { writes, deletes, conflicts };
}

/**
 * Decide whether a plan may proceed to commit and push.
 *
 * Kept separate from `planSync` so the "stop on conflict" rule is one assertion
 * rather than spread across branches.
 */
export function canProceed(plan: SyncPlan): boolean {
  return plan.conflicts.length === 0;
}

export function phaseAfterPlan(plan: SyncPlan): SyncPhase {
  return canProceed(plan) ? 'pushing' : 'conflicted';
}

/**
 * Apply the non-conflicting parts of a plan.
 *
 * Conflicted files are intentionally left untouched in the working tree: the
 * editor should show the user's own text while they decide, not a mangled
 * merge. The conflict metadata travels alongside instead.
 */
export async function applyPlan(store: NoteStore, plan: SyncPlan): Promise<void> {
  for (const { path, content } of plan.writes) {
    await store.write(path, content);
  }
  for (const path of plan.deletes) {
    await store.remove(path);
  }
}

/** Every path mentioned by the plan, for staging. */
export function touchedPaths(plan: SyncPlan): string[] {
  const set = new Set<string>();
  for (const w of plan.writes) set.add(w.path);
  for (const d of plan.deletes) set.add(d);
  for (const c of plan.conflicts) set.add(c.path);
  return [...set];
}

/** A one-line summary suitable for a status bar. */
export function describePlan(plan: SyncPlan): string {
  if (plan.conflicts.length > 0) {
    const n = plan.conflicts.length;
    return `${n} 个档案有冲突，需要手动处理`;
  }
  const parts: string[] = [];
  if (plan.writes.length > 0) parts.push(`${plan.writes.length} 个档案已合并`);
  if (plan.deletes.length > 0) parts.push(`${plan.deletes.length} 个档案已删除`);
  return parts.length > 0 ? parts.join('，') : '已是最新';
}