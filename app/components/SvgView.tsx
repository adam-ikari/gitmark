/**
 * Renders the SVG shape tree with react-native-svg.
 *
 * Every shape maps to a native vector primitive, so a diagram stays sharp at any
 * zoom rather than being rasterised. Anything the mapper does not understand is
 * reported through `onUnsupported` so the screen can say what was dropped
 * instead of silently drawing a partial picture.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, {
  G,
  Path,
  Rect,
  Circle,
  Ellipse,
  Line,
  Polyline,
  Polygon,
  Text as SvgText,
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
  ClipPath,
  Mask,
} from 'react-native-svg';

import { parseSvg, SvgParseError, walkSvg, type SvgElement, type SvgNode } from '../../core/svg/parse.ts';
import { colors, space, mono } from '../theme/tokens.ts';

export interface SvgViewProps {
  source: string;
  /** Height budget; the drawing scales to fit the available width. */
  height?: number;
  onUnsupported?: (tags: string[]) => void;
}

interface Resolved {
  width: number;
  height: number;
  viewBox: string;
}

/**
 * Work out the drawing size.
 *
 * A missing viewBox or non-pixel width is common in hand-written SVG, so the
 * intrinsic size falls back through several steps before giving up.
 */
function resolveSize(doc: ReturnType<typeof parseSvg>, budgetHeight?: number): Resolved {
  const vb = doc.viewBox;
  const w = doc.width ?? vb?.width ?? 300;
  const h = doc.height ?? vb?.height ?? 150;

  if (vb) return { width: w, height: h, viewBox: `${vb.x} ${vb.y} ${vb.width} ${vb.height}` };

  // Without a viewBox the user units are the pixels, so the drawing cannot be
  // scaled; render at its natural size inside the budget.
  return { width: w, height: budgetHeight ?? h, viewBox: `0 0 ${w} ${h}` };
}

const style = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  fallback: {
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackTitle: { fontSize: 13, fontWeight: '600', color: colors.danger, marginBottom: 4 },
  fallbackBody: { fontSize: 12, color: colors.textMuted, fontFamily: mono },
});

export function SvgView({ source, height = 200, onUnsupported }: SvgViewProps): React.JSX.Element {
  const parsed = useMemo(() => {
    try {
      return { doc: parseSvg(source), error: null as SvgParseError | null };
    } catch (e) {
      return { doc: null, error: e instanceof SvgParseError ? e : new SvgParseError(String(e), 0) };
    }
  }, [source]);

  const unsupported = useMemo(() => {
    if (!parsed.doc) return [];
    return [...walkSvg(parsed.doc.root!)].filter((e) => e.unsupported).map((e) => e.tag);
  }, [parsed.doc]);

  React.useEffect(() => {
    if (unsupported.length > 0) onUnsupported?.(unsupported);
  }, [unsupported, onUnsupported]);

  if (parsed.error || !parsed.doc) {
    return (
      <View style={[style.wrap, style.fallback]}>
        <Text style={style.fallbackTitle}>SVG 無法解析</Text>
        <Text style={style.fallbackBody}>{parsed.error?.message ?? 'unknown error'}</Text>
      </View>
    );
  }

  const size = resolveSize(parsed.doc, height);

  return (
    <View style={[style.wrap, { minHeight: size.height }]}>
      <Svg width={size.width} height={size.height} viewBox={size.viewBox}>
        <Node node={parsed.doc.root!} />
      </Svg>
    </View>
  );
}

/** Map one node to a react-native-svg element. */
function Node({ node }: { node: SvgNode }): React.JSX.Element | null {
  if (node.kind === 'text') return null;
  return <Element el={node} />;
}

