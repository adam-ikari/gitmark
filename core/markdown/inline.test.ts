import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseInlineRange } from './inline.ts';
import type { Inline } from './types.ts';

/** Compact s-expression so failures are readable. */
function sexp(n: Inline): string {
  switch (n.type) {
    case 'text':
      return `text(${JSON.stringify(n.value)})`;
    case 'code':
      return `code(${JSON.stringify(n.value)})`;
    case 'image':
      return `image(alt=${JSON.stringify(n.alt)},src=${JSON.stringify(n.src)})`;
    case 'link':
      return `link(${n.href})[${n.children.map(sexp).join(',')}]`;
    case 'hardbreak':
      return 'hardbreak';
    case 'softbreak':
      return 'softbreak';
    default:
      return `${n.type}[${n.children.map(sexp).join(',')}]`;
  }
}

const p = (s: string) => parseInline(s).map(sexp).join(' ');

test('plain text', () => {
  assert.equal(p('hello world'), 'text("hello world")');
});

test('empty input', () => {
  assert.deepEqual(parseInline(''), []);
});

test('strong', () => {
  assert.equal(p('**bold**'), 'strong[text("bold")]');
  assert.equal(p('__bold__'), 'strong[text("bold")]');
});

test('em', () => {
  assert.equal(p('*it*'), 'em[text("it")]');
  assert.equal(p('_it_'), 'em[text("it")]');
});

test('strong+em triple', () => {
  // Matches markdown-it and commonmark: em outside, strong inside.
  assert.equal(p('***x***'), 'em[strong[text("x")]]');
});

test('strike', () => {
  assert.equal(p('~~gone~~'), 'strike[text("gone")]');
});

test('nesting', () => {
  assert.equal(p('**bold with *em* inside**'), 'strong[text("bold with "),em[text("em")],text(" inside")]');
});

test('code span is literal', () => {
  assert.equal(p('`**not bold**`'), 'code("**not bold**")');
});

test('a single backtick closes a code span, per CommonMark', () => {
  // The first backtick pair wins; the trailing backtick is ordinary text.
  assert.equal(p('`a ` b`'), 'code("a ") text(" b`")');
});

test('intra-word double star is strong', () => {
  // Verified against markdown-it and commonmark: `*` has no right-flanking
  // guard, only `_` does.
  assert.equal(p('a**b**c'), 'text("a") strong[text("b")] text("c")');
});

test('intra-word single star is em', () => {
  assert.equal(p('a*b*c'), 'text("a") em[text("b")] text("c")');
});

test('double backticks delimit a code span containing a backtick', () => {
  assert.equal(p('``a ` b``'), 'code("a ` b")');
});

test('code span content is not parsed for escapes', () => {
  assert.equal(p('`\\*x\\*`'), 'code("\\\\*x\\\\*")');
});

test('backslash escape', () => {
  assert.equal(p('\\*not em\\*'), 'text("*not em*")');
  assert.equal(p('a \\_ b'), 'text("a _ b")');
});

test('link', () => {
  assert.equal(p('[text](https://x.com)'), 'link(https://x.com)[text("text")]');
  assert.equal(p('[t](/a/b)'), 'link(/a/b)[text("t")]');
});

test('link with title', () => {
  assert.equal(p('[t](/a "Title")'), 'link(/a)[text("t")]');
});

test('link with angle destination', () => {
  assert.equal(p('[t](</a b>)'), 'link(/a b)[text("t")]');
});

test('link label may contain nested markup', () => {
  assert.equal(p('[**bold**](https://x.com)'), 'link(https://x.com)[strong[text("bold")]]');
});

test('link destination with parens', () => {
  assert.equal(p('[t](https://x.com/a_(b))'), 'link(https://x.com/a_(b))[text("t")]');
});

test('image', () => {
  assert.equal(p('![alt](img.png)'), 'image(alt="alt",src="img.png")');
});

