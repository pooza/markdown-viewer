// ビルド版を、ネットを遮断したヘッドレス Edge で開いて確かめる。
//
//   node test/smoke.mjs
//
// 1. scripts/build.mjs でビルドする
// 2. テスト用の zip（CP932 のファイル名・CRLF・XSS を仕込んだもの）を作る
// 3. ビルド版に zip と確認用スクリプトを足した dist/smoke.html を作る
// 4. ネットを遮断した Edge で開き（test/edge.mjs）、ページが書いた確認結果を照合する
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, insertBeforeBodyEnd, OUTPUT } from '../scripts/build.mjs';
import { runInEdge } from './edge.mjs';

// ---- 最小の zip 作成（無圧縮）。ファイル名のバイト列と UTF-8 フラグを指定できる ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, utf8 } of entries) {
    const nameBytes = typeof name === 'string' ? Buffer.from(name, 'utf8') : Buffer.from(name);
    const body = Buffer.from(data);
    const flag = utf8 === false ? 0 : 0x0800;
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flag, 6);
    local.writeUInt16LE(0, 8); // 無圧縮
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flag, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---- テスト用の文書 ----

const crlf = (s) => s.replace(/\n/g, '\r\n');
const filler = Array.from({ length: 80 }, (_, i) => `段落 ${i + 1}`).join('\n\n');

// 1 つを中心に 9 本が放射状に出る ER 図。既定の配置では子が 1 段に並び、本文の幅より横に広がる
const WIDE = [
  'erDiagram',
  ...Array.from({ length: 9 }, (_, i) => `  HUB ||--o{ CHILD_${i + 1} : "HUB_ID = HUB_ID"`),
].join('\n');

const LONG = '長い説明の文。'.repeat(60);

const README = crlf(`# テスト文書

## 01 概要｜はじめに

- [節へ](#01-概要はじめに)
- [無い節](#no-such-section)
- [別文書の節](sub/doc.md#節-1)
- [フォルダ](data/)
- [テキスト](data/a.txt)
- [壊れ](missing.md)
- [外部](https://example.com/)
- [表計算](data/b.xlsx)

![図](img/a.svg)

![無い図](img/none.png)

\`\`\`mermaid
flowchart LR
  A[開始] --> B[終了]
\`\`\`

\`\`\`mermaid
${WIDE}
\`\`\`

<img src="x" onerror="window.__xss=1">
<script>window.__xss=2</script>
<a href="javascript:window.__xss=3">js</a>
<div onclick="window.__xss=4">クリック</div>

| a | b |
| --- | --- |
| 1 | 2 |

| # | 項目名 | 説明 |
| ---: | --- | --- |
| 1 | 記録年月 | ${LONG} |
| 2 | 加入者番号 | 短い |

- リストの中の表

  | 項目名 | 説明 |
  | --- | --- |
  | 入れ子 | ${LONG} |
`);

const DOC = `# Doc

## 節

${filler}

## 節

二つ目の節

${filler}

[戻る](../README.md)
`;

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';

// 「日本語.md」「# テスト」の CP932
const SJIS_NAME = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x2e, 0x6d, 0x64];
const SJIS_BODY = [0x23, 0x20, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a];
const SJIS_TEXT = [0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a]; // テスト

const zip = makeZip([
  { name: 'README.md', data: README },
  { name: 'sub/doc.md', data: DOC },
  { name: 'img/a.svg', data: SVG },
  { name: 'data/a.txt', data: 'plain text\n' },
  { name: 'data/sjis.txt', data: SJIS_TEXT },
  { name: 'data/b.xlsx', data: [0x50, 0x4b, 0x03, 0x04, 1, 2, 3] },
  { name: SJIS_NAME, data: SJIS_BODY, utf8: false },
  { name: 'repo/.git/config', data: 'x' },
]);

// ---- ブラウザの中で動かす確認 ----

