import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, parseMarkdown } from './blocks.ts';
import type { Block } from './types.ts';

const md = parseMarkdown;

function types(src: string): string[] {
  return md(src).map((b) => b.type);
}

test('empty document', () => {
  assert.deepEqual(md(''), []);
  assert.deepEqual(md('\n\n\n'), []);
});

test('paragraph', () => {
  assert.deepEqual(md('hello'), [{ type: 'paragraph', children: [{ type: 'text', value: 'hello' }] }]);
});

test('two paragraphs split on a blank line', () => {
  const b = md('a\n\nb');
  assert.equal(b.length, 2);
  assert.equal(b[0]!.type, 'paragraph');
  assert.equal(b[1]!.type, 'paragraph');
});

test('ATX headings', () => {
  assert.deepEqual(md('# H1'), [{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'H1' }] }]);
  assert.deepEqual(md('### H3'), [{ type: 'heading', depth: 3, children: [{ type: 'text', value: 'H3' }] }]);
});

test('ATX heading strips the closing hashes', () => {
  assert.deepEqual(md('## Title ##'), [{ type: 'heading', depth: 2, children: [{ type: 'text', value: 'Title' }] }]);
});

test('setext headings', () => {
  assert.deepEqual(md('Title\n====='), [{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] }]);
  assert.deepEqual(md('Title\n-----'), [{ type: 'heading', depth: 2, children: [{ type: 'text', value: 'Title' }] }]);
});

test('a thematic break is not a setext heading', () => {
  assert.deepEqual(types('---\n'), ['hr']);
  assert.deepEqual(types('***\n'), ['hr']);
});

test('fenced code block with a language', () => {
  assert.deepEqual(md('```ts\nlet a = 1;\n```'), [
    { type: 'code', lang: 'ts', value: 'let a = 1;' },
  ]);
});

test('fenced code block without a language', () => {
  assert.deepEqual(md('```\nplain\n```'), [{ type: 'code', lang: null, value: 'plain' }]);
});

test('fenced code block keeps markdown syntax literal', () => {
  assert.deepEqual(md('```\n**not bold**\n```'), [
    { type: 'code', lang: null, value: '**not bold**' },
  ]);
});

test('fence longer than three backticks', () => {
  assert.deepEqual(md('````\n```\n````'), [{ type: 'code', lang: null, value: '```' }]);
});

test('tilde fences', () => {
  assert.deepEqual(md('~~~\ncode\n~~~'), [{ type: 'code', lang: null, value: 'code' }]);
});

test('a backtick fence is not closed by a tilde fence', () => {
  assert.deepEqual(md('```\n~~~\n```'), [{ type: 'code', lang: null, value: '~~~' }]);
});

test('mermaid fence produces a mermaid block', () => {
  assert.deepEqual(md('```mermaid\ngraph TD;\nA-->B;\n```'), [
    { type: 'mermaid', value: 'graph TD;\nA-->B;' },
  ]);
});

test('svg fence produces an svg block', () => {
  assert.deepEqual(md('```svg\n<svg/>\n```'), [{ type: 'svg', value: '<svg/>' }]);
});

test('fence language is matched case-insensitively', () => {
  assert.deepEqual(md('```Mermaid\ngraph TD;\n```'), [{ type: 'mermaid', value: 'graph TD;' }]);
});

test('blockquote', () => {
  const b = md('> quoted');
  assert.equal(b.length, 1);
  assert.equal(b[0]!.type, 'quote');
  const inner = (b[0] as Extract<Block, { type: 'quote' }>).children;
  assert.equal(inner.length, 1);
  assert.equal(inner[0]!.type, 'paragraph');
});

test('nested blockquote', () => {
  const b = md('> a\n>\n> > b');
  const outer = (b[0] as Extract<Block, { type: 'quote' }>).children;
  assert.ok(outer.some((c) => c.type === 'quote'), 'expected a nested quote');
});

test('bullet list', () => {
  const b = md('- a\n- b');
  assert.equal(b.length, 1);
  const l = b[0] as Extract<Block, { type: 'list' }>;
  assert.equal(l.type, 'list');
  assert.equal(l.ordered, false);
  assert.equal(l.items.length, 2);
});

