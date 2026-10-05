import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EditorScreen } from './app/screens/EditorScreen.tsx';
import { RenderScreen } from './app/screens/RenderScreen.tsx';
import { NoteListScreen } from './app/screens/NoteListScreen.tsx';
import { RepoSetupScreen } from './app/screens/RepoSetupScreen.tsx';
import { SyncStatusBar } from './app/components/SyncStatusBar.tsx';
import { SyncController, IDLE_STATE, type SyncState } from './app/git/syncController.ts';
import { isConfigured } from './app/git/credentials.ts';
import { openWorkspace, type Workspace } from './app/git/workspace.ts';
import { colors, space, body } from './app/theme/tokens.ts';

type Tab = 'notes' | 'edit' | 'read';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'notes', label: '筆記' },
  { key: 'edit', label: '編輯' },
  { key: 'read', label: '渲染' },
];

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('notes');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [controller, setController] = useState<SyncController | null>(null);
  const [sync, setSync] = useState<SyncState>(IDLE_STATE);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);

  // Load the workspace once. A repo that has never been configured is not an
  // error, it is the first-run state.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { Paths } = await import('expo-file-system');
        const { loadSettings, loadToken } = await import('./app/git/credentials.ts');
        const settings = await loadSettings();
        const token = await loadToken();

        if (!isConfigured(settings, token)) {
          if (live) setReady(true);
          return;
        }

        const ws = await openWorkspace(toLocalDir(Paths.document.uri));
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
    // Reload from scratch rather than patching state: a fresh token may point at
    // a different remote, and the controller holds the transport.
    setReady(false);
    setWorkspace(null);
    setController(null);
    setSync(IDLE_STATE);
    void (async () => {
      const { Paths } = await import('expo-file-system');
      const ws = await openWorkspace(toLocalDir(Paths.document.uri));
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

  const configured = useMemo(() => workspace !== null, [workspace]);

  if (!ready) {
    return (
      <View style={styles.center}>
        <Text style={styles.meta}>載入中…</Text>
      </View>
    );
  }

  if (!configured) {
    return <RepoSetupScreen onConnected={onConnected} />;
  }

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TabButton key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
        ))}
      </View>

      {tab === 'notes' && workspace && (
        <NoteListScreen
          dir={workspace.dir}
          revision={revision}
          onOpen={() => setTab('edit')}
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
});