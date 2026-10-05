import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EditorScreen } from './app/screens/EditorScreen.tsx';
import { RenderScreen } from './app/screens/RenderScreen.tsx';
import { NoteListScreen } from './app/screens/NoteListScreen.tsx';
import { RepoSetupScreen } from './app/screens/RepoSetupScreen.tsx';
import { ConflictScreen } from './app/screens/ConflictScreen.tsx';
import { SyncStatusBar } from './app/components/SyncStatusBar.tsx';
import { SyncController, IDLE_STATE, type SyncState } from './app/git/syncController.ts';
import { isConfigured } from './app/git/credentials.ts';
import { openWorkspace, type Workspace } from './app/git/workspace.ts';
import { readNote, writeNote } from './app/git/notes.ts';
import { colors, space, body } from './app/theme/tokens.ts';

type Tab = 'notes' | 'edit' | 'read';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'notes', label: '笔记' },
  { key: 'edit', label: '编辑' },
  { key: 'read', label: '渲染' },
];

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('notes');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [controller, setController] = useState<SyncController | null>(null);
  const [sync, setSync] = useState<SyncState>(IDLE_STATE);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);

  /** The note being resolved, or null when no conflict is open. */
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [conflictText, setConflictText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  // Load the workspace once. A repo that has never been configured is not an
  // error, it is the first-run state.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { Paths } = await import('expo-file-system');
        const { loadSettings } = await import('./app/git/credentials.ts');
        const { getStoredSession } = await import('./app/github/store.ts');
        const { sessionForSync } = await import('./app/github/signIn.ts');

        const [settings, session] = await Promise.all([loadSettings(), getStoredSession()]);

        // `isConfigured` wants the token itself; the session holds it, and
        // everything else about the session stays inside the auth module.
        if (!isConfigured(settings, session.accessToken)) {
          if (live) setReady(true);
          return;
        }

        const ws = await openWorkspace(toLocalDir(Paths.document.uri), {
          accessToken: async () => (await sessionForSync()).accessToken,
        });
        if (!live) return;
        const c = new SyncController(ws.notes);
        setWorkspace(ws);
        setController(c);
        setSync(c.getState());
        setReady(true);
      } catch {
        if (live) setReady(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const onConnected = useCallback(() => {
    // Reload from scratch rather than patching state: a fresh session may point at
    // a different remote, and the controller holds the transport.
    setReady(false);
    setWorkspace(null);
    setController(null);
    setSync(IDLE_STATE);
    void (async () => {
      const { Paths } = await import('expo-file-system');
      const { sessionForSync } = await import('./app/github/signIn.ts');
      const ws = await openWorkspace(toLocalDir(Paths.document.uri), {
        accessToken: async () => (await sessionForSync()).accessToken,
      });
      const c = new SyncController(ws.notes);
      setWorkspace(ws);
      setController(c);
      setSync(c.getState());
      setReady(true);
    })().catch(() => setReady(true));
  }, []);

  const onSync = useCallback(() => {
    if (!controller) return;
    void controller.sync('sync notes', () => setSync(controller.getState())).then((report) => {
      setSync(report.state);
      // Bump the list so notes merged by this sync appear without a manual pull.
      setRevision((r) => r + 1);
    });
  }, [controller]);

  /**
   * Open a note.
   *
   * A conflicted note goes to the resolution screen; anything else to the editor.
   * The conflicted text is read once, here, and the resolution screen works on
   * that snapshot — re-reading per tap would renumber the regions underneath the
   * user's choices.
   */
  const openNote = useCallback(
    async (item: { path: string; conflicted: boolean }) => {
      if (!item.conflicted) {
        setTab('edit');
        return;
      }
      if (!workspace) return;
      setProblem(null);
      const text = await readNote(workspace.dir, item.path);
      if (text === null) {
        setProblem(`读不到 ${item.path}`);
        return;
      }
      setConflictPath(item.path);
      setConflictText(text);
    },
    [workspace],
  );

  /** Write a resolved note, then let the next sync carry it. */
  const saveResolution = useCallback(
    async (resolved: string) => {
      if (!workspace || conflictPath === null) return;
      try {
        // `guard` re-checks the markers on the exact text being written, so a
        // bug upstream of here still cannot commit a note with markers in it.
        await writeNote(workspace.dir, conflictPath, resolved, { guard: true });
        setConflictPath(null);
        setConflictText('');
        setRevision((r) => r + 1);
        // A resolved note is local work that the remote does not have yet.
        setProblem(null);
      } catch (err) {
        setProblem(err instanceof Error ? `无法储存：${err.message}` : '无法储存');
      }
    },
    [workspace, conflictPath],
  );

  /** Hand the note to the editor for manual resolution. */
  const editManually = useCallback(() => {
    setConflictPath(null);
    setTab('edit');
  }, []);

  if (!ready) {
    return (
      <View style={styles.center}>
        <Text style={styles.meta}>载入中…</Text>
      </View>
    );
  }

  if (!workspace) {
    return <RepoSetupScreen onConnected={onConnected} />;
  }

  // A conflict takes over the screen: it is the one thing that cannot be deferred,
  // because it is also blocking the sync that would carry the fix.
  if (conflictPath !== null) {
    return (
      <View style={styles.root}>
        <ConflictScreen
          path={conflictPath}
          text={conflictText}
          onSave={(resolved) => void saveResolution(resolved)}
          onEditManually={editManually}
          onCancel={() => setConflictPath(null)}
        />
        {problem && <Text style={styles.problem}>{problem}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TabButton key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
        ))}
      </View>

      {tab === 'notes' && (
        <NoteListScreen
          dir={workspace.dir}
          revision={revision}
          onOpen={(item) => void openNote(item)}
          onSync={onSync}
          busy={sync.busy}
        />
      )}
      {tab === 'edit' && <EditorScreen />}
      {tab === 'read' && <RenderScreen />}

      <SyncStatusBar
        phase={sync.phase}
        message={sync.message}
        conflictCount={sync.conflicts}
        onSync={onSync}
        busy={sync.busy}
      />
    </View>
  );
}

/** `file:///a/b` -> `/a/b`, because isomorphic-git normalises paths, not URIs. */
function toLocalDir(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  tabs: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: { paddingHorizontal: space.lg, paddingVertical: space.xs, borderRadius: 14 },
  tabActive: { backgroundColor: colors.accentSoft },
  tabText: { ...body, fontSize: 14, color: colors.textMuted },
  tabTextActive: { color: colors.accent, fontWeight: '700' },
  meta: { ...body, color: colors.textMuted, fontSize: 13 },
  problem: { ...body, color: colors.danger, fontSize: 13, padding: space.md },
});