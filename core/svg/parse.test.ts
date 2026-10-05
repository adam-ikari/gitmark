import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSvg, tokenize, readLength, SvgParseError, walkSvg } from './parse.ts';
import type { SvgElement } from './parse.ts';

const tags = (src: string): string[] => [...walkSvg(findRoot(src))].map((e) => e.tag);

function findRoot(src: string): SvgElement {
  const doc = parseSvg(src);
  return doc.root!;
}

test('a minimal svg parses', () => {
  const doc = parseSvg('<svg><path d="M0 0"/></svg>');
  assert.equal(doc.root?.tag, 'svg');
  assert.equal(doc.root?.children.length, 1);
});

test('attributes are captured', () => {
  const el = findRoot('<svg><rect x="1" y="2" width="3" height="4"/></svg>').children[0] as SvgElement;
  assert.equal(el.tag, 'rect');
  assert.equal(el.attrs.x, '1');
  assert.equal(el.attrs.width, '3');
});

test('viewBox is read', () => {
  const doc = parseSvg('<svg viewBox="0 0 100 50"></svg>');
  assert.deepEqual(doc.viewBox, { x: 0, y: 0, width: 100, height: 50 });
});

test('viewBox accepts commas and a negative origin', () => {
  const doc = parseSvg('<svg viewBox="-10,-20,30,40"></svg>');
  assert.deepEqual(doc.viewBox, { x: -10, y: -20, width: 30, height: 40 });
});

test('a malformed viewBox is ignored rather than fatal', () => {
  assert.equal(parseSvg('<svg viewBox="oops"></svg>').viewBox, null);
});

test('width and height are read as px', () => {
  const doc = parseSvg('<svg width="120px" height="60"></svg>');
  assert.equal(doc.width, 120);
  assert.equal(doc.height, 60);
});

test('readLength rejects percentages and other units', () => {
  assert.equal(readLength('50%'), null);
  assert.equal(readLength('2em'), null);
  assert.equal(readLength('12'), 12);
  assert.equal(readLength(' 7 '), 7);
});

test('nested groups', () => {
  assert.deepEqual(tags('<svg><g><g><circle/></g></g></svg>'), ['svg', 'g', 'g', 'circle']);
});

test('self-closing tags do not need a close', () => {
  assert.deepEqual(tags('<svg><path d="M0 0"/><path d="M1 1"/></svg>'), ['svg', 'path', 'path']);
});

test('text content is captured', () => {
  const el = findRoot('<svg><text>hello</text></svg>').children[0] as SvgElement;
  const text = el.children.find((c) => c.kind === 'text');
  assert.equal(text?.kind === 'text' ? text.value : null, 'hello');
});

test('entities are decoded in attributes and text', () => {
  // The input has a literal space before `b`, so the decoded value is
  // 'a & b A B' — the assertions pin the exact character sequence.
  const el = findRoot('<svg><text>a &amp; b &#65; &#x42;</text></svg>').children[0] as SvgElement;
  const text = el.children.find((c) => c.kind === 'text');
  assert.equal(text?.kind === 'text' ? text.value : null, 'a & b A B');
});

test('entities in attribute values are decoded once, not twice', () => {
  // Decoding `&amp;lt;` twice would turn it into `<`, which is wrong: the source
  // says "the literal text &lt;".
  const el = findRoot('<svg><text id="&amp;lt;">x</text></svg>').children[0] as SvgElement;
  assert.equal(el.attrs.id, '&lt;');
});

test('CDATA is kept verbatim', () => {
  const el = findRoot('<svg><style><![CDATA[.a{fill:red}]]></style></svg>').children[0] as SvgElement;
  const text = el.children.find((c) => c.kind === 'text');
  assert.equal(text?.kind === 'text' ? text.value : null, '.a{fill:red}');
});

test('comments and doctype are skipped', () => {
  assert.deepEqual(tags('<?xml version="1.0"?><!-- hi --><svg><path/></svg>'), ['svg', 'path']);
});

test('unsupported elements are flagged, not dropped', () => {
  // A foreignObject would otherwise vanish silently and the user would see a
  // picture with a hole in it.
  const doc = parseSvg('<svg><foreignObject/><path/></svg>');
  const els = [...walkSvg(doc.root!)];
  const foreign = els.find((e) => e.tag === 'foreignObject');
  assert.equal(foreign?.unsupported, true);
  assert.equal(els.find((e) => e.tag === 'path')?.unsupported, false);
});

test('gradients and defs are supported', () => {
  const src = `<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect fill="url(#g)"/></svg>`;
  assert.deepEqual(tags(src), ['svg', 'defs', 'linearGradient', 'stop', 'rect']);
});

test('a real diagram parses', () => {
  const src = `<svg width="100" height="50" viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg">
    <style>.t{font-size:12px}</style>
    <rect x="0" y="0" width="100" height="50" fill="#fff"/>
    <g transform="translate(5,5)"><circle cx="10" cy="10" r="4" stroke="#000"/></g>
    <text x="10" y="30" class="t">label</text>
  </svg>`;
  const doc = parseSvg(src);
  assert.deepEqual(doc.viewBox, { x: 0, y: 0, width: 100, height: 50 });
  assert.deepEqual(tags(src), ['svg', 'style', 'rect', 'g', 'circle', 'text']);
});

test('mismatched close tag is an error', () => {
  assert.throws(() => parseSvg('<svg><g></svg>'), SvgParseError);
});

test('an unclosed element is an error', () => {
  assert.throws(() => parseSvg('<svg><g></svg>'), SvgParseError);
});

test('two roots are an error', () => {
  assert.throws(() => parseSvg('<svg/><svg/>'), SvgParseError);
});

test('a non-svg root is an error', () => {
  assert.throws(() => parseSvg('<html><path/></html>'), SvgParseError);
});

test('an unterminated tag is an error', () => {
  assert.throws(() => parseSvg('<svg><path'), SvgParseError);
});

test('an unquoted attribute value is an error', () => {
  // Guessing here would silently mis-render geometry.
  assert.throws(() => parseSvg('<svg><rect x=1/></svg>'), SvgParseError);
});

test('an unterminated comment is an error', () => {
  assert.throws(() => parseSvg('<svg><!-- oops </svg>'), SvgParseError);
});

test('an empty document is an error', () => {
  assert.throws(() => parseSvg(''), SvgParseError);
});

test('malformed input names the offset', () => {
  try {
    parseSvg('<svg><path d="M0 0"</svg>');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof SvgParseError);
    assert.ok(Number.isFinite((e as SvgParseError).at));
  }
});

test('tokenize reports element structure', () => {
  const tokens = tokenize('<svg><path/></svg>');
  assert.deepEqual(tokens.map((t) => `${t.type}:${t.name ?? ''}`), [
    'open:svg',
    'selfclose:path',
    'close:svg',
  ]);
});

test('valueless attributes are tolerated', () => {
  const el = findRoot('<svg><path hidden d="M0 0"/></svg>').children[0] as SvgElement;
  assert.equal(el.attrs.hidden, '');
  assert.equal(el.attrs.d, 'M0 0');
});

test('tags with namespaces are accepted', () => {
  assert.deepEqual(tags('<svg><svg:rect x="1"/></svg>'), ['svg', 'svg:rect']);
});