const PROBE = `
<pre id="smoke-result">pending</pre>
<script>
(async () => {
  const out = {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(50); }
    return null;
  };
  const c = document.getElementById('markdown-content');
  const scroller = document.getElementById('content');
  const link = (text) => [...c.querySelectorAll('a')].find((a) => a.textContent === text);
  const offsetInView = (el) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  try {
    const bin = atob(window.__FIXTURE__);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    await MdvApp.openZipBuffer(buf.buffer, 'fixture.zip');

    out.first = MdvApp.currentPath;
    out.headingIds = [...c.querySelectorAll('h1, h2')].map((h) => h.id);
    out.mermaidSvg = !!(await until(() => c.querySelector('.mermaid svg')));
    await until(() => c.querySelectorAll('.diagram').length === 2);
    const diagrams = [...c.querySelectorAll('.diagram')];
    out.shrunk = diagrams.map((d) => d.classList.contains('shrunk'));
    const wide = diagrams.find((d) => d.classList.contains('shrunk'));
    if (wide) {
      const zoom = document.getElementById('diagram-zoom');
      wide.querySelector('.diagram-zoom-button').click();
      const zsvg = document.querySelector('#diagram-zoom-stage svg');
      const natural = wide.querySelector('svg').viewBox.baseVal.width;
      out.zoom = {
        open: !zoom.hidden,
        natural: Math.round(zsvg.getBoundingClientRect().width) === Math.round(natural),
        level: document.getElementById('diagram-zoom-level').textContent,
      };
      zoom.querySelector('[data-zoom="fit"]').click();
      const stage = document.getElementById('diagram-zoom-stage');
      out.zoomFit = zsvg.getBoundingClientRect().width <= stage.clientWidth;
      // 画面の 10 倍より大きい図でも「全体」で収まる（手動の縮小の下限 10% で止めない）
      stage.style.width = '100px';
      zoom.querySelector('[data-zoom="fit"]').click();
      out.zoomFitTiny = zsvg.getBoundingClientRect().width <= stage.clientWidth;
      stage.style.width = '';
      zoom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      out.zoomClosed = zoom.hidden;
    }
    out.imageSrc = (c.querySelector('img[alt="図"]').getAttribute('src') || '').slice(0, 5);
    out.brokenImage = c.querySelector('img[alt="無い図"]').classList.contains('broken-image');
    out.xss = window.__xss === undefined ? null : window.__xss;
    out.dangerous = c.querySelectorAll('script, [onerror], [onclick]').length
      + [...c.querySelectorAll('a')].filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length;
    out.brokenLinks = [...c.querySelectorAll('a.broken-link')].map((a) => a.textContent);
    out.externalTarget = link('外部').target;
    out.tree = [...document.querySelectorAll('.file-item')].map((d) => d.title);
    out.tableDisplay = getComputedStyle(c.querySelector('table')).display;
    {
      const t = [...c.querySelectorAll('table')].find((x) => x.rows[0].cells[1]?.textContent === '項目名');
      const cls = (i) => [...t.rows].every((r) => r.cells[i].classList.contains('nowrap'));
      out.nowrap = { short: cls(0) && cls(1), long: [...t.rows].some((r) => r.cells[2].classList.contains('nowrap')) };
      // 窓が広いとき: 表は本文（980px）より広がり、本文の中央に揃う
      scroller.style.flex = 'none';
      scroller.style.width = '2000px';
      window.dispatchEvent(new Event('resize'));
      const tr = t.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      const nested = c.querySelector('li table').getBoundingClientRect();
      out.wideTable = {
        wider: tr.width > cr.width + 1,
        centered: Math.abs(tr.left + tr.right - cr.left - cr.right) < 2,
        nestedInside: nested.right <= cr.right + 1,
      };
      scroller.style.flex = '';
      scroller.style.width = '';
      window.dispatchEvent(new Event('resize'));
    }

    link('別文書の節').click();
    await until(() => c.dataset.path === 'sub/doc.md');
    await wait(100);
    const target = document.getElementById('user-content-節-1');
    out.cross = { path: MdvApp.currentPath, scrolled: scroller.scrollTop > 0, targetTop: target ? Math.round(offsetInView(target)) : null };

    history.back();
    out.back = await until(() => c.dataset.path === 'README.md' && MdvApp.currentPath);

    link('フォルダ').click();
    await until(() => c.dataset.path === 'data');
    out.listing = [...c.querySelectorAll('.listing a')].map((a) => a.textContent);

    await MdvApp.navigate('data/sjis.txt');
    out.sjisText = c.querySelector('pre.plain-text').textContent;
    out.sjisPath = c.querySelector('.doc-path').textContent;

    await MdvApp.navigate('日本語.md');
    out.cp932Name = { h1: (c.querySelector('h1') || {}).textContent, notice: (c.querySelector('.warn-banner') || {}).textContent };

    await MdvApp.navigate('data/b.xlsx');
    out.download = (c.querySelector('a[download]') || {}).download || null;

    document.getElementById('about-link').click();
    out.about = { build: c.querySelector('p').textContent, licenses: c.textContent.includes('==== mermaid') };
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  document.getElementById('smoke-result').textContent = JSON.stringify(out);
})();
</script>`;

