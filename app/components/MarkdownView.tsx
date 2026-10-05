/**
 * Renders a parsed markdown document with native React Native views.
 *
 * The AST from @core is the single input, so this and the editor can never
 * disagree about what a note contains. Two blocks are delegated to dedicated
 * components: mermaid needs a DOM (WebView) and SVG needs a vector renderer.
 *
 * Nothing here is interactive: this is the read path. Editing is
 * RichTextEditor's job, and mixing the two would make both harder to reason
 * about.
 */

import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  Linking,
  StyleSheet,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { parseDocument } from '../../core/markdown/blocks.ts';
import type { Inline, RangedBlock } from '../../core/markdown/types.ts';
import { SvgView } from './SvgView.tsx';
import { MermaidView } from './MermaidView.tsx';
import { colors, space, body, code, heading as headingStyle, link, mono } from '../theme/tokens.ts';

export interface MarkdownViewProps {
  source: string;
  /** Resolve a relative image path to something `Image` can load. */
  resolveImage?: (src: string) => string | null;
  onLinkPress?: (href: string) => void;
  /** Called with the tags of any SVG elements this renderer cannot draw. */
  onSvgUnsupported?: (tags: string[]) => void;
  onMermaidError?: (message: string) => void;
  style?: StyleProp<ViewStyle>;
}

export function MarkdownView({
  source,
  resolveImage,
  onLinkPress,
  onSvgUnsupported,
  onMermaidError,
  style,
}: MarkdownViewProps): React.JSX.Element {
  const blocks = useMemo(() => parseDocument(source), [source]);

  return (
    <View style={style}>
      {blocks.map((block, i) => (
        <BlockView
          key={`${block.type}-${block.srcStart}-${i}`}
          block={block}
          resolveImage={resolveImage}
          onLinkPress={onLinkPress}
          onSvgUnsupported={onSvgUnsupported}
          onMermaidError={onMermaidError}
        />
      ))}
    </View>
  );
}

/** Callbacks a block may need; `block` itself is passed separately. */
interface RenderContext {
  resolveImage?: (src: string) => string | null;
  onLinkPress?: (href: string) => void;
  onSvgUnsupported?: (tags: string[]) => void;
  onMermaidError?: (message: string) => void;
}

interface BlockProps extends RenderContext {
  block: RangedBlock;
}

