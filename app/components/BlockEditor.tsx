/**
 * The block editor.
 *
 * One `TextInput` per block. Block structure lives *inside* the input as
 * markdown syntax (`# `, `- `), dimmed by the styled layer rather than rendered
 * around it. That is deliberate: the styled layer and the input must hold
 * identical text, or they wrap on different columns and taps land on the wrong
 * character. Block-level WYSIWYG comes from the font size applied to the block;
 * inline markers stay visible but quiet.
 *
 * All markdown logic lives in @core. This component converts gestures into core
 * calls and renders the results — it does no parsing or splicing itself.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ScrollView,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import { parseDocument } from '../../core/markdown/blocks.ts';
import type { RangedBlock } from '../../core/markdown/types.ts';
import {
  blockContextAt,
  insertNewline,
  backspaceAtLineStart,
  setHeading,
  toggleList,
  toggleTask,
} from '../../core/richtext/blocks.ts';
import {
  replaceRange,
  deleteBackward,
  deleteForward,
  selectionRange,
  type EditResult,
  type Selection,
} from '../../core/richtext/splice.ts';
import { toggleMark, toggleCode, markStateAt, type MarkName } from '../../core/richtext/marks.ts';
import { InlineHighlight } from './InlineHighlight.tsx';
import { blockTextStyle, type BlockKind } from './blockTextStyle.ts';
import { colors, space, mono } from '../theme/tokens.ts';

export interface BlockEditorProps {
  source: string;
  onChange: (next: string) => void;
  style?: StyleProp<ViewStyle>;
  placeholder?: string;
  /**
   * Overlay the input's own glyphs on top of the styled layer in a contrasting
   * colour, so any wrapping or offset difference between the two layers is
   * visible at a glance.
   *
   * This exists because alignment between the layers cannot be asserted in a
   * unit test — it only fails on a real device with a real font. Turn it on and
   * type a long mixed CJK/Latin paragraph: if the two layers agree, the red
   * glyphs sit exactly on top of the styled ones.
   */
  debugAlignment?: boolean;
}

interface BlockPiece {
  key: string;
  block: RangedBlock;
  /** This block's markdown, without the blank lines that separate blocks. */
  text: string;
  /** Offset of the block's first character within the document. */
  at: number;
}

/** Blocks that can hold a caret. Others are shown as read-only text. */
function isEditable(b: RangedBlock): boolean {
  return b.type === 'paragraph' || b.type === 'heading';
}

export function BlockEditor({ source, onChange, style, placeholder, debugAlignment = false }: BlockEditorProps): React.JSX.Element {
  const pieces = useMemo<BlockPiece[]>(() => {
    const blocks = parseDocument(source);
    return blocks.map((block, i) => {
      const at = block.srcStart;
      const nextStart = i + 1 < blocks.length ? blocks[i + 1]!.srcStart : source.length;
      const text = source.slice(at, Math.max(at, nextStart)).replace(/\n+$/, '');
      return { key: `${block.type}-${at}-${i}`, block, text, at };
    });
  }, [source]);

  return (
    <View style={style}>
      {pieces.map((piece) =>
        isEditable(piece.block) ? (
          <EditableBlock
            key={piece.key}
            piece={piece}
            source={source}
            onChange={onChange}
            placeholder={placeholder}
            debugAlignment={debugAlignment}
          />
        ) : (
          <ReadOnlyBlock key={piece.key} piece={piece} />
        ),
      )}
    </View>
  );
}