// ---- 期待値 ----

function check(r) {
  const results = [];
  const eq = (label, actual, expected) =>
    results.push({
      label,
      ok: JSON.stringify(actual) === JSON.stringify(expected),
      actual,
      expected,
    });
  const ok = (label, cond, actual) => results.push({ label, ok: !!cond, actual });

  ok('例外なく最後まで動く', !r.error, r.error);
  eq('README を最初に開く', r.first, 'README.md');
  eq('見出しに GitHub と同じ ID', r.headingIds, [
    'user-content-テスト文書',
    'user-content-01-概要はじめに',
  ]);
  ok('CRLF の mermaid が図になる（オフライン）', r.mermaidSvg, r.mermaidSvg);
  eq('横に広い図だけ「拡大」を出す（縮んでいる図だけ）', r.shrunk, [false, true]);
  eq('「拡大」で原寸の図が全画面で開く', r.zoom, { open: true, natural: true, level: '100%' });
  ok('「全体」で画面に収まる', r.zoomFit, r.zoomFit);
  ok('…画面の 10 倍より大きい図でも収まる', r.zoomFitTiny, r.zoomFitTiny);
  ok('Esc で閉じる', r.zoomClosed, r.zoomClosed);
  eq('相対パスの画像を zip から読む', r.imageSrc, 'blob:');
  ok('無い画像を示す', r.brokenImage, r.brokenImage);
  eq('生 HTML のスクリプトが動かない', r.xss, null);
  eq('危険な属性・要素が残らない', r.dangerous, 0);
  eq('リンク切れ（無い節・無いファイル）を示す', r.brokenLinks, ['無い節', '壊れ']);
  eq('外部リンクは別タブ', r.externalTarget, '_blank');
  eq('一覧に Markdown とテキストを出し、.git は出さない', r.tree, [
    'data/a.txt',
    'data/sjis.txt',
    'sub/doc.md',
    'README.md',
    '日本語.md',
  ]);
  eq('横長の表は表の中でスクロール', r.tableDisplay, 'block');
  eq('短い列は折り返さず、長い列は折り返す', r.nowrap, { short: true, long: false });
  eq('窓が広ければ表は本文より広がり、中央に揃う', r.wideTable, {
    wider: true,
    centered: true,
    nestedInside: true,
  });
  eq('別文書の節へのリンクで文書を開く', r.cross?.path, 'sub/doc.md');
  ok(
    '…そしてその節までスクロールする',
    r.cross?.scrolled && Math.abs(r.cross.targetTop) < 60,
    r.cross,
  );
  eq('ブラウザの「戻る」で前の文書へ', r.back, 'README.md');
  eq('フォルダへのリンクで中身の一覧', r.listing, [
    '📁 ..',
    '📄 a.txt',
    '📄 b.xlsx',
    '📄 sjis.txt',
  ]);
  eq('Shift_JIS のテキストを読む', r.sjisText, 'テスト\n');
  eq('…読んだ文字コードを示す', r.sjisPath, 'data/sjis.txt（Shift_JIS）');
  eq('CP932 のファイル名・本文の zip を読む', r.cp932Name, {
    h1: 'テスト',
    notice: '文字コードを Shift_JIS として読みました。',
  });
  eq('表示できないファイルは保存させる', r.download, 'b.xlsx');
  ok('ライセンスを表示できる', r.about?.licenses, r.about);
  return results;
}

// ---- 実行 ----

const { buildInfo } = await build();
const html = await readFile(OUTPUT, 'utf8');
const smokePath = join(OUTPUT, '..', 'smoke.html');
const fixture = `<script>window.__FIXTURE__ = '${zip.toString('base64')}';</script>`;
await writeFile(smokePath, insertBeforeBodyEnd(html, `${fixture}\n${PROBE}\n`));

const result = await runInEdge(pathToFileURL(smokePath).href);

console.log(buildInfo);
let failed = 0;
for (const r of check(result)) {
  if (!r.ok) failed += 1;
  console.log(
    `${r.ok ? '✔' : '✖'} ${r.label}${r.ok ? '' : `\n    actual:   ${JSON.stringify(r.actual)}${'expected' in r ? `\n    expected: ${JSON.stringify(r.expected)}` : ''}`}`,
  );
}
if (failed > 0) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nすべて成功');