test('image inside link', () => {
  assert.equal(
    p('[![alt](i.png)](https://x.com)'),
    'link(https://x.com)[image(alt="alt",src="i.png")]',
  );
});

test('lone bang is text', () => {
  assert.equal(p('wow! amazing'), 'text("wow! amazing")');
});

test('autolink', () => {
  assert.equal(p('<https://x.com/a>'), 'link(https://x.com/a)[text("https://x.com/a")]');
});

test('unmatched delimiter stays literal', () => {
  assert.equal(p('2 * 3 * 4'), 'text("2 * 3 * 4")');
  assert.equal(p('**unclosed'), 'text("**unclosed")');
  assert.equal(p('a ` b'), 'text("a ` b")');
});

test('flanking rules: no emphasis after whitespace', () => {
  assert.equal(p('a * b * c'), 'text("a * b * c")');
});

test('intra-word underscores are literal', () => {
  // CommonMark protects snake_case identifiers, which are everywhere in
  // technical notes.
  assert.equal(p('snake_case_name'), 'text("snake_case_name")');
});

test('intra-word double underscore is literal too', () => {
  assert.equal(p('foo__bar__baz'), 'text("foo__bar__baz")');
});

test('a text node before a hard break does not claim the trailing spaces', () => {
  // Regression: the text node's range used to be wider than its value, because
  // the stripped spaces were left inside its range. Every downstream consumer
  // that maps source offsets (the editor's styled layer) then desynchronised.
  const src = 'a  \nb';
  const nodes = parseInlineRange(src, 0, src.length);
  const text = nodes.find((n) => n.type === 'text')!;
  assert.equal(text.value, 'a');
  assert.equal(text.srcEnd - text.srcStart, text.value.length);
  assert.equal(src.slice(text.srcStart, text.srcEnd), 'a');
  const brk = nodes.find((n) => n.type === 'hardbreak')!;
  assert.equal(src.slice(brk.srcStart, brk.srcEnd), '  \n');
});

test('softbreak and hardbreak', () => {
  assert.equal(p('a\nb'), 'text("a") softbreak text("b")');
  assert.equal(p('a  \nb'), 'text("a") hardbreak text("b")');
  assert.equal(p('a\\\nb'), 'text("a") hardbreak text("b")');
});

test('single trailing space is a softbreak, not a hardbreak', () => {
  assert.equal(p('a \nb'), 'text("a") softbreak text("b")');
});

test('CJK text is not mangled', () => {
  assert.equal(p('这是**粗体**中文'), 'text("这是") strong[text("粗体")] text("中文")');
});

test('source ranges point at the construct', () => {
  const src = 'a **bold** b';
  const nodes = parseInlineRange(src, 0, src.length);
  const strong = nodes.find((n) => n.type === 'strong')!;
  assert.equal(src.slice(strong.srcStart, strong.srcEnd), '**bold**');
});

test('source ranges are absolute with an offset window', () => {
  const src = 'xxxx **bold** yyyy';
  const nodes = parseInlineRange(src, 5, src.length);
  const strong = nodes.find((n) => n.type === 'strong')!;
  assert.equal(strong.srcStart, 5);
  assert.equal(src.slice(strong.srcStart, strong.srcEnd), '**bold**');
});

test('ranges are contiguous and cover the source', () => {
  const src = 'a **b** _c_ `d` [e](/f)';
  const nodes = parseInlineRange(src, 0, src.length);
  for (let i = 1; i < nodes.length; i++) {
    assert.equal(nodes[i - 1]!.srcEnd, nodes[i]!.srcStart, `gap at ${i}`);
  }
  assert.equal(nodes[0]!.srcStart, 0);
  assert.equal(nodes[nodes.length - 1]!.srcEnd, src.length);
});

test('a code span does not terminate the construct that contains it', () => {
  assert.equal(p('**a `b` c**'), 'strong[text("a "),code("b"),text(" c")]');
});

test('link inside strong', () => {
  assert.equal(p('**[link](/u)**'), 'strong[link(/u)[text("link")]]');
});