test('ordered list preserves its start number', () => {
  const l = md('3. c\n4. d')[0] as Extract<Block, { type: 'list' }>;
  assert.equal(l.ordered, true);
  assert.equal(l.start, 3);
  assert.equal(l.items.length, 2);
});

test('the list ordinal does not clobber the source range', () => {
  // Regression: `start` used to mean both the ordinal and the source offset,
  // so one silently overwrote the other.
  const [b] = parseDocument('3. c\n');
  assert.equal(b!.type, 'list');
  assert.equal((b as unknown as { start: number }).start, 3);
  assert.equal(b!.srcStart, 0);
  assert.equal(b!.srcEnd, 5);
});

test('nested list', () => {
  const l = md('- a\n  - b\n')[0] as Extract<Block, { type: 'list' }>;
  const item = l.items[0]!;
  const nested = item.children.find((c) => c.type === 'list');
  assert.ok(nested, 'expected a nested list inside the first item');
});

test('task list', () => {
  const l = md('- [ ] todo\n- [x] done')[0] as Extract<Block, { type: 'list' }>;
  assert.equal(l.items[0]!.checked, false);
  assert.equal(l.items[1]!.checked, true);
});

test('a plain item has no checkbox state', () => {
  const l = md('- a')[0] as Extract<Block, { type: 'list' }>;
  assert.equal(l.items[0]!.checked, null);
});

test('table with alignment', () => {
  const b = md('| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |');
  assert.equal(b.length, 1);
  const t = b[0] as Extract<Block, { type: 'table' }>;
  assert.equal(t.type, 'table');
  assert.deepEqual(t.align, ['left', 'center', 'right']);
  assert.equal(t.header.length, 3);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0]!.length, 3);
});

test('table cells keep inline markup', () => {
  const t = md('| a |\n| - |\n| **b** |')[0] as Extract<Block, { type: 'table' }>;
  assert.deepEqual(t.rows[0]![0], [{ type: 'strong', children: [{ type: 'text', value: 'b' }] }]);
});

test('a pipe line that is not followed by a delimiter row is a paragraph', () => {
  assert.deepEqual(types('a | b\nc'), ['paragraph']);
});

test('inline markup inside a paragraph', () => {
  assert.deepEqual(md('a **b** c'), [
    {
      type: 'paragraph',
      children: [
        { type: 'text', value: 'a ' },
        { type: 'strong', children: [{ type: 'text', value: 'b' }] },
        { type: 'text', value: ' c' },
      ],
    },
  ]);
});

test('a blank line separates a list from following text', () => {
  assert.deepEqual(types('- a\n\ntext'), ['list', 'paragraph']);
});

test('CJK prose parses as a single paragraph', () => {
  assert.deepEqual(types('这是第一段\n还是同一段\n\n这是第二段'), ['paragraph', 'paragraph']);
});

test('block ranges are ordered and non-overlapping', () => {
  const blocks = parseDocument('# H\n\npara\n\n- a\n- b\n');
  for (let i = 0; i < blocks.length; i++) {
    assert.ok(blocks[i]!.srcEnd >= blocks[i]!.srcStart, `block ${i} has an inverted range`);
    if (i > 0) {
      assert.ok(blocks[i]!.srcStart >= blocks[i - 1]!.srcEnd, `block ${i} overlaps ${i - 1}`);
    }
  }
});

test('block ranges point at the right source text', () => {
  const src = 'intro\n\n```js\ncode\n```\n\noutro';
  const blocks = parseDocument(src);
  assert.equal(src.slice(blocks[0]!.srcStart, blocks[0]!.srcEnd), 'intro');
  assert.equal(src.slice(blocks[1]!.srcStart, blocks[1]!.srcEnd), '```js\ncode\n```');
  assert.equal(src.slice(blocks[2]!.srcStart, blocks[2]!.srcEnd), 'outro');
});

test('unterminated fence swallows the rest of the document', () => {
  assert.deepEqual(md('```\nstill code'), [{ type: 'code', lang: null, value: 'still code' }]);
});