function EditableBlock({
  piece,
  source,
  onChange,
  placeholder,
  debugAlignment,
}: {
  piece: BlockPiece;
  source: string;
  onChange: (next: string) => void;
  placeholder?: string;
  debugAlignment: boolean;
}): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState<Selection>({ anchor: 0, focus: 0 });

  const end = piece.at + piece.text.length;
  const caret = Math.max(piece.at, Math.min(selectionRange(sel)[1], end));

  const toLocal = useCallback(
    (o: number) => Math.max(0, Math.min(o - piece.at, piece.text.length)),
    [piece.at, piece.text.length],
  );

  const localSel = useMemo<Selection>(
    () => ({ anchor: toLocal(sel.anchor), focus: toLocal(sel.focus) }),
    [sel, toLocal],
  );

  const context = useMemo(() => blockContextAt(piece.text, localSel.focus), [piece.text, localSel.focus]);

  /** Replace this block's text, keeping the rest of the document intact. */
  const applyEdit = useCallback(
    (result: EditResult) => {
      onChange(source.slice(0, piece.at) + result.source + source.slice(end));
      const at = piece.at + result.selection.anchor;
      setSel({ anchor: at, focus: at });
    },
    [onChange, source, piece.at, end],
  );

  /** Run a core operation against this block's own text. */
  const run = useCallback(
    (fn: (text: string, sel: Selection) => EditResult) => applyEdit(fn(piece.text, localSel)),
    [applyEdit, piece.text, localSel],
  );

  /**
   * React Native reports only the new string, so the splice is recovered from
   * the common prefix and suffix. Preserving them matters: recomputing the
   * block from scratch would be fine here, but reusing `run` everywhere would
   * lose the user's caret when an edit lands in the middle.
   */
  const handleChangeText = useCallback(
    (text: string) => {
      if (text === piece.text) return;
      const max = Math.min(text.length, piece.text.length);
      let prefix = 0;
      while (prefix < max && text[prefix] === piece.text[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < max - prefix &&
        text[text.length - 1 - suffix] === piece.text[piece.text.length - 1 - suffix]
      ) {
        suffix++;
      }

      const inserted = text.slice(prefix, text.length - suffix);
      onChange(source.slice(0, piece.at) + text + source.slice(end));
      const at = piece.at + prefix + inserted.length;
      setSel({ anchor: at, focus: at });
    },
    [piece.text, piece.at, source, end, onChange],
  );

  const handleKeyPress = useCallback(
    (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
      const key = e.nativeEvent.key;

      if (key === 'Enter') {
        e.preventDefault?.();
        const atBlockEnd = localSel.focus >= piece.text.length;
        if (piece.block.type === 'paragraph' && !atBlockEnd) {
          // Inside a paragraph a newline is just a newline: the block already
          // owns that newline in its source.
          run((t, s) => replaceRange(t, s, '\n'));
          return;
        }
        if (atBlockEnd) {
          // At the end of a block, open a new one after it.
          onChange(`${source}\n`);
          const at = end + 1;
          setSel({ anchor: at, focus: at });
          return;
        }
        run((t, s) => insertNewline(t, s));
        return;
      }

      if (key === 'Backspace') {
        const atBlockStart = localSel.anchor === 0 && localSel.focus === 0;
        if (atBlockStart) {
          const handled = backspaceAtLineStart(piece.text, localSel);
          if (handled) {
            applyEdit(handled);
            return;
          }
        }
        run((t, s) => deleteBackward(t, s));
        return;
      }

      if (key === 'Delete') {
        run((t, s) => deleteForward(t, s));
      }
    },
    [localSel, piece.text, piece.block.type, run, applyEdit, onChange, source, end],
  );

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const { start, end: nativeEnd } = e.nativeEvent.selection;
      setSel({ anchor: piece.at + start, focus: piece.at + nativeEnd });
    },
    [piece.at],
  );

  const mark = useCallback(
    (name: MarkName) => {
      run((t, s) => (name === 'code' ? toggleCode(t, s) : toggleMark(t, s, name)));
    },
    [run],
  );

  // One style object for both layers. Divergence here is exactly the bug the
  // two-layer design is prone to.
  // One style object, handed to both layers. See editorConfig.ts for why this
  // is load-bearing rather than merely tidy.
  const textStyle = useMemo<TextStyle>(() => blockTextStyle(piece.block as BlockKind), [piece.block]);

  const active = useMemo(() => {
    const probe = localSel;
    return {
      bold: markStateAt(piece.text, probe, 'bold') !== 'off',
      italic: markStateAt(piece.text, probe, 'italic') !== 'off',
      code: markStateAt(piece.text, probe, 'code') !== 'off',
      strike: markStateAt(piece.text, probe, 'strike') !== 'off',
    };
  }, [piece.text, localSel]);

  return (
    <View style={styles.block}>
      <View style={styles.stack}>
        <View style={styles.highlight} pointerEvents="none">
          <InlineHighlight text={piece.text} baseStyle={textStyle} />
        </View>
        <TextInput
          style={[textStyle, debugAlignment ? styles.inputDebug : styles.input]}
          value={piece.text}
          onChangeText={handleChangeText}
          onKeyPress={handleKeyPress}
          onSelectionChange={handleSelectionChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          underlineColorAndroid="transparent"
          scrollEnabled={false}
          multiline
          // Must match the highlight layer's scaling or the two drift apart.
          allowFontScaling
        />
      </View>

      {focused && (
        <Toolbar
          active={active}
          isHeading={context.kind === 'heading'}
          onBold={() => mark('bold')}
          onItalic={() => mark('italic')}
          onCode={() => mark('code')}
          onStrike={() => mark('strike')}
          onHeading={() => run((t, s) => setHeading(t, s, context.kind === 'heading' ? 0 : 2))}
          onList={() => run((t, s) => toggleList(t, s))}
          onTask={() => run((t, s) => toggleTask(t, s))}
        />
      )}
    </View>
  );
}

