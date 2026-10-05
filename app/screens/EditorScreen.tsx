/**
 * Drive the editor: type into it, use the toolbar, and watch the markdown.
 *
 * This exists because the editor's correctness is mostly *visual*: the styled
 * layer and the input must wrap on the same columns, which no unit test can
 * assert. A screen that shows the raw markdown beside the editor makes any
 * desynchronisation obvious at a glance.
 */

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, StatusBar } from 'react-native';

import { BlockEditor } from '../components/BlockEditor.tsx';
import { colors, space, body, mono } from '../theme/tokens.ts';

const INITIAL = `# 专案笔记

这是一段**粗体**与*斜体*的混合，还有 \`行内程式码\`。

## 清单

- 第一项
- 第二项

## 待办

- [ ] 完成合并核心
- [x] 验证 isomorphic-git

结尾文字。
`;

export function EditorScreen(): React.JSX.Element {
  const [source, setSource] = useState(INITIAL);
  const [dirtyAt, setDirtyAt] = useState<number>(INITIAL.length);

  const handleChange = (next: string) => {
    setSource(next);
    setDirtyAt(next.length);
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text style={styles.title}>mark</Text>
        <Text style={styles.meta}>{source.length} 字元</Text>
      </View>

      <ScrollView contentContainerStyle={styles.editorArea} keyboardShouldPersistTaps="always">
        <BlockEditor
          source={source}
          onChange={handleChange}
          placeholder="开始写作…"
        />
      </ScrollView>

      <View style={styles.pane}>
        <View style={styles.paneHead}>
          <Text style={styles.paneTitle}>markdown</Text>
          <Text style={styles.paneMeta}>{dirtyAt} bytes</Text>
        </View>
        <ScrollView style={styles.paneBody} nestedScrollEnabled>
          <Text style={styles.source} selectable>
            {source}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { ...body, fontWeight: '700' },
  meta: { ...body, color: colors.textMuted, fontSize: 13 },
  editorArea: { padding: space.lg, paddingBottom: space.lg },
  pane: {
    height: 168,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  paneHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  paneTitle: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  paneMeta: { fontSize: 12, color: colors.textMuted, fontFamily: mono },
  paneBody: { padding: space.md },
  source: { fontFamily: mono, fontSize: 12, lineHeight: 17, color: colors.text },
});
