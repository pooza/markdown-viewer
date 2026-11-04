// node --test test/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

test('decodeBytes: UTF-8・BOM・Shift_JIS を読み分ける', () => {
  const utf8 = new TextEncoder().encode('日本語テスト');
  assert.deepEqual(C.decodeBytes(utf8), { text: '日本語テスト', encoding: 'utf-8' });

  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8]);
  assert.deepEqual(C.decodeBytes(bom), { text: '日本語テスト', encoding: 'utf-8' });

  // 「日本語テスト」の CP932
  const sjis = Uint8Array.from([
    0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67,
  ]);
  assert.deepEqual(C.decodeBytes(sjis), { text: '日本語テスト', encoding: 'shift_jis' });

  // JSZip からは配列で来ることもある
  assert.equal(C.decodeFileName(Array.from(sjis)), '日本語テスト');
  assert.equal(C.decodeFileName(Array.from(new TextEncoder().encode('docs/a.md'))), 'docs/a.md');
});

test('resolvePath: 相対・親・ルートからのパス', () => {
  assert.equal(C.resolvePath('docs/', 'a.md'), 'docs/a.md');
  assert.equal(C.resolvePath('docs/sub/', '../a.md'), 'docs/a.md');
  assert.equal(C.resolvePath('docs/', './img/x.png'), 'docs/img/x.png');
  assert.equal(C.resolvePath('', 'a.md'), 'a.md');
  assert.equal(C.resolvePath('docs/', '/README.md'), 'README.md');
  assert.equal(C.resolvePath('docs/', '資料/'), 'docs/資料');
});

test('splitHref: 節とクエリと %エンコード', () => {
  assert.deepEqual(C.splitHref('a.md#%E7%AF%80'), { path: 'a.md', anchor: '節' });
  assert.deepEqual(C.splitHref('#節-1'), { path: '', anchor: '節-1' });
  assert.deepEqual(C.splitHref('%E4%BA%8B%E4%BE%8B.md?x=1'), { path: '事例.md', anchor: '' });
  assert.deepEqual(C.splitHref('bad%E.md'), { path: 'bad%E.md', anchor: '' });
});

test('isExternal', () => {
  for (const h of ['https://example.com', 'http://x', 'mailto:a@b', 'file:///c:/x', '//host/x'])
    assert.ok(C.isExternal(h), h);
  for (const h of ['a.md', './a.md', '../x/y.md', '#a', 'c/d:e.md']) assert.ok(!C.isExternal(h), h);
});

test('kindOf', () => {
  assert.equal(C.kindOf('a/README.md'), 'markdown');
  assert.equal(C.kindOf('x.MARKDOWN'), 'markdown');
  assert.equal(C.kindOf('a/b.txt'), 'text');
  assert.equal(C.kindOf('q.sql'), 'text');
  assert.equal(C.kindOf('LICENSE'), 'text');
  assert.equal(C.kindOf('img/a.SVG'), 'image');
  assert.equal(C.kindOf('a.xlsx'), 'other');
  assert.equal(C.mimeOf('a.svg'), 'image/svg+xml');
});

test('isIgnored', () => {
  assert.ok(C.isIgnored('repo/.git/config'));
  assert.ok(C.isIgnored('repo/node_modules/x/README.md'));
  assert.ok(C.isIgnored('__MACOSX/docs/._a.md'));
  assert.ok(C.isIgnored('docs/Thumbs.db'));
  assert.ok(!C.isIgnored('docs/a.md'));
  assert.ok(!C.isIgnored('.github/README.md'));
});

test('findReadme: 浅い README → index → 最初の .md', () => {
  assert.equal(C.findReadme(['docs/README.md', 'README.md', 'a.md']), 'README.md');
  assert.equal(C.findReadme(['root/docs/readme.md', 'root/README.md']), 'root/README.md');
  assert.equal(C.findReadme(['x/index.md', 'x/a.md']), 'x/index.md');
  assert.equal(C.findReadme(['b/c.md', 'a.md']), 'a.md');
  assert.equal(C.findReadme([]), null);
});

test('isDirectory / listDirectory', () => {
  const paths = ['README.md', 'docs/a.md', 'docs/事例/01.txt', 'docs/事例/02.txt', 'docs2/x.md'];
  assert.ok(C.isDirectory(paths, 'docs'));
  assert.ok(C.isDirectory(paths, 'docs/事例'));
  assert.ok(!C.isDirectory(paths, 'doc'));
  assert.ok(C.isDirectory(paths, ''));
  assert.deepEqual(C.listDirectory(paths, 'docs'), { dirs: ['docs/事例'], files: ['docs/a.md'] });
  assert.deepEqual(C.listDirectory(paths, ''), { dirs: ['docs', 'docs2'], files: ['README.md'] });
});

test('slugify: GitHub と同じ ID になる', () => {
  // 日本語の見出し。全角記号（｜）・中黒（・）・アポストロフィは消え、空白はハイフンになる
  assert.equal(C.slugify('01 概要｜はじめに'), '01-概要はじめに');
  assert.equal(C.slugify('04 設定｜画面 第1・2章'), '04-設定画面-第12章');
  assert.equal(
    C.slugify("12 使い方｜アプリで Let's 開始 第2版"),
    '12-使い方アプリで-lets-開始-第2版',
  );
  assert.equal(
    C.slugify('08 文字コード・改行コード｜Windows 環境 補足'),
    '08-文字コード改行コードwindows-環境-補足',
  );
  // 英語の見出し
  assert.equal(C.slugify('Hello, World!'), 'hello-world');
  assert.equal(C.slugify('foo_bar-baz'), 'foo_bar-baz');
  assert.equal(C.slugify('A.B (c)'), 'ab-c');
  assert.equal(C.slugify('11-3. ドロップ方式の流用元'), '11-3-ドロップ方式の流用元');
});

test('createSlugger: 重複には -1, -2 を付ける', () => {
  const s = C.createSlugger();
  assert.equal(s.slug('節'), '節');
  assert.equal(s.slug('節'), '節-1');
  assert.equal(s.slug('節'), '節-2');
  assert.equal(s.slug('節-1'), '節-1-1');
});
