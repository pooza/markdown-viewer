// 手元の zip をビルド版で開き、全部の Markdown について
// リンク切れ・画像切れ・Mermaid の描画失敗を数える（ネットは遮断）。
//
//   node test/check-zip.mjs path/to/docs.zip
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, insertBeforeBodyEnd, OUTPUT } from '../scripts/build.mjs';
import { runInEdge } from './edge.mjs';

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('使い方: node test/check-zip.mjs <zip>');
  process.exit(2);
}

const PROBE = `
<pre id="smoke-result">pending</pre>
<script>
(async () => {
  const out = { docs: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.getElementById('markdown-content');
  try {
    const bin = atob(window.__FIXTURE__);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    await MdvApp.openZipBuffer(buf.buffer, 'check.zip');
    const docs = [...document.querySelectorAll('.file-item')].map((d) => d.title).filter((p) => /\\.(md|markdown)$/i.test(p));
    for (const path of docs) {
      await MdvApp.navigate(path);
      const blocks = c.querySelectorAll('.mermaid').length;
      let svgs = 0;
      for (let i = 0; i < 100 && (svgs = c.querySelectorAll('.mermaid svg').length) < blocks; i++) await wait(100);
      out.docs.push({
        path,
        links: c.querySelectorAll('a[data-target], a[data-anchor]').length,
        broken: [...c.querySelectorAll('a.broken-link')].map((a) => a.textContent + ' → ' + a.title),
        brokenImages: [...c.querySelectorAll('img.broken-image')].map((i) => i.title),
        mermaid: blocks,
        mermaidErrors: blocks - [...c.querySelectorAll('.mermaid svg')].filter((s) => !/Syntax error/i.test(s.textContent)).length,
      });
    }
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  document.getElementById('smoke-result').textContent = JSON.stringify(out);
})();
</script>`;

await build();
const zip = await readFile(zipPath);
const html = await readFile(OUTPUT, 'utf8');
const page = join(OUTPUT, '..', 'check.html');
await writeFile(
  page,
  insertBeforeBodyEnd(
    html,
    `<script>window.__FIXTURE__ = '${zip.toString('base64')}';</script>\n${PROBE}\n`,
  ),
);

const result = await runInEdge(pathToFileURL(page).href);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
let problems = 0;
for (const d of result.docs) {
  const bad = d.broken.length + d.brokenImages.length + d.mermaidErrors;
  problems += bad;
  console.log(`${bad ? '✖' : '✔'} ${d.path}  リンク ${d.links}・図 ${d.mermaid}`);
  for (const b of d.broken) console.log(`    リンク切れ: ${b}`);
  for (const b of d.brokenImages) console.log(`    画像切れ: ${b}`);
  if (d.mermaidErrors) console.log(`    図の描画失敗: ${d.mermaidErrors}`);
}
console.log(`\n文書 ${result.docs.length} 件、問題 ${problems} 件`);
