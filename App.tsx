import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EditorScreen } from './app/screens/EditorScreen.tsx';
import { RenderScreen } from './app/screens/RenderScreen.tsx';
import { colors, space, body } from './app/theme/tokens.ts';

type Tab = 'edit' | 'read';

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('edit');

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        <TabButton label="編輯" active={tab === 'edit'} onPress={() => setTab('edit')} />
        <TabButton label="渲染" active={tab === 'read'} onPress={() => setTab('read')} />
      </View>
      {tab === 'edit' ? <EditorScreen /> : <RenderScreen />}
    </View>
  );
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
});
