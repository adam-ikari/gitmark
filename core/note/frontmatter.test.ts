import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  bodyOf,
  withFrontmatter,
  fieldString,
  fieldList,
} from './frontmatter.ts';

const NOTE = ['---', 'title: My note', 'tags: [work, idea]', 'draft: false', '---', '', '# Heading', '', 'Body text.'].join('\n');

test('no frontmatter', () => {
  const fm = parseFrontmatter('# Just a heading\n\ntext');
  assert.equal(fm.present, false);
  assert.deepEqual(fm.fields, {});
});

test('scalars, inline list and booleans', () => {
  const fm = parseFrontmatter(NOTE);
  assert.equal(fm.present, true);
  assert.equal(fm.fields.title, 'My note');
  assert.deepEqual(fm.fields.tags, ['work', 'idea']);
  assert.equal(fm.fields.draft, 'false');
});

test('field accessors', () => {
  const fm = parseFrontmatter(NOTE);
  assert.equal(fieldString(fm, 'title'), 'My note');
  assert.deepEqual(fieldList(fm, 'tags'), ['work', 'idea']);
  assert.equal(fieldString(fm, 'missing'), null);
  assert.deepEqual(fieldList(fm, 'missing'), []);
});

test('a scalar is readable through fieldList', () => {
  const fm = parseFrontmatter('---\ntag: solo\n---\n');
  assert.deepEqual(fieldList(fm, 'tag'), ['solo']);
});

test('body strips the block but keeps the blank line after it', () => {
  // Lossless on purpose: NOTE has an empty line between the closing fence and
  // the heading, and the body is everything after that fence.
  assert.equal(bodyOf(NOTE), '\n# Heading\n\nBody text.');
});

test('body with no blank line after the fence', () => {
  const src = ['---', 'title: T', '---', '# Heading', 'text'].join('\n');
  assert.equal(bodyOf(src), '# Heading\ntext');
});

test('body of a note without frontmatter is the whole source', () => {
  assert.equal(bodyOf('# Hi\n'), '# Hi\n');
});

test('block list syntax', () => {
  const fm = parseFrontmatter(['---', 'tags:', '  - alpha', '  - beta', '---', 'body'].join('\n'));
  assert.deepEqual(fm.fields.tags, ['alpha', 'beta']);
  assert.equal(bodyOf(['---', 'tags:', '  - alpha', '---', 'body'].join('\n')), 'body');
});

test('empty inline list', () => {
  const fm = parseFrontmatter('---\ntags: []\n---\nbody');
  assert.deepEqual(fm.fields.tags, []);
});

test('key with empty value and no list', () => {
  const fm = parseFrontmatter('---\nsummary:\n---\nbody');
  assert.equal(fm.fields.summary, '');
});

test('quoted values lose their quotes', () => {
  const fm = parseFrontmatter('---\ntitle: "He said: hi"\nauthor: \'Ada\'\n---\n');
  assert.equal(fm.fields.title, 'He said: hi');
  assert.equal(fm.fields.author, 'Ada');
});

test('CJK keys and values', () => {
  const fm = parseFrontmatter('---\n标题: 我的笔记\ntags: [工作]\n---\n内文');
  assert.equal(fm.fields['标题'], '我的笔记');
  assert.deepEqual(fm.fields.tags, ['工作']);
});

test('unterminated block is treated as absent', () => {
  // A stray `---` in prose must not be mistaken for metadata.
  const fm = parseFrontmatter('---\ntitle: oops\n# Heading\n');
  assert.equal(fm.present, false);
});

test('frontmatter must start on the first line', () => {
  const fm = parseFrontmatter('\n---\ntitle: x\n---\n');
  assert.equal(fm.present, false);
});

test('BOM is tolerated', () => {
  const fm = parseFrontmatter('\uFEFF---\ntitle: x\n---\nbody');
  assert.equal(fm.present, true);
  assert.equal(fm.fields.title, 'x');
});

test('range points past the closing fence', () => {
  const src = NOTE;
  const fm = parseFrontmatter(src);
  // `start` is where a rewrite would begin (offset 0, before the opening
  // fence) and `end` is just past the closing fence, before its newline.
  assert.equal(fm.start, 0);
  assert.equal(src.slice(fm.start, fm.end), ['---', 'title: My note', 'tags: [work, idea]', 'draft: false', '---'].join('\n'));
  assert.equal(src[fm.end], '\n');
});

test('round trip preserves the body byte for byte', () => {
  const body = '# Heading\n\n```js\nconst a = 1;\n```\n\n- one\n- two\n';
  const src = `---\ntitle: T\n---\n${body}`;
  const out = withFrontmatter(src, { title: 'T2' });
  assert.equal(bodyOf(out), body);
  assert.equal(fieldString(parseFrontmatter(out), 'title'), 'T2');
});

test('a note without frontmatter gains a block when fields are set', () => {
  const out = withFrontmatter('# Hi\n', { title: 'Hi' });
  assert.equal(parseFrontmatter(out).present, true);
  assert.equal(bodyOf(out), '# Hi\n');
});

test('reading does not add a block to a note that lacks one', () => {
  const src = '# Hi\n';
  assert.equal(withFrontmatter(src, {}), src);
});

test('rendering quotes values that would otherwise be misparsed', () => {
  const out = withFrontmatter('body\n', { title: 'a: b', note: 'has #hash' });
  const fm = parseFrontmatter(out);
  assert.equal(fm.fields.title, 'a: b');
  assert.equal(fm.fields.note, 'has #hash');
});

test('writing then reading preserves list order', () => {
  const out = withFrontmatter('b\n', { tags: ['z', 'a', 'm'] });
  assert.deepEqual(fieldList(parseFrontmatter(out), 'tags'), ['z', 'a', 'm']);
});

test('empty string value survives a round trip', () => {
  const out = withFrontmatter('b\n', { summary: '' });
  assert.equal(fieldString(parseFrontmatter(out), 'summary'), '');
});