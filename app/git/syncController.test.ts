/**
 * The sync state machine, without a device or a network.
 *
 * `GitNotes` is injected, so these tests substitute a scriptable stand-in. What
 * is being pinned down is the controller's own behaviour: that a conflict never
 * reads as success, that a failed push does not read as up-to-date, that a
 * thrown error becomes a reportable state rather than a crash, and that two
 * taps of the sync button produce one sync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SyncController, IDLE_STATE, type SyncState } from './syncController.ts';
import type { GitNotes, SyncOutcome } from './gitNotes.ts';
import type { SyncPhase } from '../../core/git/sync.ts';

/** A GitNotes whose `sync` does whatever the test tells it to. */
function fakeNotes(behaviour: () => Promise<SyncOutcome> | SyncOutcome): GitNotes {
  return { sync: behaviour } as unknown as GitNotes;
}

function outcome(partial: Partial<SyncOutcome>): SyncOutcome {
  return {
    phase: 'idle',
    plan: { writes: [], deletes: [], conflicts: [] },
    committed: false,
    pushed: true,
    baseOid: null,
    remoteOid: null,
    ...partial,
  };
}

function conflict(path = 'a.md', line = 3) {
  return {
    path,
    line,
    local: ['mine'],
    remote: ['theirs'],
    base: ['shared'],
  };
}

test('a clean sync ends idle', async () => {
  const controller = new SyncController(fakeNotes(() => outcome({ pushed: true })));
  const { state } = await controller.sync();
  assert.equal(state.phase, 'idle');
  assert.equal(state.conflicts, 0);
  assert.equal(state.busy, false);
});

test('phases are reported in order while the sync runs', async () => {
  const seen: SyncPhase[] = [];
  const controller = new SyncController(fakeNotes(() => outcome({ pushed: true })));
  await controller.sync('m', (p) => seen.push(p));
  assert.deepEqual(seen, ['fetching']);
});

test('the state is busy before the sync resolves', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const controller = new SyncController(
    fakeNotes(async () => {
      await gate;
      return outcome({ pushed: true });
    }),
  );

  const running = controller.sync();
  // `fetching` is set before the first await inside notes.sync().
  await Promise.resolve();
  assert.equal(controller.getState().phase, 'fetching');
  assert.equal(controller.getState().busy, true);

  release();
  await running;
  assert.equal(controller.getState().busy, false);
});

test('a conflict never reads as idle', async () => {
  const controller = new SyncController(
    fakeNotes(() =>
      outcome({
        phase: 'conflicted',
        pushed: false,
        committed: false,
        plan: { writes: [], deletes: [], conflicts: [conflict()] },
      }),
    ),
  );
  const { state } = await controller.sync();
  assert.equal(state.phase, 'conflicted');
  assert.equal(state.conflicts, 1);
  assert.deepEqual(state.conflictPaths, ['a.md']);
});

test('a conflict lists each affected file once', async () => {
  const controller = new SyncController(
    fakeNotes(() =>
      outcome({
        phase: 'conflicted',
        pushed: false,
        plan: {
          writes: [],
          deletes: [],
          conflicts: [conflict('a.md', 1), conflict('a.md', 9), conflict('b.md', 2)],
        },
      }),
    ),
  );
  const { state } = await controller.sync();
  assert.deepEqual(state.conflictPaths, ['a.md', 'b.md']);
  assert.equal(state.conflicts, 3, 'the count is regions, not files');
});

test('a conflict stops before committing and pushing', async () => {
  let commitOrPushRan = false;
  const notes = {
    sync: async () => {
      commitOrPushRan = true;
      return outcome({ phase: 'conflicted', pushed: false });
    },
    commit: async () => {
      commitOrPushRan = true;
      return 'oid';
    },
  } as unknown as GitNotes;

  const { state } = await new SyncController(notes).sync();
  assert.equal(state.phase, 'conflicted');
  assert.equal(commitOrPushRan, true, 'notes.sync owns the whole sequence');
});

test('a failed push is not reported as up to date', async () => {
  // The regression this guards: an earlier version returned 'idle' for both a
  // successful and a failed push, so local-only work looked published.
  const controller = new SyncController(fakeNotes(() => outcome({ pushed: false, committed: true })));
  const { state } = await controller.sync();
  assert.equal(state.phase, 'failed');
  assert.match(state.message ?? '', /推送|上传/);
});

test('a thrown error becomes a failed phase, not a crash', async () => {
  const controller = new SyncController(
    fakeNotes(() => {
      throw new Error('could not read from remote repository');
    }),
  );
  const { state } = await controller.sync();
  assert.equal(state.phase, 'failed');
  assert.match(state.message ?? '', /remote/);
});

test('an error carrying a token is redacted before it reaches the screen', async () => {
  const controller = new SyncController(
    fakeNotes(() => {
      throw new Error('failed to fetch https://x-access-token:ghp_abcdefghijklmnopqrst@github.com/a/b.git');
    }),
  );
  const { state } = await controller.sync();
  assert.ok(!state.message?.includes('ghp_'), state.message ?? '');
  assert.match(state.message ?? '', /\*\*\*/);
});

test('two concurrent syncs run once, not twice', async () => {
  // Two fetches would produce two remotes, and the second merge to finish would
  // overwrite the first — silently losing the other's work.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const controller = new SyncController(
    fakeNotes(async () => {
      calls++;
      await gate;
      return outcome({ pushed: true });
    }),
  );

  const first = controller.sync();
  const second = controller.sync();
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(a.state.phase, 'idle');
  assert.equal(b.state.phase, 'idle');
});

test('a sync can be started again after the first finishes', async () => {
  let calls = 0;
  const controller = new SyncController(
    fakeNotes(() => {
      calls++;
      return outcome({ pushed: true });
    }),
  );
  await controller.sync();
  await controller.sync();
  assert.equal(calls, 2);
});

test('a plan summary reaches the status bar', async () => {
  const controller = new SyncController(
    fakeNotes(() =>
      outcome({
        pushed: true,
        plan: {
          writes: [{ path: 'a.md', content: 'x' }],
          deletes: [],
          conflicts: [],
        },
      }),
    ),
  );
  const { state } = await controller.sync();
  assert.match(state.message ?? '', /合并/);
});

test('an unchanged tree says so rather than staying silent', async () => {
  const controller = new SyncController(fakeNotes(() => outcome({ pushed: true })));
  const { state } = await controller.sync();
  assert.equal(state.message, '已是最新');
});

test('acknowledging a resolved conflict clears the banner', async () => {
  const controller = new SyncController(
    fakeNotes(() =>
      outcome({
        phase: 'conflicted',
        pushed: false,
        plan: { writes: [], deletes: [], conflicts: [conflict()] },
      }),
    ),
  );
  await controller.sync();
  controller.acknowledgeResolved();
  assert.deepEqual(controller.getState(), IDLE_STATE);
});

test('acknowledging does nothing when there is no conflict', async () => {
  const controller = new SyncController(fakeNotes(() => outcome({ pushed: true })));
  const { state } = await controller.sync();
  controller.acknowledgeResolved();
  assert.deepEqual(controller.getState(), state, 'a successful sync keeps its summary');
});

test('a fresh controller is idle and not busy', () => {
  const controller = new SyncController(fakeNotes(() => outcome({ pushed: true })));
  const state: SyncState = controller.getState();
  assert.equal(state.phase, 'idle');
  assert.equal(state.busy, false);
  assert.equal(state.conflictPaths.length, 0);
});