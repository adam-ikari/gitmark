/**
 * Conflict resolution.
 *
 * One region at a time, three ways to answer each: my version, their version,
 * or edit it by hand. There is no "discard my changes" button and nothing is
 * preselected — brain/pages/safe-auto-merge.md rules out a two-way choice with
 * a destructive default, because for notes the destructive option is the worst
 * possible default.
 *
 * The note is **not** rewritten as you tap. Each choice is recorded against the
 * text as loaded and applied once at the end, because resolving a region removes
 * its markers and renumbers every region after it — rewriting per tap would slide
 * the remaining choices onto the wrong text. See app/screens/conflictModel.ts.
 *
 * "完成并储存" stays disabled until every region is answered, and a region whose
 * markers never closed offers only manual editing, since there is no delimited
 * other side to choose.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';

import {
  startSession,
  decide,
  decideAll,
  undecide,
  regionsOf,
  outstanding,
  isReady,
  resolvedText,
  summary,
  assertCommitReady,
  stepFor,
  type ConflictSession,
} from './conflictModel.ts';
import { colors, space, body, mono } from '../theme/tokens.ts';

export interface ConflictScreenProps {
  /** Repo-relative note path, for the title. */
  path: string;
  /** The conflicted note text, as loaded. */
  text: string;
  /** Write the resolved note. Receives text that is guaranteed marker-free. */
  onSave: (resolved: string) => void;
  /** Hand the whole note to the editor for manual resolution. */
  onEditManually: (text: string) => void;
  onCancel?: () => void;
}

export function ConflictScreen({
  path,
  text,
  onSave,
  onEditManually,
  onCancel,
}: ConflictScreenProps): React.JSX.Element {
  const [session, setSession] = useState<ConflictSession>(() => startSession(text));
  const [problem, setProblem] = useState<string | null>(null);

  const regions = useMemo(() => regionsOf(session), [session]);
  const left = useMemo(() => outstanding(session), [session]);
  const ready = isReady(session);

  const save = useCallback(() => {
    const resolved = resolvedText(session);
    if (resolved === null) {
      setProblem('仍有冲突未选择');
      return;
    }
    try {
      // The last check before anything is written. A note with markers must not
      // reach a commit: the next device to pull would inherit them.
      assertCommitReady(resolved);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : '无法储存');
      return;
    }
    onSave(resolved);
  }, [session, onSave]);

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>解决冲突</Text>
          <Text style={styles.path} numberOfLines={1}>
            {path}
          </Text>
        </View>
        <Text style={styles.count}>{summary(session)}</Text>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {regions.map((region) => {
          const chosen = session.decisions[region.index];
          const malformed = !region.closed;
          return (
            <View key={region.index} style={styles.region}>
              <Text style={styles.regionHead}>
                冲突 {region.index + 1}
                {malformed ? ' · 标记不完整，需手动修正' : ''}
              </Text>

              <Side
                title="我的版本"
                lines={region.local}
                selected={chosen === 'local'}
                onPress={() => setSession((s) => decide(s, region.index, 'local'))}
                enabled={!malformed}
              />
              <Side
                title="对方的版本"
                lines={region.remote}
                selected={chosen === 'remote'}
                onPress={() => setSession((s) => decide(s, region.index, 'remote'))}
                enabled={!malformed}
              />

              <Pressable
                onPress={() => onEditManually(text)}
                style={({ pressed }) => [styles.manual, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`手动编辑第 ${region.index + 1} 个冲突`}
              >
                <Text style={styles.manualText}>手动编辑整篇</Text>
              </Pressable>

              {chosen !== undefined && (
                <Pressable
                  onPress={() => setSession((s) => undecide(s, region.index))}
                  style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`重新选择第 ${region.index + 1} 个冲突`}
                >
                  <Text style={styles.clearText}>重新选择</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.foot}>
        {problem && <Text style={styles.problem}>{problem}</Text>}
        <View style={styles.footRow}>
          {onCancel && (
            <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => setSession((s) => decideAll(s, 'local'))}
            disabled={left.length === 0}
            style={({ pressed }) => [styles.bulk, (pressed || left.length === 0) && styles.dim]}
            accessibilityRole="button"
            accessibilityLabel="全部保留我的版本"
          >
            <Text style={styles.bulkText}>全部用我的</Text>
          </Pressable>
          <Pressable
            onPress={() => setSession((s) => decideAll(s, 'remote'))}
            disabled={left.length === 0}
            style={({ pressed }) => [styles.bulk, (pressed || left.length === 0) && styles.dim]}
            accessibilityRole="button"
            accessibilityLabel="全部采用对方的版本"
          >
            <Text style={styles.bulkText}>全部用对方的</Text>
          </Pressable>
          <Pressable
            onPress={save}
            disabled={!ready}
            style={({ pressed }) => [styles.save, (!ready || pressed) && styles.dim]}
            accessibilityRole="button"
            accessibilityLabel="储存解析结果"
          >
            <Text style={styles.saveText}>{ready ? '储存' : `还有 ${left.length} 个`}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Side({
  title,
  lines,
  selected,
  onPress,
  enabled,
}: {
  title: string;
  lines: string[];
  selected: boolean;
  onPress: () => void;
  enabled: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      style={({ pressed }) => [
        styles.side,
        selected && styles.sideSelected,
        !enabled && styles.sideDisabled,
        pressed && styles.pressed,
      ]}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !enabled }}
      accessibilityLabel={title}
    >
      <Text style={styles.sideTitle}>{title}</Text>
      {lines.length === 0 ? (
        <Text style={styles.sideEmpty}>（空）</Text>
      ) : (
        lines.map((line, i) => (
          <Text key={`${i}-${line}`} style={styles.sideLine} selectable>
            {line === '' ? ' ' : line}
          </Text>
        ))
      )}
    </Pressable>
  );
}

/** Re-exported so a screen can check the shape without importing core. */
export { stepFor };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  head: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headText: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  title: { ...body, fontWeight: '700' },
  path: { ...body, fontSize: 12, color: colors.textMuted, flex: 1, fontFamily: mono },
  count: { ...body, fontSize: 12, color: colors.conflict, marginTop: 2 },
  body: { flex: 1 },
  bodyContent: { padding: space.lg },
  region: { marginBottom: space.xl },
  regionHead: { ...body, fontSize: 13, fontWeight: '700', color: colors.textMuted, marginBottom: space.sm },
  side: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: space.md,
    marginBottom: space.sm,
    backgroundColor: colors.surface,
  },
  sideSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  sideDisabled: { opacity: 0.5 },
  sideTitle: { ...body, fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: space.xs },
  sideEmpty: { ...body, fontFamily: mono, fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },
  sideLine: { ...body, fontFamily: mono, fontSize: 13, lineHeight: 19 },
  manual: { paddingVertical: space.sm },
  manualText: { ...body, fontSize: 13, color: colors.accent },
  clear: { paddingVertical: space.xs },
  clearText: { ...body, fontSize: 12, color: colors.textMuted },
  foot: { borderTopWidth: 1, borderTopColor: colors.border, padding: space.md, gap: space.sm },
  footRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  problem: { ...body, fontSize: 13, color: colors.danger },
  cancel: { paddingHorizontal: space.md, paddingVertical: space.sm },
  cancelText: { ...body, fontSize: 13, color: colors.textMuted },
  bulk: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 16, backgroundColor: colors.surface },
  bulkText: { ...body, fontSize: 13, color: colors.text },
  save: {
    marginLeft: 'auto',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  saveText: { ...body, fontSize: 13, fontWeight: '700', color: '#ffffff' },
  dim: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});