/**
 * The note list.
 *
 * Reads titles and tags from frontmatter, falling back to the first heading and
 * then the filename — so a note with no metadata still shows something
 * recognisable rather than a row of `.md`. Metadata is not rewritten on read:
 * a note that has never had frontmatter should not grow a block just from being
 * opened.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';

import { toNoteList, sortNotes, conflictCount, type NoteListItem } from './noteIndex.ts';
import { listNotesUnder } from '../git/gitNotes.ts';
import { readNote } from '../git/notes.ts';
import { colors, space, body } from '../theme/tokens.ts';

export type { NoteListItem } from './noteIndex.ts';

export interface NoteListScreenProps {
  /** Absolute path of the working tree. */
  dir: string;
  /** Changing this forces a reload; bump it after a sync. */
  revision?: number;
  /**
   * Open a note.
   *
   * The whole item is passed, not just the path, because a conflicted note goes
   * somewhere different: it opens the resolution screen rather than the editor.
   * The caller needs the flag to make that choice.
   */
  onOpen: (item: NoteListItem) => void;
  onSync: () => void;
  busy?: boolean;
}

export function NoteListScreen({
  dir,
  revision = 0,
  onOpen,
  onSync,
  busy = false,
}: NoteListScreenProps): React.JSX.Element {
  const [items, setItems] = useState<NoteListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const paths = await listNotesUnder(dir, '');
    const entries = await Promise.all(
      // `readNote` already returns null for a file that is absent or unreadable,
      // and already adds the `file://` scheme — which this screen used to omit,
      // handing expo a bare POSIX path.
      paths.map(async (path) => [path, await readNote(dir, path)] as [string, string | null]),
    );
    setItems(sortNotes(toNoteList(entries)));
    setLoading(false);
  }, [dir, revision]);

  useEffect(() => {
    void load();
  }, [load]);

  const conflicts = useMemo(() => conflictCount(items), [items]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>mark</Text>
        <View style={styles.headRight}>
          {conflicts > 0 && (
            <Text style={styles.conflictCount}>{conflicts} 个冲突</Text>
          )}
          <Pressable
            onPress={onSync}
            disabled={busy}
            style={({ pressed }) => [styles.syncButton, (pressed || busy) && styles.dim]}
            accessibilityRole="button"
            accessibilityLabel="同步"
          >
            <Text style={styles.syncText}>{busy ? '同步中…' : '同步'}</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.path}
        contentContainerStyle={items.length === 0 ? styles.emptyWrap : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>还没有笔记</Text>
            <Text style={styles.emptyHint}>在「编辑」分页建立第一篇。</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onOpen(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.rowPath} numberOfLines={1}>
              {item.path}
              {item.conflicted ? ' · 有冲突' : ''}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title: { ...body, fontWeight: '700' },
  conflictCount: { ...body, color: colors.conflict, fontSize: 13 },
  syncButton: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 14, backgroundColor: colors.accentSoft },
  syncText: { ...body, color: colors.accent, fontWeight: '700', fontSize: 13 },
  dim: { opacity: 0.6 },
  list: { paddingVertical: space.sm },
  emptyWrap: { flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyTitle: { ...body, fontWeight: '700', color: colors.textMuted },
  emptyHint: { ...body, fontSize: 13, color: colors.textMuted, marginTop: space.xs },
  row: { paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surface },
  rowTitle: { ...body, fontWeight: '600' },
  rowPath: { ...body, fontSize: 12, color: colors.textMuted, marginTop: 2 },
});