/**
 * A screen that exercises every renderer against one document.
 *
 * Its job is to make rendering problems visible on a real device: the three
 * tricky paths (mermaid via WebView, SVG via react-native-svg, and images) are
 * the ones most likely to break in ways type checking cannot catch.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, StatusBar } from 'react-native';

import { MarkdownView } from '../components/MarkdownView.tsx';
import { colors, space, body } from '../theme/tokens.ts';

const SAMPLE = `---
title: Renderer check
tags: [demo, rendering]
---

# Renderer check

A paragraph with **bold**, *italic*, ~~struck~~, \`inline code\` and a
[link](https://example.com). Inline styling works around **bold with
*italic* nested inside**, which is the case that usually breaks.

## Lists

- a plain item
- another one
  - nested
- [x] finished
- [ ] not finished

1. first
2. second

## Code

\`\`\`ts
function greet(name: string) {
  return \`hello \${name}\`;
}
\`\`\`

## Table

| block | status | tests |
| :- | :-: | -: |
| markdown | ok | 68 |
| merge | ok | 50 |

## Quote

> Notes stay plain text, so they remain readable with any other tool.

---

## Mermaid

\`\`\`mermaid
graph TD;
  A[Save] --> B[Commit];
  B --> C{Push};
  C -->|up to date| D[Done];
  C -->|diverged| E[Three-way merge];
  E --> F{clean?};
  F -->|yes| B;
  F -->|no| G[Ask the user];
\`\`\`

## SVG

\`\`\`svg
<svg width="220" height="120" viewBox="0 0 220 120">
  <rect x="4" y="4" width="212" height="112" rx="10" fill="#f6f7f9" stroke="#e3e5e8"/>
  <circle cx="48" cy="60" r="22" fill="#2f6feb"/>
  <rect x="86" y="40" width="52" height="40" rx="6" fill="#e8f0fe" stroke="#2f6feb"/>
  <path d="M150 60 L176 60 L190 44 L204 76 L214 60" fill="none" stroke="#b42318" stroke-width="3"/>
  <text x="48" y="100" font-size="11" text-anchor="middle" fill="#1b1d21">vector</text>
</svg>
\`\`\`

## Relative image

![not available offline](assets/nope.png)
`;

export function RenderScreen(): React.JSX.Element {
  const [svgWarning, setSvgWarning] = useState<string[]>([]);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [source, setSource] = useState(SAMPLE);

  const unresolved = useMemo(() => svgWarning.length > 0 ? svgWarning.join(', ') : null, [svgWarning]);

  return (
    <View style={style.root}>
      <StatusBar barStyle="dark-content" />
      <View style={style.header}>
        <Text style={style.headerTitle}>Renderer</Text>
        <View style={style.headerActions}>
          <Pressable
            onPress={() => setSource(SAMPLE)}
            style={({ pressed }) => [style.chip, pressed && style.chipPressed]}
          >
            <Text style={style.chipText}>reset</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={style.content}>
        {(unresolved || mermaidError) && (
          <View style={style.warn}>
            <Text style={style.warnText}>
              {unresolved ? `svg 略過: ${unresolved}` : null}
              {unresolved && mermaidError ? '\n' : null}
              {mermaidError ? `mermaid: ${mermaidError}` : null}
            </Text>
          </View>
        )}

        <MarkdownView
          source={source}
          onSvgUnsupported={(tags) => setSvgWarning(tags)}
          onMermaidError={(m) => setMermaidError(m)}
        />
      </ScrollView>
    </View>
  );
}

const style = StyleSheet.create({
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
  headerTitle: { ...body, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: 14,
    backgroundColor: colors.surface,
  },
  chipPressed: { opacity: 0.6 },
  chipText: { fontSize: 13, color: colors.accent },
  content: { padding: space.lg, paddingBottom: space.xxl },
  warn: {
    backgroundColor: colors.conflictBg,
    borderRadius: 8,
    padding: space.md,
    marginBottom: space.md,
  },
  warnText: { fontSize: 12, color: colors.conflict },
});