/**
 * The sync status bar.
 *
 * Conflicts are reported here and written into the note as standard diff3
 * markers, so the file stays self-describing: whatever tool opens it — this app,
 * another editor, `git` — shows the conflict the same way. The bar's job is to
 * make sure the user finds out, because a conflict that is only visible when
 * they happen to scroll to it is a conflict that sits unresolved for weeks.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';

import { colors, space, body } from '../theme/tokens.ts';
import type { SyncPhase } from '../../core/git/sync.ts';

export type SyncTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error';

export interface SyncStatusBarProps {
  phase: SyncPhase;
  tone?: SyncTone;
  message?: string | null;
  conflictCount?: number;
  onSync?: () => void;
  busy?: boolean;
}

const TONE_STYLE: Record<SyncTone, { bg: string; fg: string }> = {
  idle: { bg: colors.surface, fg: colors.textMuted },
  busy: { bg: colors.accentSoft, fg: colors.accent },
  ok: { bg: colors.surface, fg: colors.textMuted },
  warn: { bg: colors.conflictBg, fg: colors.conflict },
  error: { bg: colors.conflictBg, fg: colors.conflict },
};

export function SyncStatusBar({
  phase,
  tone,
  message,
  conflictCount = 0,
  onSync,
  busy = false,
}: SyncStatusBarProps): React.JSX.Element {
  const resolved = tone ?? toneFor(phase, conflictCount);
  const toneStyle = TONE_STYLE[resolved];
  const label = message ?? defaultLabel(phase, conflictCount);

  return (
    <View style={[styles.bar, { backgroundColor: toneStyle.bg }]}>
      <View style={styles.left}>
        {busy && <ActivityIndicator size="small" color={toneStyle.fg} />}
        <Text style={[styles.label, { color: toneStyle.fg }]} numberOfLines={2}>
          {label}
        </Text>
      </View>
      {onSync && (
        <Pressable
          onPress={onSync}
          disabled={busy}
          style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonDim]}
          accessibilityRole="button"
          accessibilityLabel="同步"
        >
          <Text style={[styles.buttonText, { color: toneStyle.fg }]}>同步</Text>
        </Pressable>
      )}
    </View>
  );
}

function toneFor(phase: SyncPhase, conflicts: number): SyncTone {
  if (phase === 'conflicted') return 'warn';
  if (phase === 'failed') return 'error';
  if (phase === 'fetching' || phase === 'merging' || phase === 'pushing') return 'busy';
  return conflicts > 0 ? 'warn' : 'idle';
}

function defaultLabel(phase: SyncPhase, conflicts: number): string {
  switch (phase) {
    case 'fetching':
      return '抓取中…';
    case 'merging':
      return '合併中…';
    case 'pushing':
      return '推送中…';
    case 'conflicted':
      return `${conflicts} 個衝突待處理`;
    case 'failed':
      return '同步失敗';
    default:
      return conflicts > 0 ? `${conflicts} 個衝突待處理` : '已是最新';
  }
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  label: { ...body, fontSize: 13, flexShrink: 1 },
  button: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 14 },
  buttonDim: { opacity: 0.5 },
  buttonText: { fontSize: 13, fontWeight: '700' },
});