function BlockView({ block, ...rest }: BlockProps): React.JSX.Element | null {
  switch (block.type) {
    case 'paragraph':
      return (
        <Text style={style.paragraph}>
          <InlineText node={block.children} {...rest} />
        </Text>
      );

    case 'heading':
      return (
        <Text style={[style.paragraph, headingStyle(block.depth), block.depth <= 2 && style.headingTight]}>
          <InlineText node={block.children} {...rest} />
        </Text>
      );

    case 'code':
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={style.codeScroll}>
          <Text style={[style.code, code]} selectable>
            {block.value}
          </Text>
        </ScrollView>
      );

    case 'mermaid':
      return <MermaidView source={block.value} onError={rest.onMermaidError} />;

    case 'svg':
      return <SvgView source={block.value} onUnsupported={rest.onSvgUnsupported} />;

    case 'quote':
      return (
        <View style={style.quote}>
          {(block.children as RangedBlock[]).map((c, i) => (
            <BlockView key={i} block={c} {...rest} />
          ))}
        </View>
      );

    case 'list':
      return (
        <View style={style.list}>
          {block.items.map((item, i) => (
            <View key={i} style={style.listItem}>
              <Text style={style.bullet}>
                {item.checked === null ? (block.ordered ? `${block.start + i}.` : '•') : item.checked ? '[x]' : '[ ]'}
              </Text>
              <View style={style.listBody}>
                {(item.children as RangedBlock[]).map((c, j) => (
                  <BlockView key={j} block={c} {...rest} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );

    case 'hr':
      return <View style={style.hr} />;

    case 'table':
      return <TableView block={block} {...rest} />;

    default:
      return null;
  }
}

function TableView({ block, ...rest }: BlockProps): React.JSX.Element {
  const table = block as Extract<RangedBlock, { type: 'table' }>;
  const cols = Math.max(table.header.length, ...table.rows.map((r) => r.length), 1);
  const cell = (inline: Inline[], i: number, header: boolean) => (
    <View key={i} style={[style.cell, header && style.cellHeader]}>
      <Text style={header ? style.cellHeaderText : undefined}>
        <InlineText node={inline} {...rest} />
      </Text>
    </View>
  );

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={style.table}>
        <View style={style.tableRow}>
          {Array.from({ length: cols }, (_, i) => cell(table.header[i] ?? [], i, true))}
        </View>
        {table.rows.map((row, r) => (
          <View key={r} style={[style.tableRow, r % 2 === 1 && style.tableRowAlt]}>
            {Array.from({ length: cols }, (_, i) => cell(row[i] ?? [], i, false))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** Render a run of inline nodes. Inline nodes may carry source ranges; the
 * renderer ignores them, so they are accepted as-is. */
function InlineText({ node, onLinkPress, resolveImage }: { node: Inline[] } & RenderContext): React.JSX.Element {
  const open = useCallback(
    (href: string) => {
      if (onLinkPress) {
        onLinkPress(href);
        return;
      }
      // Outside the app, hand off to the OS rather than guessing.
      void Linking.openURL(href).catch(() => undefined);
    },
    [onLinkPress],
  );

  return (
    <>
      {node.map((n, i) => (
        <InlineNode key={i} node={n} onLinkPress={open} resolveImage={resolveImage} />
      ))}
    </>
  );
}

function InlineNode({
  node,
  onLinkPress,
  resolveImage,
}: {
  node: Inline;
  onLinkPress: (href: string) => void;
  resolveImage?: (src: string) => string | null;
}): React.JSX.Element | null {
  switch (node.type) {
    case 'text':
      return <Text>{node.value}</Text>;

    case 'strong':
      return (
        <Text style={style.bold}>
          <InlineText node={node.children} onLinkPress={onLinkPress} resolveImage={resolveImage} />
        </Text>
      );

    case 'em':
      return (
        <Text style={style.italic}>
          <InlineText node={node.children} onLinkPress={onLinkPress} resolveImage={resolveImage} />
        </Text>
      );

    case 'strike':
      return (
        <Text style={style.strike}>
          <InlineText node={node.children} onLinkPress={onLinkPress} resolveImage={resolveImage} />
        </Text>
      );

    case 'code':
      return <Text style={style.inlineCode}>{node.value}</Text>;

    case 'link':
      return (
        <Pressable onPress={() => onLinkPress(node.href)}>
          <Text style={link}>
            <InlineText node={node.children} onLinkPress={onLinkPress} resolveImage={resolveImage} />
          </Text>
        </Pressable>
      );

    case 'image': {
      const uri = resolveImage?.(node.src) ?? node.src;
      if (!/^(https?|file|data):/.test(uri)) {
        // A relative path with no resolver means the image is not available
        // here; say so rather than showing a broken glyph.
        return <Text style={style.missingImage}>[图片: {node.alt || node.src}]</Text>;
      }
      return <Image source={{ uri }} style={style.image} accessibilityLabel={node.alt} />;
    }

    case 'hardbreak':
      return <Text>{'\n'}</Text>;

    case 'softbreak':
      return <Text>{' '}</Text>;

    default:
      return null;
  }
}

const style = StyleSheet.create({
  paragraph: { ...body, marginBottom: space.md },
  headingTight: { marginTop: space.xs },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  inlineCode: { fontFamily: mono, fontSize: 14, backgroundColor: colors.codeBg, color: '#b4235f' },
  codeScroll: {
    backgroundColor: colors.codeBg,
    borderRadius: 8,
    padding: space.md,
    marginBottom: space.md,
  },
  code: { ...code },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.quoteBar,
    paddingLeft: space.md,
    marginBottom: space.md,
  },
  list: { marginBottom: space.md },
  listItem: { flexDirection: 'row', marginBottom: space.xs },
  bullet: { ...body, width: 28, color: colors.textMuted },
  listBody: { flex: 1 },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: space.lg },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden', marginBottom: space.md },
  tableRow: { flexDirection: 'row' },
  tableRowAlt: { backgroundColor: colors.surface },
  cell: { padding: space.sm, minWidth: 96, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border },
  cellHeader: { backgroundColor: colors.accentSoft },
  cellHeaderText: { fontWeight: '700' },
  image: { width: '100%', height: 200, borderRadius: 8, marginBottom: space.md, backgroundColor: colors.surface },
  missingImage: { ...body, color: colors.textMuted, fontStyle: 'italic' },
});