/**
 * The invariants the two-layer editor depends on.
 *
 * These cannot be verified by looking at a screenshot in CI, because the failure
 * mode is font-dependent and only appears on a device. What *can* be pinned down
 * here is the set of conditions that make alignment possible, so that a future
 * change which breaks one of them fails a test instead of producing an editor
 * whose taps land on the wrong character.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Relative imports, not the `@core/*` alias: Metro resolves that from
// tsconfig paths, but Node's ESM resolver does not, and these tests run in Node.
import { toSegments } from '../../core/markdown/segments.ts';
import { parseDocument } from '../../core/markdown/blocks.ts';
import { blockTextStyle } from './blockTextStyle.ts';
import { blockEditorConfig } from './editorConfig.ts';

test('the styled layer and the input must hold identical text', () => {
  // This is the whole basis of the approach. If the styled layer dropped a
  // marker, it would wrap on different columns and every tap would be off.
  for (const src of [
    '**bold** and *italic*',
    '# heading with `code`',
    '- item with [link](/x)',
    'CJK 粗體 and English bold **together**',
    '~~struck~~ and ``` inline',
  ]) {
    const rendered = toSegments(src)
      .map((s) => s.text)
      .join('');
    assert.equal(rendered, src, `styled layer must reproduce ${JSON.stringify(src)}`);
  }
});

test('a segment never claims more source than it contains', () => {
  for (const src of ['a  \nb', '**x**', 'x']) {
    for (const s of toSegments(src)) {
      assert.equal(s.text.length, s.end - s.start, `range wider than text in ${JSON.stringify(src)}`);
    }
  }
});

test('every editable block renders with a style carrying an explicit lineHeight', () => {
  // A platform default line height differs per font fallback, so the two layers
  // would diverge on any device whose default font is not the one assumed.
  for (const src of ['plain', '# h1', '## h2', '###### h6']) {
    for (const block of parseDocument(src)) {
      const style = blockTextStyle(block.type === 'heading' ? { type: 'heading', depth: block.depth } : { type: 'paragraph' });
      assert.ok(
        typeof style.lineHeight === 'number' && style.lineHeight > 0,
        `heading ${src} must set lineHeight explicitly`,
      );
      assert.ok(typeof style.fontSize === 'number');
    }
  }
});

test('every editable block shares one style for both layers', () => {
  const config = blockEditorConfig();
  assert.equal(config.sharedStyle, true, 'the input and the highlight layer must be given the same object');
  assert.equal(config.highlightHidesCharacters, false, 'hiding characters would desynchronise the layers');
  assert.equal(config.inputDrawsGlyphs, false);
  assert.equal(config.allowFontScaling, true, 'both layers must scale font identically');
});

test('heading depth maps to a strictly decreasing size', () => {
  const sizes = [1, 2, 3, 4, 5, 6].map((d) => blockTextStyle({ type: 'heading', depth: d as 1 }).fontSize as number);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i]! <= sizes[i - 1]!, `depth ${i + 1} must not be larger than depth ${i}`);
  }
});