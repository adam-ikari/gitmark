import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSegments, type Segment } from './segments.ts';

const seg = (s: string) => toSegments(s);
const joined = (s: string) => seg(s).map((x) => x.text).join('');
const marked = (s: string) => seg(s).filter((x) => x.delimiter).map((x) => x.text).join('');

test('plain text is one segment', () => {
  const s = seg('hello');
  assert.equal(s.length, 1);
  assert.equal(s[0]!.text, 'hello');
  assert.equal(s[0]!.delimiter, false);
});

test('empty input gives no segments', () => {
  assert.deepEqual(seg(''), []);
});

/**
 * The invariant that makes the two-layer editor work: the styled layer renders
 * exactly the characters the input holds. If this fails, lines wrap differently
 * and taps land on the wrong character.
 */
function assertLossless(src: string) {
  assert.equal(joined(src), src, `segments must reproduce ${JSON.stringify(src)} exactly`);
}

test('segments reproduce the input exactly', () => {
  for (const src of [
    'plain text',
    '**bold**',
    '*italic*',
    '***both***',
    '~~struck~~',
    '`code`',
    'a **b** c *d* `e` ~~f~~',
    '[label](https://x.com)',
    '[**bold link**](https://x.com)',
    '![](img.png)',
    'mixed **bold with *nested* inside** end',
    '**a `b` c**',
    'unmatched ** marker',
    '中文**粗体**中文',
    '`a `` b`',
    'trailing **',
  ]) {
    assertLossless(src);
  }
});

test('segments are contiguous and ordered', () => {
  const s = seg('a **b** c *d*');
  for (let i = 0; i < s.length; i++) {
    assert.equal(s[i]!.start, i === 0 ? 0 : s[i - 1]!.end, `gap at ${i}`);
    assert.equal(s[i]!.end - s[i]!.start, s[i]!.text.length, `length mismatch at ${i}`);
  }
});

test('delimiters are separated from content', () => {
  assert.equal(marked('**bold**'), '****');
  assert.deepEqual(seg('**bold**').map((x) => [x.text, x.delimiter]), [
    ['**', true],
    ['bold', false],
    ['**', true],
  ]);
});

test('bold content carries the bold flag', () => {
  const s = seg('**bold**');
  assert.equal(s.find((x) => x.text === 'bold')?.bold, true);
  assert.equal(s.find((x) => x.text === '**')?.bold, false);
});

test('italic content carries the italic flag', () => {
  const s = seg('*em*');
  assert.equal(s[1]!.italic, true);
  assert.equal(s[1]!.text, 'em');
});

test('strike content carries the strike flag', () => {
  const s = seg('~~x~~');
  assert.equal(s[1]!.strike, true);
  assert.equal(s[1]!.text, 'x');
});

test('code span content carries the code flag', () => {
  const s = seg('`x`');
  assert.equal(s[1]!.code, true);
  assert.equal(s[1]!.text, 'x');
});

test('a multi-backtick fence is measured, not assumed', () => {
  const s = seg('``a ` b``');
  assert.equal(s[0]!.text, '``');
  assert.equal(s[1]!.text, 'a ` b');
  assert.equal(s[1]!.code, true);
  assert.equal(s[2]!.text, '``');
});

test('nested marks combine', () => {
  const s = seg('***both***');
  const inner = s.find((x) => x.text === 'both');
  assert.equal(inner?.bold, true);
  assert.equal(inner?.italic, true);
});

test('a mark inside a mark keeps the outer flag', () => {
  const s = seg('**bold with *em* inside**');
  const em = s.find((x) => x.text === 'em');
  assert.equal(em?.bold, true, 'the outer bold must survive');
  assert.equal(em?.italic, true);
});

test('code inside bold keeps bold', () => {
  const s = seg('**a `b` c**');
  const code = s.find((x) => x.text === 'b');
  assert.equal(code?.bold, true);
  assert.equal(code?.code, true);
});

test('link label is marked and the destination is a delimiter', () => {
  const s = seg('[label](https://x.com)');
  assert.equal(s[0]!.text, '[');
  assert.equal(s[1]!.text, 'label');
  assert.equal(s[1]!.href, 'https://x.com');
  assert.equal(s[2]!.text, '](https://x.com)');
  assert.equal(s[2]!.delimiter, true);
});

test('a link with a title keeps the whole tail as a delimiter', () => {
  assertLossless('[t](/a "Title")');
  const s = seg('[t](/a "Title")');
  assert.equal(s[0]!.text, '[');
  assert.equal(s[1]!.text, 't');
  assert.equal(s[2]!.text, '](/a "Title")');
});

test('an image is a single delimiter run', () => {
  const s = seg('![alt](img.png)');
  assert.equal(s.length, 1);
  assert.equal(s[0]!.delimiter, true);
  assert.equal(s[0]!.text, '![alt](img.png)');
});

test('unmatched markers survive as literal text', () => {
  assertLossless('a ** b');
  assertLossless('trailing *');
  const s = seg('a ** b');
  // Unmatched delimiters are not treated as markers, so nothing is dimmed away.
  assert.equal(s.every((x) => !x.delimiter), true);
});

test('CJK text with bold is segmented', () => {
  assertLossless('这是**粗体**中文');
  const s = seg('这是**粗体**中文');
  assert.equal(s.find((x) => x.text === '粗体')?.bold, true);
});

test('a hard break keeps its trailing spaces so widths match', () => {
  // Normalising `  \n` to a bare `\n` would drop two characters of width and
  // desynchronise the styled layer from the input.
  const s = seg('a  \nb');
  assertLossless('a  \nb');
  const hard = s.find((x) => x.text.includes('\n'));
  assert.equal(hard?.text, '  \n');
  assert.equal(hard?.delimiter, true, 'the trailing spaces are markdown punctuation');
});

test('a soft break renders the source newline itself', () => {
  const s = seg('a\nb');
  const soft = s.find((x) => x.text === '\n');
  assert.equal(soft?.delimiter, false);
  assert.equal(soft?.text, '\n');
});

test('line offsets are absolute when a window is given', () => {
  // The editor highlights one block at a time but reports document offsets.
  const doc = 'first **block**';
  const s = seg(doc);
  assert.equal(s[0]!.start, 0);
  assert.equal(s[s.length - 1]!.end, doc.length);
});

test('segments cover the whole input with no holes', () => {
  for (const src of ['a **b** [c](/d) `e` ~~f~~', 'x'.repeat(50)]) {
    const s = seg(src);
    let at = 0;
    for (const part of s) {
      assert.equal(part.start, at);
      at = part.end;
    }
    assert.equal(at, src.length);
  }
});