function Element({ el }: { el: SvgElement }): React.JSX.Element | null {
  if (el.unsupported) return null;
  const a = el.attrs;
  const kids = el.children;

  switch (el.tag) {
    case 'svg':
      return (
        <G {...common(a)}>
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </G>
      );

    case 'g':
    case 'symbol':
      return (
        <G {...common(a)}>
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </G>
      );

    case 'defs':
      return (
        <Defs>
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </Defs>
      );

    case 'clipPath':
      return (
        <ClipPath id={a.id}>
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </ClipPath>
      );

    case 'mask':
      return (
        <Mask id={a.id}>
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </Mask>
      );

    case 'linearGradient':
      return (
        <LinearGradient
          id={a.id}
          x1={a.x1 ?? '0%'}
          y1={a.y1 ?? '0%'}
          x2={a.x2 ?? '100%'}
          y2={a.y2 ?? '0%'}
        >
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </LinearGradient>
      );

    case 'radialGradient':
      return (
        <RadialGradient id={a.id} cx={a.cx ?? '50%'} cy={a.cy ?? '50%'} r={a.r ?? '50%'}>
          {kids.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </RadialGradient>
      );

    case 'stop':
      return <Stop offset={a.offset ?? '0'} stopColor={a['stop-color'] ?? colors.text} stopOpacity={num(a['stop-opacity'], 1)} />;

    case 'path':
      return <Path d={a.d ?? ''} {...paint(a)} />;

    case 'rect':
      return (
        <Rect
          x={num(a.x, 0)}
          y={num(a.y, 0)}
          width={num(a.width, 0)}
          height={num(a.height, 0)}
          rx={num(a.rx, undefined)}
          ry={num(a.ry, undefined)}
          {...paint(a)}
        />
      );

    case 'circle':
      return <Circle cx={num(a.cx, 0)} cy={num(a.cy, 0)} r={num(a.r, 0)} {...paint(a)} />;

    case 'ellipse':
      return (
        <Ellipse
          cx={num(a.cx, 0)}
          cy={num(a.cy, 0)}
          rx={num(a.rx, 0)}
          ry={num(a.ry, 0)}
          {...paint(a)}
        />
      );

    case 'line':
      return <Line x1={num(a.x1, 0)} y1={num(a.y1, 0)} x2={num(a.x2, 0)} y2={num(a.y2, 0)} {...paint(a)} />;

    case 'polyline':
      return <Polyline points={a.points ?? ''} {...paint(a)} />;

    case 'polygon':
      return <Polygon points={a.points ?? ''} {...paint(a)} />;

    case 'text':
    case 'tspan':
      return (
        <SvgText
          x={num(a.x, 0)}
          y={num(a.y, 0)}
          fontSize={num(a['font-size'], 14)}
          fill={a.fill ?? colors.text}
          textAnchor={a['text-anchor'] as 'start' | 'middle' | 'end' | undefined}
        >
          {kids.map((c, i) => (c.kind === 'text' ? c.value : null)).join('')}
        </SvgText>
      );

    case 'style':
    case 'title':
    case 'desc':
      // Carried for completeness; CSS classes and metadata are not applied.
      return null;

    default:
      return null;
  }
}

/** Attributes common to container elements. */
function common(a: Record<string, string>) {
  return {
    transform: a.transform,
    opacity: a.opacity !== undefined ? num(a.opacity, 1) : undefined,
    fill: a.fill,
    clipPath: a['clip-path'],
    mask: a.mask,
  };
}

/** Paint attributes, with `fill="none"` respected so holes stay holes. */
function paint(a: Record<string, string>) {
  return {
    fill: a.fill ?? (a.stroke ? 'none' : colors.text),
    stroke: a.stroke ?? 'none',
    strokeWidth: a.stroke ? num(a['stroke-width'], 1) : undefined,
    strokeDasharray: a['stroke-dasharray'],
    fillOpacity: a['fill-opacity'] !== undefined ? num(a['fill-opacity'], 1) : undefined,
    strokeOpacity: a['stroke-opacity'] !== undefined ? num(a['stroke-opacity'], 1) : undefined,
    strokeLinecap: a['stroke-linecap'] as 'butt' | 'round' | 'square' | undefined,
    strokeLinejoin: a['stroke-linejoin'] as 'miter' | 'round' | 'bevel' | undefined,
  };
}

function num(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}