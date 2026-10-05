/**
 * The styled layer that sits behind the transparent input.
 *
 * It renders the *same characters* the input holds — nothing is hidden — so the
 * two layers wrap on the same columns. Markdown punctuation is dimmed rather
 * than removed; removing it would shrink this layer relative to the input and
 * desynchronise the two. See brain/pages/native-richtext-editor.md for why the
 * two-layer overlay only works when both sides hold identical text.
 */

import React, { useMemo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { toSegments } from '@core/markdown/segments.ts';
import { colors, mono } from '../theme/tokens.ts';

export interface InlineHighlightProps {
  text: string;
  /** Must be the same object the input uses, or the layers drift apart. */
  baseStyle: StyleProp<TextStyle>;
  /** Hide the text entirely and show only punctuation dimming. Debug aid. */
  showMarkers?: boolean;
}

export function InlineHighlight({
  text,
  baseStyle,
  showMarkers = true,
}: InlineHighlightProps): React.JSX.Element {
  const segments = useMemo(() => toSegments(text), [text]);

  return (
    <Text style={baseStyle} allowFontScaling selectable={false}>
      {segments.map((s, i) => (
        <Text key={i} style={styleFor(s, showMarkers)}>
          {s.text}
        </Text>
      ))}
      {/* A trailing newline is not renderable, so a zero-width space keeps the
          last line from collapsing and keeps the two layers the same height. */}
      {text.endsWith('\n') ? '' : null}
    </Text>
  );
}

function styleFor(
  s: { bold: boolean; italic: boolean; strike: boolean; code: boolean; href: string | null; delimiter: boolean },
  showMarkers: boolean,
): TextStyle | null {
  if (s.code) return { fontFamily: mono, fontSize: 14, color: '#b4235f' };
  if (s.href) return { color: colors.accent, textDecorationLine: 'underline' };

  if (s.delimiter) {
    // Dimmed, never absent: these characters still occupy width in the input,
    // and hiding them here would shift every line after this point.
    return showMarkers ? { color: colors.textMuted, opacity: 0.45 } : { opacity: 0 };
  }

  if (!s.bold && !s.italic && !s.strike) return null;

  return {
    fontWeight: s.bold ? '700' : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecorationLine: s.strike ? 'line-through' : undefined,
  };
}