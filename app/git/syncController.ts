/**
 * The sync controller: the object a screen holds.
 *
 * It owns the phase, so that a screen cannot accidentally show "up to date"
 * while a sync is in flight. It also owns the single rule that matters —
 * a conflict stops everything — by making `sync()` the only path to a push and
 * by refusing to run a second sync while one is outstanding.
 *
 * Pure with respect to the screen: it takes a `GitNotes` and reports state, so
 * the whole state machine is testable without a device or a network.
 */

import { describePlan, type SyncPhase } from '../../core/git/sync.ts';
import type { SyncOutcome, GitNotes } from './gitNotes.ts';

export interface SyncState {
  phase: SyncPhase;
  /** Message for the status bar. Null means "derive it from the phase". */
  message: string | null;
  /** Files with unresolved conflict markers. */
  conflicts: number;
  /** Paths the last sync could not decide. */
  conflictPaths: string[];
  /** Whether a sync is running right now. */
  busy: boolean;
}

export const IDLE_STATE: SyncState = {
  phase: 'idle',
  message: null,
  conflicts: 0,
  conflictPaths: [],
  busy: false,
};

/** What the UI needs after a sync, whether or not it succeeded. */
export interface SyncReport {
  state: SyncState;
  outcome: SyncOutcome;
}

export class SyncController {
  private state: SyncState = IDLE_STATE;
  private inFlight: Promise<SyncReport> | null = null;

  // Written as an explicit field rather than a parameter property: Node's
  // type-stripping loader (which `node --test` uses) does not support them, and
  // this module has to stay importable from a test.
  private readonly notes: GitNotes;

  constructor(notes: GitNotes) {
    this.notes = notes;
  }

  getState(): SyncState {
    return this.state;
  }

  /**
   * Run a sync, reporting each phase as it happens.
   *
   * Re-entrant calls join the outstanding sync rather than starting a second
   * one. Two concurrent fetches of the same repo produce two different remotes,
   * and whichever merge finished last would silently overwrite the other's
   * result — the exact failure the conflict policy exists to prevent.
   */
  async sync(message = 'sync notes', onPhase?: (phase: SyncPhase) => void): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;

    const run = this.run(message, onPhase).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async run(message: string, onPhase?: (phase: SyncPhase) => void): Promise<SyncReport> {
    const report = async (phase: SyncPhase): Promise<void> => {
      this.state = { ...this.state, phase, busy: phase !== 'idle' };
      onPhase?.(phase);
    };

    await report('fetching');

    let outcome: SyncOutcome;
    try {
      outcome = await this.notes.sync(message);
    } catch (err) {
      // A thrown error is a failed sync, not a crash. The message is redacted
      // because GitHub puts credentials in URLs for some endpoints, and this
      // string reaches the screen.
      const message = redact(err instanceof Error ? err.message : String(err));
      this.state = { ...IDLE_STATE, phase: 'failed', message };
      return {
        state: this.state,
        outcome: {
          phase: 'failed',
          plan: { writes: [], deletes: [], conflicts: [] },
          committed: false,
          pushed: false,
          baseOid: null,
          remoteOid: null,
          message,
        },
      };
    }

    const conflictPaths = [...new Set(outcome.plan.conflicts.map((c) => c.path))];
    const conflicts = outcome.plan.conflicts.length;

    if (outcome.phase === 'conflicted') {
      // No commit, no push. The working tree still holds the user's own text.
      this.state = {
        phase: 'conflicted',
        message: outcome.message ?? describePlan(outcome.plan),
        conflicts,
        conflictPaths,
        busy: false,
      };
      return { state: this.state, outcome };
    }

    if (!outcome.pushed) {
      this.state = {
        phase: 'failed',
        message: outcome.message ?? '推送失败，本机变更尚未上传',
        conflicts,
        conflictPaths,
        busy: false,
      };
      return { state: this.state, outcome };
    }

    this.state = {
      phase: 'idle',
      message: describePlan(outcome.plan),
      conflicts,
      conflictPaths,
      busy: false,
    };
    return { state: this.state, outcome };
  }

  /**
   * Clear the conflict banner once the user has resolved everything.
   *
   * Deliberately not automatic. A conflict that clears itself because the file
   * happens to have been re-read is a conflict that gets pushed with markers
   * still in it.
   */
  acknowledgeResolved(): void {
    if (this.state.phase !== 'conflicted') return;
    this.state = { ...IDLE_STATE };
  }
}

/**
 * Strip token-shaped substrings from anything user-visible.
 *
 * Duplicated from fetchClient rather than imported because a controller that
 * cannot report an error without importing the transport module is a controller
 * that will eventually be used somewhere the transport is not available.
 */
function redact(input: string): string {
  return input
    .replace(/\/\/[^@/\s]+@/g, '//***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}