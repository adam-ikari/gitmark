/**
 * Design tokens.
 *
 * One source of truth for colour, spacing and type, so the renderer and the
 * editor can be styled independently and still agree. The editor has a hard
 * requirement here: the overlay `<Text>` and the transparent `<TextInput>` must
 * derive their metrics from the *same* object, or soft-wrapped lines drift and
 * taps land on the wrong character. See app/components/RichTextEditor.tsx.
 */

import type { TextStyle } from 'react-native';

export const colors = {
  bg: '#ffffff',
  surface: '#f6f7f9',
  border: '#e3e5e8',
  text: '#1b1d21',
  textMuted: '#6b7280',
  accent: '#2f6feb',
  accentSoft: '#e8f0fe',
  codeBg: '#f2f3f5',
  quoteBar: '#c9ced6',
  conflict: '#b42318',
  conflictBg: '#fef3f2',
  danger: '#b42318',
} as const;

/** 4pt base scale. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * A monospace family.
 *
 * `'monospace'` is a generic family that React Native resolves on both
 * platforms — Droid Sans Mono on Android, Menlo on iOS — so it avoids bundling
 * a font file and avoids importing `Platform` here. Dropping that import keeps
 * this module loadable from a plain Node test, which is what lets the editor's
 * typography be asserted without a renderer.
 */
export const mono = 'monospace';

/**
 * The base paragraph style.
 *
 * `lineHeight` is set explicitly rather than left to the platform: the editor
 * stacks a styled `<Text>` under a `<TextInput>`, and the two must break lines
 * at exactly the same columns. A platform default would differ per font
 * fallback and break the alignment.
 */
export const body: TextStyle = {
  fontSize: 16,
  lineHeight: 24,
  color: colors.text,
};

export const code: TextStyle = {
  fontFamily: mono,
  fontSize: 14,
  lineHeight: 20,
  color: colors.text,
};

export const heading = (depth: number): TextStyle => ({
  fontSize: [26, 22, 19, 17, 16, 15][depth - 1] ?? 15,
  lineHeight: [32, 28, 24, 22, 21, 20][depth - 1] ?? 20,
  fontWeight: '700',
  color: colors.text,
});

export const link: TextStyle = {
  color: colors.accent,
  textDecorationLine: 'underline',
};