function ReadOnlyBlock({ piece }: { piece: BlockPiece }): React.JSX.Element {
  return (
    <View style={styles.readOnly}>
      <Text style={blockTextStyle(piece.block)} selectable>
        {piece.text}
      </Text>
    </View>
  );
}

interface ToolbarProps {
  active: { bold: boolean; italic: boolean; code: boolean; strike: boolean };
  isHeading: boolean;
  onBold: () => void;
  onItalic: () => void;
  onCode: () => void;
  onStrike: () => void;
  onHeading: () => void;
  onList: () => void;
  onTask: () => void;
}

function Toolbar({ active, isHeading, onBold, onItalic, onCode, onStrike, onHeading, onList, onTask }: ToolbarProps): React.JSX.Element {
  const items: Array<{ key: string; label: string; onPress: () => void; on: boolean }> = [
    { key: 'b', label: 'B', onPress: onBold, on: active.bold },
    { key: 'i', label: 'I', onPress: onItalic, on: active.italic },
    { key: 'c', label: '</>', onPress: onCode, on: active.code },
    { key: 's', label: 'S', onPress: onStrike, on: active.strike },
    { key: 'h', label: 'H', onPress: onHeading, on: isHeading },
    { key: 'l', label: '•', onPress: onList, on: false },
    { key: 't', label: '☑', onPress: onTask, on: false },
  ];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolbar} keyboardShouldPersistTaps="always">
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={item.onPress}
          style={({ pressed }) => [styles.tool, item.on && styles.toolOn, pressed && styles.toolPressed]}
        >
          <Text style={[styles.toolText, item.on && styles.toolTextOn]}>{item.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: space.xs },
  stack: { position: 'relative' },
  highlight: { ...StyleSheet.absoluteFill },
  // The input draws no glyphs; the styled layer provides them. Selection and the
  // caret still come from the input, which is why it must stay on top.
  input: { color: 'transparent', padding: 0, margin: 0, textAlignVertical: 'top' },
  // Alignment probe: the input's glyphs become visible on top of the styled
  // layer. Agreement means both layers laid the same characters out identically.
  inputDebug: { color: 'rgba(220,38,38,0.55)', padding: 0, margin: 0, textAlignVertical: 'top' },
  readOnly: { marginBottom: space.sm },
  toolbar: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 18, marginTop: space.xs },
  tool: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 14, marginHorizontal: 2 },
  toolOn: { backgroundColor: colors.accentSoft },
  toolPressed: { opacity: 0.6 },
  toolText: { fontSize: 14, color: colors.text },
  toolTextOn: { color: colors.accent, fontWeight: '700' },
});